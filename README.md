# AuraReader

Narrador de PDF/EPUB para **MP3** ou **M4B**. A extração de texto de PDF usa Gemini; a síntese de voz usa **Qwen3-TTS** local via MLX (`qwen3-tts-apple-silicon/`, modelos Lite 0.6B).

## Modos do app

Menu lateral:

| Modo | O que faz |
|------|-----------|
| **Narrar** | Extrai texto (PDF/EPUB), revisa e narra. Saída MP3 ou M4B; capa JPEG com o mesmo nome do áudio. |
| **Extrair capa** | Salva só a capa do livro como JPEG em Downloads. |
| **MP3 → M4B** | Empacota um MP3 + capa (imagem, PDF ou EPUB) em audiobook M4B. |
| **M4B → MP3** | Extrai MP3 + imagem de capa embutida. |

Na narração:

- Nome do arquivo: `<livro>.mp3` / `.m4b` (sem intervalo de páginas no nome; basename do arquivo original).
- Capa: `<livro>.jpg` (mesmo basename).
- **M4B**: PDF embute só a capa; EPUB embute a capa e as demais imagens do livro como artwork.
- M4B e conversões exigem **ffmpeg** no PATH.

## Pré-requisitos

- [Bun](https://bun.sh)
- macOS Apple Silicon (M1/M2/M3/M4)
- Python 3.12+ com o venv em `qwen3-tts-apple-silicon/.venv`
- Modelo **Base** Lite (recomendado, ICL) e/ou CustomVoice em `qwen3-tts-apple-silicon/models/`
- `ffmpeg` (`brew install ffmpeg`) — obrigatório para M4B e modos de conversão
- `GEMINI_API_KEY` no `.env` (apenas para extrair texto de PDFs; EPUBs são locais)

## Setup do TTS (uma vez)

```bash
cd qwen3-tts-apple-silicon
python3.12 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt fastapi 'uvicorn[standard]'

# Base (recomendado): voice cloning / ICL — trava o tom entre blocos usando a prévia em cache
python -c "from huggingface_hub import snapshot_download; snapshot_download('mlx-community/Qwen3-TTS-12Hz-0.6B-Base-8bit', local_dir='models/Qwen3-TTS-12Hz-0.6B-Base-8bit')"

# CustomVoice (opcional): gera as prévias/âncoras iniciais e fallback se Base não estiver instalado
python -c "from huggingface_hub import snapshot_download; snapshot_download('mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit', local_dir='models/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit')"
```

Com o Base instalado, cada voz usa o WAV em `assets/voice-previews/` como `ref_audio` + transcript como `ref_text` em **todos** os blocos.

## Rodar

```bash
bun install
bun start
```

Isso sobe:

1. O servidor Qwen3 TTS em `http://127.0.0.1:8765`
2. O app AuraReader em `http://0.0.0.0:3000` (após o TTS ficar pronto)

### Scripts úteis

| Comando | Descrição |
|---------|-----------|
| `bun start` | Qwen TTS + app juntos |
| `bun run start:tts` | Só o servidor Qwen TTS |
| `bun run start:app` | Só o app (espera TTS em `TTS_URL`) |

### Variáveis de ambiente

```bash
GEMINI_API_KEY=...
TTS_URL=http://127.0.0.1:8765   # opcional
TTS_PORT=8765                     # opcional
QWEN_TTS_MODEL=Qwen3-TTS-12Hz-0.6B-Base-8bit   # ICL; fallback automático para CustomVoice se Base ausente
QWEN_TTS_VOICE=Vivian             # opcional
QWEN_TTS_LANGUAGE=Auto            # opcional
QWEN_TTS_TEMPERATURE=0.3          # amostragem baixa; identidade vem da âncora ICL
```
