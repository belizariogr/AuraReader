/**
 * Electron main process for AuraReader.
 * Starts Express quickly and opens a native window; Qwen TTS starts on first use.
 */
const { app, BrowserWindow, dialog, Menu, shell } = require("electron");
const { spawn, execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const http = require("http");

const APP_PORT = process.env.PORT || "3000";
const APP_URL = `http://127.0.0.1:${APP_PORT}`;
const TTS_PORT = process.env.TTS_PORT || process.env.DIA_PORT || "8765";
const TTS_URL = process.env.TTS_URL || process.env.DIA_URL || `http://127.0.0.1:${TTS_PORT}`;

const children = [];
let shuttingDown = false;
let mainWindow = null;

function resolveRoot() {
  if (process.env.AURA_ROOT) {
    return path.resolve(process.env.AURA_ROOT);
  }

  const fromMain = path.resolve(__dirname, "..");
  if (hasProjectRoot(fromMain)) {
    return fromMain;
  }

  if (app.isPackaged) {
    let dir = path.dirname(process.execPath);
    for (let i = 0; i < 8; i++) {
      dir = path.dirname(dir);
      if (hasProjectRoot(dir)) {
        return dir;
      }
    }
  }

  return fromMain;
}

function hasProjectRoot(dir) {
  return fs.existsSync(path.join(dir, "qwen3-tts-apple-silicon", ".venv", "bin", "python"));
}

function log(...args) {
  console.log("[electron]", ...args);
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

function resolveNodeRunner(root) {
  try {
    const bun = execSync("which bun", { encoding: "utf8" }).trim();
    if (bun && fs.existsSync(bun)) {
      return { command: bun, args: ["dist/server.cjs"] };
    }
  } catch {
    // fall through
  }

  try {
    const node = execSync("which node", { encoding: "utf8" }).trim();
    if (node && fs.existsSync(node)) {
      return { command: node, args: ["dist/server.cjs"] };
    }
  } catch {
    // fall through
  }

  const bunLocal = path.join(root, "node_modules", ".bin", "bun");
  if (fs.existsSync(bunLocal)) {
    return { command: bunLocal, args: ["dist/server.cjs"] };
  }

  throw new Error("Neither bun nor node found on PATH. Install Node.js or Bun to run AuraReader.");
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
    path.join(__dirname, "..", "build", "icon.png"),
    path.join(__dirname, "..", "build", "icon.icns"),
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

async function startBackend(root) {
  const qwenPython = path.join(root, "qwen3-tts-apple-silicon", ".venv", "bin", "python");
  const serverJs = path.join(root, "dist", "server.cjs");
  const distIndex = path.join(root, "dist", "index.html");

  if (!fs.existsSync(qwenPython)) {
    throw new Error(
      `Python venv não encontrado em:\n${qwenPython}\n\nDefina AURA_ROOT para a pasta do projeto AuraReader (com qwen3-tts-apple-silicon/.venv).`
    );
  }
  if (!fs.existsSync(serverJs) || !fs.existsSync(distIndex)) {
    throw new Error(
      `Build de produção ausente em ${path.join(root, "dist")}.\nRode: bun run build`
    );
  }

  // TTS starts lazily inside the Express server on first narrate/preview.
  const runner = resolveNodeRunner(root);
  spawnInherit(runner.command, runner.args, {
    cwd: root,
    name: "aura-app",
    env: {
      ...process.env,
      NODE_ENV: "production",
      TTS_URL,
      TTS_PORT: String(TTS_PORT),
      PORT: String(APP_PORT),
      QWEN_TTS_PRELOAD: process.env.QWEN_TTS_PRELOAD ?? "0",
    },
  });

  await waitForUrl(`${APP_URL}/api/health`, 30_000, "AuraReader server");
}

app.whenReady().then(async () => {
  buildMenu();

  const root = resolveRoot();
  log(`project root: ${root}`);

  try {
    await startBackend(root);
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
