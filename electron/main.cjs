/**
 * Electron main process for AuraReader.
 * Packaged builds use Resources/aura (self-contained). Dev uses the project tree.
 */
const { app, BrowserWindow, dialog, Menu, shell } = require("electron");
const { spawn, execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const http = require("http");
const os = require("os");

const APP_PORT = process.env.PORT || "3000";
const APP_URL = `http://127.0.0.1:${APP_PORT}`;
const TTS_PORT = process.env.TTS_PORT || process.env.DIA_PORT || "8765";
const TTS_URL = process.env.TTS_URL || process.env.DIA_URL || `http://127.0.0.1:${TTS_PORT}`;

const children = [];
let shuttingDown = false;
let mainWindow = null;

function log(...args) {
  console.log("[electron]", ...args);
}

function hasBundledAura(dir) {
  return (
    fs.existsSync(path.join(dir, "dist", "server.cjs")) &&
    fs.existsSync(path.join(dir, "dist", "index.html")) &&
    fs.existsSync(path.join(dir, "qwen3-tts-apple-silicon", "tts_server.py")) &&
    (fs.existsSync(path.join(dir, "qwen3-tts-apple-silicon", "site-packages")) ||
      fs.existsSync(
        path.join(dir, "qwen3-tts-apple-silicon", ".venv", "bin", "python")
      ))
  );
}

function hasProjectRoot(dir) {
  if (!dir || dir.includes(".asar")) return false;
  return fs.existsSync(
    path.join(dir, "qwen3-tts-apple-silicon", ".venv", "bin", "python")
  );
}

function seedDataFromBundle(auraRoot, dataDir) {
  const seed = path.join(auraRoot, "cache", "voice-previews");
  const dest = path.join(dataDir, "cache", "voice-previews");
  if (fs.existsSync(seed)) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(seed)) {
      const from = path.join(seed, name);
      const to = path.join(dest, name);
      if (!fs.existsSync(to)) {
        fs.copyFileSync(from, to);
      }
    }
  }

  const envSeed = path.join(auraRoot, ".env");
  const envDest = path.join(dataDir, ".env");
  if (fs.existsSync(envSeed) && !fs.existsSync(envDest)) {
    fs.copyFileSync(envSeed, envDest);
  }
}

function resolveAuraRoot() {
  if (process.env.AURA_ROOT) {
    return path.resolve(process.env.AURA_ROOT);
  }

  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, "aura");
    if (hasBundledAura(bundled)) return bundled;
    throw new Error(
      `Runtime embutido não encontrado em:\n${bundled}\n\nGere o app com: bun run dist:mac`
    );
  }

  const fromMain = path.resolve(__dirname, "..");
  if (hasBundledAura(fromMain) || hasProjectRoot(fromMain)) return fromMain;

  throw new Error("Pasta do projeto AuraReader não encontrada.");
}

function guiPath() {
  const extras = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(os.homedir(), ".bun", "bin"),
    path.join(os.homedir(), ".local", "bin"),
  ];
  const current = process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin";
  return [...extras, current].filter(Boolean).join(":");
}

function spawnInherit(command, args, { cwd, env, name }) {
  log(`launching ${name}: ${command} ${args.join(" ")}`);
  const child = spawn(command, args, {
    cwd,
    env: env || process.env,
    stdio: "inherit",
    shell: false,
  });
  children.push(child);
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    log(`${name} exited (code=${code}, signal=${signal}). Shutting down.`);
    dialog.showErrorBox(
      "AuraReader",
      `${name} encerrado inesperadamente (code=${code ?? "?"}). O app será fechado.`
    );
    shutdown(1);
  });
  return child;
}

function waitForUrl(url, timeoutMs, label) {
  const started = Date.now();
  let lastLog = 0;
  log(`waiting for ${label} at ${url} ...`);

  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 500) {
          log(`${label} is ready.`);
          resolve();
          return;
        }
        retry();
      });
      req.on("error", retry);
      req.setTimeout(2000, () => {
        req.destroy();
        retry();
      });
    };

    const retry = () => {
      if (Date.now() - started >= timeoutMs) {
        reject(new Error(`${label} did not become ready within ${timeoutMs / 1000}s`));
        return;
      }
      if (Date.now() - lastLog > 5000) {
        log(`still waiting for ${label}...`);
        lastLog = Date.now();
      }
      setTimeout(tick, 500);
    };

    tick();
  });
}

function resolveServerRunner(auraRoot) {
  const serverJs = path.join(auraRoot, "dist", "server.cjs");

  // Prefer Electron-as-Node so the .app does not depend on system bun/node.
  if (app.isPackaged || process.env.AURA_USE_ELECTRON_NODE === "1") {
    return {
      command: process.execPath,
      args: [serverJs],
      envExtra: { ELECTRON_RUN_AS_NODE: "1" },
    };
  }

  const pathEnv = guiPath();
  const candidates = [
    "/opt/homebrew/bin/bun",
    path.join(os.homedir(), ".bun", "bin", "bun"),
    "/usr/local/bin/bun",
    path.join(auraRoot, "node_modules", ".bin", "bun"),
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
  ];
  for (const command of candidates) {
    if (fs.existsSync(command)) {
      return { command, args: [serverJs], envExtra: { PATH: pathEnv } };
    }
  }

  try {
    const bun = execSync("which bun", {
      encoding: "utf8",
      env: { ...process.env, PATH: pathEnv },
    }).trim();
    if (bun && fs.existsSync(bun)) {
      return { command: bun, args: [serverJs], envExtra: { PATH: pathEnv } };
    }
  } catch {
    // fall through
  }

  // Last resort: Electron as Node even in dev
  return {
    command: process.execPath,
    args: [serverJs],
    envExtra: { ELECTRON_RUN_AS_NODE: "1", PATH: pathEnv },
  };
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
    }
  }
  setTimeout(() => {
    app.exit(code);
  }, 400);
}

function appIconPath() {
  const candidates = [
    path.join(process.resourcesPath || "", "icon.png"),
    path.join(process.resourcesPath || "", "icon.icns"),
    path.join(__dirname, "..", "assets", "icon.png"),
    path.join(__dirname, "..", "assets", "icon.icns"),
  ];
  return candidates.find((p) => p && fs.existsSync(p));
}

function createWindow() {
  const icon = appIconPath();
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    title: "AuraReader",
    show: false,
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.loadURL(APP_URL);
}

function buildMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "close" }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function startBackend(auraRoot) {
  if (!hasBundledAura(auraRoot) && !hasProjectRoot(auraRoot)) {
    throw new Error(`Runtime incompleto em:\n${auraRoot}`);
  }

  const dataDir = app.getPath("userData");
  fs.mkdirSync(path.join(dataDir, "cache", "voice-previews"), { recursive: true });
  seedDataFromBundle(auraRoot, dataDir);

  const pythonHome = path.join(
    auraRoot,
    "python",
    "Python.framework",
    "Versions",
    "3.12"
  );
  const modelsDir = path.join(dataDir, "models");
  fs.mkdirSync(modelsDir, { recursive: true });

  const runner = resolveServerRunner(auraRoot);
  spawnInherit(runner.command, runner.args, {
    cwd: auraRoot,
    name: "aura-app",
    env: {
      ...process.env,
      PATH: guiPath(),
      ...(runner.envExtra || {}),
      NODE_ENV: "production",
      AURA_ROOT: auraRoot,
      AURA_DATA_DIR: dataDir,
      AURA_PYTHON_HOME: fs.existsSync(pythonHome) ? pythonHome : "",
      QWEN_TTS_MODELS_DIR: modelsDir,
      TTS_URL,
      TTS_PORT: String(TTS_PORT),
      PORT: String(APP_PORT),
      QWEN_TTS_PRELOAD: process.env.QWEN_TTS_PRELOAD ?? "0",
      VOICE_PREVIEW_DIR: path.join(dataDir, "cache", "voice-previews"),
    },
  });

  await waitForUrl(`${APP_URL}/api/health`, 30_000, "AuraReader server");
}

app.whenReady().then(async () => {
  buildMenu();

  try {
    const auraRoot = resolveAuraRoot();
    log(`aura root: ${auraRoot}`);
    await startBackend(auraRoot);
    createWindow();
  } catch (err) {
    console.error("[electron] failed to start:", err);
    dialog.showErrorBox("AuraReader — falha ao iniciar", err?.message || String(err));
    shutdown(1);
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && !shuttingDown) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  shutdown(0);
});

app.on("before-quit", () => {
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
    }
  }
});

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
