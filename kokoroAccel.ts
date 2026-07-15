/**
 * Probe whether Kokoro ONNX can actually use a GPU EP on this machine.
 * AMD needs system MIGraphX (libmigraphx_c); NVIDIA needs onnxruntime-gpu.
 */
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import type { KokoroDeviceId } from "./ttsEngine";

export type KokoroAccelProbe = {
  requested: KokoroDeviceId;
  /** Effective device the next session should get if libs are OK. */
  effective: "gpu" | "cpu";
  gpuReady: boolean;
  availableProviders: string[];
  hint: string | null;
};

const GPU_EPS = [
  "CUDAExecutionProvider",
  "MIGraphXExecutionProvider",
  "ROCMExecutionProvider",
  "DmlExecutionProvider",
  "CoreMLExecutionProvider",
];

function findMigraphxLib(): string | null {
  const roots = [
    process.env.ROCM_PATH,
    "/opt/rocm",
    "/opt/rocm-7.2.3",
    "/opt/rocm-7.2.1",
    "/opt/rocm-7.2",
    "/opt/rocm-6.3",
  ].filter(Boolean) as string[];

  for (const root of roots) {
    for (const name of ["libmigraphx_c.so.3", "libmigraphx_c.so"]) {
      const p = path.join(root, "lib", name);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

function findSharedLib(
  name: string,
  roots: string[] = ["/usr/lib", "/usr/lib64", "/opt/rocm/lib", "/opt/rocm/lib/migraphx/lib"]
): string | null {
  for (const root of roots) {
    const p = path.join(root, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function missingAmdGpuLibs(): string[] {
  const needed = [
    "libmigraphx_c.so.3",
    "libprotobuf.so.35.1.0",
    "libabsl_hash.so.2605.0.0",
  ];
  const missing: string[] = [];
  for (const name of needed) {
    if (name.startsWith("libmigraphx")) {
      if (!findMigraphxLib()) missing.push(name);
    } else if (!findSharedLib(name)) {
      missing.push(name);
    }
  }
  return missing;
}

function amdGpuHint(missing: string[]): string {
  if (missing.includes("libmigraphx_c.so.3")) {
    return "GPU AMD exige o pacote de sistema MIGraphX. No Arch: sudo pacman -S migraphx — depois reinicie o AuraReader.";
  }
  if (
    missing.some((m) => m.includes("libprotobuf") || m.includes("libabsl"))
  ) {
    return (
      "O MIGraphX do ROCm precisa de protobuf 35 + abseil recente. " +
      "No Arch: sudo pacman -S protobuf abseil-cpp — depois reinicie o AuraReader."
    );
  }
  return `Libs AMD ausentes: ${missing.join(", ")}.`;
}

function kokoroPython(auraRoot: string): string | null {
  const candidates = [
    path.join(auraRoot, "tts", "kokoro", ".venv", "bin", "python"),
    path.join(auraRoot, "tts", "kokoro", ".venv", "Scripts", "python.exe"),
    path.join(auraRoot, "tts", "kokoro", "site-packages"), // marker only
  ];
  for (const c of candidates.slice(0, 2)) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function listOrtProviders(auraRoot: string): string[] {
  const py = kokoroPython(auraRoot);
  if (!py) return [];
  try {
    const out = execFileSync(
      py,
      ["-c", "import onnxruntime as ort; print(','.join(ort.get_available_providers()))"],
      { encoding: "utf8", timeout: 15_000, env: { ...process.env } }
    ).trim();
    return out.split(",").map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** Extra dirs to prepend to LD_LIBRARY_PATH for MIGraphX / ROCm. */
export function kokoroGpuLibraryPath(): string {
  const extras: string[] = [];
  const lib = findMigraphxLib();
  if (lib) extras.push(path.dirname(lib));
  for (const root of [
    "/opt/rocm/lib",
    "/opt/rocm/lib64",
    "/opt/rocm/lib/migraphx/lib",
    "/usr/lib",
  ]) {
    if (fs.existsSync(root) && !extras.includes(root)) extras.push(root);
  }
  const existing = process.env.LD_LIBRARY_PATH || "";
  return [...extras, existing].filter(Boolean).join(path.delimiter);
}

export function probeKokoroAccel(
  auraRoot: string,
  requested: KokoroDeviceId
): KokoroAccelProbe {
  if (requested === "cpu") {
    return {
      requested,
      effective: "cpu",
      gpuReady: false,
      availableProviders: [],
      hint: null,
    };
  }

  const providers = listOrtProviders(auraRoot);
  const hasCuda = providers.includes("CUDAExecutionProvider");
  const hasMigraphx = providers.includes("MIGraphXExecutionProvider");
  const hasRocm = providers.includes("ROCMExecutionProvider");
  const hasDml = providers.includes("DmlExecutionProvider");
  const hasCoreMl = providers.includes("CoreMLExecutionProvider");
  const hasGpuEp = GPU_EPS.some((p) => providers.includes(p));

  if (!hasGpuEp) {
    return {
      requested,
      effective: "cpu",
      gpuReady: false,
      availableProviders: providers,
      hint:
        "O runtime ONNX do Kokoro foi instalado só com CPU. Rode: bun run setup:tts:kokoro -- --force --accel=rocm (AMD) ou --accel=cuda (NVIDIA).",
    };
  }

  if (hasMigraphx || hasRocm) {
    const missing = missingAmdGpuLibs();
    if (missing.length) {
      return {
        requested,
        effective: "cpu",
        gpuReady: false,
        availableProviders: providers,
        hint: amdGpuHint(missing),
      };
    }
    return {
      requested,
      effective: "gpu",
      gpuReady: true,
      availableProviders: providers,
      hint: null,
    };
  }

  if (hasCuda || hasDml || hasCoreMl) {
    return {
      requested,
      effective: "gpu",
      gpuReady: true,
      availableProviders: providers,
      hint: null,
    };
  }

  return {
    requested,
    effective: "cpu",
    gpuReady: false,
    availableProviders: providers,
    hint: "Nenhum execution provider de GPU utilizável foi encontrado.",
  };
}
