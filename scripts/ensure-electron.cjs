/**
 * Ensures the Electron binary (incl. Frameworks) is present.
 * bun/@electron get sometimes leaves a partial extract; fall back to system unzip.
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.resolve(__dirname, "..");
const electronDir = path.join(root, "node_modules", "electron");
const distDir = path.join(electronDir, "dist");
const frameworkDir = path.join(distDir, "Electron.app", "Contents", "Frameworks");
const pathTxt = path.join(electronDir, "path.txt");
const platformPath = "Electron.app/Contents/MacOS/Electron";

function ok() {
  return fs.existsSync(frameworkDir) && fs.existsSync(path.join(distDir, platformPath));
}

if (ok()) {
  if (!fs.existsSync(pathTxt) || fs.readFileSync(pathTxt, "utf8") !== platformPath) {
    fs.writeFileSync(pathTxt, platformPath);
  }
  process.exit(0);
}

console.log("[ensure-electron] Electron Frameworks missing — repairing install...");

try {
  execFileSync(process.execPath, [path.join(electronDir, "install.js")], {
    cwd: electronDir,
    stdio: "inherit",
    env: { ...process.env, force_no_cache: "true" },
  });
} catch {
  // fall through to manual unzip
}

if (ok()) {
  fs.writeFileSync(pathTxt, platformPath);
  process.exit(0);
}

const cacheRoot = process.env.electron_config_cache || path.join(os.homedir(), "Library", "Caches", "electron");
const { version } = require(path.join(electronDir, "package.json"));
const zipName = `electron-v${version}-darwin-${process.arch}.zip`;

function findZip(dir, depth = 0) {
  if (!fs.existsSync(dir) || depth > 3) return null;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      const found = findZip(full, depth + 1);
      if (found) return found;
    } else if (name === zipName) {
      return full;
    }
  }
  return null;
}

const zipPath = findZip(cacheRoot);
if (!zipPath) {
  console.error(
    `[ensure-electron] Could not find ${zipName} under ${cacheRoot}.\n` +
      "Try: rm -rf node_modules/electron && bun install && node node_modules/electron/install.js"
  );
  process.exit(1);
}

fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });
execFileSync("unzip", ["-q", zipPath, "-d", distDir], { stdio: "inherit" });
fs.writeFileSync(pathTxt, platformPath);

if (!ok()) {
  console.error("[ensure-electron] Repair failed after unzip.");
  process.exit(1);
}

console.log("[ensure-electron] Electron repaired.");
