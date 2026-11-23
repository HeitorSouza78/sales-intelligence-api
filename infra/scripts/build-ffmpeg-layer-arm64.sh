#!/usr/bin/env bash
set -euo pipefail

# Constrói uma AWS Lambda Layer com binário estático do FFmpeg para Linux arm64 (Graviton2).
# Estrutura exigida pela AWS Lambda: bin/ffmpeg -> montado em /opt/bin/ffmpeg.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="${1:-$SCRIPT_DIR/../dist}"
OUT_ZIP="$OUT_DIR/ffmpeg-layer-arm64.zip"
FFMPEG_URL="${FFMPEG_ARM64_URL:-https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-arm64-static.tar.xz}"

for cmd in curl tar file zip; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Erro: dependência obrigatória não encontrada: $cmd" >&2
    exit 1
  fi
done

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

mkdir -p "$OUT_DIR" "$WORKDIR/layer/bin"

echo "==> Baixando FFmpeg estático Linux arm64..."
curl -fL "$FFMPEG_URL" -o "$WORKDIR/ffmpeg-arm64.tar.xz"

echo "==> Extraindo binário ffmpeg..."
tar -xJf "$WORKDIR/ffmpeg-arm64.tar.xz" -C "$WORKDIR"
FFMPEG_BIN="$(find "$WORKDIR" -maxdepth 2 -type f -name ffmpeg | head -n 1)"

if [[ -z "$FFMPEG_BIN" || ! -f "$FFMPEG_BIN" ]]; then
  echo "Erro: binário 'ffmpeg' não encontrado após extração." >&2
  exit 1
fi

cp "$FFMPEG_BIN" "$WORKDIR/layer/bin/ffmpeg"
chmod 755 "$WORKDIR/layer/bin/ffmpeg"

echo "==> Validando arquitetura do binário (obrigatório ELF 64-bit ARM aarch64)..."
FILE_INFO="$(file "$WORKDIR/layer/bin/ffmpeg")"
echo "    $FILE_INFO"

if [[ "$FILE_INFO" != *"ARM aarch64"* && "$FILE_INFO" != *"aarch64"* ]]; then
  echo "Erro: binário NÃO é arm64/aarch64! Abortando empacotamento." >&2
  exit 1
fi

echo "==> Empacotando Layer em $OUT_ZIP..."
rm -f "$OUT_ZIP"
(
  cd "$WORKDIR/layer"
  zip -9 -r "$OUT_ZIP" bin/ffmpeg >/dev/null
)

echo "==> Layer arm64 gerada com sucesso:"
ls -lh "$OUT_ZIP"
