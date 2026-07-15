# TTS backend — MLX (macOS Apple Silicon)

O runtime MLX permanece em [`qwen3-tts-apple-silicon/`](../../qwen3-tts-apple-silicon/) (`tts_server.py` + venv/`site-packages`).

O app Node seleciona esse caminho automaticamente em `process.platform === "darwin"`.

Para Windows/Linux (PyTorch / CUDA / ROCm / CPU), veja [`tts/torch/`](../torch/).
