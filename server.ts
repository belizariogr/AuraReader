import express from "express";
import path from "path";
import fs from "fs";
import os from "os";
import { spawn, type ChildProcess } from "child_process";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
import { Mp3Encoder } from "./lamejsBridge";
import { PDFDocument } from "pdf-lib";
// @ts-ignore
import { EPub } from "epub2";
import {
  cancelModelDownload,
  deleteModels,
  downloadMissingModels,
  getModelsStatus as getModelsStatusFromManager,
  isModelDownloadActive,
  resolveModelsDir,
} from "./modelManager";
import { detectGpu } from "./gpuDetect";
import { kokoroGpuLibraryPath, probeKokoroAccel } from "./kokoroAccel";
import {
  isTtsEngineId,
  readTtsEngine,
  writeTtsEngine,
  readKokoroDevice,
  writeKokoroDevice,
  isKokoroDeviceId,
  type TtsEngineId,
} from "./ttsEngine";

/** Packaged app root (Resources/aura) or project cwd. */
const AURA_ROOT = process.env.AURA_ROOT
  ? path.resolve(process.env.AURA_ROOT)
  : process.cwd();
/** Writable data (cache, .env) — userData when packaged, else project root. */
const AURA_DATA_DIR = process.env.AURA_DATA_DIR
  ? path.resolve(process.env.AURA_DATA_DIR)
  : AURA_ROOT;

dotenv.config({ path: path.join(AURA_DATA_DIR, ".env") });
dotenv.config({ path: path.join(AURA_ROOT, ".env") });
dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const TTS_URL = process.env.TTS_URL || process.env.DIA_URL || "http://127.0.0.1:8765";
const TTS_PORT =
  process.env.TTS_PORT ||
  process.env.DIA_PORT ||
  (() => {
    try {
      return new URL(TTS_URL).port || "8765";
    } catch {
      return "8765";
    }
  })();
/** Bun idle-timeout for /tts (ms). 0 / unset = disable (Qwen can take a while per chunk). */
const TTS_TIMEOUT_MS = Number(process.env.TTS_TIMEOUT_MS ?? process.env.DIA_TTS_TIMEOUT_MS ?? "0");
/** Stable narrator style applied to every chunk (must match Qwen server default intent). */
const TTS_INSTRUCT =
  process.env.QWEN_TTS_INSTRUCT ||
  "Speak as a consistent, calm, neutral book narrator. Keep the same pitch, energy, emotion, and pace for every sentence. Do not sound excited, dramatic, whispery, or casual.";
/** Low temperature keeps tone stable across chunks; 0 (greedy) truncates some voices. Override with QWEN_TTS_TEMPERATURE. */
const TTS_TEMPERATURE = Number(process.env.QWEN_TTS_TEMPERATURE ?? "0.3");
const TTS_LANGUAGE = process.env.QWEN_TTS_LANGUAGE || "Auto";

let ttsChild: ChildProcess | null = null;
let ttsStartPromise: Promise<void> | null = null;
/** Engine currently bound to ttsChild (if any). */
let ttsRunningEngine: TtsEngineId | null = null;

type TtsAccel = "cuda" | "rocm" | "cpu" | "mlx";

function readTtsAccel(): TtsAccel {
  const metaPath = path.join(AURA_ROOT, "tts-accel.json");
  try {
    if (fs.existsSync(metaPath)) {
      const raw = JSON.parse(fs.readFileSync(metaPath, "utf8")) as { accel?: string };
      const accel = String(raw.accel || "").toLowerCase();
      if (accel === "cuda" || accel === "rocm" || accel === "cpu" || accel === "mlx") {
        return accel;
      }
    }
  } catch {
    // ignore malformed meta
  }
  if (process.platform === "darwin") return "mlx";
  return "cuda";
}

function rocmSpawnEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    MIOPEN_FIND_MODE: process.env.MIOPEN_FIND_MODE ?? "2",
    TORCH_ROCM_AOTRITON_ENABLE_EXPERIMENTAL:
      process.env.TORCH_ROCM_AOTRITON_ENABLE_EXPERIMENTAL ?? "1",
  };

  // Consumer RDNA2 (RX 6000 / Navi 21–23) often needs an override on ROCm.
  if (!process.env.HSA_OVERRIDE_GFX_VERSION) {
    try {
      const gpu = detectGpu(AURA_ROOT);
      const blob = gpu.devices.map((d) => d.name).join(" ").toLowerCase();
      if (
        /navi 2[123]|rx 6[789]\d{2}|rx 6800|rx 6900|rx 6700|rx 6600|gfx1030|gfx1031|gfx1032/.test(
          blob
        )
      ) {
        env.HSA_OVERRIDE_GFX_VERSION = "10.3.0";
      }
    } catch {
      // ignore
    }
  }

  return env;
}

function activeTtsEngine(): TtsEngineId {
  return readTtsEngine(AURA_DATA_DIR);
}

function resolveKokoroLaunch(): {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
} {
  const ttsDir = path.join(AURA_ROOT, "tts", "kokoro");
  const sitePackages = path.join(ttsDir, "site-packages");
  const modelsDir = resolveModelsDir(AURA_ROOT, AURA_DATA_DIR, "kokoro");
  const cacheRoot = path.join(AURA_DATA_DIR, "kokoro-ort-cache");
  const kokoroDevice = readKokoroDevice(AURA_DATA_DIR);
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    // AMD RDNA2 + MIGraphX / ROCm (same overrides as Qwen torch).
    ...(kokoroDevice === "gpu" ? rocmSpawnEnv() : {}),
    QWEN_TTS_PORT: String(TTS_PORT),
    TTS_PORT: String(TTS_PORT),
    QWEN_TTS_PRELOAD: process.env.QWEN_TTS_PRELOAD ?? "0",
    KOKORO_MODEL_DIR: modelsDir,
    KOKORO_DEVICE: kokoroDevice,
    // Persist MIGraphX compile cache across runs (first load can be slow).
    ORT_MIGRAPHX_CACHE_PATH: process.env.ORT_MIGRAPHX_CACHE_PATH || cacheRoot,
    ORT_MIGRAPHX_MODEL_CACHE_PATH:
      process.env.ORT_MIGRAPHX_MODEL_CACHE_PATH || cacheRoot,
  };
  // Force CPU EP when the user picks CPU; otherwise clear overrides so GPU EPs win.
  if (kokoroDevice === "cpu") {
    baseEnv.AURA_ONNX_PROVIDER = "CPUExecutionProvider";
    baseEnv.ONNX_PROVIDER = "CPUExecutionProvider";
  } else {
    delete baseEnv.AURA_ONNX_PROVIDER;
    delete baseEnv.ONNX_PROVIDER;
    // MIGraphX libs live under /opt/rocm/lib — ensure the loader can find them.
    const libPath = kokoroGpuLibraryPath();
    if (libPath) baseEnv.LD_LIBRARY_PATH = libPath;
  }

  const pythonHome =
    process.env.AURA_PYTHON_HOME || path.join(AURA_ROOT, "python");
  const bundledCandidates = [
    path.join(pythonHome, "python.exe"),
    path.join(pythonHome, "bin", "python3.12"),
    path.join(pythonHome, "bin", "python3"),
    path.join(pythonHome, "bin", "python"),
    // mac packaged framework (shared with MLX builds)
    path.join(AURA_ROOT, "python", "Python.framework", "Versions", "3.12", "bin", "python3.12"),
  ];
  const bundledPython = bundledCandidates.find((p) => fs.existsSync(p));
  const venvCandidates = [
    path.join(ttsDir, ".venv", "Scripts", "python.exe"),
    path.join(ttsDir, ".venv", "bin", "python"),
  ];
  const venvPython = venvCandidates.find((p) => fs.existsSync(p));

  if (bundledPython && fs.existsSync(sitePackages)) {
    return {
      command: bundledPython,
      args: ["tts_server.py", "--host", "127.0.0.1", "--port", String(TTS_PORT)],
      cwd: ttsDir,
      env: {
        ...baseEnv,
        PYTHONHOME:
          bundledPython.includes("Python.framework")
            ? path.join(AURA_ROOT, "python", "Python.framework", "Versions", "3.12")
            : pythonHome,
        PYTHONPATH: sitePackages,
        PYTHONNOUSERSITE: "1",
      },
    };
  }

  if (venvPython) {
    return {
      command: venvPython,
      args: ["tts_server.py", "--host", "127.0.0.1", "--port", String(TTS_PORT)],
      cwd: ttsDir,
      env: baseEnv,
    };
  }

  throw new Error(
    `Kokoro TTS runtime não encontrado em ${ttsDir} (site-packages ou .venv).\n` +
      `Configure com: bun run setup:tts:kokoro`
  );
}

function resolveQwenLaunch(): {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
} {
  const previewDir = path.join(AURA_ROOT, "assets", "voice-previews");
  const modelsDir = resolveModelsDir(AURA_ROOT, AURA_DATA_DIR, "qwen3");
  const accel = readTtsAccel();
  const useTorch = process.platform === "win32" || process.platform === "linux";
  const ttsDir = useTorch
    ? path.join(AURA_ROOT, "tts", "torch")
    : path.join(AURA_ROOT, "qwen3-tts-apple-silicon");
  const sitePackages = path.join(ttsDir, "site-packages");

  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    QWEN_TTS_PORT: String(TTS_PORT),
    TTS_PORT: String(TTS_PORT),
    QWEN_TTS_PRELOAD: process.env.QWEN_TTS_PRELOAD ?? "0",
    VOICE_PREVIEW_DIR: previewDir,
    QWEN_TTS_MODELS_DIR: modelsDir,
    ...(accel === "rocm" ? rocmSpawnEnv() : {}),
  };

  if (useTorch) {
    const pythonHome =
      process.env.AURA_PYTHON_HOME || path.join(AURA_ROOT, "python");
    const bundledCandidates = [
      path.join(pythonHome, "python.exe"),
      path.join(pythonHome, "bin", "python3.12"),
      path.join(pythonHome, "bin", "python3"),
      path.join(pythonHome, "bin", "python"),
    ];
    const bundledPython = bundledCandidates.find((p) => fs.existsSync(p));
    const venvCandidates = [
      path.join(ttsDir, ".venv", "Scripts", "python.exe"),
      path.join(ttsDir, ".venv", "bin", "python"),
    ];
    const venvPython = venvCandidates.find((p) => fs.existsSync(p));

    if (bundledPython && fs.existsSync(sitePackages)) {
      return {
        command: bundledPython,
        args: ["tts_server.py", "--host", "127.0.0.1", "--port", String(TTS_PORT)],
        cwd: ttsDir,
        env: {
          ...baseEnv,
          PYTHONHOME: pythonHome,
          PYTHONPATH: sitePackages,
          PYTHONNOUSERSITE: "1",
        },
      };
    }

    if (venvPython) {
      return {
        command: venvPython,
        args: ["tts_server.py", "--host", "127.0.0.1", "--port", String(TTS_PORT)],
        cwd: ttsDir,
        env: baseEnv,
      };
    }

    throw new Error(
      `Qwen TTS (Torch) runtime não encontrado em ${ttsDir} (site-packages ou .venv).\n` +
        `Configure com: bun run setup:tts\n` +
        `(AMD → setup:tts -- --accel=rocm | NVIDIA → --accel=cuda | sem GPU → --accel=cpu). ` +
        `Detalhes: tts/torch/README.md (accel=${accel}).`
    );
  }

  // darwin / MLX
  const pythonHome =
    process.env.AURA_PYTHON_HOME ||
    path.join(AURA_ROOT, "python", "Python.framework", "Versions", "3.12");
  const bundledPython = path.join(pythonHome, "bin", "python3.12");
  const venvPython = path.join(ttsDir, ".venv", "bin", "python");

  if (fs.existsSync(bundledPython) && fs.existsSync(sitePackages)) {
    return {
      command: bundledPython,
      args: ["tts_server.py", "--host", "127.0.0.1", "--port", String(TTS_PORT)],
      cwd: ttsDir,
      env: {
        ...baseEnv,
        PYTHONHOME: pythonHome,
        PYTHONPATH: sitePackages,
        PYTHONNOUSERSITE: "1",
      },
    };
  }

  if (fs.existsSync(venvPython)) {
    return {
      command: venvPython,
      args: ["tts_server.py", "--host", "127.0.0.1", "--port", String(TTS_PORT)],
      cwd: ttsDir,
      env: baseEnv,
    };
  }

  throw new Error(
    `Qwen TTS runtime não encontrado em ${ttsDir} (site-packages ou .venv).`
  );
}

function resolveTtsLaunch(engine: TtsEngineId = activeTtsEngine()): {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  engine: TtsEngineId;
} {
  if (engine === "kokoro") {
    return { ...resolveKokoroLaunch(), engine };
  }
  return { ...resolveQwenLaunch(), engine };
}

function getModelsStatus() {
  return getModelsStatusFromManager(AURA_ROOT, AURA_DATA_DIR);
}

async function isTtsProcessReady(engine?: TtsEngineId): Promise<boolean> {
  const want = engine ?? activeTtsEngine();
  if (ttsRunningEngine && ttsRunningEngine !== want) return false;
  try {
    const ttsRes = await fetch(`${TTS_URL}/health`);
    if (!ttsRes.ok) return false;
    const body = (await ttsRes.json()) as { ready?: boolean; provider?: string };
    if (body.ready === false) return false;
    if (want === "kokoro" && body.provider && body.provider !== "kokoro") return false;
    if (want === "qwen3" && body.provider === "kokoro") return false;
    return true;
  } catch {
    return false;
  }
}

/** Start the active TTS process on first need (preview / narrate). */
async function ensureTtsRunning(timeoutMs = 90_000): Promise<void> {
  const engine = activeTtsEngine();
  if (await isTtsProcessReady(engine)) return;
  if (ttsStartPromise) {
    await ttsStartPromise;
    return;
  }

  ttsStartPromise = (async () => {
    if (await isTtsProcessReady(engine)) return;

    // Wrong engine still listening — stop before respawn.
    if (ttsChild || (await isTtsProcessAlive())) {
      console.log(`[TTS] Restarting for engine=${engine} (was ${ttsRunningEngine || "unknown"})`);
      await unloadTtsModel().catch(() => undefined);
      stopManagedTts();
      await new Promise((r) => setTimeout(r, 400));
    }

    const status = getModelsStatus();
    if (!status.ready) {
      throw new Error(
        "Modelos TTS ainda não foram baixados. Abra a tela de instalação dos modelos."
      );
    }

    const launch = resolveTtsLaunch(engine);
    const label = engine === "kokoro" ? "Kokoro" : "Qwen3";

    if (!ttsChild || ttsChild.killed || ttsChild.exitCode !== null) {
      console.log(`[TTS] Starting ${label} TTS lazily on port ${TTS_PORT}...`);
      ttsRunningEngine = engine;
      ttsChild = spawn(launch.command, launch.args, {
        cwd: launch.cwd,
        env: launch.env,
        stdio: "inherit",
      });
      ttsChild.on("exit", (code, signal) => {
        console.warn(`[TTS] ${label} exited (code=${code}, signal=${signal})`);
        ttsChild = null;
        ttsRunningEngine = null;
      });
    }

    const started = Date.now();
    let lastLog = 0;
    while (Date.now() - started < timeoutMs) {
      if (await isTtsProcessReady(engine)) {
        console.log(`[TTS] ${label} TTS is ready (model loads on first conversion).`);
        return;
      }
      if (Date.now() - lastLog > 5_000) {
        console.log(`[TTS] still waiting for ${label} TTS server...`);
        lastLog = Date.now();
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error(`${label} TTS did not become ready within ${timeoutMs / 1000}s`);
  })().finally(() => {
    ttsStartPromise = null;
  });

  await ttsStartPromise;
}

async function isTtsProcessAlive(): Promise<boolean> {
  try {
    const ttsRes = await fetch(`${TTS_URL}/health`);
    return ttsRes.ok;
  } catch {
    return false;
  }
}

function stopManagedTts() {
  if (ttsChild && !ttsChild.killed) {
    try {
      ttsChild.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
  ttsChild = null;
  ttsRunningEngine = null;
}

process.on("exit", stopManagedTts);
process.once("SIGINT", () => {
  stopManagedTts();
  process.exit(0);
});
process.once("SIGTERM", () => {
  stopManagedTts();
  process.exit(0);
});

// Set up larger limits for base64 file payloads
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// Initialize the Gemini SDK (PDF text extraction only; TTS is handled by Qwen3 locally)
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    }
  }
});

/** Decode HTML named + numeric entities that often leak from PDF/EPUB extraction. */
function decodeHtmlEntities(raw: string): string {
  if (!raw) return "";

  const named: Record<string, string> = {
    nbsp: " ",
    lt: "<",
    gt: ">",
    amp: "&",
    quot: '"',
    apos: "'",
    ldquo: '"',
    rdquo: '"',
    lsquo: "'",
    rsquo: "'",
    ndash: "-",
    mdash: "—",
    hellip: "…",
    bull: "•",
  };

  let text = raw.replace(/&([a-zA-Z]+);/g, (match, name: string) => {
    const key = name.toLowerCase();
    return Object.prototype.hasOwnProperty.call(named, key) ? named[key] : match;
  });

  // Decimal: &#160; Hex: &#xA0; / &#XA0;
  text = text.replace(/&#(\d+);/g, (_, code: string) => {
    const n = Number(code);
    if (n === 160 || n === 0x202f || n === 0x2007) return " "; // nbsp-like
    try {
      return String.fromCodePoint(n);
    } catch {
      return "";
    }
  });

  text = text.replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => {
    const n = parseInt(hex, 16);
    if (n === 0xa0 || n === 0x202f || n === 0x2007) return " ";
    try {
      return String.fromCodePoint(n);
    } catch {
      return "";
    }
  });

  return text;
}

// Helper: Strip HTML tags and decode basic entities to get plain text from EPUB XHTML
function stripHtml(html: string): string {
  if (!html) return "";
  
  // Replace linebreaks and paragraphs
  let text = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<p[^>]*>/gi, "")
    .replace(/<div[^>]*>/gi, "")
    .replace(/<\/div>/gi, "\n")
    .replace(/<h[1-6][^>]*>/gi, "\n\n")
    .replace(/<\/h[1-6]>/gi, "\n\n");
    
  // Strip any other tags
  text = text.replace(/<[^>]*>/g, " ");
  text = decodeHtmlEntities(text);
  
  // Clean up excessive lines and whitespace
  text = text
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .join("\n");
    
  return sanitizeExtractedText(text);
}

/** Remove control chars, markup leftovers, and OCR/LLM junk before TTS and display. */
function sanitizeExtractedText(raw: string): string {
  if (!raw) return "";

  let text = decodeHtmlEntities(raw)
    // Strip Markdown code fences and heading markers often added by LLMs
    .replace(/```[\s\S]*?```/g, (block) =>
      block.replace(/^```[a-zA-Z0-9]*\n?/, "").replace(/\n?```$/, "")
    )
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/(?<!\w)\*(?!\s)(.+?)(?<!\s)\*(?!\w)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    // Common Gemini / PDF artifacts
    .replace(/^\s*\[?\s*Page\s+\d+\s*\]?\s*:?\s*/gim, "")
    .replace(/^\s*P[aá]gina\s+\d+\s*:?\s*/gim, "")
    .replace(/\uFFFD/g, "") // replacement char
    .replace(/[\u200B-\u200D\uFEFF\u00AD]/g, "") // zero-width / soft hyphen
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "") // control chars (keep \t \n)
    .replace(/\t+/g, " ")
    // Collapse odd runs of punctuation / separators from OCR
    .replace(/[|¦]{2,}/g, " ")
    .replace(/_{3,}/g, " ")
    .replace(/-{3,}/g, "—")
    .replace(/[•●▪◦]+/g, "•")
    // Normalize whitespace (incl. real nbsp U+00A0)
    .replace(/[\u00A0\u202F\u2007]/g, " ")
    .replace(/[ ]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n");

  text = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");

  return text.trim();
}

// Helper: Extract Text from EPUB Chapters using local epub2 library
async function extractTextFromEpub(filePath: string, startChapter: number, endChapter: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const epub = new EPub(filePath);
    
    epub.on("end", async () => {
      try {
        const flow = epub.flow;
        if (!flow || flow.length === 0) {
          reject(new Error("O arquivo EPUB não possui capítulos ou seções legíveis."));
          return;
        }

        const startIdx = Math.max(0, startChapter - 1);
        const endIdx = Math.min(flow.length - 1, endChapter - 1);

        if (startIdx >= flow.length) {
          reject(new Error(`O EPUB possui apenas ${flow.length} seções/capítulos, mas a seção inicial solicitada foi ${startChapter}.`));
          return;
        }
        if (endIdx < startIdx) {
          reject(new Error("Intervalo de seções/capítulos inválido."));
          return;
        }

        let fullText = "";
        
        for (let i = startIdx; i <= endIdx; i++) {
          const chapter = flow[i];
          const text = await new Promise<string>((resChan) => {
            epub.getChapter(chapter.id, (err, text) => {
              if (err) {
                console.warn(`[Epub] Error reading chapter ${chapter.id}:`, err);
                resChan("");
              } else {
                resChan(text || "");
              }
            });
          });

          if (text) {
            const chapterText = stripHtml(text);
            if (chapterText) {
              fullText += (fullText ? "\n\n" : "") + chapterText;
            }
          }
        }

        resolve(fullText.trim());
      } catch (err) {
        reject(err);
      }
    });

    epub.on("error", (err) => {
      reject(err);
    });

    epub.parse();
  });
}

type EpubChapterInfo = { index: number; id: string; title: string };

async function getEpubOutline(filePath: string): Promise<EpubChapterInfo[]> {
  return new Promise((resolve, reject) => {
    const epub = new EPub(filePath);
    epub.on("end", () => {
      try {
        const flow = epub.flow || [];
        const chapters = flow.map((chapter: { id?: string; title?: string }, i: number) => ({
          index: i + 1,
          id: chapter.id || String(i),
          title: (chapter.title || "").trim() || `Seção ${i + 1}`,
        }));
        resolve(chapters);
      } catch (err) {
        reject(err);
      }
    });
    epub.on("error", reject);
    epub.parse();
  });
}

/**
 * Synthesize speech via the local Qwen3-TTS HTTP server.
 * Returns PCM s16le samples and sample rate.
 *
 * Pass refAudioPath + refText to lock speaker identity via ICL (Base model).
 * Pass skipIcl when generating the enrollment/preview sample itself.
 *
 * Note: Bun's fetch has a ~5min idle timeout by default. Qwen sends no bytes until
 * generation finishes, so we must disable/extend that timeout or the client
 * aborts while TTS keeps running.
 */
async function synthesizeWithTts(
  text: string,
  voice: string,
  jobId?: string,
  signal?: AbortSignal,
  opts?: {
    refAudioPath?: string;
    refText?: string;
    skipIcl?: boolean;
  }
): Promise<{ pcm: Buffer; sampleRate: number; cancelled: boolean; icl?: boolean }> {
  if (signal?.aborted) {
    return { pcm: Buffer.alloc(0), sampleRate: 24000, cancelled: true };
  }

  await ensureTtsRunning();

  const fetchOptions: RequestInit & { timeout?: boolean | number | { connect?: number | false; idle?: number | false } } = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      voice,
      jobId,
      instruct: TTS_INSTRUCT,
      temperature: TTS_TEMPERATURE,
      language: TTS_LANGUAGE,
      ...(opts?.refAudioPath && opts?.refText
        ? { refAudioPath: opts.refAudioPath, refText: opts.refText }
        : {}),
      ...(opts?.skipIcl ? { skipIcl: true } : {}),
    }),
    signal,
    timeout: TTS_TIMEOUT_MS > 0
      ? { connect: 30_000, idle: TTS_TIMEOUT_MS }
      : false,
  };

  let res: Response;
  try {
    res = await fetch(`${TTS_URL}/tts`, fetchOptions);
  } catch (err: any) {
    if (signal?.aborted || err?.name === "AbortError") {
      return { pcm: Buffer.alloc(0), sampleRate: 24000, cancelled: true };
    }
    if (jobId) {
      await cancelTtsJob(jobId);
    }
    const msg = err?.message || String(err);
    throw new Error(msg.includes("timed out") || err?.name === "TimeoutError"
      ? `Qwen TTS timed out waiting for generation (${msg}). Increase TTS_TIMEOUT_MS or leave it unset to disable.`
      : msg);
  }

  if (!res.ok) {
    let detail = `Qwen TTS HTTP ${res.status}`;
    try {
      const errBody = await res.json();
      detail = errBody.detail || errBody.error || detail;
    } catch {
      // ignore parse errors
    }
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }

  const body = (await res.json()) as {
    sampleRate: number;
    audioData: string;
    format: string;
    cancelled?: boolean;
    icl?: boolean;
    voice?: string;
  };

  const cancelled = !!body.cancelled;
  if (body.voice && body.voice.toLowerCase() !== voice.toLowerCase().replace(/\s+/g, "_")) {
    console.warn(
      `[TTS] Voice mismatch: requested=${voice} resolved=${body.voice}`
    );
  }
  if (!body.audioData) {
    return {
      pcm: Buffer.alloc(0),
      sampleRate: body.sampleRate || 24000,
      cancelled,
      icl: !!body.icl,
    };
  }

  return {
    pcm: Buffer.from(body.audioData, "base64"),
    sampleRate: body.sampleRate || 24000,
    cancelled,
    icl: !!body.icl,
  };
}

async function cancelTtsJob(jobId: string): Promise<void> {
  try {
    const res = await fetch(`${TTS_URL}/tts/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId }),
    });
    if (!res.ok) {
      console.warn(`[NarrateStop] TTS cancel HTTP ${res.status} for job ${jobId}`);
      return;
    }
    const body = (await res.json()) as { success?: boolean; message?: string };
    console.log(`[NarrateStop] TTS cancel response:`, body);
  } catch (err) {
    console.warn(`[NarrateStop] Failed to cancel TTS job ${jobId}:`, err);
  }
}

/** Release TTS weights from memory (no-op if TTS is not running). */
async function unloadTtsModel(): Promise<void> {
  if (!(await isTtsProcessAlive())) return;
  try {
    const res = await fetch(`${TTS_URL}/tts/unload`, { method: "POST" });
    if (!res.ok) {
      console.warn(`[TTS] unload HTTP ${res.status}`);
      return;
    }
    const body = (await res.json()) as { unloaded?: boolean };
    console.log(`[TTS] Model unload:`, body);
  } catch (err: any) {
    const msg = err?.message || String(err);
    if (/ConnectionRefused|ECONNREFUSED|Unable to connect/i.test(msg)) return;
    console.warn(`[TTS] Failed to unload model:`, err);
  }
}

function parsePageRange(startPage: unknown, endPage: unknown): { start: number; end: number } {
  const start = Math.max(1, parseInt(String(startPage ?? "1"), 10) || 1);
  let end = start; // default: only the start page/section (not “to end of document”)

  if (endPage !== null && endPage !== undefined && String(endPage).trim() !== "") {
    end = parseInt(String(endPage), 10);
    if (!Number.isFinite(end) || end < 1) {
      throw new Error("A página/seção final é inválida.");
    }
    if (end < start) {
      throw new Error(`A página/seção final (${end}) não pode ser menor que a inicial (${start}).`);
    }
  }
  return { start, end };
}

/** Physically slice PDF to the requested 1-indexed page range so Gemini cannot leave the bounds. */
async function slicePdfToPageRange(
  base64Data: string,
  start: number,
  end: number
): Promise<{ base64: string; actualStart: number; actualEnd: number; totalPages: number }> {
  const src = await PDFDocument.load(Buffer.from(base64Data, "base64"), {
    ignoreEncryption: true,
  });
  const totalPages = src.getPageCount();
  if (totalPages < 1) {
    throw new Error("O PDF não possui páginas legíveis.");
  }

  const startIdx = start - 1;
  if (startIdx >= totalPages) {
    throw new Error(
      `O PDF possui apenas ${totalPages} página(s), mas a página inicial solicitada foi ${start}.`
    );
  }

  const endIdx = Math.min(end - 1, totalPages - 1);
  if (end > totalPages) {
    console.warn(
      `[PDF Slice] Requested end page ${end} exceeds document (${totalPages}); clamping to ${totalPages}.`
    );
  }
  if (endIdx < startIdx) {
    throw new Error("Intervalo de páginas inválido após o ajuste ao tamanho do PDF.");
  }

  const out = await PDFDocument.create();
  const indices: number[] = [];
  for (let i = startIdx; i <= endIdx; i++) indices.push(i);
  const copied = await out.copyPages(src, indices);
  copied.forEach((page) => out.addPage(page));

  const bytes = await out.save();
  return {
    base64: Buffer.from(bytes).toString("base64"),
    actualStart: startIdx + 1,
    actualEnd: endIdx + 1,
    totalPages,
  };
}

async function extractTextFromPdfWithGemini(
  pdfBase64: string,
  actualStart: number,
  actualEnd: number
): Promise<string> {
  const pageCount = actualEnd - actualStart + 1;
  const extractionPrompt = `This PDF contains EXACTLY ${pageCount} page(s). These pages correspond to original document pages ${actualStart} through ${actualEnd} (inclusive).

Extract and return ONLY the plain textual content of ALL pages in this PDF, in reading order.

Important rules:
- Return ONLY the exact textual content. No introductions, explanations, page numbers, headers like "Page N", or metadata.
- Cover every page in this file from first to last — do not skip pages and do not invent content beyond them.
- If there is no readable text, return exactly 'NO_CONTENT'.
- Keep paragraphs well structured.`;

  const extractionResponse = await ai.models.generateContent({
    model: "gemini-3.5-flash",
    contents: [
      {
        inlineData: {
          data: pdfBase64,
          mimeType: "application/pdf",
        },
      },
      extractionPrompt,
    ],
  });

  return extractionResponse.text ? extractionResponse.text.trim() : "";
}

async function extractDocumentText(options: {
  fileData: string;
  fileType: "pdf" | "epub";
  start: number;
  end: number;
}): Promise<{ extractedText: string; pagesNarrated: string; actualStart: number; actualEnd: number }> {
  const { fileData, fileType, start, end } = options;

  if (fileType === "pdf") {
    const sliced = await slicePdfToPageRange(fileData, start, end);
    let extractedText = await extractTextFromPdfWithGemini(
      sliced.base64,
      sliced.actualStart,
      sliced.actualEnd
    );
    extractedText = sanitizeExtractedText(extractedText);

    if (!extractedText || extractedText === "NO_CONTENT") {
      throw new Error(
        "Não foi possível extrair texto das páginas selecionadas ou o PDF não possui conteúdo legível nesse intervalo."
      );
    }

    const pagesNarrated =
      sliced.actualStart === sliced.actualEnd
        ? `Página ${sliced.actualStart}`
        : `Páginas ${sliced.actualStart} - ${sliced.actualEnd}`;

    return {
      extractedText,
      pagesNarrated,
      actualStart: sliced.actualStart,
      actualEnd: sliced.actualEnd,
    };
  }

  // EPUB
  const tmpDir = os.tmpdir();
  const tempPath = path.join(
    tmpDir,
    `temp_epub_${Date.now()}_${Math.random().toString(36).substring(7)}.epub`
  );
  try {
    await fs.promises.writeFile(tempPath, Buffer.from(fileData, "base64"));
    let extractedText = await extractTextFromEpub(tempPath, start, end);
    extractedText = sanitizeExtractedText(extractedText);
    if (!extractedText) {
      throw new Error(
        "O EPUB não possui conteúdo legível nas seções/capítulos selecionados."
      );
    }
    const pagesNarrated =
      start === end
        ? `Capítulo/Seção ${start}`
        : `Capítulos/Seções ${start} - ${end}`;
    return {
      extractedText,
      pagesNarrated,
      actualStart: start,
      actualEnd: end,
    };
  } finally {
    await fs.promises.unlink(tempPath).catch(() => {});
  }
}

// Helper: Split text into natural chunks of maximum character count (approx. natural sentence/paragraph bounds)
// Qwen lite works well with moderate length (~5–20s of speech ≈ 120–280 chars).
function splitTextIntoChunks(text: string, maxChunkLength = 240): string[] {
  const paragraphs = text.split(/\n+/);
  const chunks: string[] = [];
  let currentChunk = "";

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    if ((currentChunk + "\n" + trimmed).length <= maxChunkLength) {
      currentChunk = currentChunk ? (currentChunk + "\n" + trimmed) : trimmed;
    } else {
      if (currentChunk) {
        chunks.push(currentChunk);
      }
      
      if (trimmed.length > maxChunkLength) {
        // Split by sentence boundaries
        const sentences = trimmed.match(/[^.!?]+[.!?]+(\s|$)/g) || [trimmed];
        currentChunk = "";
        for (const sentence of sentences) {
          const sTrimmed = sentence.trim();
          if (!sTrimmed) continue;
          if ((currentChunk + " " + sTrimmed).length <= maxChunkLength) {
            currentChunk = currentChunk ? (currentChunk + " " + sTrimmed) : sTrimmed;
          } else {
            if (currentChunk) chunks.push(currentChunk);
            if (sTrimmed.length > maxChunkLength) {
              // Hard-split oversized sentences by words
              const words = sTrimmed.split(/\s+/);
              currentChunk = "";
              for (const word of words) {
                if ((currentChunk + " " + word).trim().length <= maxChunkLength) {
                  currentChunk = currentChunk ? `${currentChunk} ${word}` : word;
                } else {
                  if (currentChunk) chunks.push(currentChunk);
                  currentChunk = word;
                }
              }
            } else {
              currentChunk = sTrimmed;
            }
          }
        }
      } else {
        currentChunk = trimmed;
      }
    }
  }
  if (currentChunk) {
    chunks.push(currentChunk);
  }
  return chunks;
}

// Helper: Convert PCM samples to MP3 using lamejs
function encodePcmToMp3(samples: Int16Array, sampleRate = 24000, kbps = 128): Buffer {
  const mp3encoder = new Mp3Encoder(1, sampleRate, kbps);
  const mp3Data: Buffer[] = [];
  
  const sampleBlockSize = 1152;
  for (let i = 0; i < samples.length; i += sampleBlockSize) {
    const sampleChunk = samples.subarray(i, i + sampleBlockSize);
    const mp3buf = mp3encoder.encodeBuffer(sampleChunk);
    if (mp3buf.length > 0) {
      mp3Data.push(Buffer.from(mp3buf));
    }
  }
  
  const mp3buf = mp3encoder.flush();
  if (mp3buf.length > 0) {
    mp3Data.push(Buffer.from(mp3buf));
  }
  
  return Buffer.concat(mp3Data);
}

const VOICE_PREVIEW_TEXT =
  process.env.QWEN_TTS_PREVIEW_TEXT ||
  "Hello. This is a preview of my voice, reading in a calm and clear tone.";
/** Bump when preview text or TTS settings change so old disk samples are ignored. */
const VOICE_PREVIEW_CACHE_VERSION = process.env.QWEN_TTS_PREVIEW_CACHE_VERSION || "en-v2";
/** WAV + transcript used as voice-reference (ref_audio / ref_text for ICL). */
const VOICE_PREVIEW_DIR = path.join(AURA_ROOT, "assets", "voice-previews");
/** In-memory WAV previews (base64) layered on disk cache. */
const voicePreviewCache = new Map<string, string>();

function voicePreviewSafeKey(voiceKey: string): string {
  return voiceKey.replace(/[^a-z0-9_-]/gi, "_").toLowerCase();
}

function voicePreviewWavPath(voiceKey: string): string {
  const safe = voicePreviewSafeKey(voiceKey);
  return path.join(VOICE_PREVIEW_DIR, `${safe}_${VOICE_PREVIEW_CACHE_VERSION}.wav`);
}

function voicePreviewTextPath(voiceKey: string): string {
  const safe = voicePreviewSafeKey(voiceKey);
  return path.join(VOICE_PREVIEW_DIR, `${safe}_${VOICE_PREVIEW_CACHE_VERSION}.txt`);
}

/** Drop trailing near-silence so truncated/greedy generations don't pad the preview. */
function trimTrailingSilence(samples: Int16Array, sampleRate = 24000): Int16Array {
  const threshold = 200;
  const padSamples = Math.floor(sampleRate * 0.12); // keep a short natural tail
  let last = samples.length - 1;
  while (last > 0 && Math.abs(samples[last]) <= threshold) last--;
  const end = Math.min(samples.length, last + 1 + padSamples);
  if (end >= samples.length) return samples;
  if (end < sampleRate * 0.4) return samples; // don't trim near-empty clips
  return samples.subarray(0, end);
}

/** Encode mono PCM s16le as a WAV (usable as Qwen ICL ref_audio). */
function encodePcmToWav(samples: Int16Array, sampleRate = 24000): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16); // PCM fmt chunk size
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  buffer.set(new Uint8Array(samples.buffer, samples.byteOffset, dataSize), 44);
  return buffer;
}

async function loadVoicePreviewFromDisk(voiceKey: string): Promise<string | null> {
  const filePath = voicePreviewWavPath(voiceKey);
  try {
    const buf = await fs.promises.readFile(filePath);
    if (buf.length > 0) return buf.toString("base64");
  } catch {
    // miss
  }
  return null;
}

async function saveVoicePreviewToDisk(
  voiceKey: string,
  wav: Buffer,
  transcript: string
): Promise<void> {
  await fs.promises.mkdir(VOICE_PREVIEW_DIR, { recursive: true });
  await fs.promises.writeFile(voicePreviewWavPath(voiceKey), wav);
  // Transcript must match the WAV for ICL voice reference (ref_text).
  await fs.promises.writeFile(voicePreviewTextPath(voiceKey), `${transcript.trim()}\n`, "utf8");
}

/**
 * Ensure a disk WAV+TXT voice anchor exists for ICL narration.
 * Reuses assets/voice-previews; synthesizes once with skipIcl if missing.
 */
async function ensureVoicePreview(
  voiceName: string
): Promise<{ refAudioPath: string; refText: string; created: boolean }> {
  const cacheKey = voiceName.toLowerCase();
  const wavPath = voicePreviewWavPath(cacheKey);
  const txtPath = voicePreviewTextPath(cacheKey);

  try {
    await fs.promises.access(wavPath, fs.constants.R_OK);
    await fs.promises.access(txtPath, fs.constants.R_OK);
    const fromDisk = (await fs.promises.readFile(txtPath, "utf8")).trim();
    const refText = fromDisk || VOICE_PREVIEW_TEXT;
    const wavBuf = await fs.promises.readFile(wavPath);
    if (wavBuf.length > 0) {
      voicePreviewCache.set(cacheKey, wavBuf.toString("base64"));
      return { refAudioPath: wavPath, refText, created: false };
    }
  } catch {
    // miss — generate below
  }

  console.log(`[VoicePreview] Generating ICL anchor for ${voiceName}...`);
  const { pcm, sampleRate, cancelled } = await synthesizeWithTts(
    VOICE_PREVIEW_TEXT,
    voiceName,
    undefined,
    undefined,
    { skipIcl: true }
  );
  if (cancelled || pcm.length === 0) {
    throw new Error(
      `Não foi possível gerar a âncora de voz para "${voiceName}". ` +
        "Toque a prévia na UI ou verifique o servidor Qwen TTS."
    );
  }

  const samples = trimTrailingSilence(
    new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2)),
    sampleRate
  );
  const wavBuffer = encodePcmToWav(samples, sampleRate);
  voicePreviewCache.set(cacheKey, wavBuffer.toString("base64"));
  await saveVoicePreviewToDisk(cacheKey, wavBuffer, VOICE_PREVIEW_TEXT);
  console.log(`[VoicePreview] Saved ICL anchor: ${wavPath}`);
  return {
    refAudioPath: wavPath,
    refText: VOICE_PREVIEW_TEXT,
    created: true,
  };
}

// Short sample of a narrator voice (WAV base64 + disk WAV/TXT for voice reference)
app.post("/api/voice-preview", async (req, res) => {
  let didGenerate = false;
  try {
    const engine = activeTtsEngine();
    const voiceName =
      String(req.body?.voiceName || "").trim() ||
      (engine === "kokoro" ? "af_heart" : "Vivian");

    // Kokoro: synthesize a short clip on the fly (no ICL disk anchor).
    if (engine === "kokoro") {
      const { pcm, sampleRate } = await synthesizeWithTts(
        VOICE_PREVIEW_TEXT,
        voiceName,
        undefined,
        undefined,
        { skipIcl: true }
      );
      didGenerate = true;
      if (pcm.length === 0) {
        throw new Error("Prévia Kokoro vazia.");
      }
      const samples = new Int16Array(
        pcm.buffer,
        pcm.byteOffset,
        Math.floor(pcm.byteLength / 2)
      );
      const wavBuffer = encodePcmToWav(samples, sampleRate);
      return res.json({
        audioData: wavBuffer.toString("base64"),
        mimeType: "audio/wav",
        voiceName,
        cached: false,
        source: "generated",
        engine,
      });
    }

    const cacheKey = voiceName.toLowerCase();

    const memCached = voicePreviewCache.get(cacheKey);
    if (memCached) {
      return res.json({
        audioData: memCached,
        mimeType: "audio/wav",
        voiceName,
        cached: true,
        source: "memory",
        filePath: voicePreviewWavPath(cacheKey),
        textPath: voicePreviewTextPath(cacheKey),
        engine,
      });
    }

    const diskCached = await loadVoicePreviewFromDisk(cacheKey);
    if (diskCached) {
      voicePreviewCache.set(cacheKey, diskCached);
      return res.json({
        audioData: diskCached,
        mimeType: "audio/wav",
        voiceName,
        cached: true,
        source: "disk",
        filePath: voicePreviewWavPath(cacheKey),
        textPath: voicePreviewTextPath(cacheKey),
        engine,
      });
    }

    const anchor = await ensureVoicePreview(voiceName);
    didGenerate = anchor.created;
    const audioData =
      voicePreviewCache.get(cacheKey) ||
      (await fs.promises.readFile(anchor.refAudioPath)).toString("base64");
    voicePreviewCache.set(cacheKey, audioData);

    return res.json({
      audioData,
      mimeType: "audio/wav",
      voiceName,
      cached: false,
      source: "generated",
      filePath: anchor.refAudioPath,
      textPath: voicePreviewTextPath(cacheKey),
      engine,
    });
  } catch (err: any) {
    console.error("[VoicePreview]", err?.message || err);
    didGenerate = true;
    return res.status(500).json({
      error: err?.message || "Falha ao gerar prévia de voz.",
    });
  } finally {
    if (didGenerate) {
      await unloadTtsModel();
    }
  }
});

// Active TTS engine (qwen3 | kokoro)
app.get("/api/tts-engine", (_req, res) => {
  try {
    const status = getModelsStatus();
    res.json({
      engine: status.engine,
      engines: status.engines,
      voices: status.voices,
      ready: status.ready,
      kokoroDevice: status.kokoroDevice,
      kokoroAccel: status.kokoroAccel,
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

app.post("/api/tts-engine", async (req, res) => {
  try {
    const nextEngine = req.body?.engine;
    const nextDevice = req.body?.kokoroDevice;
    const hasEngine = nextEngine !== undefined && nextEngine !== null;
    const hasDevice = nextDevice !== undefined && nextDevice !== null;

    if (hasEngine && !isTtsEngineId(nextEngine)) {
      return res.status(400).json({ error: 'engine must be "qwen3" or "kokoro"' });
    }
    if (hasDevice && !isKokoroDeviceId(nextDevice)) {
      return res.status(400).json({ error: 'kokoroDevice must be "cpu" or "gpu"' });
    }
    if (!hasEngine && !hasDevice) {
      return res.status(400).json({
        error: 'Provide "engine" and/or "kokoroDevice"',
      });
    }

    const prevEngine = activeTtsEngine();
    const prevDevice = readKokoroDevice(AURA_DATA_DIR);

    if (hasEngine) writeTtsEngine(AURA_DATA_DIR, nextEngine);
    if (hasDevice) writeKokoroDevice(AURA_DATA_DIR, nextDevice);

    const engineChanged = hasEngine && prevEngine !== nextEngine;
    const deviceChanged = hasDevice && prevDevice !== nextDevice;
    // Restart TTS if engine changed, or Kokoro device changed while Kokoro is active.
    const needRestart =
      engineChanged ||
      (deviceChanged && (hasEngine ? nextEngine === "kokoro" : prevEngine === "kokoro"));

    if (needRestart) {
      await unloadTtsModel().catch(() => undefined);
      stopManagedTts();
    }

    const status = getModelsStatus();
    res.json({
      engine: status.engine,
      engines: status.engines,
      voices: status.voices,
      ready: status.ready,
      kokoroDevice: status.kokoroDevice,
      kokoroAccel: status.kokoroAccel,
      restarted: needRestart,
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// TTS model install status (Base + CustomVoice)
app.get("/api/models/status", (_req, res) => {
  try {
    res.json(getModelsStatus());
  } catch (err: any) {
    res.status(500).json({ ready: false, error: err?.message || String(err) });
  }
});

// Download missing models; streams NDJSON progress events (TS/fetch, not Python)
app.post("/api/models/download", async (req, res) => {
  if (isModelDownloadActive()) {
    res.status(409).json({ error: "Download já em andamento." });
    return;
  }

  const status = getModelsStatus();
  if (status.ready) {
    res.json({ ready: true, skipped: true, modelsDir: status.modelsDir });
    return;
  }

  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  if (typeof (res as any).flushHeaders === "function") {
    (res as any).flushHeaders();
  }

  const writeEvent = (payload: Record<string, unknown>) => {
    if (!res.writableEnded) {
      res.write(`${JSON.stringify(payload)}\n`);
    }
  };

  try {
    await downloadMissingModels({
      auraRoot: AURA_ROOT,
      auraDataDir: AURA_DATA_DIR,
      onEvent: writeEvent,
    });
  } catch (err: any) {
    if (!res.writableEnded) {
      writeEvent({
        type: "error",
        message: err?.message || String(err),
        ready: getModelsStatus().ready,
      });
    }
  } finally {
    if (!res.writableEnded) res.end();
  }
});

app.post("/api/models/download/cancel", (_req, res) => {
  const cancelled = cancelModelDownload();
  res.json({
    success: cancelled,
    message: cancelled ? "Cancelamento solicitado." : "Nenhum download em andamento.",
  });
});

app.delete("/api/models", async (req, res) => {
  try {
    if (isModelDownloadActive()) {
      return res.status(409).json({ error: "Cancele o download antes de excluir modelos." });
    }
    // Free GPU/RAM if TTS was using the weights
    stopManagedTts();
    await unloadTtsModel().catch(() => undefined);

    const idsRaw = req.query.id;
    const ids = Array.isArray(idsRaw)
      ? idsRaw.map(String)
      : typeof idsRaw === "string" && idsRaw.length
        ? idsRaw.split(",").map((s) => s.trim()).filter(Boolean)
        : undefined;

    const result = deleteModels(AURA_ROOT, AURA_DATA_DIR, ids);
    res.json({
      success: true,
      ...result,
      status: getModelsStatus(),
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// Health Check API
app.get("/api/health", async (req, res) => {
  let ttsReady = false;
  let modelLoaded = false;
  const models = getModelsStatus();
  try {
    const ttsRes = await fetch(`${TTS_URL}/health`);
    if (ttsRes.ok) {
      const body = (await ttsRes.json()) as { ready?: boolean; modelLoaded?: boolean };
      ttsReady = body.ready !== false;
      modelLoaded = !!body.modelLoaded;
    }
  } catch {
    ttsReady = false;
    modelLoaded = false;
  }
  res.json({
    status: "ok",
    time: new Date().toISOString(),
    models,
    tts: {
      provider: models.engine === "kokoro" ? "kokoro" : "qwen3-tts",
      backend: models.backend,
      engine: models.engine,
      url: TTS_URL,
      ready: ttsReady,
      modelLoaded,
    },
  });
});

// Active generation tasks map for cancellation/stop support
const activeTasks = new Map<string, { stopped: boolean; abort: AbortController }>();

// API to stop an active narration stream and wrap up the processed audio so far
app.post("/api/narrate-stop", async (req, res) => {
  const { taskId } = req.body;
  console.log(`[NarrateStop] Request received to stop task: ${taskId}`);
  
  if (taskId && activeTasks.has(taskId)) {
    const task = activeTasks.get(taskId);
    if (task) {
      task.stopped = true;
      // Abort in-flight /tts fetch so the stream moves to encoding immediately
      if (!task.abort.signal.aborted) {
        task.abort.abort();
      }
      console.log(`[NarrateStop] Task ${taskId} marked as stopped and aborted.`);
      // Best-effort interrupt on TTS server (may finish current generate silently).
      // Model unload happens in narrate-stream finally / after cancelled /tts returns.
      void cancelTtsJob(taskId);
      return res.json({ success: true, message: "Narração interrompida com sucesso. Gerando áudio até o momento..." });
    }
  }
  
  res.status(404).json({ error: "Tarefa de narração ativa não encontrada ou já concluída." });
});

// Document metadata: PDF page count or EPUB chapter outline
app.post("/api/document-info", async (req, res) => {
  let tempPath: string | null = null;
  try {
    const { fileData, pdfData, fileType } = req.body;
    const activeData = fileData || pdfData;
    const type = (fileType || "pdf") as "pdf" | "epub";

    if (!activeData) {
      return res.status(400).json({ error: "O conteúdo do arquivo é obrigatório." });
    }

    if (type === "pdf") {
      const src = await PDFDocument.load(Buffer.from(activeData, "base64"), {
        ignoreEncryption: true,
      });
      const pageCount = src.getPageCount();
      return res.json({
        fileType: "pdf",
        pageCount,
        message: `PDF com ${pageCount} página(s) no arquivo (numeração do leitor PDF, não rótulos impressos).`,
      });
    }

    const tmpDir = os.tmpdir();
    tempPath = path.join(
      tmpDir,
      `temp_epub_info_${Date.now()}_${Math.random().toString(36).substring(7)}.epub`
    );
    await fs.promises.writeFile(tempPath, Buffer.from(activeData, "base64"));
    const chapters = await getEpubOutline(tempPath);
    await fs.promises.unlink(tempPath).catch(() => {});
    tempPath = null;

    return res.json({
      fileType: "epub",
      chapterCount: chapters.length,
      chapters,
      message:
        "EPUB não tem páginas fixas como PDF. Os números abaixo são capítulos/seções da estrutura do livro.",
    });
  } catch (err: any) {
    console.error("[DocumentInfo Error]", err);
    if (tempPath) await fs.promises.unlink(tempPath).catch(() => {});
    res.status(400).json({ error: err.message || "Erro ao ler o documento." });
  }
});

// Extract text only (PDF/EPUB) — used for editable preview before TTS
app.post("/api/extract", async (req, res) => {
  try {
    const { fileData, pdfData, fileType, startPage, endPage } = req.body;
    const activeData = fileData || pdfData;
    const type = (fileType || "pdf") as "pdf" | "epub";

    if (!activeData) {
      return res.status(400).json({ error: "O conteúdo do arquivo é obrigatório." });
    }

    const { start, end } = parsePageRange(startPage, endPage);
    console.log(`[Extract] Type: ${type}, Start: ${start}, End: ${end}`);

    const result = await extractDocumentText({
      fileData: activeData,
      fileType: type,
      start,
      end,
    });

    res.json(result);
  } catch (err: any) {
    console.error("[Extract Error]", err);
    res.status(400).json({ error: err.message || "Erro ao extrair texto do documento." });
  }
});

// PDF/EPUB Extraction and TTS with Stream Progress SSE API
// Accepts either `text` (skip extraction) or fileData for legacy one-shot flow.
app.post("/api/narrate-stream", async (req, res) => {
  // Set headers for SSE stream
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  
  const sendEvent = (data: any) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  let tempPath: string | null = null;
  let taskId: string | undefined = undefined;

  try {
    const {
      pdfData,
      fileData,
      fileType,
      startPage,
      endPage,
      voiceName,
      taskId: reqTaskId,
      text: providedText,
      pagesNarrated: providedPagesLabel,
    } = req.body;
    taskId = reqTaskId;
    
    if (taskId) {
      activeTasks.set(taskId, { stopped: false, abort: new AbortController() });
    }
    
    const activeData = fileData || pdfData;
    const type = (fileType || "pdf") as "pdf" | "epub";
    const voice = voiceName || "Vivian";

    let start = 1;
    let end = 1;
    try {
      ({ start, end } = parsePageRange(startPage, endPage));
    } catch (rangeErr: any) {
      if (!providedText) {
        sendEvent({ type: "error", error: rangeErr.message });
        return res.end();
      }
    }

    console.log(
      `[NarrateStream] textProvided=${!!providedText}, Type: ${type}, Start: ${start}, End: ${end}, Voice: ${voice}`
    );

    let extractedText = "";
    let pagesLabel =
      providedPagesLabel ||
      (type === "pdf"
        ? start === end
          ? `Página ${start}`
          : `Páginas ${start} - ${end}`
        : start === end
          ? `Capítulo/Seção ${start}`
          : `Capítulos/Seções ${start} - ${end}`);

    if (typeof providedText === "string" && providedText.trim()) {
      sendEvent({
        type: "status",
        step: "pre_tts",
        message: "Preparando texto editado para narração...",
      });
      extractedText = sanitizeExtractedText(providedText);
      if (!extractedText) {
        sendEvent({ type: "error", error: "O texto para narração está vazio." });
        return res.end();
      }
      sendEvent({
        type: "status",
        step: "pre_tts",
        message: "Texto pronto. Dividindo o conteúdo para narração...",
        extractedText,
      });
    } else {
      if (!activeData) {
        sendEvent({ type: "error", error: "O conteúdo do arquivo é obrigatório." });
        return res.end();
      }

      sendEvent({
        type: "status",
        step: "init",
        message:
          type === "pdf"
            ? "Iniciando leitura e preparando o PDF..."
            : "Iniciando leitura e preparando o EPUB...",
      });

      sendEvent({
        type: "status",
        step: "extraction",
        message:
          type === "pdf"
            ? `Extraindo texto das páginas ${start}${start === end ? "" : ` a ${end}`}...`
            : `Extraindo texto do EPUB a partir da seção/capítulo ${start}...`,
      });

      try {
        const result = await extractDocumentText({
          fileData: activeData,
          fileType: type,
          start,
          end,
        });
        extractedText = result.extractedText;
        pagesLabel = result.pagesNarrated;
      } catch (extractErr: any) {
        sendEvent({ type: "error", error: extractErr.message || "Falha na extração." });
        return res.end();
      }

      sendEvent({
        type: "status",
        step: "pre_tts",
        message: "Texto extraído com sucesso! Dividindo o conteúdo para narração...",
        extractedText,
      });
    }

    // Split extracted text into logical chunks (Qwen prefers moderate-length prompts)
    const textChunks = splitTextIntoChunks(extractedText, 240);
    const totalChunks = textChunks.length;

    if (totalChunks === 0) {
      sendEvent({ type: "error", error: "O texto extraído do documento está vazio." });
      return res.end();
    }

    sendEvent({ 
      type: "status", 
      step: "chunks", 
      message: `Conteúdo dividido em ${totalChunks} partes para processamento.`,
      current: 0,
      total: totalChunks,
    });

    // Qwen: ensure preview WAV+TXT for ICL. Kokoro: speaker id only.
    const engine = activeTtsEngine();
    let voiceAnchor: { refAudioPath: string; refText: string } | null = null;
    if (engine === "qwen3") {
      sendEvent({
        type: "status",
        step: "pre_tts",
        message: "Preparando âncora de voz (prévia) para tom consistente...",
      });
      try {
        voiceAnchor = await ensureVoicePreview(voice);
        console.log(`[NarrateStream] Voice anchor: ${voiceAnchor.refAudioPath}`);
      } catch (anchorErr: any) {
        sendEvent({
          type: "error",
          error:
            anchorErr?.message ||
            "Falha ao preparar a âncora de voz. Gere a prévia da voz no seletor e tente de novo.",
        });
        return res.end();
      }
    }

    // Run Text-To-Speech via local engine for each chunk
    const pcmChunks: Buffer[] = [];
    let sampleRate = 24000;
    let wasStoppedEarly = false;
    const taskAbort = taskId ? activeTasks.get(taskId)?.abort : undefined;
    const engineLabel = engine === "kokoro" ? "Kokoro" : "Qwen3";
    
    for (let i = 0; i < totalChunks; i++) {
      // Check if task has been cancelled / stopped
      if (taskId) {
        const task = activeTasks.get(taskId);
        if (task?.stopped || task?.abort.signal.aborted) {
          console.log(`[NarrateStream] Task ${taskId} was stopped by user at chunk index ${i}.`);
          wasStoppedEarly = true;
          break;
        }
      }

      const chunk = textChunks[i];
      const partNum = i + 1;
      
      sendEvent({ 
        type: "status", 
        step: "tts", 
        current: partNum, 
        total: totalChunks, 
        message: `Narrando parte ${partNum} de ${totalChunks} (${engineLabel})...` 
      });

      const heartbeat = setInterval(() => {
        sendEvent({
          type: "status",
          step: "tts",
          current: partNum,
          total: totalChunks,
          message: `Narrando parte ${partNum} de ${totalChunks} — ${engineLabel} ainda gerando...`,
        });
      }, 10_000);

      try {
        const { pcm, sampleRate: sr, cancelled, icl } = await synthesizeWithTts(
          chunk,
          voice,
          taskId,
          taskAbort?.signal,
          voiceAnchor
            ? {
                refAudioPath: voiceAnchor.refAudioPath,
                refText: voiceAnchor.refText,
              }
            : { skipIcl: true }
        );
        sampleRate = sr;
        if (i === 0) {
          console.log(
            `[NarrateStream] Chunk 1 TTS done (engine=${engine}, voice=${voice}, icl=${!!icl}, cancelled=${cancelled})`
          );
        }
        if (engine === "qwen3" && !icl && !cancelled) {
          console.warn(
            `[NarrateStream] Chunk ${partNum}: ICL not used for voice=${voice} — ` +
              "preview anchor may be missing or Base encoder not ready."
          );
        }
        if (pcm.length > 0) {
          pcmChunks.push(pcm);
        }
        if (cancelled) {
          console.log(`[NarrateStream] TTS cancelled mid-chunk at index ${i}.`);
          wasStoppedEarly = true;
          break;
        }
      } catch (ttsErr: any) {
        console.warn(`[NarrateStream] Chunk ${partNum} failed:`, ttsErr?.message || ttsErr);
        if (taskId && activeTasks.get(taskId)?.stopped) {
          wasStoppedEarly = true;
          break;
        }
      } finally {
        clearInterval(heartbeat);
      }
    }

    if (pcmChunks.length === 0) {
      if (wasStoppedEarly) {
        sendEvent({ type: "error", error: "A geração de áudio foi interrompida pelo usuário antes que qualquer parte pudesse ser narrada." });
      } else {
        sendEvent({
          type: "error",
          error: `A geração de áudio falhou para todas as partes do texto. Verifique se o servidor ${engineLabel} TTS está rodando.`,
        });
      }
      return res.end();
    }

    sendEvent({ 
      type: "status", 
      step: "encoding", 
      current: pcmChunks.length,
      total: totalChunks,
      message: wasStoppedEarly 
        ? "Geração interrompida. Codificando áudio gerado até o momento..."
        : "Codificando e compactando áudio para o formato MP3..." 
    });

    // Combine all PCM chunks and convert to MP3
    const combinedPcm = Buffer.concat(pcmChunks);
    const samplesCount = combinedPcm.length / 2;
    const samples = new Int16Array(samplesCount);
    for (let i = 0; i < samplesCount; i++) {
      samples[i] = combinedPcm.readInt16LE(i * 2);
    }

    const mp3Buffer = encodePcmToMp3(samples, sampleRate, 128);

    sendEvent({
      type: "done",
      audioData: mp3Buffer.toString("base64"),
      extractedText: extractedText,
      voiceName: voice,
      pagesNarrated: wasStoppedEarly 
        ? `${pagesLabel} (Interrompido na parte ${pcmChunks.length} de ${totalChunks})`
        : pagesLabel
    });

    res.end();

  } catch (err: any) {
    console.error("[NarrateStream Server Error]", err);
    if (tempPath) {
      await fs.promises.unlink(tempPath).catch(() => {});
    }
    sendEvent({ type: "error", error: err.message || "Ocorreu um erro interno ao processar o áudio." });
    res.end();
  } finally {
    await unloadTtsModel();
    if (taskId) {
      activeTasks.delete(taskId);
      console.log(`[NarrateStream] Cleaned up taskId ${taskId} from activeTasks.`);
    }
  }
});

// Original endpoint kept for backwards compatibility / fallback
app.post("/api/narrate", async (req, res) => {
  try {
    const { pdfData, startPage, endPage, voiceName } = req.body;

    if (!pdfData) {
      return res.status(400).json({ error: "O arquivo PDF é obrigatório." });
    }

    const { start, end } = parsePageRange(startPage, endPage);
    const voice = voiceName || "Vivian";

    console.log(`[Narrate Legacy] Start Page: ${start}, End Page: ${end}, Voice: ${voice}`);

    const { extractedText, pagesNarrated } = await extractDocumentText({
      fileData: pdfData,
      fileType: "pdf",
      start,
      end,
    });

    const textChunks = splitTextIntoChunks(extractedText, 240);
    const engine = activeTtsEngine();
    let voiceAnchor: { refAudioPath: string; refText: string } | null = null;
    if (engine === "qwen3") {
      voiceAnchor = await ensureVoicePreview(voice);
    }
    const pcmChunks: Buffer[] = [];
    let sampleRate = 24000;
    
    for (let i = 0; i < textChunks.length; i++) {
      const chunk = textChunks[i];
      try {
        const { pcm, sampleRate: sr } = await synthesizeWithTts(
          chunk,
          voice,
          undefined,
          undefined,
          voiceAnchor
            ? {
                refAudioPath: voiceAnchor.refAudioPath,
                refText: voiceAnchor.refText,
              }
            : { skipIcl: true }
        );
        sampleRate = sr;
        if (pcm.length > 0) {
          pcmChunks.push(pcm);
        }
      } catch (ttsErr: any) {
        console.warn(`[Narrate Legacy] Chunk ${i + 1} failed:`, ttsErr?.message || ttsErr);
      }
    }

    if (pcmChunks.length === 0) {
      return res.status(500).json({
        error: `A geração de áudio falhou para todas as partes do texto. Verifique se o servidor ${engine === "kokoro" ? "Kokoro" : "Qwen3"} TTS está rodando.`,
      });
    }

    const combinedPcm = Buffer.concat(pcmChunks);
    const samplesCount = combinedPcm.length / 2;
    const samples = new Int16Array(samplesCount);
    for (let i = 0; i < samplesCount; i++) {
      samples[i] = combinedPcm.readInt16LE(i * 2);
    }

    const mp3Buffer = encodePcmToMp3(samples, sampleRate, 128);

    res.json({
      audioData: mp3Buffer.toString("base64"),
      extractedText: extractedText,
      voiceName: voice,
      pagesNarrated
    });

  } catch (error: any) {
    console.error("[Narrate Legacy Error]", error);
    res.status(500).json({ error: error.message || "Erro interno ao processar e narrar o PDF." });
  } finally {
    await unloadTtsModel();
  }
});

// Configure Vite middleware in development or serve static built files in production
async function start() {
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(AURA_ROOT, "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

start();
