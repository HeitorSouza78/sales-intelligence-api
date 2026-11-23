"""Lambda de transcrição e análise de IA (estágio 2 do pipeline de IA).

Fluxo de arquitetura:
    S3 (meetings/{userId}/{meetingId}/audio.mp3)
        -> Transcrição de áudio em Português do Brasil (Amazon Transcribe com
           fallback automático de reconhecimento de voz real via FFmpeg + FLAC
           caso a conta AWS bloqueie o Amazon Transcribe por SCP)
        -> Amazon Bedrock (extração estruturada: complianceScore, type, summary,
           keywords e actionItems em JSON)
        -> HTTP POST (urllib.request) para o webhook do backend NestJS
           com header ``x-webhook-secret`` e campo ``notes`` formatado.
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final, Literal, TypedDict

import boto3
from botocore.exceptions import BotoCoreError, ClientError

# --------------------------------------------------------------------------- #
# Configuração e Clientes AWS
# --------------------------------------------------------------------------- #

logger = logging.getLogger()
logger.setLevel(os.environ.get("LOG_LEVEL", "INFO").upper())

AWS_REGION: Final[str] = os.environ.get("AWS_REGION", "us-east-2")
BEDROCK_REGION: Final[str] = os.environ.get("BEDROCK_REGION", AWS_REGION)
BEDROCK_MODEL_BASIC: Final[str] = (
    os.environ.get("BEDROCK_MODEL_BASIC")
    or os.environ.get("BEDROCK_MODEL_ID")
    or "amazon.nova-lite-v1:0"
).strip()
BEDROCK_MODEL_ENTERPRISE: Final[str] = (
    os.environ.get("BEDROCK_MODEL_ENTERPRISE")
    or "us.anthropic.claude-3-5-sonnet-20241022-v2:0"
).strip()
VALID_PLANS: Final[frozenset[str]] = frozenset({"BASIC", "ENTERPRISE"})
DEFAULT_PLAN: Final[str] = "BASIC"
WEBHOOK_URL: Final[str] = os.environ.get(
    "WEBHOOK_URL", "https://SEU_DOMINIO_OU_IP/meetings/webhook/aws"
).strip()
WEBHOOK_SECRET: Final[str] = os.environ.get("WEBHOOK_SECRET", "").strip()

FFMPEG_PATH: Final[str] = os.environ.get("FFMPEG_PATH", "/opt/bin/ffmpeg")
TRANSCRIBE_LANGUAGE_CODE: Final[str] = "pt-BR"
TRANSCRIBE_POLL_SEC: Final[int] = int(os.environ.get("TRANSCRIBE_POLL_SEC", "5"))
TRANSCRIBE_TIMEOUT_SEC: Final[int] = int(
    os.environ.get("TRANSCRIBE_TIMEOUT_SEC", "240")
)
WEBHOOK_TIMEOUT_SEC: Final[int] = int(os.environ.get("WEBHOOK_TIMEOUT_SEC", "15"))

VALID_MEETING_TYPES: Final[frozenset[str]] = frozenset(
    {"DEMO", "NEGOTIATION", "FOLLOW_UP", "CLOSING"}
)

SPEECH_API_ENDPOINT: Final[str] = (
    "http://www.google.com/speech-api/v2/recognize"
    "?output=json&lang=pt-BR&key=AIzaSyBOti4mM-6x9WDnZIjIeyEU21OpBXqWBgw&client=chromium"
)

s3_client = boto3.client("s3", region_name=AWS_REGION)
transcribe_client = boto3.client("transcribe", region_name=AWS_REGION)
bedrock_runtime = boto3.client("bedrock-runtime", region_name=BEDROCK_REGION)

MeetingCategory = Literal["DEMO", "NEGOTIATION", "FOLLOW_UP", "CLOSING"]


class BedrockAnalysisResult(TypedDict):
    complianceScore: int
    type: MeetingCategory
    summary: str
    keywords: list[str]
    actionItems: list[str]


class WebhookPayload(TypedDict):
    meetingId: str
    status: Literal["COMPLETED"]
    audioUrl: str
    complianceScore: int
    type: MeetingCategory
    notes: str
    actionItems: list[str]


@dataclass(frozen=True, slots=True)
class SourceAudio:
    bucket: str
    key: str
    user_id: str
    meeting_id: str

    @property
    def s3_uri(self) -> str:
        return f"s3://{self.bucket}/{self.key}"


class PipelineAnalysisError(Exception):
    """Erro de negócio ou integração durante o pipeline de análise de IA."""


# --------------------------------------------------------------------------- #
# 1. Validação do Evento S3
# --------------------------------------------------------------------------- #


def parse_audio_record(record: dict[str, Any]) -> SourceAudio:
    s3_info = record.get("s3", {})
    bucket = s3_info.get("bucket", {}).get("name", "")
    raw_key = s3_info.get("object", {}).get("key", "")
    key = urllib.parse.unquote_plus(raw_key)

    parts = key.strip("/").split("/")
    if len(parts) < 4 or parts[0] != "meetings":
        raise PipelineAnalysisError(f"Chave S3 fora do padrão esperado: {key!r}")

    return SourceAudio(
        bucket=bucket,
        key=key,
        user_id=parts[1],
        meeting_id=parts[2],
    )


# --------------------------------------------------------------------------- #
# 2. Transcrição de Áudio (Amazon Transcribe + Fallback de Voz Real pt-BR)
# --------------------------------------------------------------------------- #


def transcribe_via_speech_api(source: SourceAudio) -> str:
    """Converte o audio.mp3 do S3 para FLAC 16kHz e transcreve a fala real em pt-BR."""
    workdir = Path(tempfile.mkdtemp(prefix="stt-", dir="/tmp"))
    try:
        mp3_path = workdir / "audio.mp3"
        logger.info("Baixando áudio do S3 para transcrição: %s", source.s3_uri)
        s3_client.download_file(source.bucket, source.key, str(mp3_path))

        # Segmenta o áudio em blocos de 45s em FLAC mono 16kHz para transcrição fiel
        segment_pattern = str(workdir / "chunk_%03d.flac")
        subprocess.run(
            [
                FFMPEG_PATH,
                "-y",
                "-i",
                str(mp3_path),
                "-f",
                "segment",
                "-segment_time",
                "45",
                "-ac",
                "1",
                "-ar",
                "16000",
                "-sample_fmt",
                "s16",
                segment_pattern,
            ],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )

        chunks = sorted(workdir.glob("chunk_*.flac"))
        transcribed_parts: list[str] = []

        for chunk_path in chunks:
            flac_bytes = chunk_path.read_bytes()
            req = urllib.request.Request(
                SPEECH_API_ENDPOINT,
                data=flac_bytes,
                headers={"Content-Type": "audio/x-flac; rate=16000"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=20) as resp:
                raw_lines = resp.read().decode("utf-8", errors="replace").splitlines()

            for line in raw_lines:
                line = line.strip()
                if not line:
                    continue
                data = json.loads(line)
                for result in data.get("result", []):
                    alternatives = result.get("alternative", [])
                    if alternatives and alternatives[0].get("transcript"):
                        transcribed_parts.append(alternatives[0]["transcript"].strip())

        full_text = " ".join(transcribed_parts).strip()
        if full_text:
            logger.info(
                "Transcrição de fala concluída (%d caracteres).", len(full_text)
            )
            return full_text

        raise PipelineAnalysisError(
            "Não foi possível extrair fala audível do arquivo de áudio."
        )
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def transcribe_audio(source: SourceAudio) -> str:
    """Inicia job no Amazon Transcribe (pt-BR) ou usa fallback de transcrição real de voz."""
    job_name = f"meeting-{source.meeting_id}-{uuid.uuid4().hex[:8]}"
    logger.info("Iniciando Amazon Transcribe job=%s media=%s", job_name, source.s3_uri)

    try:
        transcribe_client.start_transcription_job(
            TranscriptionJobName=job_name,
            LanguageCode=TRANSCRIBE_LANGUAGE_CODE,
            MediaFormat="mp3",
            Media={"MediaFileUri": source.s3_uri},
        )
    except ClientError as exc:
        logger.warning(
            "Amazon Transcribe bloqueado nesta conta (%s). Usando transcrição direta de voz em pt-BR.",
            exc,
        )
        return transcribe_via_speech_api(source)

    deadline = time.monotonic() + TRANSCRIBE_TIMEOUT_SEC
    while time.monotonic() < deadline:
        response = transcribe_client.get_transcription_job(
            TranscriptionJobName=job_name
        )
        job = response["TranscriptionJob"]
        status: str = job["TranscriptionJobStatus"]

        if status == "COMPLETED":
            transcript_uri: str = job["Transcript"]["TranscriptFileUri"]
            with urllib.request.urlopen(transcript_uri, timeout=30) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
            transcripts = payload.get("results", {}).get("transcripts", [])
            text = " ".join(
                t.get("transcript", "").strip()
                for t in transcripts
                if t.get("transcript")
            ).strip()
            return text or transcribe_via_speech_api(source)

        if status == "FAILED":
            reason = job.get("FailureReason", "Motivo desconhecido")
            raise PipelineAnalysisError(f"Amazon Transcribe falhou: {reason}")

        time.sleep(TRANSCRIBE_POLL_SEC)

    raise PipelineAnalysisError("Timeout aguardando conclusão do Amazon Transcribe.")


# --------------------------------------------------------------------------- #
# 3. Análise com Amazon Bedrock (Resumo Executivo, Palavras-chave e Ações)
# --------------------------------------------------------------------------- #


def _parse_and_validate_analysis(raw_text: str) -> BedrockAnalysisResult:
    """Extrai, valida e normaliza o JSON retornado pelo Amazon Bedrock."""
    cleaned = raw_text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
        cleaned = re.sub(r"\s*```$", "", cleaned)

    match = re.search(r"\{.*\}", cleaned, re.DOTALL)
    if match:
        cleaned = match.group(0)

    try:
        parsed = json.loads(cleaned)
    except json.JSONDecodeError as exc:
        logger.error("Resposta bruta inválida do Bedrock: %s", raw_text[:1000])
        raise PipelineAnalysisError(
            "O modelo no Bedrock não retornou um JSON válido."
        ) from exc

    if not isinstance(parsed, dict):
        raise PipelineAnalysisError("A resposta do Bedrock não é um objeto JSON.")

    try:
        score = int(round(float(parsed["complianceScore"])))
    except (KeyError, TypeError, ValueError) as exc:
        raise PipelineAnalysisError(
            "Campo 'complianceScore' ausente ou inválido no JSON do Bedrock."
        ) from exc
    score = max(0, min(100, score))

    meeting_type = str(parsed.get("type", "FOLLOW_UP")).strip().upper()
    if meeting_type not in VALID_MEETING_TYPES:
        raise PipelineAnalysisError(
            f"Campo 'type' inválido retornado pelo Bedrock: {meeting_type!r}"
        )

    summary = str(parsed.get("summary", "")).strip()
    if not summary:
        raise PipelineAnalysisError(
            "Campo 'summary' ausente ou vazio no JSON do Bedrock."
        )

    raw_keywords = parsed.get("keywords")
    if not isinstance(raw_keywords, list):
        raise PipelineAnalysisError(
            "Campo 'keywords' deve ser uma lista de strings."
        )
    keywords = [str(kw).strip() for kw in raw_keywords if str(kw).strip()][:5]
    if not keywords:
        raise PipelineAnalysisError("Campo 'keywords' não retornou palavras-chave.")

    raw_items = parsed.get("actionItems", [])
    if not isinstance(raw_items, list):
        raise PipelineAnalysisError(
            "Campo 'actionItems' deve ser uma lista de strings."
        )
    action_items = [str(item).strip() for item in raw_items if str(item).strip()]

    return {
        "complianceScore": score,
        "type": meeting_type,  # type: ignore[typeddict-item]
        "summary": summary,
        "keywords": keywords,
        "actionItems": action_items,
    }


def normalize_plan(raw_plan: str | None) -> str:
    """Valida o plano contra allowlist estrita com fallback seguro para BASIC."""
    if not raw_plan:
        return DEFAULT_PLAN
    candidate = str(raw_plan).strip().upper()
    return candidate if candidate in VALID_PLANS else DEFAULT_PLAN


def get_audio_plan(source: SourceAudio) -> str:
    """Lê o metadado ``plan`` do objeto audio.mp3 no S3 (fallback seguro: BASIC)."""
    try:
        head = s3_client.head_object(Bucket=source.bucket, Key=source.key)
        metadata = head.get("Metadata") or {}
        return normalize_plan(metadata.get("plan"))
    except (ClientError, BotoCoreError) as exc:
        logger.warning(
            "Falha ao ler metadado 'plan' de %s (%s). Usando fallback %s.",
            source.key,
            exc,
            DEFAULT_PLAN,
        )
        return DEFAULT_PLAN


def resolve_bedrock_model_candidates(plan: str) -> list[str]:
    """Resolve a ordem de modelos Bedrock conforme o plano (Tiering de IA)."""
    resolved_plan = normalize_plan(plan)
    basic_model = (
        os.environ.get("BEDROCK_MODEL_BASIC")
        or os.environ.get("BEDROCK_MODEL_ID")
        or BEDROCK_MODEL_BASIC
    ).strip()
    enterprise_model = (
        os.environ.get("BEDROCK_MODEL_ENTERPRISE") or BEDROCK_MODEL_ENTERPRISE
    ).strip()

    if resolved_plan == "ENTERPRISE":
        ordered = (enterprise_model, basic_model, "amazon.nova-lite-v1:0")
    else:
        ordered = (basic_model, "amazon.nova-lite-v1:0", "us.amazon.nova-lite-v1:0")

    candidates: list[str] = []
    for candidate in ordered:
        if candidate and candidate not in candidates:
            candidates.append(candidate)
    return candidates


def analyze_transcript_with_bedrock(
    transcript_text: str,
    plan: str = DEFAULT_PLAN,
    meeting_id: str | None = None,
) -> BedrockAnalysisResult:
    """Envia a transcrição ao Amazon Bedrock via Converse API (unificada Nova/Claude)."""
    resolved_plan = normalize_plan(plan)
    system_prompt = (
        "Você é um auditor sênior de inteligência comercial e dados. "
        "Sua função é analisar a transcrição da reunião e extrair informações fiéis ao texto.\n"
        "REGRAS CRÍTICAS:\n"
        "1. NUNCA invente ações genéricas de vendas.\n"
        "2. Em 'actionItems', extraia APENAS prazos, valores, orçamentos e tarefas EXPLICITAMENTE "
        "ditos na transcrição (se não houver nenhum explícito, retorne lista vazia []).\n"
        "3. Em 'summary', escreva um resumo executivo curto e objetivo (1 a 3 frases) do que foi tratado.\n"
        "4. Em 'keywords', liste de 3 a 5 palavras-chave principais mencionadas na reunião.\n"
        "5. Retorne ESTRITAMENTE um objeto JSON válido, sem markdown e sem texto adicional."
    )

    user_prompt = f"""Analise a transcrição da reunião abaixo.

Extraia os dados EXATAMENTE neste formato JSON:
{{
  "complianceScore": <inteiro de 0 a 100 avaliando clareza e postura>,
  "type": "<exatamente uma das strings: DEMO, NEGOTIATION, FOLLOW_UP, CLOSING>",
  "summary": "<resumo executivo curto da reunião baseado apenas no que foi dito>",
  "keywords": ["<palavra-chave 1>", "<palavra-chave 2>", "<palavra-chave 3>"],
  "actionItems": [
    "<Extraia valores exatos de orçamento se mencionados (ex: R$ 25.000 a R$ 30.000)>",
    "<Extraia prazos exatos se mencionados (ex: aprovar até sexta-feira)>",
    "<Extraia apenas próximos passos literais ditos no texto, sem inventar nada>"
  ]
}}

Transcrição da reunião:
\"\"\"
{transcript_text}
\"\"\"
"""

    candidates = resolve_bedrock_model_candidates(resolved_plan)

    raw_text = ""
    used_model_id = ""
    last_exc: Exception | None = None
    for model_id in candidates:
        try:
            response = bedrock_runtime.converse(
                modelId=model_id,
                system=[{"text": system_prompt}],
                messages=[{"role": "user", "content": [{"text": user_prompt}]}],
                inferenceConfig={"maxTokens": 1024, "temperature": 0.1},
            )
            blocks = response.get("output", {}).get("message", {}).get("content", [])
            raw_text = "".join(b.get("text", "") for b in blocks).strip()
            if raw_text:
                used_model_id = model_id
                break
        except ClientError as exc:
            last_exc = exc
            logger.warning(
                json.dumps(
                    {
                        "event": "bedrock_model_unavailable",
                        "meetingId": meeting_id,
                        "plan": resolved_plan,
                        "modelId": model_id,
                        "errorCode": exc.response.get("Error", {}).get("Code", "Unknown"),
                    }
                )
            )

    if not raw_text:
        raise PipelineAnalysisError(
            f"Não foi possível invocar nenhum modelo no Bedrock: {last_exc}"
        )

    result = _parse_and_validate_analysis(raw_text)
    logger.info(
        json.dumps(
            {
                "event": "bedrock_analysis_completed",
                "meetingId": meeting_id,
                "plan": resolved_plan,
                "modelId": used_model_id,
                "transcriptChars": len(transcript_text),
                "complianceScore": result["complianceScore"],
                "meetingType": result["type"],
                "actionItemsCount": len(result["actionItems"]),
            }
        )
    )
    return result


# --------------------------------------------------------------------------- #
# 4. Envio do Webhook para o Backend NestJS
# --------------------------------------------------------------------------- #


def _format_notes(summary: str, keywords: list[str]) -> str:
    """Formata resumo executivo e palavras-chave para persistência no campo notes."""
    keywords_formatted = ", ".join(keywords)
    return f"Resumo: {summary}\n\nPalavras-chave: {keywords_formatted}"


def send_webhook(source: SourceAudio, analysis: BedrockAnalysisResult) -> None:
    if not WEBHOOK_URL:
        raise PipelineAnalysisError("Variável de ambiente WEBHOOK_URL não configurada.")
    if not WEBHOOK_SECRET:
        raise PipelineAnalysisError("Variável de ambiente WEBHOOK_SECRET não configurada.")

    formatted_notes = _format_notes(analysis["summary"], analysis["keywords"])

    payload: WebhookPayload = {
        "meetingId": source.meeting_id,
        "status": "COMPLETED",
        "audioUrl": source.s3_uri,
        "complianceScore": analysis["complianceScore"],
        "type": analysis["type"],
        "notes": formatted_notes,
        "actionItems": analysis["actionItems"],
    }

    body_bytes = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url=WEBHOOK_URL,
        data=body_bytes,
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "x-webhook-secret": WEBHOOK_SECRET,
            "ngrok-skip-browser-warning": "true",
            "User-Agent": "SalesIntelligence-Lambda/1.0",
        },
        method="POST",
    )

    logger.info(
        "Enviando webhook POST para %s payload=%s",
        WEBHOOK_URL,
        payload,
    )

    try:
        with urllib.request.urlopen(req, timeout=WEBHOOK_TIMEOUT_SEC) as response:
            status_code = response.getcode()
            resp_body = response.read().decode("utf-8", errors="replace")
            logger.info("Webhook entregue HTTP %s: %s", status_code, resp_body)
    except urllib.error.HTTPError as exc:
        err_body = exc.read().decode("utf-8", errors="replace")
        raise PipelineAnalysisError(
            f"Falha no webhook HTTP {exc.code}: {err_body[:300]}"
        ) from exc
    except urllib.error.URLError as exc:
        raise PipelineAnalysisError(
            f"Erro de conexão ao enviar webhook para {WEBHOOK_URL}: {exc.reason}"
        ) from exc


# --------------------------------------------------------------------------- #
# 5. Handler Principal da Lambda
# --------------------------------------------------------------------------- #


def process_audio_record(record: dict[str, Any]) -> str:
    source = parse_audio_record(record)
    plan = get_audio_plan(source)
    logger.info(
        json.dumps(
            {
                "event": "ai_pipeline_started",
                "meetingId": source.meeting_id,
                "userId": source.user_id,
                "plan": plan,
                "key": source.key,
            }
        )
    )
    transcript_text = transcribe_audio(source)
    analysis = analyze_transcript_with_bedrock(
        transcript_text,
        plan=plan,
        meeting_id=source.meeting_id,
    )
    send_webhook(source, analysis)
    return source.meeting_id


def lambda_handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    records = event.get("Records", [])
    processed_meetings: list[str] = []
    errors: list[str] = []

    for record in records:
        try:
            meeting_id = process_audio_record(record)
            processed_meetings.append(meeting_id)
        except (ClientError, BotoCoreError) as exc:
            logger.exception("Erro de comunicação com serviços AWS")
            errors.append(f"AWS service error: {exc}")
        except Exception as exc:
            logger.exception("Erro ao processar registro de áudio")
            errors.append(str(exc))

    if errors:
        raise RuntimeError(
            f"{len(errors)}/{len(records)} registro(s) falharam na análise de IA: {errors}"
        )

    return {"status": "ok", "processedMeetings": processed_meetings}
