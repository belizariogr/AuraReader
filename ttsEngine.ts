/**
 * Active TTS engine preference (qwen3 | kokoro), persisted under AURA_DATA_DIR.
 */
import fs from "fs";
import path from "path";

export type TtsEngineId = "qwen3" | "kokoro";
/** Kokoro ONNX Runtime target: force CPU, or prefer GPU EP when available. */
export type KokoroDeviceId = "cpu" | "gpu";

const ENGINE_FILE = "tts-engine.json";

type EngineFile = {
  engine?: string;
  kokoroDevice?: string;
  updatedAt?: string;
};

export function isTtsEngineId(value: unknown): value is TtsEngineId {
  return value === "qwen3" || value === "kokoro";
}

export function isKokoroDeviceId(value: unknown): value is KokoroDeviceId {
  return value === "cpu" || value === "gpu";
}

export function ttsEnginePath(auraDataDir: string): string {
  return path.join(auraDataDir, ENGINE_FILE);
}

function readEngineFile(auraDataDir: string): EngineFile {
  const file = ttsEnginePath(auraDataDir);
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, "utf8")) as EngineFile;
    }
  } catch {
    // ignore corrupt file
  }
  return {};
}

function writeEngineFile(auraDataDir: string, patch: EngineFile): void {
  fs.mkdirSync(auraDataDir, { recursive: true });
  const prev = readEngineFile(auraDataDir);
  const next: EngineFile = {
    ...prev,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  if (!isTtsEngineId(next.engine)) next.engine = "qwen3";
  if (!isKokoroDeviceId(next.kokoroDevice)) next.kokoroDevice = "gpu";
  fs.writeFileSync(ttsEnginePath(auraDataDir), JSON.stringify(next, null, 2));
}

export function readTtsEngine(auraDataDir: string): TtsEngineId {
  const raw = readEngineFile(auraDataDir);
  return isTtsEngineId(raw.engine) ? raw.engine : "qwen3";
}

export function writeTtsEngine(auraDataDir: string, engine: TtsEngineId): void {
  writeEngineFile(auraDataDir, { engine });
}

export function readKokoroDevice(auraDataDir: string): KokoroDeviceId {
  const raw = readEngineFile(auraDataDir);
  return isKokoroDeviceId(raw.kokoroDevice) ? raw.kokoroDevice : "gpu";
}

export function writeKokoroDevice(auraDataDir: string, device: KokoroDeviceId): void {
  writeEngineFile(auraDataDir, { kokoroDevice: device });
}

/** Friendly voice catalog for Kokoro (English subset used in the UI). */
export const KOKORO_VOICES = [
  {
    id: "af_heart",
    name: "Heart",
    gender: "Feminino" as const,
    description: "Voz feminina clara e natural (EN).",
    icon: "👩",
  },
  {
    id: "af_sarah",
    name: "Sarah",
    gender: "Feminino" as const,
    description: "Timbre suave para leituras longas.",
    icon: "👩‍🦰",
  },
  {
    id: "af_bella",
    name: "Bella",
    gender: "Feminino" as const,
    description: "Presença expressiva e envolvente.",
    icon: "🧑",
  },
  {
    id: "af_nicole",
    name: "Nicole",
    gender: "Feminino" as const,
    description: "Dicção limpa, boa para diálogos.",
    icon: "👩‍🎤",
  },
  {
    id: "am_adam",
    name: "Adam",
    gender: "Masculino" as const,
    description: "Tom estável para capítulos longos.",
    icon: "👨",
  },
  {
    id: "am_michael",
    name: "Michael",
    gender: "Masculino" as const,
    description: "Narração sólida e pausada.",
    icon: "🧔",
  },
  {
    id: "am_fenrir",
    name: "Fenrir",
    gender: "Masculino" as const,
    description: "Presença mais grave e marcada.",
    icon: "🧑‍💼",
  },
  {
    id: "am_puck",
    name: "Puck",
    gender: "Masculino" as const,
    description: "Tom mais leve e animado.",
    icon: "👨‍🏫",
  },
];

export const QWEN_VOICES = [
  {
    id: "Vivian",
    name: "Vivian",
    gender: "Feminino" as const,
    description: "Narração clara e calorosa — boa para romances e não-ficção.",
    icon: "👩",
  },
  {
    id: "Serena",
    name: "Serena",
    gender: "Feminino" as const,
    description: "Timbre suave, adequada para leituras longas.",
    icon: "👩‍🦰",
  },
  {
    id: "Sohee",
    name: "Sohee",
    gender: "Feminino" as const,
    description: "Voz expressiva e natural.",
    icon: "🧑",
  },
  {
    id: "Ono_Anna",
    name: "Ono Anna",
    gender: "Feminino" as const,
    description: "Dicção limpa, boa para diálogos.",
    icon: "👩‍🎤",
  },
  {
    id: "Ryan",
    name: "Ryan",
    gender: "Masculino" as const,
    description: "Tom sereno e estável para capítulos longos.",
    icon: "👨",
  },
  {
    id: "Aiden",
    name: "Aiden",
    gender: "Masculino" as const,
    description: "Presença mais animada e envolvente.",
    icon: "🧑‍💼",
  },
  {
    id: "Eric",
    name: "Eric",
    gender: "Masculino" as const,
    description: "Dicção formal, boa para textos técnicos.",
    icon: "👨‍🏫",
  },
  {
    id: "Dylan",
    name: "Dylan",
    gender: "Masculino" as const,
    description: "Tom sólido para narrativa geral.",
    icon: "🧔",
  },
  {
    id: "Uncle_Fu",
    name: "Uncle Fu",
    gender: "Masculino" as const,
    description: "Timbre maduro e pausado.",
    icon: "🧓",
  },
];

export function voicesForEngine(engine: TtsEngineId) {
  return engine === "kokoro" ? KOKORO_VOICES : QWEN_VOICES;
}
