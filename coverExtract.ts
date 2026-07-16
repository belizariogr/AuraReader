import fs from "fs";
import path from "path";
import os from "os";
import { spawn } from "child_process";
import { PDFDocument } from "pdf-lib";

export type CoverResult = {
  jpegPath: string;
  width: number;
  height: number;
  source: "pdf-page" | "epub-cover" | "epub-image";
};

export type EpubImageEntry = {
  href: string;
  mediaType: string;
  isCover: boolean;
  localPath: string;
};

function tmpDir(): string {
  const dir = path.join(os.tmpdir(), "aura-cover");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function uniqueTmp(ext: string): string {
  return path.join(
    tmpDir(),
    `cover-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${ext}`
  );
}

async function runFfmpeg(args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", ["-y", ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg falhou (código ${code}): ${stderr.slice(-800)}`));
    });
  });
}

/** Convert any image ffmpeg can read into a JPEG. */
export async function convertImageToJpeg(
  inputPath: string,
  outputPath?: string,
  quality = 2
): Promise<string> {
  const out = outputPath || uniqueTmp("jpg");
  await runFfmpeg(["-i", inputPath, "-q:v", String(quality), out]);
  return out;
}

async function renderPdfPageToJpeg(
  pdfBytes: Buffer,
  pageNumber: number
): Promise<{ jpegPath: string; width: number; height: number }> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const { createCanvas } = await import("@napi-rs/canvas");

  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(pdfBytes),
    useSystemFonts: true,
  });
  const doc = await loadingTask.promise;
  const total = doc.numPages;
  if (pageNumber < 1 || pageNumber > total) {
    throw new Error(`Página da capa ${pageNumber} está fora do intervalo (1–${total}).`);
  }

  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 2 });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const context = canvas.getContext("2d");

  await page.render({
    canvasContext: context as unknown as CanvasRenderingContext2D,
    viewport,
    canvas: canvas as unknown as HTMLCanvasElement,
  }).promise;

  const jpegPath = uniqueTmp("jpg");
  const jpegBuffer = canvas.toBuffer("image/jpeg", 85);
  await fs.promises.writeFile(jpegPath, jpegBuffer);

  return {
    jpegPath,
    width: Math.ceil(viewport.width),
    height: Math.ceil(viewport.height),
  };
}

function resolveZipPath(baseDir: string, href: string): string {
  const cleaned = href.replace(/^\//, "").split("#")[0];
  return path.normalize(path.join(baseDir, cleaned));
}

type OpfParsed = {
  opfDir: string;
  coverHref: string | null;
  images: { href: string; mediaType: string; isCover: boolean }[];
};

function parseOpf(opfXml: string, opfDir: string): OpfParsed {
  const images: { href: string; mediaType: string; isCover: boolean }[] = [];
  let coverId: string | null = null;
  let coverHref: string | null = null;

  const metaCover = opfXml.match(
    /<meta[^>]*name=["']cover["'][^>]*content=["']([^"']+)["'][^>]*\/?>/i
  );
  if (metaCover) coverId = metaCover[1];

  const itemRe =
    /<item\b([^>]*)\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(opfXml))) {
    const attrs = m[1];
    const id = attrs.match(/\bid=["']([^"']+)["']/i)?.[1] || "";
    const href = attrs.match(/\bhref=["']([^"']+)["']/i)?.[1] || "";
    const mediaType = attrs.match(/\bmedia-type=["']([^"']+)["']/i)?.[1] || "";
    const properties = attrs.match(/\bproperties=["']([^"']+)["']/i)?.[1] || "";
    if (!href || !mediaType.startsWith("image/")) continue;
    const isCover =
      properties.split(/\s+/).includes("cover-image") ||
      (coverId != null && id === coverId);
    if (isCover) coverHref = href;
    images.push({ href, mediaType, isCover });
  }

  if (!coverHref && images.length > 0) {
    const named = images.find((i) => /cover/i.test(i.href));
    if (named) {
      named.isCover = true;
      coverHref = named.href;
    }
  }

  return { opfDir, coverHref, images };
}

async function extractEpubZip(epubPath: string, destDir: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("unzip", ["-o", "-q", epubPath, "-d", destDir], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      // unzip returns 1 for warnings (e.g. backslash paths) — still ok if files exist
      if (code === 0 || code === 1) resolve();
      else reject(new Error(`Falha ao abrir EPUB (unzip ${code}): ${stderr.slice(-400)}`));
    });
  });
}

function findOpfPath(extractRoot: string): string {
  const containerPath = path.join(extractRoot, "META-INF", "container.xml");
  if (fs.existsSync(containerPath)) {
    const xml = fs.readFileSync(containerPath, "utf8");
    const fullPath = xml.match(/full-path=["']([^"']+)["']/i)?.[1];
    if (fullPath) return path.join(extractRoot, fullPath);
  }
  // Fallback: first .opf
  const walk = (dir: string): string | null => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) {
        const found = walk(p);
        if (found) return found;
      } else if (name.toLowerCase().endsWith(".opf")) {
        return p;
      }
    }
    return null;
  };
  const found = walk(extractRoot);
  if (!found) throw new Error("Não foi possível localizar o arquivo OPF do EPUB.");
  return found;
}

export async function extractEpubImages(
  epubBytes: Buffer
): Promise<{ extractDir: string; coverJpegPath: string | null; artworks: string[] }> {
  const extractDir = path.join(tmpDir(), `epub-${Date.now().toString(36)}`);
  fs.mkdirSync(extractDir, { recursive: true });
  const epubPath = path.join(extractDir, "book.epub");
  await fs.promises.writeFile(epubPath, epubBytes);
  await extractEpubZip(epubPath, extractDir);

  const opfPath = findOpfPath(extractDir);
  const opfDir = path.dirname(opfPath);
  const opfXml = await fs.promises.readFile(opfPath, "utf8");
  const parsed = parseOpf(opfXml, opfDir);

  const artworks: string[] = [];
  let coverJpegPath: string | null = null;

  for (const img of parsed.images) {
    const src = resolveZipPath(opfDir, img.href);
    if (!fs.existsSync(src)) continue;
    try {
      const jpeg = await convertImageToJpeg(src);
      // Skip tiny icons (< 64px on either side) — probe via ffprobe if available, else keep
      const dims = await probeImageSize(jpeg);
      if (dims && (dims.width < 64 || dims.height < 64)) {
        await fs.promises.unlink(jpeg).catch(() => undefined);
        continue;
      }
      artworks.push(jpeg);
      if (img.isCover || (!coverJpegPath && img.href === parsed.coverHref)) {
        coverJpegPath = jpeg;
      }
    } catch (err) {
      console.warn(`[Cover] Skip EPUB image ${img.href}:`, (err as Error)?.message || err);
    }
  }

  if (!coverJpegPath && artworks.length > 0) {
    coverJpegPath = artworks[0];
  }

  return { extractDir, coverJpegPath, artworks };
}

async function probeImageSize(
  imagePath: string
): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const child = spawn(
      "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height",
        "-of",
        "csv=p=0:s=x",
        imagePath,
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    let out = "";
    child.stdout?.on("data", (d) => {
      out += String(d);
    });
    child.on("error", () => resolve(null));
    child.on("close", () => {
      const m = out.trim().match(/^(\d+)x(\d+)/);
      if (!m) return resolve(null);
      resolve({ width: Number(m[1]), height: Number(m[2]) });
    });
  });
}

export async function extractCoverFromPdf(
  pdfBytes: Buffer,
  coverPage: number
): Promise<CoverResult> {
  const rendered = await renderPdfPageToJpeg(pdfBytes, coverPage);
  return {
    jpegPath: rendered.jpegPath,
    width: rendered.width,
    height: rendered.height,
    source: "pdf-page",
  };
}

export async function extractCoverFromEpub(epubBytes: Buffer): Promise<CoverResult> {
  const { coverJpegPath, artworks } = await extractEpubImages(epubBytes);
  if (!coverJpegPath) {
    throw new Error("Capa não encontrada neste EPUB.");
  }
  const dims = (await probeImageSize(coverJpegPath)) || { width: 0, height: 0 };
  // Prefer cover; artworks[0] already used as fallback inside extractEpubImages
  void artworks;
  return {
    jpegPath: coverJpegPath,
    width: dims.width,
    height: dims.height,
    source: "epub-cover",
  };
}

export async function extractCover(opts: {
  fileData: string;
  fileType: "pdf" | "epub";
  coverPage?: number | null;
}): Promise<CoverResult> {
  const bytes = Buffer.from(opts.fileData, "base64");
  if (opts.fileType === "pdf") {
    const page = opts.coverPage == null || opts.coverPage < 1 ? 1 : Math.floor(opts.coverPage);
    return extractCoverFromPdf(bytes, page);
  }
  return extractCoverFromEpub(bytes);
}

export async function coverToBase64Jpeg(jpegPath: string): Promise<{
  imageData: string;
  mimeType: string;
  width: number;
  height: number;
}> {
  const buf = await fs.promises.readFile(jpegPath);
  const dims = (await probeImageSize(jpegPath)) || { width: 0, height: 0 };
  return {
    imageData: buf.toString("base64"),
    mimeType: "image/jpeg",
    width: dims.width,
    height: dims.height,
  };
}

/** Validate PDF page count quickly with pdf-lib. */
export async function getPdfPageCount(pdfBytes: Buffer): Promise<number> {
  const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  return doc.getPageCount();
}
