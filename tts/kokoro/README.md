# TTS backend — Kokoro ONNX

Runtime leve (`kokoro-onnx` + `onnxruntime`) com a mesma API HTTP do Qwen
(`/health`, `/tts`, `/tts/cancel`, `/tts/unload`). Ideal quando o Qwen3
(Torch) fica lento — e com GPU via Execution Provider.

## Setup

Na raiz do repo (ou pela UI do AuraReader ao instalar o modelo — o app
também prepara o runtime automaticamente):

```bash
# Detecta GPU (AMD → MIGraphX/ROCm, NVIDIA → CUDA, senão CPU)
bun run setup:tts:kokoro -- --force

# Ou force o acelerador:
bun run setup:tts:kokoro -- --force --accel=rocm   # AMD
bun run setup:tts:kokoro -- --force --accel=cuda   # NVIDIA
bun run setup:tts:kokoro -- --force --accel=cpu
# Windows AMD/Intel (sem ROCm): --accel=dml
```

### AMD (ROCm / MIGraphX)

Além do wheel Python, precisa do pacote de sistema **migraphx** alinhado ao ROCm:

```bash
# Arch
sudo pacman -S migraphx

# Ubuntu / Radeon Software — siga a doc AMD:
# https://rocm.docs.amd.com/projects/radeon-ryzen/en/latest/docs/install/installrad/native_linux/install-onnx.html
```

RX 6000 (RDNA2 / gfx1030): o Aura já exporta `HSA_OVERRIDE_GFX_VERSION=10.3.0` no spawn.

O `/health` reporta `device` (`rocm` | `cuda` | `cpu` | …) e `onnxProviders`.

## Modelos

Baixados pela UI ou em `models/kokoro/`:

- `kokoro-v1.0.onnx`
- `voices-v1.0.bin`

(releases: https://github.com/thewh1teagle/kokoro-onnx/releases/tag/model-files-v1.0)

## Smoke

```bash
bun run start:tts:kokoro
# ou:
tts/kokoro/.venv/bin/python tts/kokoro/tts_server.py
curl -s http://127.0.0.1:8765/health | jq .device,.onnxProviders
```

## Warm-up GPU (AMD MIGraphX)

Na UI: **Aquecer GPU (pré-compilar)** — ou:

```bash
curl -X POST http://127.0.0.1:3000/api/tts/kokoro-warmup
# progresso:
curl -s http://127.0.0.1:3000/api/tts/kokoro-warmup | jq
```

Isso sintetiza vários tamanhos de texto para popular o cache `.mxr` e define
`MIGRAPHX_GPU_COMPILE_PARALLEL` = nº de cores da CPU.
