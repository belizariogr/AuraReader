/**
 * Package AuraReader for the current OS (mirrors dist:mac flow).
 *
 *   bun run dist
 *   AURA_TTS_ACCEL=rocm bun run dist
 *   AURA_TTS_ACCEL=cpu bun run dist
 */
const { spawnSync } = require("child_process");
const path = require("path");

const root = path.resolve(__dirname, "..");
const accel = (process.env.AURA_TTS_ACCEL || "cuda").toLowerCase();
const platform = process.platform;

function run(cmd, args) {
  console.log(`[dist] ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, {
    cwd: root,
    stdio: "inherit",
    env: process.env,
    shell: platform === "win32",
  });
  if (r.status !== 0) process.exit(r.status || 1);
}

if (platform === "darwin") {
  run("bun", ["run", "dist:mac"]);
} else if (platform === "win32") {
  const script =
    accel === "rocm" ? "dist:win:rocm" : accel === "cpu" ? "dist:win:cpu" : "dist:win";
  run("bun", ["run", script]);
} else if (platform === "linux") {
  const script =
    accel === "rocm"
      ? "dist:linux:rocm"
      : accel === "cpu"
        ? "dist:linux:cpu"
        : "dist:linux";
  run("bun", ["run", script]);
} else {
  console.error(`[dist] Unsupported platform: ${platform}`);
  process.exit(1);
}
