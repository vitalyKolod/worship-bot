#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
command -v ffmpeg >/dev/null || { echo 'ffmpeg is missing. Ubuntu: sudo apt-get update && sudo apt-get install -y ffmpeg python3-venv'; exit 1; }
python3 -m venv .audio-venv
.audio-venv/bin/python -m pip install --upgrade pip
# Force the CPU wheel: the default PyPI torch package may pull several GB of CUDA
# libraries even on a CPU-only server.
.audio-venv/bin/python -m pip install torch --index-url https://download.pytorch.org/whl/cpu
.audio-venv/bin/python -m pip install demucs numpy 'librosa>=0.11,<0.12'
.audio-venv/bin/python -m demucs --help >/dev/null
ffmpeg -version | head -n 1
echo 'Audio dependencies are ready. The model is downloaded on first separation.'
