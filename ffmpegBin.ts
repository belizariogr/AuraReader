import fs from "fs";
import path from "path";

function exeName(name: "ffmpeg" | "ffprobe"): string {
  return process.platform === "win32" ? `${name}.exe` : name;
}

function candidateRoots(): string[] {
  const roots: string[] = [];
  if (process.env.AURA_ROOT) roots.push(path.resolve(process.env.AURA_ROOT));
  // Packaged resources: AURA_ROOT is …/Resources/aura
  // Dev / unpackaged: project root or build/app-resources after prepare
  roots.push(process.cwd());
  return [...new Set(roots)];
}

function candidatesFor(name: "ffmpeg" | "ffprobe"): string[] {
  const exe = exeName(name);
  const out: string[] = [];
  if (name === "ffmpeg" && process.env.FFMPEG_PATH) out.push(process.env.FFMPEG_PATH);
  if (name === "ffprobe" && process.env.FFPROBE_PATH) out.push(process.env.FFPROBE_PATH);
  for (const root of candidateRoots()) {
    out.push(path.join(root, "bin", exe));
    out.push(path.join(root, "build", "app-resources", "bin", exe));
  }
  return out;
}

/** Absolute path to bundled binary, or the bare command name for PATH lookup. */
export function resolveFfmpegBin(name: "ffmpeg" | "ffprobe"): string {
  for (const candidate of candidatesFor(name)) {
    try {
      if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // ignore
    }
  }
  return name;
}

export function ffmpegBin(): string {
  return resolveFfmpegBin("ffmpeg");
}

export function ffprobeBin(): string {
  return resolveFfmpegBin("ffprobe");
}
