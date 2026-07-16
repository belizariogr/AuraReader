import React, { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  BookOpen,
  CheckCircle2,
  FileAudio,
  Image as ImageIcon,
  Loader2,
  Square,
  Upload,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.split(",")[1] || "");
    };
    reader.onerror = () => reject(new Error(`Erro ao ler ${file.name}`));
    reader.readAsDataURL(file);
  });
}

function detectDocType(file: File): "pdf" | "epub" {
  const ext = file.name.split(".").pop()?.toLowerCase();
  return ext === "epub" || file.type === "application/epub+zip" ? "epub" : "pdf";
}

function isPdfOrEpub(file: File): boolean {
  const ext = file.name.split(".").pop()?.toLowerCase();
  return (
    file.type === "application/pdf" ||
    ext === "pdf" ||
    ext === "epub" ||
    file.type === "application/epub+zip"
  );
}

function isCoverImage(file: File): boolean {
  const ext = file.name.split(".").pop()?.toLowerCase() || "";
  if (["jpg", "jpeg", "png", "webp", "gif", "bmp"].includes(ext)) return true;
  return file.type.startsWith("image/");
}

function isCoverSource(file: File): boolean {
  return isPdfOrEpub(file) || isCoverImage(file);
}

function detectCoverSourceType(file: File): "pdf" | "epub" | "image" {
  if (isCoverImage(file)) return "image";
  return detectDocType(file);
}

async function readConvertSse(
  res: Response,
  onStatus: (payload: {
    message?: string;
    percent?: number | null;
    stage?: string;
  }) => void,
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  if (signal?.aborted) {
    throw new DOMException("Conversão cancelada.", "AbortError");
  }

  if (!res.ok && !res.body) {
    const payload = await res.json().catch(() => ({}));
    throw new Error((payload as any).error || `Erro HTTP ${res.status}`);
  }

  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("text/event-stream")) {
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error || "Falha na conversão.");
    return payload;
  }

  if (!res.body) throw new Error("Resposta sem fluxo de progresso.");

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let donePayload: Record<string, unknown> | null = null;

  const onAbort = () => {
    void reader.cancel();
  };
  signal?.addEventListener("abort", onAbort);

  try {
    while (true) {
      if (signal?.aborted) {
        throw new DOMException("Conversão cancelada.", "AbortError");
      }
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        try {
          const payload = JSON.parse(trimmed.slice(6));
          if (payload.type === "status") {
            onStatus(payload);
          } else if (payload.type === "done") {
            donePayload = payload;
          } else if (payload.type === "error") {
            throw new Error(payload.error || "Erro na conversão.");
          }
        } catch (err: any) {
          if (err?.message && !err.message.startsWith("Unexpected")) throw err;
        }
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }

  if (signal?.aborted) {
    throw new DOMException("Conversão cancelada.", "AbortError");
  }
  if (!donePayload) throw new Error("A conversão terminou sem confirmação.");
  return donePayload;
}

function CoverPreviewBlock({
  previewUrl,
  loading,
  message,
}: {
  previewUrl: string | null;
  loading: boolean;
  message?: string | null;
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-black/20 p-4 flex flex-col items-center gap-3 min-h-[180px] justify-center">
      {loading ? (
        <Loader2 className="w-8 h-8 text-blue-400 animate-spin" />
      ) : previewUrl ? (
        <img
          src={previewUrl}
          alt="Preview da capa"
          className="max-h-56 max-w-full rounded-lg object-contain shadow-lg"
        />
      ) : (
        <div className="text-center text-slate-400 text-sm px-4">
          <ImageIcon className="w-8 h-8 mx-auto mb-2 opacity-40" />
          {message || "Sem preview da capa"}
        </div>
      )}
    </div>
  );
}

function ConvertWorkingScreen({
  title,
  fileLabel,
  stage,
  percent,
  message,
  accent,
  onCancel,
  cancelling,
}: {
  title: string;
  fileLabel: string;
  stage: string;
  percent: number | null;
  message: string | null;
  accent: "violet" | "amber";
  onCancel: () => void;
  cancelling: boolean;
}) {
  const showPct = percent != null && Number.isFinite(percent);
  const bar =
    accent === "violet"
      ? "from-violet-500 to-indigo-500 shadow-violet-500/20"
      : "from-amber-500 to-orange-500 shadow-amber-500/20";
  const ring =
    accent === "violet" ? "border-t-violet-500" : "border-t-amber-500";
  const soft =
    accent === "violet"
      ? "border-violet-500/25 bg-violet-500/10 text-violet-200"
      : "border-amber-500/25 bg-amber-500/10 text-amber-200";

  const steps =
    accent === "violet"
      ? [
          { id: "upload", label: "Envio dos arquivos" },
          { id: "cover", label: "Preparação da capa" },
          { id: "encode", label: "Conversão ffmpeg (AAC)" },
          { id: "save", label: "Salvar em Downloads" },
        ]
      : [
          { id: "upload", label: "Envio do M4B" },
          { id: "encode", label: "Extração do áudio MP3" },
          { id: "save", label: "Salvar em Downloads" },
        ];

  const stageOrder = steps.map((s) => s.id);
  const stageIdx = Math.max(0, stageOrder.indexOf(stage || "encode"));

  return (
    <motion.div
      key="converting"
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.98 }}
      className="max-w-2xl mx-auto bg-white/5 backdrop-blur-2xl border border-white/15 rounded-3xl shadow-2xl p-8 sm:p-12 text-center"
    >
      <div className="relative w-24 h-24 mx-auto mb-8 flex items-center justify-center">
        <div className="absolute inset-0 border-4 border-white/10 rounded-full animate-pulse" />
        <div
          className={`absolute inset-0 border-4 ${ring} border-transparent rounded-full animate-spin [animation-duration:1.2s]`}
        />
        <FileAudio
          className={`w-10 h-10 animate-bounce ${
            accent === "violet" ? "text-violet-400" : "text-amber-400"
          }`}
        />
      </div>

      <h3 className="text-xl font-bold text-white mb-2">{title}</h3>

      <div className={`max-w-md mx-auto mb-4 rounded-2xl border px-4 py-3 ${soft}`}>
        <p className="text-[11px] font-semibold uppercase tracking-wider opacity-80 mb-1">
          Arquivo
        </p>
        <p className="text-sm font-semibold text-white truncate" title={fileLabel}>
          {fileLabel}
        </p>
      </div>

      <p className="text-slate-300 text-sm max-w-md mx-auto mb-8">
        {message || "Processando… Isso pode levar alguns minutos em arquivos grandes."}
      </p>

      <div className="max-w-md mx-auto mb-8">
        <div className="flex justify-between text-xs text-slate-400 mb-2">
          <span>Progresso</span>
          <span
            className={`font-mono font-bold ${
              accent === "violet" ? "text-violet-400" : "text-amber-400"
            }`}
          >
            {showPct ? `${Math.round(percent!)}%` : "…"}
          </span>
        </div>
        <div className="w-full bg-slate-900 border border-white/10 rounded-full h-2 overflow-hidden">
          <motion.div
            className={`bg-gradient-to-r ${bar} h-full rounded-full shadow-lg`}
            initial={{ width: "0%" }}
            animate={{
              width: showPct
                ? `${Math.min(100, Math.max(0, percent!))}%`
                : "35%",
            }}
            transition={{ ease: "easeOut", duration: 0.25 }}
          />
        </div>
      </div>

      <div className="bg-slate-900/40 border border-white/10 rounded-2xl p-5 max-w-md mx-auto text-left space-y-3 mb-8">
        <span className="text-xs font-mono text-slate-400">Etapas do Processo</span>
        <hr className="border-white/5" />
        {steps.map((step, idx) => {
          const done = idx < stageIdx || (stage === "save" && showPct && percent! >= 100);
          const active = step.id === stage || (stage === "upload" && idx === 0 && !stage);
          return (
            <div key={step.id} className="flex items-center gap-3 text-sm">
              {done ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
              ) : active ? (
                <Loader2
                  className={`w-4 h-4 animate-spin shrink-0 ${
                    accent === "violet" ? "text-violet-400" : "text-amber-400"
                  }`}
                />
              ) : (
                <div className="w-4 h-4 rounded-full border border-white/20 shrink-0" />
              )}
              <span
                className={
                  active
                    ? "text-white font-medium animate-pulse"
                    : done
                      ? "text-slate-400"
                      : "text-slate-500"
                }
              >
                {step.label}
              </span>
            </div>
          );
        })}
      </div>

      <div className="max-w-md mx-auto">
        <button
          type="button"
          onClick={onCancel}
          disabled={cancelling}
          className="w-full bg-red-500/10 hover:bg-red-500/20 active:bg-red-500/30 border border-red-500/30 hover:border-red-500/50 disabled:opacity-50 disabled:cursor-not-allowed text-red-400 py-3 px-6 rounded-2xl text-sm font-semibold transition-all flex items-center justify-center gap-2 cursor-pointer"
        >
          {cancelling ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Cancelando…
            </>
          ) : (
            <>
              <Square className="w-4 h-4 fill-current" />
              Cancelar conversão
            </>
          )}
        </button>
        <p className="text-[11px] text-slate-400 mt-2">
          Interrompe o ffmpeg e descarta o arquivo parcial.
        </p>
      </div>
    </motion.div>
  );
}

export function ExtractCoverPanel() {
  const [file, setFile] = useState<File | null>(null);
  const [fileBase64, setFileBase64] = useState("");
  const [fileType, setFileType] = useState<"pdf" | "epub">("pdf");
  const [coverPage, setCoverPage] = useState("1");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewMsg, setPreviewMsg] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const previewBlobRef = useRef<string | null>(null);

  const clearPreview = () => {
    if (previewBlobRef.current) {
      URL.revokeObjectURL(previewBlobRef.current);
      previewBlobRef.current = null;
    }
    setPreviewUrl(null);
  };

  useEffect(() => {
    if (!fileBase64) return;
    const t = window.setTimeout(async () => {
      setPreviewLoading(true);
      setPreviewMsg(null);
      setError(null);
      try {
        const res = await fetch("/api/cover-preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fileData: fileBase64,
            fileType,
            coverPage: fileType === "pdf" ? coverPage : undefined,
          }),
        });
        const payload = await res.json();
        clearPreview();
        if (!res.ok || !payload.found) {
          setPreviewMsg(payload.error || payload.message || "Capa não encontrada");
          return;
        }
        const binary = atob(payload.imageData as string);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const url = URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
        previewBlobRef.current = url;
        setPreviewUrl(url);
      } catch (err: any) {
        setPreviewMsg(err?.message || "Falha no preview");
      } finally {
        setPreviewLoading(false);
      }
    }, 350);
    return () => window.clearTimeout(t);
  }, [fileBase64, fileType, coverPage]);

  useEffect(() => () => clearPreview(), []);

  const onPick = async (f: File | null) => {
    setError(null);
    setSuccess(null);
    clearPreview();
    if (!f || !isPdfOrEpub(f)) {
      setError("Selecione um PDF ou EPUB.");
      return;
    }
    setFile(f);
    setFileType(detectDocType(f));
    setCoverPage("1");
    setFileBase64(await fileToBase64(f));
  };

  const handleSave = async () => {
    if (!file || !fileBase64) return;
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch("/api/extract-cover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileData: fileBase64,
          fileType,
          coverPage: fileType === "pdf" ? coverPage : undefined,
          fileName: file.name,
        }),
      });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error || "Falha ao salvar a capa.");
      setSuccess(`Capa salva em Downloads: ${payload.fileName}`);
    } catch (err: any) {
      setError(err?.message || "Erro ao extrair capa.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-xl mx-auto space-y-6">
      <div>
        <h2 className="text-xl font-bold text-white mb-1">Extrair capa</h2>
        <p className="text-sm text-slate-400">
          Extrai a capa do PDF ou EPUB como JPEG e salva em Downloads.
        </p>
      </div>

      {error && (
        <div className="p-3 rounded-xl bg-rose-950/40 border border-rose-500/30 text-rose-200 text-sm flex gap-2">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          {error}
        </div>
      )}
      {success && (
        <div className="p-3 rounded-xl bg-emerald-950/40 border border-emerald-500/30 text-emerald-200 text-sm flex gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
          {success}
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept=".pdf,.epub,application/pdf,application/epub+zip"
        className="hidden"
        onChange={(e) => void onPick(e.target.files?.[0] ?? null)}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className="w-full rounded-2xl border border-dashed border-white/20 bg-white/5 hover:bg-white/10 px-6 py-10 text-center transition-colors"
      >
        <Upload className="w-8 h-8 mx-auto mb-2 text-blue-400" />
        <p className="text-sm font-medium text-white">
          {file ? file.name : "Escolher PDF ou EPUB"}
        </p>
      </button>

      {fileType === "pdf" && file && (
        <label className="block text-sm">
          <span className="text-slate-300 mb-1.5 block">Página da capa</span>
          <input
            type="number"
            min={1}
            value={coverPage}
            onChange={(e) => setCoverPage(e.target.value)}
            className="w-full rounded-xl bg-slate-900 border border-white/10 px-3 py-2 text-white"
          />
        </label>
      )}

      <CoverPreviewBlock
        previewUrl={previewUrl}
        loading={previewLoading}
        message={previewMsg}
      />

      <button
        type="button"
        disabled={!fileBase64 || saving || previewLoading}
        onClick={() => void handleSave()}
        className="w-full rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:pointer-events-none text-white font-semibold py-3 flex items-center justify-center gap-2"
      >
        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <ImageIcon className="w-4 h-4" />}
        Salvar capa em Downloads
      </button>
    </div>
  );
}

export function Mp3ToM4bPanel() {
  const [mp3File, setMp3File] = useState<File | null>(null);
  const [docFile, setDocFile] = useState<File | null>(null);
  const [docType, setDocType] = useState<"pdf" | "epub" | "image">("pdf");
  const [coverPage, setCoverPage] = useState("1");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewMsg, setPreviewMsg] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [docBase64, setDocBase64] = useState("");
  const [converting, setConverting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [progressPercent, setProgressPercent] = useState<number | null>(null);
  const [progressMessage, setProgressMessage] = useState<string | null>(null);
  const [progressStage, setProgressStage] = useState("upload");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const mp3Ref = useRef<HTMLInputElement>(null);
  const docRef = useRef<HTMLInputElement>(null);
  const previewBlobRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const clearPreview = () => {
    if (previewBlobRef.current) {
      URL.revokeObjectURL(previewBlobRef.current);
      previewBlobRef.current = null;
    }
    setPreviewUrl(null);
  };

  useEffect(() => {
    if (!docFile) return;
    if (docType === "image") {
      clearPreview();
      const url = URL.createObjectURL(docFile);
      previewBlobRef.current = url;
      setPreviewUrl(url);
      setPreviewMsg(null);
      setPreviewLoading(false);
      return;
    }
    if (!docBase64) return;
    const t = window.setTimeout(async () => {
      setPreviewLoading(true);
      setPreviewMsg(null);
      try {
        const res = await fetch("/api/cover-preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fileData: docBase64,
            fileType: docType,
            coverPage: docType === "pdf" ? coverPage : undefined,
          }),
        });
        const payload = await res.json();
        clearPreview();
        if (!res.ok || !payload.found) {
          setPreviewMsg(payload.error || "Capa não encontrada");
          return;
        }
        const binary = atob(payload.imageData as string);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const url = URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
        previewBlobRef.current = url;
        setPreviewUrl(url);
      } catch (err: any) {
        setPreviewMsg(err?.message || "Falha no preview");
      } finally {
        setPreviewLoading(false);
      }
    }, 350);
    return () => window.clearTimeout(t);
  }, [docFile, docBase64, docType, coverPage]);

  useEffect(() => () => clearPreview(), []);

  const handleCancel = () => {
    setCancelling(true);
    abortRef.current?.abort();
  };

  const handleConvert = async () => {
    if (!mp3File || !docFile) return;
    const abort = new AbortController();
    abortRef.current = abort;
    setConverting(true);
    setCancelling(false);
    setError(null);
    setSuccess(null);
    setProgressPercent(null);
    setProgressStage("upload");
    setProgressMessage("Enviando arquivos…");
    try {
      const form = new FormData();
      form.append("mp3", mp3File);
      form.append("cover", docFile);
      form.append("fileType", docType);
      if (docType === "pdf") form.append("coverPage", coverPage);
      form.append(
        "fileName",
        mp3File.name.replace(/\.[^/.]+$/, "") || docFile.name
      );
      const res = await fetch("/api/convert/mp3-to-m4b", {
        method: "POST",
        body: form,
        signal: abort.signal,
      });
      const payload = await readConvertSse(
        res,
        (status) => {
          setProgressMessage(status.message || "Convertendo…");
          setProgressPercent(
            typeof status.percent === "number" ? status.percent : null
          );
          if (status.stage) setProgressStage(status.stage);
        },
        abort.signal
      );
      setSuccess(
        `Salvo: ${payload.fileName}` +
          (payload.coverFileName ? ` + ${payload.coverFileName}` : "")
      );
    } catch (err: any) {
      if (err?.name === "AbortError" || /cancelad/i.test(String(err?.message || ""))) {
        setError("Conversão cancelada.");
      } else {
        setError(err?.message || "Erro na conversão.");
      }
    } finally {
      abortRef.current = null;
      setConverting(false);
      setCancelling(false);
      setProgressPercent(null);
      setProgressMessage(null);
      setProgressStage("upload");
    }
  };

  return (
    <AnimatePresence mode="wait">
      {converting ? (
        <ConvertWorkingScreen
          title="Convertendo MP3 → M4B"
          fileLabel={mp3File?.name || "áudio"}
          stage={progressStage}
          percent={progressPercent}
          message={progressMessage}
          accent="violet"
          onCancel={handleCancel}
          cancelling={cancelling}
        />
      ) : (
        <motion.div
          key="form"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          className="max-w-xl mx-auto space-y-6"
        >
          <div>
            <h2 className="text-xl font-bold text-white mb-1">MP3 → M4B</h2>
            <p className="text-sm text-slate-400">
              Junta um MP3 com uma capa (imagem, PDF ou EPUB) em um audiobook M4B.
            </p>
          </div>

          {error && (
            <div className="p-3 rounded-xl bg-rose-950/40 border border-rose-500/30 text-rose-200 text-sm flex gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              {error}
            </div>
          )}
          {success && (
            <div className="p-3 rounded-xl bg-emerald-950/40 border border-emerald-500/30 text-emerald-200 text-sm flex gap-2">
              <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
              {success}
            </div>
          )}

          <input
            ref={mp3Ref}
            type="file"
            accept=".mp3,audio/mpeg"
            className="hidden"
            onChange={(e) => setMp3File(e.target.files?.[0] ?? null)}
          />
          <input
            ref={docRef}
            type="file"
            accept=".pdf,.epub,.jpg,.jpeg,.png,.webp,.gif,.bmp,application/pdf,application/epub+zip,image/*"
            className="hidden"
            onChange={async (e) => {
              const f = e.target.files?.[0] ?? null;
              clearPreview();
              if (!f || !isCoverSource(f)) {
                setError("Selecione uma imagem, PDF ou EPUB para a capa.");
                return;
              }
              setError(null);
              setDocFile(f);
              setDocType(detectCoverSourceType(f));
              setDocBase64(await fileToBase64(f));
            }}
          />

          <button
            type="button"
            onClick={() => mp3Ref.current?.click()}
            className="w-full rounded-2xl border border-dashed border-white/20 bg-white/5 hover:bg-white/10 px-6 py-6 text-center"
          >
            <FileAudio className="w-7 h-7 mx-auto mb-2 text-violet-400" />
            <p className="text-sm font-medium text-white">
              {mp3File ? mp3File.name : "Escolher arquivo MP3"}
            </p>
          </button>

          <button
            type="button"
            onClick={() => docRef.current?.click()}
            className="w-full rounded-2xl border border-dashed border-white/20 bg-white/5 hover:bg-white/10 px-6 py-6 text-center"
          >
            {docType === "image" ? (
              <ImageIcon className="w-7 h-7 mx-auto mb-2 text-blue-400" />
            ) : (
              <BookOpen className="w-7 h-7 mx-auto mb-2 text-blue-400" />
            )}
            <p className="text-sm font-medium text-white">
              {docFile ? docFile.name : "Escolher capa (imagem, PDF ou EPUB)"}
            </p>
          </button>

          {docType === "pdf" && docFile && (
            <label className="block text-sm">
              <span className="text-slate-300 mb-1.5 block">Página da capa</span>
              <input
                type="number"
                min={1}
                value={coverPage}
                onChange={(e) => setCoverPage(e.target.value)}
                className="w-full rounded-xl bg-slate-900 border border-white/10 px-3 py-2 text-white"
              />
            </label>
          )}

          <CoverPreviewBlock
            previewUrl={previewUrl}
            loading={previewLoading}
            message={previewMsg}
          />

          <button
            type="button"
            disabled={!mp3File || !docFile}
            onClick={() => void handleConvert()}
            className="w-full rounded-xl bg-violet-600 hover:bg-violet-500 disabled:opacity-40 disabled:pointer-events-none text-white font-semibold py-3 flex items-center justify-center gap-2"
          >
            <FileAudio className="w-4 h-4" />
            Converter para M4B
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function M4bToMp3Panel() {
  const [m4bFile, setM4bFile] = useState<File | null>(null);
  const [converting, setConverting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [progressPercent, setProgressPercent] = useState<number | null>(null);
  const [progressMessage, setProgressMessage] = useState<string | null>(null);
  const [progressStage, setProgressStage] = useState("upload");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const handleCancel = () => {
    setCancelling(true);
    abortRef.current?.abort();
  };

  const handleConvert = async () => {
    if (!m4bFile) return;
    const abort = new AbortController();
    abortRef.current = abort;
    setConverting(true);
    setCancelling(false);
    setError(null);
    setSuccess(null);
    setProgressPercent(null);
    setProgressStage("upload");
    setProgressMessage("Enviando arquivo…");
    try {
      const form = new FormData();
      form.append("m4b", m4bFile);
      form.append("fileName", m4bFile.name);
      const res = await fetch("/api/convert/m4b-to-mp3", {
        method: "POST",
        body: form,
        signal: abort.signal,
      });
      const payload = await readConvertSse(
        res,
        (status) => {
          setProgressMessage(status.message || "Extraindo…");
          setProgressPercent(
            typeof status.percent === "number" ? status.percent : null
          );
          if (status.stage) setProgressStage(status.stage);
        },
        abort.signal
      );
      setSuccess(
        `Salvo: ${payload.fileName}` +
          (payload.coverFileName
            ? ` + ${payload.coverFileName}`
            : " (sem capa embutida)")
      );
    } catch (err: any) {
      if (err?.name === "AbortError" || /cancelad/i.test(String(err?.message || ""))) {
        setError("Conversão cancelada.");
      } else {
        setError(err?.message || "Erro na conversão.");
      }
    } finally {
      abortRef.current = null;
      setConverting(false);
      setCancelling(false);
      setProgressPercent(null);
      setProgressMessage(null);
      setProgressStage("upload");
    }
  };

  return (
    <AnimatePresence mode="wait">
      {converting ? (
        <ConvertWorkingScreen
          title="Convertendo M4B → MP3"
          fileLabel={m4bFile?.name || "audiobook"}
          stage={progressStage}
          percent={progressPercent}
          message={progressMessage}
          accent="amber"
          onCancel={handleCancel}
          cancelling={cancelling}
        />
      ) : (
        <motion.div
          key="form"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          className="max-w-xl mx-auto space-y-6"
        >
          <div>
            <h2 className="text-xl font-bold text-white mb-1">M4B → MP3</h2>
            <p className="text-sm text-slate-400">
              Extrai o áudio MP3 e a imagem de capa (se houver) de um M4B.
            </p>
          </div>

          {error && (
            <div className="p-3 rounded-xl bg-rose-950/40 border border-rose-500/30 text-rose-200 text-sm flex gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              {error}
            </div>
          )}
          {success && (
            <div className="p-3 rounded-xl bg-emerald-950/40 border border-emerald-500/30 text-emerald-200 text-sm flex gap-2">
              <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
              {success}
            </div>
          )}

          <input
            ref={inputRef}
            type="file"
            accept=".m4b,.m4a,audio/mp4,audio/x-m4b"
            className="hidden"
            onChange={(e) => setM4bFile(e.target.files?.[0] ?? null)}
          />
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="w-full rounded-2xl border border-dashed border-white/20 bg-white/5 hover:bg-white/10 px-6 py-10 text-center"
          >
            <FileAudio className="w-8 h-8 mx-auto mb-2 text-amber-400" />
            <p className="text-sm font-medium text-white">
              {m4bFile ? m4bFile.name : "Escolher arquivo M4B"}
            </p>
          </button>

          <button
            type="button"
            disabled={!m4bFile}
            onClick={() => void handleConvert()}
            className="w-full rounded-xl bg-amber-600 hover:bg-amber-500 disabled:opacity-40 disabled:pointer-events-none text-white font-semibold py-3 flex items-center justify-center gap-2"
          >
            <FileAudio className="w-4 h-4" />
            Converter para MP3 + capa
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
