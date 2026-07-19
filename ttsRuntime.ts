/**
 * Detect / prepare TTS Python runtimes (Kokoro ONNX/MLX, Qwen Torch/MLX).
 * Called during model install so users don't need a separate CLI setup step.
 */
import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import path from "path";
import {
  defaultKokoroBackend,
  type KokoroBackendId,
  type TtsEngineId,
} from "./ttsEngine";

export type RuntimeProgressEvent = Record<string, unknown>;

let activeSetupChild: ChildProcess | null = null;

export function cancelRuntimeSetup(): boolean {
  if (!activeSetupChild || activeSetupChild.killed) return false;
  try {
    activeSetupChild.kill("SIGTERM");
  } catch {
    // ignore
  }
  return true;
}

function hasPythonAt(...candidates: string[]): boolean {
  return candidates.some((p) => fs.existsSync(p));
}

function hasMisakiMarker(auraRoot: string): boolean {
  const candidates = [
    path.join(auraRoot, "qwen3-tts-apple-silicon", "site-packages", "misaki"),
    path.join(
      auraRoot,
      "qwen3-tts-apple-silicon",
      ".venv",
      "lib",
      "python3.12",
      "site-packages",
      "misaki"
    ),
  ];
  return candidates.some((p) => fs.existsSync(p));
}

export function isKokoroRuntimeReady(
  auraRoot: string,
  platform = process.platform,
  backend: KokoroBackendId = defaultKokoroBackend(platform)
): boolean {
  const ttsDir = path.join(auraRoot, "tts", "kokoro");
  if (backend === "mlx" && platform === "darwin") {
    if (!fs.existsSync(path.join(ttsDir, "tts_server_mlx.py"))) return false;
    // Shared MLX stack with Qwen; misaki is required for Kokoro G2P.
    return isQwenMlxRuntimeReady(auraRoot) && hasMisakiMarker(auraRoot);
  }
  if (!fs.existsSync(path.join(ttsDir, "tts_server.py"))) return false;
  if (fs.existsSync(path.join(ttsDir, "site-packages"))) return true;
  return hasPythonAt(
    path.join(ttsDir, ".venv", "bin", "python"),
    path.join(ttsDir, ".venv", "Scripts", "python.exe")
  );
}

export function isQwenTorchRuntimeReady(auraRoot: string): boolean {
  const ttsDir = path.join(auraRoot, "tts", "torch");
  if (!fs.existsSync(path.join(ttsDir, "tts_server.py"))) return false;
  if (fs.existsSync(path.join(ttsDir, "site-packages"))) return true;
  return hasPythonAt(
    path.join(ttsDir, ".venv", "bin", "python"),
    path.join(ttsDir, ".venv", "Scripts", "python.exe")
  );
}

export function isQwenMlxRuntimeReady(auraRoot: string): boolean {
  const ttsDir = path.join(auraRoot, "qwen3-tts-apple-silicon");
  if (!fs.existsSync(path.join(ttsDir, "tts_server.py"))) return false;
  if (fs.existsSync(path.join(ttsDir, "site-packages"))) return true;
  return hasPythonAt(path.join(ttsDir, ".venv", "bin", "python"));
}

export function isEngineRuntimeReady(
  auraRoot: string,
  engine: TtsEngineId,
  platform = process.platform,
  kokoroBackend: KokoroBackendId = defaultKokoroBackend(platform)
): boolean {
  if (engine === "kokoro") {
    return isKokoroRuntimeReady(auraRoot, platform, kokoroBackend);
  }
  if (platform === "win32" || platform === "linux") {
    return isQwenTorchRuntimeReady(auraRoot);
  }
  return isQwenMlxRuntimeReady(auraRoot);
}

function setupScriptPath(auraRoot: string, name: string): string | null {
  const candidates = [
    path.join(auraRoot, "scripts", name),
    // Dev when AURA_ROOT points at a nested data dir / packaged layout misses scripts.
    path.join(process.cwd(), "scripts", name),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function nodeBinary(): string {
  // Prefer the current interpreter when it's Node/Bun (not Electron's helper binary).
  const exe = process.execPath || "";
  if (exe && !/electron/i.test(exe)) return exe;
  return "node";
}

function spawnOnce(
  command: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {}
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    activeSetupChild = child;
    let stderr = "";
    const onAbort = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    child.on("error", (err) => {
      opts.signal?.removeEventListener("abort", onAbort);
      if (activeSetupChild === child) activeSetupChild = null;
      reject(err);
    });
    child.on("close", (code, signalName) => {
      opts.signal?.removeEventListener("abort", onAbort);
      if (activeSetupChild === child) activeSetupChild = null;
      if (opts.signal?.aborted || signalName === "SIGTERM" || signalName === "SIGINT") {
        reject(new Error("Preparação cancelada."));
        return;
      }
      resolve({ code: code ?? 1, stderr });
    });
  });
}

async function resolveSystemPython312(): Promise<string> {
  const candidates = [
    "python3.12",
    "/usr/bin/python3.12",
    "/usr/local/bin/python3.12",
    "/opt/homebrew/bin/python3.12",
    "python3",
  ];
  for (const c of candidates) {
    try {
      const { code } = await spawnOnce(c, [
        "-c",
        "import sys; raise SystemExit(0 if sys.version_info[:2] >= (3, 12) else 1)",
      ]);
      if (code === 0) return c;
    } catch {
      // try next
    }
  }
  throw new Error(
    "Python 3.12+ não encontrado. Instale python3.12 (ex.: brew install python@3.12) e tente de novo."
  );
}

async function runSetupScript(options: {
  scriptPath: string;
  label: string;
  args?: string[];
  onEvent: (evt: RuntimeProgressEvent) => void;
  signal?: AbortSignal;
}): Promise<void> {
  const { scriptPath, label, args = [], onEvent, signal } = options;

  if (signal?.aborted) throw new Error("Preparação cancelada.");

  onEvent({
    type: "runtime_start",
    label,
    phase: `Preparando runtime ${label}…`,
  });

  await new Promise<void>((resolve, reject) => {
    const child = spawn(nodeBinary(), [scriptPath, ...args], {
      cwd: path.dirname(path.dirname(scriptPath)),
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    activeSetupChild = child;

    let stderrTail = "";
    const onAbort = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const emitLine = (line: string, stream: "stdout" | "stderr") => {
      const text = line.trim();
      if (!text) return;
      if (stream === "stderr") {
        stderrTail = (stderrTail + "\n" + text).slice(-2000);
      }
      onEvent({
        type: "runtime_log",
        label,
        stream,
        line: text.slice(0, 400),
        phase: text.slice(0, 120),
      });
    };

    const attach = (stream: NodeJS.ReadableStream | null, name: "stdout" | "stderr") => {
      if (!stream) return;
      let buf = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        buf += chunk;
        const parts = buf.split(/\r?\n/);
        buf = parts.pop() || "";
        for (const line of parts) emitLine(line, name);
      });
      stream.on("end", () => {
        if (buf.trim()) emitLine(buf, name);
      });
    };

    attach(child.stdout, "stdout");
    attach(child.stderr, "stderr");

    child.on("error", (err) => {
      signal?.removeEventListener("abort", onAbort);
      if (activeSetupChild === child) activeSetupChild = null;
      reject(err);
    });

    child.on("close", (code, signalName) => {
      signal?.removeEventListener("abort", onAbort);
      if (activeSetupChild === child) activeSetupChild = null;
      if (signal?.aborted || signalName === "SIGTERM" || signalName === "SIGINT") {
        reject(new Error("Preparação cancelada."));
        return;
      }
      if (code !== 0) {
        reject(
          new Error(
            `Falha ao preparar ${label} (exit ${code}).` +
              (stderrTail ? `\n${stderrTail.trim()}` : "")
          )
        );
        return;
      }
      resolve();
    });
  });

  onEvent({
    type: "runtime_done",
    label,
    phase: `Runtime ${label} pronto`,
  });
}

async function ensureMlxRuntime(options: {
  auraRoot: string;
  onEvent: (evt: RuntimeProgressEvent) => void;
  signal?: AbortSignal;
}): Promise<void> {
  const { auraRoot, onEvent, signal } = options;
  const ttsDir = path.join(auraRoot, "qwen3-tts-apple-silicon");
  const req = path.join(ttsDir, "requirements.txt");
  const venvPy = path.join(ttsDir, ".venv", "bin", "python");

  if (!fs.existsSync(req)) {
    throw new Error(
      `Runtime MLX ausente em ${ttsDir} e não há como instalar automaticamente neste pacote.`
    );
  }

  onEvent({
    type: "runtime_start",
    label: "Qwen3 (MLX)",
    phase: "Preparando runtime Qwen3 (MLX)…",
  });

  const py = await resolveSystemPython312();

  if (!fs.existsSync(venvPy)) {
    onEvent({
      type: "runtime_log",
      label: "Qwen3 (MLX)",
      phase: "Criando venv Python…",
      line: `${py} -m venv .venv`,
    });
    const created = await spawnOnce(py, ["-m", "venv", path.join(ttsDir, ".venv")], {
      cwd: ttsDir,
      signal,
    });
    if (created.code !== 0) {
      throw new Error(
        `Falha ao criar venv MLX (exit ${created.code}).` +
          (created.stderr ? `\n${created.stderr.trim()}` : "")
      );
    }
  }

  onEvent({
    type: "runtime_log",
    label: "Qwen3 (MLX)",
    phase: "Instalando dependências MLX (pode demorar)…",
    line: "pip install -r requirements.txt",
  });

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      venvPy,
      ["-m", "pip", "install", "-r", "requirements.txt"],
      {
        cwd: ttsDir,
        env: { ...process.env, PIP_DISABLE_PIP_VERSION_CHECK: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    activeSetupChild = child;
    const onAbort = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    let stderrTail = "";
    const feed = (chunk: string, stream: "stdout" | "stderr") => {
      if (stream === "stderr") stderrTail = (stderrTail + chunk).slice(-2000);
      const line = chunk.trim().split(/\r?\n/).pop();
      if (!line) return;
      onEvent({
        type: "runtime_log",
        label: "Qwen3 (MLX)",
        stream,
        line: line.slice(0, 400),
        phase: line.slice(0, 120),
      });
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (c: string) => feed(c, "stdout"));
    child.stderr?.on("data", (c: string) => feed(c, "stderr"));

    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (activeSetupChild === child) activeSetupChild = null;
      if (signal?.aborted) reject(new Error("Preparação cancelada."));
      else if (code !== 0) {
        reject(
          new Error(
            `Falha ao instalar deps MLX (exit ${code}).` +
              (stderrTail ? `\n${stderrTail.trim()}` : "")
          )
        );
      } else resolve();
    });
    child.on("error", reject);
  });

  if (!isQwenMlxRuntimeReady(auraRoot)) {
    throw new Error("Runtime MLX ainda incompleto após a instalação.");
  }

  onEvent({
    type: "runtime_done",
    label: "Qwen3 (MLX)",
    phase: "Runtime Qwen3 (MLX) pronto",
  });
}

/**
 * Ensure the Python runtime for the active engine exists.
 * Packaged builds already ship site-packages → no-op.
 * Dev checkouts run setup-kokoro-tts / setup-torch-tts (or MLX venv) as needed.
 */
export async function ensureEngineRuntime(options: {
  auraRoot: string;
  engine: TtsEngineId;
  kokoroBackend?: KokoroBackendId;
  onEvent: (evt: RuntimeProgressEvent) => void;
  signal?: AbortSignal;
}): Promise<void> {
  const { auraRoot, engine, onEvent, signal } = options;
  const kokoroBackend =
    options.kokoroBackend ?? defaultKokoroBackend(process.platform);

  if (isEngineRuntimeReady(auraRoot, engine, process.platform, kokoroBackend)) {
    onEvent({
      type: "runtime_skip",
      engine,
      reason: "already_present",
      phase: "Runtime já preparado",
    });
    return;
  }

  if (engine === "kokoro") {
    if (kokoroBackend === "mlx" && process.platform === "darwin") {
      await ensureMlxRuntime({ auraRoot, onEvent, signal });
      if (!isKokoroRuntimeReady(auraRoot, process.platform, kokoroBackend)) {
        throw new Error(
          "Runtime Kokoro (MLX) ainda incompleto após a preparação. " +
            "Confirme misaki[en] em qwen3-tts-apple-silicon/requirements.txt."
        );
      }
      return;
    }

    const script = setupScriptPath(auraRoot, "setup-kokoro-tts.cjs");
    if (!script) {
      throw new Error(
        "Runtime Kokoro ausente e scripts/setup-kokoro-tts.cjs não encontrado. " +
          "Em desenvolvimento: bun run setup:tts:kokoro"
      );
    }
    await runSetupScript({
      scriptPath: script,
      label: "Kokoro",
      args: ["--accel=auto"],
      onEvent,
      signal,
    });
    if (!isKokoroRuntimeReady(auraRoot, process.platform, kokoroBackend)) {
      throw new Error("Runtime Kokoro ainda incompleto após a preparação.");
    }
    return;
  }

  if (process.platform === "win32" || process.platform === "linux") {
    const script = setupScriptPath(auraRoot, "setup-torch-tts.cjs");
    if (!script) {
      throw new Error(
        "Runtime Qwen (Torch) ausente e scripts/setup-torch-tts.cjs não encontrado. " +
          "Em desenvolvimento: bun run setup:tts"
      );
    }
    await runSetupScript({
      scriptPath: script,
      label: "Qwen3 (Torch)",
      args: ["--accel=auto"],
      onEvent,
      signal,
    });
    if (!isQwenTorchRuntimeReady(auraRoot)) {
      throw new Error("Runtime Qwen (Torch) ainda incompleto após a preparação.");
    }
    return;
  }

  await ensureMlxRuntime({ auraRoot, onEvent, signal });
}
