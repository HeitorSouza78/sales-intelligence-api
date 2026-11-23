"""Testes unitários das AWS Lambdas (Fase 3: propagação de plan e Tiering de IA)."""

from __future__ import annotations

import importlib
import json
import os
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

LAMBDAS_DIR = Path(__file__).resolve().parent.parent
if str(LAMBDAS_DIR) not in sys.path:
    sys.path.insert(0, str(LAMBDAS_DIR))


def _ensure_boto_stubs() -> None:
    """Fornece stubs mínimos de boto3/botocore caso o ambiente local não tenha boto3."""
    if "botocore" not in sys.modules:
        botocore_mod = types.ModuleType("botocore")
        exc_mod = types.ModuleType("botocore.exceptions")

        class BotoCoreError(Exception):
            pass

        class ClientError(Exception):
            def __init__(self, error_response: dict, operation_name: str) -> None:
                super().__init__(str(error_response))
                self.response = error_response
                self.operation_name = operation_name

        exc_mod.BotoCoreError = BotoCoreError  # type: ignore[attr-defined]
        exc_mod.ClientError = ClientError  # type: ignore[attr-defined]
        botocore_mod.exceptions = exc_mod  # type: ignore[attr-defined]
        sys.modules["botocore"] = botocore_mod
        sys.modules["botocore.exceptions"] = exc_mod

    if "boto3" not in sys.modules:
        boto3_mod = types.ModuleType("boto3")
        boto3_mod.client = MagicMock(return_value=MagicMock())  # type: ignore[attr-defined]
        sys.modules["boto3"] = boto3_mod


_ensure_boto_stubs()

lambda_function = importlib.import_module("lambda_function")
lambda_ai_analysis = importlib.import_module("lambda_ai_analysis")


class TestLambda1PlanPropagation(unittest.TestCase):
    def setUp(self) -> None:
        self.source = lambda_function.SourceVideo(
            bucket="test-bucket",
            key="meetings/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/original.mp4",
            user_id="11111111-1111-4111-8111-111111111111",
            meeting_id="22222222-2222-4222-8222-222222222222",
        )

    def _run_process_video(self, metadata: dict[str, str] | None) -> MagicMock:
        mock_s3 = MagicMock()
        mock_s3.head_object.return_value = {
            "ContentLength": 1024,
            **({"Metadata": metadata} if metadata is not None else {}),
        }

        def fake_extract(_video_path: Path, audio_path: Path) -> None:
            audio_path.write_bytes(b"fake-mp3")

        with (
            patch.object(lambda_function, "s3_client", mock_s3),
            patch.object(lambda_function, "extract_audio", side_effect=fake_extract),
        ):
            audio_key = lambda_function.process_video(self.source, 1024)
            self.assertEqual(audio_key, self.source.audio_key)

        return mock_s3

    def test_propagates_enterprise_plan_from_video_to_audio(self) -> None:
        mock_s3 = self._run_process_video({"plan": "ENTERPRISE"})
        _, kwargs = mock_s3.upload_file.call_args
        self.assertEqual(
            kwargs["ExtraArgs"],
            {"ContentType": "audio/mpeg", "Metadata": {"plan": "ENTERPRISE"}},
        )

    def test_defaults_to_basic_when_metadata_missing_or_invalid(self) -> None:
        for bad_meta in (None, {}, {"plan": "SUPER_ADMIN"}):
            mock_s3 = self._run_process_video(bad_meta)
            _, kwargs = mock_s3.upload_file.call_args
            self.assertEqual(
                kwargs["ExtraArgs"],
                {"ContentType": "audio/mpeg", "Metadata": {"plan": "BASIC"}},
            )


class TestLambda2BedrockTiering(unittest.TestCase):
    def setUp(self) -> None:
        self.source = lambda_ai_analysis.SourceAudio(
            bucket="test-bucket",
            key="meetings/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/audio.mp3",
            user_id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            meeting_id="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        )
        self.bedrock_ok_response = {
            "output": {
                "message": {
                    "content": [
                        {
                            "text": json.dumps(
                                {
                                    "complianceScore": 92,
                                    "type": "NEGOTIATION",
                                    "summary": "Cliente aprovou escopo comercial.",
                                    "keywords": ["escopo", "prazo", "orçamento"],
                                    "actionItems": ["Enviar contrato até sexta"],
                                }
                            )
                        }
                    ]
                }
            }
        }

    def _run_pipeline_with_metadata(
        self, metadata: dict[str, str] | None
    ) -> tuple[MagicMock, list[str]]:
        mock_s3 = MagicMock()
        mock_s3.head_object.return_value = (
            {"Metadata": metadata} if metadata is not None else {}
        )
        mock_bedrock = MagicMock()
        mock_bedrock.converse.return_value = self.bedrock_ok_response

        secret_transcript = "segredo ultra confidencial do cliente 999888"
        record = {
            "s3": {
                "bucket": {"name": self.source.bucket},
                "object": {"key": self.source.key},
            }
        }

        env_override = {
            "BEDROCK_MODEL_BASIC": "amazon.nova-lite-v1:0",
            "BEDROCK_MODEL_ENTERPRISE": "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
        }

        with (
            patch.dict(os.environ, env_override, clear=False),
            patch.object(lambda_ai_analysis, "s3_client", mock_s3),
            patch.object(lambda_ai_analysis, "bedrock_runtime", mock_bedrock),
            patch.object(
                lambda_ai_analysis,
                "transcribe_audio",
                return_value=secret_transcript,
            ),
            patch.object(lambda_ai_analysis, "send_webhook"),
            self.assertLogs(lambda_ai_analysis.logger, level="INFO") as captured,
        ):
            lambda_ai_analysis.process_audio_record(record)

        # Garante que nenhum log vazou o texto sensível da transcrição
        for line in captured.output:
            self.assertNotIn(secret_transcript, line)

        return mock_bedrock, captured.output

    def test_basic_plan_uses_bedrock_model_basic(self) -> None:
        mock_bedrock, logs = self._run_pipeline_with_metadata({"plan": "BASIC"})
        _, kwargs = mock_bedrock.converse.call_args
        self.assertEqual(kwargs["modelId"], "amazon.nova-lite-v1:0")
        self.assertTrue(
            any(
                '"plan": "BASIC"' in line
                and '"modelId": "amazon.nova-lite-v1:0"' in line
                for line in logs
            )
        )

    def test_enterprise_plan_uses_bedrock_model_enterprise(self) -> None:
        mock_bedrock, logs = self._run_pipeline_with_metadata({"plan": "ENTERPRISE"})
        _, kwargs = mock_bedrock.converse.call_args
        self.assertEqual(
            kwargs["modelId"], "us.anthropic.claude-3-5-sonnet-20241022-v2:0"
        )
        self.assertTrue(
            any(
                '"plan": "ENTERPRISE"' in line
                and '"modelId": "us.anthropic.claude-3-5-sonnet-20241022-v2:0"' in line
                for line in logs
            )
        )

    def test_missing_or_invalid_plan_falls_back_to_basic(self) -> None:
        for bad_meta in (None, {}, {"plan": "INVALID_TIER"}):
            mock_bedrock, _ = self._run_pipeline_with_metadata(bad_meta)
            _, kwargs = mock_bedrock.converse.call_args
            self.assertEqual(kwargs["modelId"], "amazon.nova-lite-v1:0")


if __name__ == "__main__":
    unittest.main()
