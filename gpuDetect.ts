/**
 * Detect discrete/integrated GPUs on Windows / Linux for UI guidance.
 * macOS is skipped (MLX / Apple Silicon path).
 */
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";

export type GpuVendor = "nvidia" | "amd" | "intel" | "unknown";

export type GpuDevice = {
  name: string;
  vendor: GpuVendor;
};

export type GpuDetectResult = {
  /** Feature only applies to Windows/Linux Torch builds. */
  supported: boolean;
  devices: GpuDevice[];
  /** Best-effort primary discrete vendor (nvidia > amd > intel > unknown). */
  primary: GpuVendor | null;
  /** Suggested torch wheel / dist flavor. */
  recommendedAccel: "cuda" | "rocm" | "cpu" | null;
  /** Accel written into the packaged build (tts-accel.json), if any. */
  packagedAccel: "cuda" | "rocm" | "cpu" | "mlx" | null;
  summary: string;
};

function isTorchHost(platform = process.platform): boolean {
  return platform === "win32" || platform === "linux";
}

function classifyName(name: string): GpuVendor {
  const n = name.toLowerCase();
  if (
    /\bnvidia\b|\bgeforce\b|\bquadro\b|\btesla\b|\brtx\b|\bgt?x\s?\d/.test(n) ||
    n.includes("nvidia")
  ) {
    return "nvidia";
  }
  if (
    /\bamd\b|\bradeon\b|\brx\s?\d|\binstinct\b|\bfirepro\b|\bati\b/.test(n) ||
    n.includes("amd/")
  ) {
    return "amd";
  }
  if (/\bintel\b|\barc\b|\biris\b|\buhd graphics\b|\bhd graphics\b/.test(n)) {
    return "intel";
  }
  return "unknown";
}

function classifyPciVendorId(id: string): GpuVendor {
  const v = id.toLowerCase().replace(/^0x/, "");
  if (v === "10de") return "nvidia";
  if (v === "1002" || v === "1022") return "amd";
  if (v === "8086") return "intel";
  return "unknown";
}

function rankVendor(v: GpuVendor): number {
  if (v === "nvidia") return 3;
  if (v === "amd") return 2;
  if (v === "intel") return 1;
  return 0;
}

function pickPrimary(devices: GpuDevice[]): GpuVendor | null {
  if (!devices.length) return null;
  return [...devices].sort((a, b) => rankVendor(b.vendor) - rankVendor(a.vendor))[0]
    .vendor;
}

function recommendAccel(primary: GpuVendor | null): "cuda" | "rocm" | "cpu" | null {
  if (!primary) return "cpu";
  if (primary === "nvidia") return "cuda";
  if (primary === "amd") return "rocm";
  // Intel: no dedicated Aura build yet — CPU torch is the safe path.
  if (primary === "intel") return "cpu";
  return "cpu";
}

function vendorLabel(v: GpuVendor | null): string {
  if (v === "nvidia") return "NVIDIA";
  if (v === "amd") return "AMD";
  if (v === "intel") return "Intel";
  return "desconhecida";
}

function buildSummary(
  devices: GpuDevice[],
  primary: GpuVendor | null,
  recommendedAccel: "cuda" | "rocm" | "cpu" | null,
  packagedAccel: string | null
): string {
  if (!devices.length) {
    return "Nenhuma GPU detectada — o TTS usará CPU (mais lento).";
  }
  const names = devices.map((d) => d.name).join("; ");
  let msg = `GPU detectada: ${vendorLabel(primary)}`;
  if (devices.length === 1) {
    msg += ` (${devices[0].name})`;
  } else {
    msg += ` · ${devices.length} adaptadores (${names})`;
  }
  if (recommendedAccel === "cuda") {
    msg += ". Recomendado: build CUDA (NVIDIA).";
  } else if (recommendedAccel === "rocm") {
    msg += ". Recomendado: build ROCm (AMD).";
  } else if (recommendedAccel === "cpu") {
    msg +=
      primary === "intel"
        ? ". Intel GPU: use o build CPU (sem aceleração dedicada no AuraReader ainda)."
        : ". Recomendado: build CPU.";
  }
  if (packagedAccel && recommendedAccel && packagedAccel !== recommendedAccel) {
    msg += ` Este pacote é ${packagedAccel.toUpperCase()} — considere baixar o instalador ${recommendedAccel.toUpperCase()}.`;
  }
  return msg;
}

function readPackagedAccel(auraRoot: string): "cuda" | "rocm" | "cpu" | "mlx" | null {
  const metaPath = path.join(auraRoot, "tts-accel.json");
  try {
    if (!fs.existsSync(metaPath)) return null;
    const raw = JSON.parse(fs.readFileSync(metaPath, "utf8")) as { accel?: string };
    const accel = String(raw.accel || "").toLowerCase();
    if (accel === "cuda" || accel === "rocm" || accel === "cpu" || accel === "mlx") {
      return accel;
    }
  } catch {
    // ignore
  }
  return null;
}

function detectLinux(): GpuDevice[] {
  const devices: GpuDevice[] = [];
  const seen = new Set<string>();

  const push = (name: string, vendor?: GpuVendor) => {
    const cleaned = name.replace(/\s+/g, " ").trim();
    if (!cleaned || seen.has(cleaned.toLowerCase())) return;
    seen.add(cleaned.toLowerCase());
    devices.push({ name: cleaned, vendor: vendor || classifyName(cleaned) });
  };

  try {
    const out = execFileSync("lspci", ["-nn"], {
      encoding: "utf8",
      timeout: 4000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    for (const line of out.split("\n")) {
      if (!/VGA compatible controller|3D controller|Display controller/i.test(line)) {
        continue;
      }
      // e.g. 01:00.0 VGA ...: NVIDIA Corporation ... [10de:2206] (rev a1)
      const vendorMatch = line.match(/\[([0-9a-f]{4}):[0-9a-f]{4}\]/i);
      const vendor = vendorMatch
        ? classifyPciVendorId(vendorMatch[1])
        : classifyName(line);
      // "BB:DD.F VGA ... [0300]: Vendor Device [vvvv:dddd] (rev …)"
      const classSep = line.indexOf("]: ");
      const afterClass = classSep >= 0 ? line.slice(classSep + 3) : line;
      const namePart = afterClass
        .replace(/\s*\[[0-9a-f]{4}:[0-9a-f]{4}\].*$/i, "")
        .trim();
      push(namePart || line, vendor);
    }
  } catch {
    // lspci may be missing
  }

  // Fallback: DRM sysfs vendor IDs
  if (!devices.length) {
    try {
      const drmRoot = "/sys/class/drm";
      if (fs.existsSync(drmRoot)) {
        for (const name of fs.readdirSync(drmRoot)) {
          if (!/^card\d+$/.test(name)) continue;
          const vendorPath = path.join(drmRoot, name, "device", "vendor");
          const devicePath = path.join(drmRoot, name, "device", "device");
          if (!fs.existsSync(vendorPath)) continue;
          const vendorId = fs.readFileSync(vendorPath, "utf8").trim();
          const deviceId = fs.existsSync(devicePath)
            ? fs.readFileSync(devicePath, "utf8").trim()
            : "";
          const vendor = classifyPciVendorId(vendorId);
          push(`${vendorLabel(vendor)} GPU (${name}${deviceId ? ` ${deviceId}` : ""})`, vendor);
        }
      }
    } catch {
      // ignore
    }
  }

  return devices;
}

function detectWindows(): GpuDevice[] {
  const devices: GpuDevice[] = [];
  const seen = new Set<string>();

  const push = (name: string) => {
    const cleaned = name.replace(/\s+/g, " ").trim();
    if (!cleaned || /^name$/i.test(cleaned) || seen.has(cleaned.toLowerCase())) return;
    seen.add(cleaned.toLowerCase());
    devices.push({ name: cleaned, vendor: classifyName(cleaned) });
  };

  // Prefer PowerShell CIM (works without WMIC on newer Windows).
  try {
    const out = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name",
      ],
      {
        encoding: "utf8",
        timeout: 8000,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      }
    );
    for (const line of out.split(/\r?\n/)) push(line);
    if (devices.length) return devices;
  } catch {
    // fall through
  }

  try {
    const out = execFileSync(
      "wmic",
      ["path", "win32_VideoController", "get", "Name"],
      {
        encoding: "utf8",
        timeout: 8000,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      }
    );
    for (const line of out.split(/\r?\n/)) push(line);
  } catch {
    // ignore
  }

  return devices;
}

let cached: GpuDetectResult | null = null;

export function detectGpu(auraRoot?: string): GpuDetectResult {
  if (cached && !auraRoot) return cached;

  if (!isTorchHost()) {
    const result: GpuDetectResult = {
      supported: false,
      devices: [],
      primary: null,
      recommendedAccel: null,
      packagedAccel: null,
      summary: "",
    };
    cached = result;
    return result;
  }

  const devices =
    process.platform === "win32" ? detectWindows() : detectLinux();
  const primary = pickPrimary(devices);
  const recommendedAccel = recommendAccel(primary);
  const packagedAccel = auraRoot ? readPackagedAccel(auraRoot) : null;
  const result: GpuDetectResult = {
    supported: true,
    devices,
    primary,
    recommendedAccel,
    packagedAccel,
    summary: buildSummary(devices, primary, recommendedAccel, packagedAccel),
  };
  if (!auraRoot) cached = result;
  return result;
}
