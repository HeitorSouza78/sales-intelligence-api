"""Lambda de extração de áudio (estágio 1 do pipeline de IA).

Fluxo:
    S3 (meetings/{userId}/{meetingId}/original.mp4)
        -> download para /tmp
        -> ffmpeg extrai somente o áudio (audio.mp3)
        -> upload para meetings/{userId}/{meetingId}/audio.mp3

Requisitos de infraestrutura:
    * Runtime Python 3.12+, dependência ``ffmpeg-python`` (Layer ou pacote).
    * Binário estático do FFmpeg numa Layer (padrão: ``/opt/bin/ffmpeg``,
      sobrescrevível via ``FFMPEG_PATH``).
    * Ephemeral storage (/tmp) dimensionado para o maior vídeo aceito (2 GB)
      + o MP3 gerado. O padrão de 512 MB NÃO é suficiente: use >= 5120 MB.
    * Trigger S3 ``ObjectCreated`` com filtro prefix ``meetings/`` e
      suffix ``/original.mp4``. O filtro por sufixo evita loop recursivo,
      pois o audio.mp3 é gravado no mesmo bucket.
    * IAM: ``s3:GetObject`` em ``meetings/*/*/original.mp4`` e
      ``s3:PutObject`` em ``meetings/*/*/audio.mp3``.

Variáveis de ambiente (opcionais):
    FFMPEG_PATH          Caminho do binário (default ``/opt/bin/ffmpeg``).
    MAX_VIDEO_BYTES      Tamanho máximo aceito (default 2 GiB).
    AUDIO_BITRATE        Bitrate do MP3 (default ``64k``).
    AUDIO_SAMPLE_RATE    Taxa de amostragem em Hz (default 16000).
    LOG_LEVEL            Nível de log (default ``INFO``).
"""

from __future__ import annotations

import logging
import os
import re
import shutil
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final, TypedDict
from urllib.parse import unquote_plus

import boto3
import ffmpeg  # pacote ffmpeg-python
from botocore.exceptions import BotoCoreError, ClientError

# --------------------------------------------------------------------------- #
# Configuração
# --------------------------------------------------------------------------- #

logger = logging.getLogger()
logger.setLevel(os.environ.get("LOG_LEVEL", "INFO").upper())

def _resolve_ffmpeg_path() -> str:
    """Localiza o binário do FFmpeg (variável de ambiente, Layer ou pacote embutido)."""
    env_path = os.environ.get("FFMPEG_PATH")
    if env_path and Path(env_path).is_file():
        return env_path

    candidates = [
        Path("/opt/bin/ffmpeg"),
        Path(__file__).resolve().parent / "bin" / "ffmpeg",
    ]
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)

    try:
        import imageio_ffmpeg  # type: ignore[import-not-found]

        return str(imageio_ffmpeg.get_ffmpeg_exe())
    except Exception:
        pass

    return shutil.which("ffmpeg") or "/opt/bin/ffmpeg"


TMP_ROOT: Final[str] = "/tmp"
FFMPEG_PATH: Final[str] = _resolve_ffmpeg_path()
MAX_VIDEO_BYTES: Final[int] = int(os.environ.get("MAX_VIDEO_BYTES", 2 * 1024**3))
AUDIO_BITRATE: Final[str] = os.environ.get("AUDIO_BITRATE", "64k")
AUDIO_SAMPLE_RATE: Final[int] = int(os.environ.get("AUDIO_SAMPLE_RATE", "16000"))

# Margem de espaço livre exigida além do tamanho do vídeo (para o MP3).
DISK_SAFETY_MARGIN_BYTES: Final[int] = 256 * 1024**2

_UUID = r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
SOURCE_KEY_PATTERN: Final[re.Pattern[str]] = re.compile(
    rf"^meetings/(?P<user_id>{_UUID})/(?P<meeting_id>{_UUID})/original\.mp4$"
)

# Cliente reutilizado entre invocações (warm start). Não guarda dados do usuário.
s3_client = boto3.client("s3")


# --------------------------------------------------------------------------- #
# Tipos
# --------------------------------------------------------------------------- #


class S3Object(TypedDict):
    key: str
    size: int


class S3Bucket(TypedDict):
    name: str


class S3Entity(TypedDict):
    bucket: S3Bucket
    object: S3Object


class S3EventRecord(TypedDict):
    eventSource: str
    s3: S3Entity


class S3Event(TypedDict):
    Records: list[S3EventRecord]


@dataclass(frozen=True, slots=True)
class SourceVideo:
    """Identifica o vídeo de origem já validado."""

    bucket: str
    key: str
    user_id: str
    meeting_id: str

    @property
    def audio_key(self) -> str:
        """Mesma 'pasta' do vídeo original, com o nome fixo ``audio.mp3``."""
        return f"meetings/{self.user_id}/{self.meeting_id}/audio.mp3"


class AudioExtractionError(Exception):
    """Falha de domínio no pipeline (entrada inválida, ffmpeg, limites)."""


# --------------------------------------------------------------------------- #
# Funções auxiliares
# --------------------------------------------------------------------------- #


def parse_record(record: S3EventRecord) -> SourceVideo:
    """Extrai e valida bucket/key do registro do evento S3.

    A key chega URL-encoded (espaços viram ``+``, etc.), por isso o
    ``unquote_plus``. A validação por regex estrita garante que apenas o
    padrão esperado seja processado (impede path traversal e recursão).
    """
    if record.get("eventSource") != "aws:s3":
        raise AudioExtractionError("Evento não originado do S3")

    bucket = record["s3"]["bucket"]["name"]
    key = unquote_plus(record["s3"]["object"]["key"])

    match = SOURCE_KEY_PATTERN.fullmatch(key)
    if match is None:
        raise AudioExtractionError(f"Key fora do padrão esperado: {key!r}")

    return SourceVideo(
        bucket=bucket,
        key=key,
        user_id=match["user_id"].lower(),
        meeting_id=match["meeting_id"].lower(),
    )


def ensure_capacity(video_size: int, workdir: Path) -> None:
    """Garante limites de tamanho e espaço em disco antes do download."""
    if video_size <= 0:
        raise AudioExtractionError("Vídeo vazio")
    if video_size > MAX_VIDEO_BYTES:
        raise AudioExtractionError(
            f"Vídeo excede o limite ({video_size} > {MAX_VIDEO_BYTES} bytes)"
        )
    needed = video_size + DISK_SAFETY_MARGIN_BYTES
    free = shutil.disk_usage(workdir).free
    if free < needed:
        raise AudioExtractionError(
            f"Espaço insuficiente em /tmp (livre={free}, necessário≈{needed}). "
            "Aumente o Ephemeral Storage da função."
        )


def extract_audio(video_path: Path, audio_path: Path) -> None:
    """Extrai somente a trilha de áudio (sem vídeo) para MP3 mono.

    * ``map='0:a:0'`` seleciona exclusivamente a 1ª trilha de áudio.
    * ``vn`` descarta qualquer vídeo.
    * Mono / 16 kHz / 64 kbps: suficiente para transcrição de fala e reduz
      custo de armazenamento e processamento nas etapas seguintes.
    """
    try:
        (
            ffmpeg.input(str(video_path))
            .output(
                str(audio_path),
                map="0:a:0",
                vn=None,
                acodec="libmp3lame",
                audio_bitrate=AUDIO_BITRATE,
                ar=AUDIO_SAMPLE_RATE,
                ac=1,
                map_metadata="-1",  # não propaga metadados do vídeo original
            )
            .overwrite_output()
            .run(
                cmd=FFMPEG_PATH,
                capture_stdout=True,
                capture_stderr=True,
                quiet=True,
            )
        )
    except ffmpeg.Error as exc:
        stderr = (exc.stderr or b"").decode("utf-8", errors="replace")
        # Apenas o final do stderr: suficiente para diagnóstico, sem poluir logs.
        logger.error("ffmpeg falhou: %s", stderr[-2000:])
        raise AudioExtractionError(
            "Falha ao extrair áudio (arquivo corrompido ou sem trilha de áudio)"
        ) from exc
    except FileNotFoundError as exc:
        raise AudioExtractionError(
            f"Binário do FFmpeg não encontrado em {FFMPEG_PATH}"
        ) from exc

    if not audio_path.is_file() or audio_path.stat().st_size == 0:
        raise AudioExtractionError("O ffmpeg não gerou um áudio válido")


def cleanup(workdir: Path | None) -> None:
    """Remove o diretório temporário da invocação (vídeo e áudio)."""
    if workdir is None:
        return
    try:
        shutil.rmtree(workdir)
    except FileNotFoundError:
        pass
    except OSError:
        # Nunca deixar a limpeza mascarar o erro original, mas registrar.
        logger.exception("Falha ao limpar diretório temporário %s", workdir)


def process_video(source: SourceVideo, declared_size: int) -> str:
    """Executa o ETL completo de um vídeo. Retorna a key do áudio gerado."""
    workdir: Path | None = None
    try:
        # Diretório exclusivo por invocação, com permissão 0700.
        workdir = Path(tempfile.mkdtemp(prefix="meeting-", dir=TMP_ROOT))
        video_path = workdir / "original.mp4"
        audio_path = workdir / "audio.mp3"

        # Fonte de verdade do tamanho: metadados atuais do objeto no S3.
        head = s3_client.head_object(Bucket=source.bucket, Key=source.key)
        video_size = int(head.get("ContentLength", declared_size))
        ensure_capacity(video_size, workdir)

        logger.info(
            "Baixando vídeo meeting=%s user=%s size=%d",
            source.meeting_id,
            source.user_id,
            video_size,
        )
        s3_client.download_file(source.bucket, source.key, str(video_path))

        logger.info("Extraindo áudio meeting=%s", source.meeting_id)
        extract_audio(video_path, audio_path)

        # O vídeo não é mais necessário: libera disco antes do upload.
        video_path.unlink(missing_ok=True)

        logger.info(
            "Enviando áudio meeting=%s key=%s", source.meeting_id, source.audio_key
        )
        s3_client.upload_file(
            str(audio_path),
            source.bucket,
            source.audio_key,
            ExtraArgs={"ContentType": "audio/mpeg"},
        )
        return source.audio_key
    finally:
        # Obrigatório: evita vazamento de dados entre warm starts.
        cleanup(workdir)


# --------------------------------------------------------------------------- #
# Handler
# --------------------------------------------------------------------------- #


def lambda_handler(event: S3Event, context: Any) -> dict[str, Any]:
    """Ponto de entrada da Lambda (evento ``s3:ObjectCreated:*``).

    Todos os registros são tentados; se algum falhar, a exceção é relançada
    ao final para que o Lambda aplique retry / DLQ (invocação assíncrona).
    O reprocessamento é idempotente: o audio.mp3 é sobrescrito.
    """
    records = event.get("Records", [])
    processed: list[str] = []
    failures: list[str] = []

    for record in records:
        try:
            source = parse_record(record)
            declared_size = int(record["s3"]["object"].get("size", 0))
            audio_key = process_video(source, declared_size)
            processed.append(audio_key)
            logger.info("Áudio extraído com sucesso: %s", audio_key)
        except AudioExtractionError as exc:
            logger.error("Falha de processamento: %s", exc)
            failures.append(str(exc))
        except (ClientError, BotoCoreError):
            logger.exception("Erro de comunicação com o S3")
            failures.append("S3 error")
        except Exception:
            logger.exception("Erro inesperado no processamento do registro")
            failures.append("unexpected error")

    if failures:
        raise RuntimeError(
            f"{len(failures)}/{len(records)} registro(s) falharam: {failures}"
        )

    return {"status": "ok", "processed": processed}
