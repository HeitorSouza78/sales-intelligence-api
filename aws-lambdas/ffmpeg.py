"""Wrapper compatível com a API fluente do ffmpeg-python para Python 3.12+/3.15 no AWS Lambda."""

from __future__ import annotations

import subprocess
from typing import Any


class Error(Exception):
    """Exceção compatível com ``ffmpeg.Error``."""

    def __init__(self, cmd: str | list[str], stdout: bytes | None, stderr: bytes | None) -> None:
        super().__init__(f"{cmd} error (see stderr output for detail)")
        self.stdout = stdout
        self.stderr = stderr


class _Stream:
    def __init__(self, input_path: str) -> None:
        self._input_path = input_path
        self._output_path: str | None = None
        self._kwargs: dict[str, Any] = {}
        self._overwrite = False

    def output(self, filename: str, **kwargs: Any) -> _Stream:
        self._output_path = filename
        self._kwargs = kwargs
        return self

    def overwrite_output(self) -> _Stream:
        self._overwrite = True
        return self

    def run(
        self,
        cmd: str = "ffmpeg",
        capture_stdout: bool = False,
        capture_stderr: bool = False,
        quiet: bool = False,
    ) -> tuple[bytes, bytes]:
        if not self._output_path:
            raise ValueError("Output path must be specified before calling run()")

        args: list[str] = [cmd]
        if self._overwrite:
            args.append("-y")
        args.extend(["-i", self._input_path])

        for key, value in self._kwargs.items():
            flag = "-b:a" if key == "audio_bitrate" else f"-{key}"
            args.append(flag)
            if value is not None:
                args.append(str(value))

        args.append(self._output_path)

        proc = subprocess.run(
            args,
            stdout=subprocess.PIPE if (capture_stdout or quiet) else None,
            stderr=subprocess.PIPE if (capture_stderr or quiet) else None,
            check=False,
        )
        out = proc.stdout or b""
        err = proc.stderr or b""
        if proc.returncode != 0:
            raise Error(cmd, out, err)
        return out, err


def input(filename: str) -> _Stream:  # noqa: A001
    return _Stream(filename)
