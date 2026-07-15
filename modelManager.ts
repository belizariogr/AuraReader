/**
 * Local TTS model install status + downloads (no Python).
 * Supports Qwen3 (HF repos by platform) and Kokoro (direct ONNX assets).
 */
import fs from "fs";
import path from "path";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import type { ReadableStream as WebReadableStream } from "stream/web";
import { detectGpu, type GpuDetectResult } from "./gpuDetect";
import { probeKokoroAccel } from "./kokoroAccel";
import {
  readTtsEngine,
  readKokoroDevice,
  type TtsEngineId,
  voicesForEngine,
} from "./ttsEngine";

export type ModelSpec = {
  id: string;
  folder: string;
  label: string;
  /** Hugging Face repo (Qwen) or empty for direct URL assets (Kokoro). */
  repo: string;
  approxBytes: number;
  /** Direct file downloads (Kokoro). */
  files?: Array<{ name: string; url: string; approxBytes: number }>;
};

const MLX_MODELS: ModelSpec[] = [
  {
    id: "base",
    folder: "Qwen3-TTS-12Hz-0.6B-Base-8bit",
    label: "Base (ICL / clonagem de voz)",
    repo: "mlx-community/Qwen3-TTS-12Hz-0.6B-Base-8bit",
    approxBytes: 2_000_000_000,
  },
  {
    id: "custom",
    folder: "Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit",
    label: "CustomVoice (prévias e speakers)",
    repo: "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit",
    approxBytes: 2_000_000_000,
  },
];

const TORCH_MODELS: ModelSpec[] = [
  {
    id: "base",
    folder: "Qwen3-TTS-12Hz-0.6B-Base",
    label: "Base (ICL / clonagem de voz)",
    repo: "Qwen/Qwen3-TTS-12Hz-0.6B-Base",
    approxBytes: 1_500_000_000,
  },
  {
    id: "custom",
    folder: "Qwen3-TTS-12Hz-0.6B-CustomVoice",
    label: "CustomVoice (prévias e speakers)",
    repo: "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice",
    approxBytes: 1_500_000_000,
  },
];

const KOKORO_RELEASE =
  "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0";

const KOKORO_MODELS: ModelSpec[] = [
  {
    id: "kokoro",
    folder: "kokoro",
    label: "Kokoro 82M (ONNX + vozes)",
    repo: "",
    approxBytes: 325_000_000 + 28_000_000,
    files: [
      {
        name: "kokoro-v1.0.onnx",
        url: `${KOKORO_RELEASE}/kokoro-v1.0.onnx`,
        approxBytes: 325_000_000,
      },
      {
        name: "voices-v1.0.bin",
        url: `${KOKORO_RELEASE}/voices-v1.0.bin`,
        approxBytes: 28_000_000,
      },
    ],
  },
];

export function isTorchTtsPlatform(platform = process.platform): boolean {
  return platform === "win32" || platform === "linux";
}

export function getQwenModels(platform = process.platform): ModelSpec[] {
  return isTorchTtsPlatform(platform) ? TORCH_MODELS : MLX_MODELS;
}

export function getRequiredModels(
  engine: TtsEngineId = "qwen3",
  platform = process.platform
): ModelSpec[] {
  if (engine === "kokoro") return KOKORO_MODELS;
  return getQwenModels(platform);
}

/** @deprecated Prefer getRequiredModels(readTtsEngine(...)) */
export const REQUIRED_MODELS: ModelSpec[] = getQwenModels();

export type ProgressEvent = Record<string, unknown>;

type HfTreeEntry = {
  type: "file" | "directory";
  path: string;
  size?: number;
};

let downloadAbort: AbortController | null = null;
let downloadActive = false;

export function isModelDownloadActive(): boolean {
  return downloadActive;
}

export function cancelModelDownload(): boolean {
  if (!downloadAbort) return false;
  downloadAbort.abort();
  return true;
}

export function modelFolderReady(folderPath: string): boolean {
  if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) return false;
  const stack = [folderPath];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      let st: fs.Stats;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) stack.push(full);
      else if (/\.(safetensors|npz)$/i.test(name)) return true;
    }
  }
  return false;
}

export function kokoroAssetsReady(folderPath: string): boolean {
  if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) return false;
  const onnx = path.join(folderPath, "kokoro-v1.0.onnx");
  const voices = path.join(folderPath, "voices-v1.0.bin");
  try {
    return (
      fs.existsSync(onnx) &&
      fs.statSync(onnx).size > 1_000_000 &&
      fs.existsSync(voices) &&
      fs.statSync(voices).size > 1_000_000
    );
  } catch {
    return false;
  }
}

function specReady(spec: ModelSpec, folderPath: string): boolean {
  if (spec.files?.length) return kokoroAssetsReady(folderPath);
  return modelFolderReady(folderPath);
}

export function projectModelsDir(
  auraRoot: string,
  engine: TtsEngineId = "qwen3",
  platform = process.platform
): string {
  if (engine === "kokoro") {
    return path.join(auraRoot, "tts", "kokoro", "models");
  }
  if (isTorchTtsPlatform(platform)) {
    return path.join(auraRoot, "tts", "torch", "models");
  }
  return path.join(auraRoot, "qwen3-tts-apple-silicon", "models");
}

export function resolveModelsDir(
  auraRoot: string,
  auraDataDir: string,
  engine?: TtsEngineId
): string {
  const active = engine ?? readTtsEngine(auraDataDir);
  if (active === "kokoro") {
    if (process.env.KOKORO_MODEL_DIR) {
      return path.resolve(process.env.KOKORO_MODEL_DIR);
    }
    const projectModels = projectModelsDir(auraRoot, "kokoro");
    const dataModels = path.join(auraDataDir, "models", "kokoro");
    if (kokoroAssetsReady(projectModels)) return projectModels;
    if (kokoroAssetsReady(dataModels)) return dataModels;
    if (path.resolve(auraDataDir) !== path.resolve(auraRoot)) return dataModels;
    return projectModels;
  }

  if (process.env.QWEN_TTS_MODELS_DIR) {
    return path.resolve(process.env.QWEN_TTS_MODELS_DIR);
  }
  const models = getQwenModels();
  const projectModels = projectModelsDir(auraRoot, "qwen3");
  const dataModels = path.join(auraDataDir, "models");
  const projectReady = models.every((m) =>
    modelFolderReady(path.join(projectModels, m.folder))
  );
  if (projectReady) return projectModels;
  const dataReady = models.every((m) =>
    modelFolderReady(path.join(dataModels, m.folder))
  );
  if (dataReady) return dataModels;
  if (path.resolve(auraDataDir) !== path.resolve(auraRoot)) return dataModels;
  return projectModels;
}

function engineStatusBlock(
  auraRoot: string,
  auraDataDir: string,
  engine: TtsEngineId
) {
  const modelsDir = resolveModelsDir(auraRoot, auraDataDir, engine);
  const models = getRequiredModels(engine).map((m) => {
    const folderPath =
      engine === "kokoro" ? modelsDir : path.join(modelsDir, m.folder);
    const present = specReady(m, folderPath);
    return {
      id: m.id,
      folder: m.folder,
      label: m.label,
      present,
      approxBytes: m.approxBytes,
      path: folderPath,
    };
  });
  return {
    ready: models.every((m) => m.present),
    modelsDir,
    models,
    voices: voicesForEngine(engine),
  };
}

export function getModelsStatus(auraRoot: string, auraDataDir: string) {
  const engine = readTtsEngine(auraDataDir);
  const kokoroDevice = readKokoroDevice(auraDataDir);
  const active = engineStatusBlock(auraRoot, auraDataDir, engine);
  const qwen3 = engineStatusBlock(auraRoot, auraDataDir, "qwen3");
  const kokoro = engineStatusBlock(auraRoot, auraDataDir, "kokoro");
  const gpu: GpuDetectResult = detectGpu(auraRoot);
  return {
    ready: active.ready,
    engine,
    kokoroDevice,
    modelsDir: active.modelsDir,
    models: active.models.map((m) => ({ ...m, downloading: downloadActive })),
    engines: {
      qwen3: {
        ready: qwen3.ready,
        modelsDir: qwen3.modelsDir,
        models: qwen3.models,
        voices: qwen3.voices,
        label: "Qwen3-TTS",
        description: "Alta qualidade com clonagem de voz (ICL).",
      },
      kokoro: {
        ready: kokoro.ready,
        modelsDir: kokoro.modelsDir,
        models: kokoro.models,
        voices: kokoro.voices,
        label: "Kokoro",
        description: "Rápido e leve (ONNX) — ideal em AMD/CPU.",
      },
    },
    downloading: downloadActive,
    backend:
      engine === "kokoro" ? "onnx" : isTorchTtsPlatform() ? "torch" : "mlx",
    platform: process.platform,
    gpu,
    voices: active.voices,
    kokoroAccel: probeKokoroAccel(auraRoot, kokoroDevice),
  };
}

function hfHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": "AuraReader/0.0.1",
  };
  const token = process.env.HF_TOKEN || process.env.HUGGING_FACE_HUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function listRepoFiles(repo: string, signal: AbortSignal): Promise<HfTreeEntry[]> {
  const url = `https://huggingface.co/api/models/${repo}/tree/main?recursive=true`;
  const res = await fetch(url, { headers: hfHeaders(), signal });
  if (!res.ok) {
    throw new Error(`Falha ao listar ${repo}: HTTP ${res.status}`);
  }
  const tree = (await res.json()) as HfTreeEntry[];
  return tree.filter(
    (e) =>
      e.type === "file" &&
      !!e.path &&
      !e.path.endsWith(".gitattributes") &&
      path.basename(e.path) !== ".gitattributes"
  );
}

function ensureParentDir(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

async function downloadUrlToFile(
  url: string,
  destPath: string,
  expectedSize: number,
  signal: AbortSignal,
  onBytes: (received: number, total: number) => void,
  headers: Record<string, string> = { "User-Agent": "AuraReader/0.0.1" }
): Promise<number> {
  const partialPath = `${destPath}.partial`;

  let startAt = 0;
  if (fs.existsSync(partialPath)) {
    startAt = fs.statSync(partialPath).size;
  } else if (fs.existsSync(destPath) && expectedSize > 0) {
    const existing = fs.statSync(destPath).size;
    if (existing === expectedSize || (expectedSize > 1_000_000 && existing > expectedSize * 0.95)) {
      onBytes(existing, existing);
      return existing;
    }
  }

  const reqHeaders = { ...headers };
  if (startAt > 0) reqHeaders.Range = `bytes=${startAt}-`;

  const res = await fetch(url, { headers: reqHeaders, signal, redirect: "follow" });
  if (!(res.ok || res.status === 206)) {
    throw new Error(`Download falhou (${path.basename(destPath)}): HTTP ${res.status}`);
  }

  const totalHeader = res.headers.get("content-length");
  const chunkLen = totalHeader ? Number(totalHeader) : expectedSize - startAt;
  const total = expectedSize > 0 ? expectedSize : startAt + (Number.isFinite(chunkLen) ? chunkLen : 0);

  ensureParentDir(destPath);
  const flags = startAt > 0 && res.status === 206 ? "a" : "w";
  if (flags === "w" && fs.existsSync(partialPath)) fs.unlinkSync(partialPath);

  const body = res.body;
  if (!body) throw new Error(`Resposta vazia ao baixar ${path.basename(destPath)}`);

  let received = flags === "a" ? startAt : 0;
  onBytes(received, total || expectedSize);

  const nodeReadable = Readable.fromWeb(body as unknown as WebReadableStream<Uint8Array>);
  const writeStream = fs.createWriteStream(partialPath, { flags });

  nodeReadable.on("data", (chunk: Buffer | Uint8Array) => {
    received += chunk.length;
    onBytes(received, total || expectedSize || received);
  });

  await pipeline(nodeReadable, writeStream);

  if (expectedSize > 0 && received !== expectedSize) {
    if (res.status === 206 && received < expectedSize) {
      throw new Error(
        `Arquivo incompleto: ${path.basename(destPath)} (${received}/${expectedSize})`
      );
    }
  }

  fs.renameSync(partialPath, destPath);
  return received;
}

async function downloadFile(
  repo: string,
  relativePath: string,
  destPath: string,
  expectedSize: number,
  signal: AbortSignal,
  onBytes: (received: number, total: number) => void
): Promise<number> {
  const url = `https://huggingface.co/${repo}/resolve/main/${relativePath
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
  return downloadUrlToFile(url, destPath, expectedSize, signal, onBytes, hfHeaders());
}

function formatEta(seconds: number | null): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null;
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}m ${rem}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export async function downloadMissingModels(options: {
  auraRoot: string;
  auraDataDir: string;
  engine?: TtsEngineId;
  onEvent: (evt: ProgressEvent) => void;
}): Promise<void> {
  if (downloadActive) {
    throw new Error("Download já em andamento.");
  }

  const engine = options.engine ?? readTtsEngine(options.auraDataDir);
  const modelsDir = resolveModelsDir(options.auraRoot, options.auraDataDir, engine);
  fs.mkdirSync(modelsDir, { recursive: true });

  const abort = new AbortController();
  downloadAbort = abort;
  downloadActive = true;

  const startedAt = Date.now();
  let lastEmit = 0;
  let lastBytes = 0;
  let lastSpeedAt = startedAt;
  let speedEma = 0;

  const emit = (evt: ProgressEvent, force = false) => {
    const now = Date.now();
    if (!force && now - lastEmit < 200 && evt.type === "progress") return;
    lastEmit = now;
    options.onEvent(evt);
  };

  try {
    emit(
      {
        type: "start",
        modelsDir,
        engine,
        backend:
          engine === "kokoro" ? "onnx" : isTorchTtsPlatform() ? "torch" : "mlx",
      },
      true
    );

    for (const spec of getRequiredModels(engine)) {
      if (abort.signal.aborted) throw new Error("Download cancelado.");

      const localDir =
        engine === "kokoro" ? modelsDir : path.join(modelsDir, spec.folder);
      if (specReady(spec, localDir)) {
        emit(
          {
            type: "model_skip",
            model: spec.id,
            label: spec.label,
            folder: spec.folder,
            reason: "already_present",
          },
          true
        );
        continue;
      }

      fs.mkdirSync(localDir, { recursive: true });

      if (spec.files?.length) {
        const totalBytes = spec.files.reduce((sum, f) => sum + f.approxBytes, 0);
        let modelDownloaded = 0;

        emit(
          {
            type: "model_start",
            model: spec.id,
            label: spec.label,
            repo: "kokoro-onnx",
            folder: spec.folder,
            totalBytes,
            files: spec.files.length,
          },
          true
        );

        for (let i = 0; i < spec.files.length; i++) {
          if (abort.signal.aborted) throw new Error("Download cancelado.");
          const file = spec.files[i];
          const size = file.approxBytes;
          const dest = path.join(localDir, file.name);

          emit(
            {
              type: "file_start",
              model: spec.id,
              label: spec.label,
              file: file.name,
              fileIndex: i + 1,
              fileCount: spec.files.length,
              fileBytes: size,
              downloadedBytes: modelDownloaded,
              totalBytes,
              percent: totalBytes ? Math.round((1000 * modelDownloaded) / totalBytes) / 10 : 0,
            },
            true
          );

          await downloadUrlToFile(
            file.url,
            dest,
            size,
            abort.signal,
            (fileReceived, fileTotal) => {
              const overallDownloaded = modelDownloaded + fileReceived;
              const now = Date.now();
              const dt = (now - lastSpeedAt) / 1000;
              if (dt >= 0.4) {
                const instant = (overallDownloaded - lastBytes) / Math.max(dt, 0.001);
                speedEma = speedEma ? speedEma * 0.7 + instant * 0.3 : instant;
                lastBytes = overallDownloaded;
                lastSpeedAt = now;
              }
              const remaining = Math.max(0, totalBytes - overallDownloaded);
              const etaSeconds = speedEma > 1024 ? remaining / speedEma : null;
              emit({
                type: "progress",
                model: spec.id,
                label: spec.label,
                file: file.name,
                fileIndex: i + 1,
                fileCount: spec.files!.length,
                fileDownloadedBytes: fileReceived,
                fileTotalBytes: fileTotal || size,
                filePercent:
                  fileTotal || size
                    ? Math.round((1000 * fileReceived) / (fileTotal || size)) / 10
                    : 0,
                downloadedBytes: overallDownloaded,
                totalBytes,
                percent: totalBytes
                  ? Math.round((1000 * overallDownloaded) / totalBytes) / 10
                  : 0,
                bytesPerSecond: Math.round(speedEma),
                etaSeconds: etaSeconds != null ? Math.round(etaSeconds) : null,
                etaLabel: formatEta(etaSeconds),
              });
            }
          );

          modelDownloaded += fs.statSync(dest).size;
          emit(
            {
              type: "file_done",
              model: spec.id,
              file: file.name,
              fileIndex: i + 1,
              fileCount: spec.files.length,
              downloadedBytes: modelDownloaded,
              totalBytes,
              percent: totalBytes
                ? Math.round((1000 * modelDownloaded) / totalBytes) / 10
                : 100,
              bytesPerSecond: Math.round(speedEma),
            },
            true
          );
        }

        emit(
          {
            type: "model_done",
            model: spec.id,
            label: spec.label,
            folder: spec.folder,
            downloadedBytes: modelDownloaded,
            totalBytes,
          },
          true
        );
        continue;
      }

      const files = await listRepoFiles(spec.repo, abort.signal);
      const totalBytes = files.reduce((sum, f) => sum + (f.size || 0), 0);
      let modelDownloaded = 0;

      emit(
        {
          type: "model_start",
          model: spec.id,
          label: spec.label,
          repo: spec.repo,
          folder: spec.folder,
          totalBytes,
          files: files.length,
        },
        true
      );

      for (let i = 0; i < files.length; i++) {
        if (abort.signal.aborted) throw new Error("Download cancelado.");
        const file = files[i];
        const size = file.size || 0;
        const dest = path.join(localDir, file.path);

        emit(
          {
            type: "file_start",
            model: spec.id,
            label: spec.label,
            file: file.path,
            fileIndex: i + 1,
            fileCount: files.length,
            fileBytes: size,
            downloadedBytes: modelDownloaded,
            totalBytes,
            percent: totalBytes ? Math.round((1000 * modelDownloaded) / totalBytes) / 10 : 0,
          },
          true
        );

        await downloadFile(
          spec.repo,
          file.path,
          dest,
          size,
          abort.signal,
          (fileReceived, fileTotal) => {
            const overallDownloaded = modelDownloaded + fileReceived;
            const now = Date.now();
            const dt = (now - lastSpeedAt) / 1000;
            if (dt >= 0.4) {
              const instant = (overallDownloaded - lastBytes) / Math.max(dt, 0.001);
              speedEma = speedEma ? speedEma * 0.7 + instant * 0.3 : instant;
              lastBytes = overallDownloaded;
              lastSpeedAt = now;
            }
            const remaining = Math.max(0, totalBytes - overallDownloaded);
            const etaSeconds = speedEma > 1024 ? remaining / speedEma : null;

            emit({
              type: "progress",
              model: spec.id,
              label: spec.label,
              file: file.path,
              fileIndex: i + 1,
              fileCount: files.length,
              fileDownloadedBytes: fileReceived,
              fileTotalBytes: fileTotal || size,
              filePercent:
                fileTotal || size
                  ? Math.round((1000 * fileReceived) / (fileTotal || size)) / 10
                  : 0,
              downloadedBytes: overallDownloaded,
              totalBytes,
              percent: totalBytes
                ? Math.round((1000 * overallDownloaded) / totalBytes) / 10
                : 0,
              bytesPerSecond: Math.round(speedEma),
              etaSeconds: etaSeconds != null ? Math.round(etaSeconds) : null,
              etaLabel: formatEta(etaSeconds),
            });
          }
        );

        modelDownloaded += size || fs.statSync(dest).size;
        emit(
          {
            type: "file_done",
            model: spec.id,
            file: file.path,
            fileIndex: i + 1,
            fileCount: files.length,
            downloadedBytes: modelDownloaded,
            totalBytes,
            percent: totalBytes ? Math.round((1000 * modelDownloaded) / totalBytes) / 10 : 100,
            bytesPerSecond: Math.round(speedEma),
            etaSeconds:
              speedEma > 1024 ? Math.round((totalBytes - modelDownloaded) / speedEma) : null,
            etaLabel: formatEta(
              speedEma > 1024 ? (totalBytes - modelDownloaded) / speedEma : null
            ),
          },
          true
        );
      }

      emit(
        {
          type: "model_done",
          model: spec.id,
          label: spec.label,
          folder: spec.folder,
          downloadedBytes: modelDownloaded,
          totalBytes,
        },
        true
      );
    }

    const status = getModelsStatus(options.auraRoot, options.auraDataDir);
    emit({ type: "done", ready: status.ready, modelsDir: status.modelsDir, engine }, true);
    if (!status.ready && status.engine === engine) {
      throw new Error("Download terminou, mas os modelos ainda estão incompletos.");
    }
  } catch (err: any) {
    const cancelled =
      abort.signal.aborted ||
      err?.name === "AbortError" ||
      /cancelad/i.test(String(err?.message || err));
    emit(
      {
        type: cancelled ? "cancelled" : "error",
        message: cancelled ? "Download cancelado." : err?.message || String(err),
        ready: getModelsStatus(options.auraRoot, options.auraDataDir).ready,
      },
      true
    );
    if (!cancelled) throw err;
  } finally {
    downloadActive = false;
    downloadAbort = null;
  }
}

export function deleteModels(
  auraRoot: string,
  auraDataDir: string,
  ids?: string[],
  engine?: TtsEngineId
): { deleted: string[]; modelsDir: string } {
  if (downloadActive) {
    throw new Error("Cancele o download antes de excluir modelos.");
  }
  const active = engine ?? readTtsEngine(auraDataDir);
  const modelsDir = resolveModelsDir(auraRoot, auraDataDir, active);
  const all = getRequiredModels(active);
  const targets = ids && ids.length ? all.filter((m) => ids.includes(m.id)) : all;

  const deleted: string[] = [];
  for (const spec of targets) {
    const folderPath =
      active === "kokoro" ? modelsDir : path.join(modelsDir, spec.folder);
    if (fs.existsSync(folderPath)) {
      if (active === "kokoro") {
        for (const f of spec.files || []) {
          const p = path.join(folderPath, f.name);
          if (fs.existsSync(p)) fs.rmSync(p, { force: true });
          if (fs.existsSync(`${p}.partial`)) fs.rmSync(`${p}.partial`, { force: true });
        }
        deleted.push(spec.id);
      } else {
        fs.rmSync(folderPath, { recursive: true, force: true });
        deleted.push(spec.id);
      }
    }
    const partialRoot = `${folderPath}.partial`;
    if (fs.existsSync(partialRoot)) {
      fs.rmSync(partialRoot, { recursive: true, force: true });
    }
  }
  return { deleted, modelsDir };
}
