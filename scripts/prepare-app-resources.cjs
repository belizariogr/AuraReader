/**
 * Assemble a self-contained runtime tree for Electron packaging:
 *   build/app-resources/
 *     dist/
 *     python/…                  (framework on darwin; portable 3.12 on win/linux)
 *     qwen3-tts-apple-silicon/  (darwin only)
 *     tts/torch/                (win32/linux only)
 *     tts-accel.json
 *     assets/voice-previews/ (ICL voice anchors)
 *
 * Usage:
 *   node scripts/prepare-app-resources.cjs [--platform=darwin|win32|linux] [--accel=cuda|rocm|cpu]
 *
 * GPU wheels must be prepared on the target OS (no cross-compile of torch).
 */
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const { execFileSync, spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const out = path.join(root, "build", "app-resources");
const qwenSrc = path.join(root, "qwen3-tts-apple-silicon");
const torchSrc = path.join(root, "tts", "torch");
const kokoroSrc = path.join(root, "tts", "kokoro");
const cacheDir = path.join(root, "build", "cache");

/** Pinned portable CPython 3.12 (python-build-standalone). */
const PBS_TAG = "20260303";
const PBS_VERSION = "3.12.13";

/** AMD ROCm Windows wheels (Python 3.12 / ROCm 7.2). Update when AMD bumps releases. */
const ROCM_WINDOWS_WHEELS = [
  "https://repo.radeon.com/rocm/windows/rocm-rel-7.2/torch-2.9.1%2Brocmsdk20260116-cp312-cp312-win_amd64.whl",
  "https://repo.radeon.com/rocm/windows/rocm-rel-7.2/torchaudio-2.9.1%2Brocmsdk20260116-cp312-cp312-win_amd64.whl",
  "https://repo.radeon.com/rocm/windows/rocm-rel-7.2/torchvision-0.24.1%2Brocmsdk20260116-cp312-cp312-win_amd64.whl",
];

const TORCH_INDEX = {
  cuda: "https://download.pytorch.org/whl/cu124",
  cpu: "https://download.pytorch.org/whl/cpu",
  rocm: "https://download.pytorch.org/whl/rocm6.3",
};

function parseArgs(argv) {
  let platform = process.platform;
  let accel = "cuda";
  for (const arg of argv) {
    if (arg.startsWith("--platform=")) platform = arg.slice("--platform=".length);
    else if (arg.startsWith("--accel=")) accel = arg.slice("--accel=".length);
  }
  if (!["darwin", "win32", "linux"].includes(platform)) {
    throw new Error(`Invalid --platform=${platform}`);
  }
  if (!["cuda", "rocm", "cpu", "mlx"].includes(accel)) {
    throw new Error(`Invalid --accel=${accel}`);
  }
  if (platform === "darwin") accel = "mlx";
  else if (accel === "mlx") {
    throw new Error("--accel=mlx is only valid with --platform=darwin");
  }
  return { platform, accel };
}

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

function writeAccelMeta(platform, accel) {
  const meta = { platform, accel, preparedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(out, "tts-accel.json"), JSON.stringify(meta, null, 2));
  console.log("[prepare-app-resources] Wrote tts-accel.json", meta);
}

function seedCommon() {
  mustExist(path.join(root, "dist", "server.cjs"), "dist/server.cjs");
  mustExist(path.join(root, "dist", "index.html"), "dist/index.html");
  fs.cpSync(path.join(root, "dist"), path.join(out, "dist"), { recursive: true });

  const previewSrc = path.join(root, "assets", "voice-previews");
  const previewDst = path.join(out, "assets", "voice-previews");
  if (fs.existsSync(previewSrc)) {
    fs.cpSync(previewSrc, previewDst, { recursive: true });
    console.log("[prepare-app-resources] Bundled assets/voice-previews");
  } else {
    console.warn("[prepare-app-resources] Missing assets/voice-previews — ICL anchors unavailable");
  }

  const envSrc = path.join(root, ".env");
  if (fs.existsSync(envSrc)) {
    fs.copyFileSync(envSrc, path.join(out, ".env"));
    console.log("[prepare-app-resources] Included .env seed");
  }
}

function resolveFrameworkDir(venvPython) {
  mustExist(venvPython, "venv python");
  const real = fs.realpathSync(venvPython);
  const versions = path.resolve(real, "..", "..");
  const framework = path.resolve(versions, "..", "..");
  if (!framework.endsWith("Python.framework") || !fs.existsSync(framework)) {
    throw new Error(
      `[prepare-app-resources] Could not locate Python.framework from ${real}`
    );
  }
  return framework;
}

function prepareDarwin() {
  const venvPython = path.join(qwenSrc, ".venv", "bin", "python3.12");
  const siteSrc = path.join(qwenSrc, ".venv", "lib", "python3.12", "site-packages");
  mustExist(siteSrc, "venv site-packages");
  mustExist(path.join(qwenSrc, "tts_server.py"), "tts_server.py");

  const frameworkSrc = resolveFrameworkDir(venvPython);
  const frameworkDst = path.join(out, "python", "Python.framework");
  console.log("[prepare-app-resources] Copying Python.framework from", frameworkSrc);
  fs.cpSync(frameworkSrc, frameworkDst, { recursive: true, dereference: true });

  const qwenDst = path.join(out, "qwen3-tts-apple-silicon");
  fs.mkdirSync(qwenDst, { recursive: true });
  for (const file of ["tts_server.py", "requirements.txt", "main.py", "README.md"]) {
    const src = path.join(qwenSrc, file);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(qwenDst, file));
  }
  console.log("[prepare-app-resources] Skipping models/ (downloaded on first launch)");
  console.log("[prepare-app-resources] Copying site-packages...");
  copyFiltered(siteSrc, path.join(qwenDst, "site-packages"));

  ensureKokoroVenv("darwin", "cpu");
  bundleKokoroRuntime("darwin");

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
    execFileSync(
      pyBin,
      ["-c", "import fastapi, onnxruntime, kokoro_onnx; print('kokoro ok')"],
      {
        env: {
          ...process.env,
          PYTHONHOME: path.join(frameworkDst, "Versions", "3.12"),
          PYTHONPATH: path.join(out, "tts", "kokoro", "site-packages"),
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
}

function pbsAssetName(platform) {
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  if (platform === "win32") {
    return `cpython-${PBS_VERSION}+${PBS_TAG}-${arch}-pc-windows-msvc-install_only.tar.gz`;
  }
  if (platform === "linux") {
    return `cpython-${PBS_VERSION}+${PBS_TAG}-${arch}-unknown-linux-gnu-install_only.tar.gz`;
  }
  throw new Error(`No portable Python asset for ${platform}`);
}

function downloadFile(url, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1_000_000) {
    console.log("[prepare-app-resources] Using cached", dest);
    return;
  }
  console.log("[prepare-app-resources] Downloading", url);
  const tmp = `${dest}.partial`;
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(tmp);
    const get = (u, redirects = 0) => {
      const lib = u.startsWith("https") ? https : http;
      lib
        .get(u, (res) => {
          if (
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location &&
            redirects < 8
          ) {
            res.resume();
            get(res.headers.location, redirects + 1);
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`Download failed HTTP ${res.statusCode}: ${u}`));
            return;
          }
          res.pipe(file);
          file.on("finish", () => {
            file.close(() => {
              fs.renameSync(tmp, dest);
              resolve();
            });
          });
        })
        .on("error", (err) => {
          try {
            fs.unlinkSync(tmp);
          } catch {
            // ignore
          }
          reject(err);
        });
    };
    get(url);
  });
}

function extractTarGz(archive, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  execFileSync("tar", ["-xzf", archive, "-C", destDir], { stdio: "inherit" });
}

/**
 * Download + extract portable CPython 3.12 into build/cache/python-standalone/<platform>.
 * Returns path to python binary.
 */
async function ensurePortablePython(platform) {
  const asset = pbsAssetName(platform);
  const url = `https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_TAG}/${asset}`;
  const archive = path.join(cacheDir, asset);
  const extractRoot = path.join(cacheDir, `python-standalone-${platform}`);
  const marker = path.join(extractRoot, ".ready");

  if (!fs.existsSync(marker)) {
    await downloadFile(url, archive);
    fs.rmSync(extractRoot, { recursive: true, force: true });
    fs.mkdirSync(extractRoot, { recursive: true });
    extractTarGz(archive, extractRoot);
    fs.writeFileSync(marker, PBS_TAG);
  }

  // install_only layout: <extract>/python/bin/python3.12  (or python/python.exe)
  const candidates =
    platform === "win32"
      ? [
          path.join(extractRoot, "python", "python.exe"),
          path.join(extractRoot, "python.exe"),
        ]
      : [
          path.join(extractRoot, "python", "bin", "python3.12"),
          path.join(extractRoot, "python", "bin", "python3"),
          path.join(extractRoot, "bin", "python3.12"),
        ];
  const py = candidates.find((p) => fs.existsSync(p));
  if (!py) {
    throw new Error(
      `[prepare-app-resources] Portable Python binary not found under ${extractRoot}`
    );
  }
  console.log("[prepare-app-resources] Portable Python:", py);
  return { pythonBin: py, pythonPrefix: path.join(extractRoot, "python") };
}

function torchVenvPython(platform) {
  if (platform === "win32") {
    return path.join(torchSrc, ".venv", "Scripts", "python.exe");
  }
  return path.join(torchSrc, ".venv", "bin", "python");
}

function torchSitePackages(platform) {
  if (platform === "win32") {
    return path.join(torchSrc, ".venv", "Lib", "site-packages");
  }
  const lib = path.join(torchSrc, ".venv", "lib");
  if (!fs.existsSync(lib)) {
    return path.join(torchSrc, ".venv", "lib", "python3.12", "site-packages");
  }
  const pyDirs = fs.readdirSync(lib).filter((n) => n.startsWith("python"));
  const preferred = pyDirs.find((n) => n.includes("3.12")) || pyDirs[0];
  if (!preferred) {
    return path.join(torchSrc, ".venv", "lib", "python3.12", "site-packages");
  }
  return path.join(lib, preferred, "site-packages");
}

function runPip(pythonBin, args) {
  const result = spawnSync(pythonBin, ["-m", "pip", ...args], {
    cwd: torchSrc,
    stdio: "inherit",
    env: { ...process.env, PIP_DISABLE_PIP_VERSION_CHECK: "1" },
  });
  if (result.status !== 0) {
    throw new Error(`pip failed: ${args.join(" ")}`);
  }
}

function ensureTorchVenv(platform, accel, portablePy) {
  const py = torchVenvPython(platform);
  if (fs.existsSync(py) && fs.existsSync(torchSitePackages(platform))) {
    // Reuse only if it is 3.12.x (torch/ROCm wheels).
    try {
      const ver = execFileSync(py, ["-c", "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"], {
        encoding: "utf8",
      }).trim();
      if (ver === "3.12") {
        console.log("[prepare-app-resources] Reusing existing tts/torch/.venv (3.12)");
        return py;
      }
      console.log(
        `[prepare-app-resources] Existing venv is Python ${ver}; recreating with 3.12...`
      );
      fs.rmSync(path.join(torchSrc, ".venv"), { recursive: true, force: true });
    } catch {
      fs.rmSync(path.join(torchSrc, ".venv"), { recursive: true, force: true });
    }
  }

  console.log(
    `[prepare-app-resources] Creating tts/torch/.venv (platform=${platform}, accel=${accel})...`
  );
  const create = spawnSync(
    portablePy,
    ["-m", "venv", path.join(torchSrc, ".venv")],
    { cwd: torchSrc, stdio: "inherit" }
  );
  if (create.status !== 0) {
    throw new Error("Failed to create tts/torch/.venv with portable Python 3.12.");
  }

  const venvPy = torchVenvPython(platform);
  mustExist(venvPy, "new venv python");

  const baseReq = path.join(torchSrc, "requirements-base.txt");
  mustExist(baseReq, "requirements-base.txt");
  runPip(venvPy, ["install", "--upgrade", "pip"]);
  // qwen-tts pulls a generic torchaudio from PyPI; overwrite torch+torchaudio
  // from the accel index afterward so ROCm/CPU builds never keep CUDA wheels.
  runPip(venvPy, ["install", "-r", baseReq]);

  if (accel === "rocm" && platform === "win32") {
    runPip(venvPy, ["install", "--force-reinstall", "--no-cache-dir", ...ROCM_WINDOWS_WHEELS]);
  } else {
    const accelReq = path.join(torchSrc, `requirements-${accel}.txt`);
    mustExist(accelReq, `requirements-${accel}.txt`);
    const index = TORCH_INDEX[accel];
    runPip(venvPy, [
      "install",
      "--force-reinstall",
      "--no-cache-dir",
      "-r",
      accelReq,
      "--index-url",
      index,
    ]);
  }

  return venvPy;
}

function bundlePortablePython(pythonPrefix) {
  const pythonDst = path.join(out, "python");
  console.log("[prepare-app-resources] Bundling portable Python from", pythonPrefix);
  fs.cpSync(pythonPrefix, pythonDst, { recursive: true, dereference: true });

  const candidates = [
    path.join(pythonDst, "python.exe"),
    path.join(pythonDst, "bin", "python3.12"),
    path.join(pythonDst, "bin", "python3"),
    path.join(pythonDst, "bin", "python"),
  ];
  const pyBin = candidates.find((p) => fs.existsSync(p));
  if (!pyBin) {
    throw new Error("[prepare-app-resources] No python binary after bundle");
  }
  return pyBin;
}

function kokoroVenvPython(platform) {
  return platform === "win32"
    ? path.join(kokoroSrc, ".venv", "Scripts", "python.exe")
    : path.join(kokoroSrc, ".venv", "bin", "python");
}

function kokoroSitePackages(platform) {
  const lib = path.join(kokoroSrc, ".venv", "lib");
  if (platform === "win32") {
    return path.join(kokoroSrc, ".venv", "Lib", "site-packages");
  }
  if (!fs.existsSync(lib)) return path.join(lib, "python3.12", "site-packages");
  const preferred = fs
    .readdirSync(lib)
    .find((n) => n.startsWith("python3."));
  if (!preferred) {
    return path.join(kokoroSrc, ".venv", "lib", "python3.12", "site-packages");
  }
  return path.join(lib, preferred, "site-packages");
}

function ensureKokoroVenv(platform, accel = "cpu") {
  const kokoroAccel =
    accel === "rocm" ? "rocm" : accel === "cuda" ? "cuda" : "cpu";
  // Prefer the dedicated setup script so ORT GPU wheels stay in one place.
  console.log(
    `[prepare-app-resources] Ensuring tts/kokoro/.venv (accel=${kokoroAccel}) via setup-kokoro-tts…`
  );
  const setup = spawnSync(
    process.execPath,
    [path.join(__dirname, "setup-kokoro-tts.cjs"), `--accel=${kokoroAccel}`],
    { cwd: root, stdio: "inherit", env: process.env }
  );
  if (setup.status !== 0) {
    throw new Error("setup-kokoro-tts.cjs failed while preparing Kokoro runtime");
  }
  const venvPy = kokoroVenvPython(platform);
  mustExist(venvPy, "kokoro venv python");
  return venvPy;
}

function bundleKokoroRuntime(platform) {
  mustExist(path.join(kokoroSrc, "tts_server.py"), "tts/kokoro/tts_server.py");
  const siteSrc = kokoroSitePackages(platform);
  mustExist(siteSrc, "tts/kokoro/.venv site-packages");

  const kokoroDst = path.join(out, "tts", "kokoro");
  fs.mkdirSync(kokoroDst, { recursive: true });
  for (const file of ["tts_server.py", "requirements.txt", "README.md"]) {
    const src = path.join(kokoroSrc, file);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(kokoroDst, file));
  }
  console.log("[prepare-app-resources] Copying kokoro site-packages...");
  copyFiltered(siteSrc, path.join(kokoroDst, "site-packages"));
}

async function prepareWinLinux(platform, accel) {
  if (platform !== process.platform) {
    throw new Error(
      `[prepare-app-resources] Cannot prepare ${platform} torch wheels on ${process.platform}. ` +
        `Run this script on the target OS (or CI runner).`
    );
  }

  mustExist(path.join(torchSrc, "tts_server.py"), "tts/torch/tts_server.py");

  const { pythonBin: portablePy, pythonPrefix } = await ensurePortablePython(platform);
  const venvPy = ensureTorchVenv(platform, accel, portablePy);
  const siteSrc = torchSitePackages(platform);
  mustExist(siteSrc, "tts/torch/.venv site-packages");
  ensureKokoroVenv(platform, accel);
  const pyBin = bundlePortablePython(pythonPrefix);
  console.log("[prepare-app-resources] Bundled python:", pyBin);

  const torchDst = path.join(out, "tts", "torch");
  fs.mkdirSync(torchDst, { recursive: true });
  for (const file of [
    "tts_server.py",
    "requirements.txt",
    "requirements-base.txt",
    "requirements-cuda.txt",
    "requirements-rocm.txt",
    "requirements-cpu.txt",
    "README.md",
  ]) {
    const src = path.join(torchSrc, file);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(torchDst, file));
  }
  console.log("[prepare-app-resources] Skipping models/ (downloaded on first launch)");
  console.log("[prepare-app-resources] Copying torch site-packages...");
  copyFiltered(siteSrc, path.join(torchDst, "site-packages"));
  bundleKokoroRuntime(platform);

  const pythonHome = path.join(out, "python");
  try {
    execFileSync(
      pyBin,
      [
        "-c",
        "import fastapi, uvicorn, torch; print('ok', torch.__version__, 'cuda', torch.cuda.is_available())",
      ],
      {
        env: {
          ...process.env,
          PYTHONHOME: pythonHome,
          PYTHONPATH: path.join(torchDst, "site-packages"),
          PYTHONNOUSERSITE: "1",
        },
        stdio: "inherit",
      }
    );
    execFileSync(
      pyBin,
      ["-c", "import fastapi, onnxruntime, kokoro_onnx; print('kokoro ok')"],
      {
        env: {
          ...process.env,
          PYTHONHOME: pythonHome,
          PYTHONPATH: path.join(out, "tts", "kokoro", "site-packages"),
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
}

async function main() {
  const { platform, accel } = parseArgs(process.argv.slice(2));
  console.log(
    `[prepare-app-resources] Preparing ${out} (platform=${platform}, accel=${accel})`
  );
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });

  seedCommon();
  writeAccelMeta(platform, accel);

  if (platform === "darwin") {
    prepareDarwin();
  } else {
    await prepareWinLinux(platform, accel);
  }

  let size = "?";
  try {
    size = execFileSync("du", ["-sh", out], { encoding: "utf8" }).trim();
  } catch {
    // du may be missing on Windows
  }
  console.log("[prepare-app-resources] Done:", size);
}

main().catch((err) => {
  console.error("[prepare-app-resources]", err?.message || err);
  process.exit(1);
});
