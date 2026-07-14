/**
 * Assemble a self-contained runtime tree for the macOS .app:
 *   build/app-resources/
 *     dist/
 *     python/Python.framework/
 *     qwen3-tts-apple-silicon/{tts_server.py,models,site-packages}
 *     cache/voice-previews/ (seed)
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const out = path.join(root, "build", "app-resources");
const qwenSrc = path.join(root, "qwen3-tts-apple-silicon");
const venvPython = path.join(qwenSrc, ".venv", "bin", "python3.12");
const siteSrc = path.join(qwenSrc, ".venv", "lib", "python3.12", "site-packages");

function mustExist(p, label) {
  if (!fs.existsSync(p)) {
    throw new Error(`[prepare-app-resources] Missing ${label}: ${p}`);
  }
}

function copyFiltered(src, dst, skipNames = new Set()) {
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    if (skipNames.has(name)) continue;
    if (name === "__pycache__" || name === ".git" || name === ".DS_Store") continue;
    if (name.endsWith(".pyc")) continue;
    const from = path.join(src, name);
    const to = path.join(dst, name);
    const st = fs.lstatSync(from);
    if (st.isDirectory()) {
      copyFiltered(from, to, skipNames);
    } else if (st.isSymbolicLink()) {
      try {
        fs.copyFileSync(fs.realpathSync(from), to);
      } catch {
        fs.cpSync(from, to, { dereference: true });
      }
    } else {
      fs.copyFileSync(from, to);
    }
  }
}

function resolveFrameworkDir() {
  mustExist(venvPython, "venv python");
  const real = fs.realpathSync(venvPython);
  // .../Python.framework/Versions/3.12/bin/python3.12
  const versions = path.resolve(real, "..", ".."); // Versions/3.12
  const framework = path.resolve(versions, "..", ".."); // Python.framework
  if (!framework.endsWith("Python.framework") || !fs.existsSync(framework)) {
    throw new Error(
      `[prepare-app-resources] Could not locate Python.framework from ${real}`
    );
  }
  return framework;
}

console.log("[prepare-app-resources] Preparing", out);
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

mustExist(path.join(root, "dist", "server.cjs"), "dist/server.cjs");
mustExist(path.join(root, "dist", "index.html"), "dist/index.html");
mustExist(siteSrc, "venv site-packages");
mustExist(path.join(qwenSrc, "tts_server.py"), "tts_server.py");
// Frontend + bundled server
fs.cpSync(path.join(root, "dist"), path.join(out, "dist"), { recursive: true });

// Bundled CPython framework (relocatable via PYTHONHOME at runtime)
const frameworkSrc = resolveFrameworkDir();
const frameworkDst = path.join(out, "python", "Python.framework");
console.log("[prepare-app-resources] Copying Python.framework from", frameworkSrc);
fs.cpSync(frameworkSrc, frameworkDst, { recursive: true, dereference: true });

// Qwen runtime (models are downloaded on first launch into userData)
const qwenDst = path.join(out, "qwen3-tts-apple-silicon");
fs.mkdirSync(qwenDst, { recursive: true });
for (const file of ["tts_server.py", "requirements.txt", "main.py", "README.md"]) {
  const src = path.join(qwenSrc, file);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(qwenDst, file));
}
console.log("[prepare-app-resources] Skipping models/ (downloaded on first launch)");
console.log("[prepare-app-resources] Copying site-packages...");
copyFiltered(siteSrc, path.join(qwenDst, "site-packages"));

// Seed voice previews so first ICL narrations work offline
const previewSrc = path.join(root, "cache", "voice-previews");
const previewDst = path.join(out, "cache", "voice-previews");
if (fs.existsSync(previewSrc)) {
  fs.cpSync(previewSrc, previewDst, { recursive: true });
}

// Optional local secrets for personal builds (copied into userData on first launch)
const envSrc = path.join(root, ".env");
if (fs.existsSync(envSrc)) {
  fs.copyFileSync(envSrc, path.join(out, ".env"));
  console.log("[prepare-app-resources] Included .env seed");
}

// Quick smoke: bundled python can import fastapi (site-packages on PYTHONPATH)
const pyBin = path.join(frameworkDst, "Versions", "3.12", "bin", "python3.12");
mustExist(pyBin, "bundled python3.12");
try {
  execFileSync(
    pyBin,
    ["-c", "import fastapi, uvicorn, mlx; print('ok', fastapi.__version__)"],
    {
      env: {
        ...process.env,
        PYTHONHOME: path.join(frameworkDst, "Versions", "3.12"),
        PYTHONPATH: path.join(qwenDst, "site-packages"),
        PYTHONNOUSERSITE: "1",
      },
      stdio: "inherit",
    }
  );
} catch (err) {
  throw new Error(
    "[prepare-app-resources] Bundled Python failed to import TTS deps. " +
      (err?.message || err)
  );
}

const size = execFileSync("du", ["-sh", out], { encoding: "utf8" }).trim();
console.log("[prepare-app-resources] Done:", size);
