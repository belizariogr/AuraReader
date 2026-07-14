/**
 * Start AuraReader. Qwen TTS is launched lazily by the app on first use.
 */
import { spawn, type ChildProcess } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const TTS_PORT = process.env.TTS_PORT || process.env.DIA_PORT || "8765";
const TTS_URL = process.env.TTS_URL || process.env.DIA_URL || `http://127.0.0.1:${TTS_PORT}`;

const children: ChildProcess[] = [];
let shuttingDown = false;

function spawnInherit(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; name: string }
): ChildProcess {
  console.log(`[start] launching ${options.name}: ${command} ${args.join(" ")}`);
  const child = spawn(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    stdio: "inherit",
    shell: false,
  });
  children.push(child);
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    console.error(`[start] ${options.name} exited (code=${code}, signal=${signal}). Shutting down.`);
    shutdown(code ?? 1);
  });
  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  }
  setTimeout(() => process.exit(code), 500);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

async function main() {
  console.log("[start] Qwen TTS will start on first narrate/preview.");
  spawnInherit("bun", ["server.ts"], {
    cwd: root,
    name: "aura-app",
    env: {
      ...process.env,
      TTS_URL,
      TTS_PORT,
      QWEN_TTS_PRELOAD: process.env.QWEN_TTS_PRELOAD ?? "0",
    },
  });
}

main().catch((err) => {
  console.error("[start] failed:", err);
  shutdown(1);
});
