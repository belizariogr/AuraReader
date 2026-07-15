import { useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import {
  AlertCircle,
  CheckCircle2,
  CircleStop,
  Cpu,
  Download,
  HardDrive,
  Loader2,
  Sparkles,
  Trash2,
} from "lucide-react";

type ModelInfo = {
  id: string;
  folder: string;
  label: string;
  present: boolean;
  approxBytes: number;
};

type GpuInfo = {
  supported: boolean;
  devices: Array<{ name: string; vendor: string }>;
  primary: "nvidia" | "amd" | "intel" | "unknown" | null;
  recommendedAccel: "cuda" | "rocm" | "cpu" | null;
  packagedAccel: "cuda" | "rocm" | "cpu" | "mlx" | null;
  summary: string;
};

type ProgressState = {
  modelId?: string;
  modelLabel?: string;
  file?: string;
  fileIndex?: number;
  fileCount?: number;
  fileDownloadedBytes: number;
  fileTotalBytes: number;
  filePercent: number;
  downloadedBytes: number;
  totalBytes: number;
  percent: number;
  bytesPerSecond: number;
  etaLabel?: string | null;
  phase: string;
};

function formatBytes(n: number): string {
  if (!n || n < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatSpeed(bps: number): string {
  if (!bps || bps < 1) return "—";
  return `${formatBytes(bps)}/s`;
}

function vendorBadge(primary: GpuInfo["primary"]): {
  label: string;
  className: string;
} {
  if (primary === "nvidia") {
    return {
      label: "NVIDIA",
      className: "bg-emerald-500/15 text-emerald-300 border-emerald-400/25",
    };
  }
  if (primary === "amd") {
    return {
      label: "AMD",
      className: "bg-rose-500/15 text-rose-300 border-rose-400/25",
    };
  }
  if (primary === "intel") {
    return {
      label: "Intel",
      className: "bg-sky-500/15 text-sky-300 border-sky-400/25",
    };
  }
  return {
    label: "GPU não identificada",
    className: "bg-slate-500/15 text-slate-300 border-white/10",
  };
}

const emptyProgress = (): ProgressState => ({
  fileDownloadedBytes: 0,
  fileTotalBytes: 0,
  filePercent: 0,
  downloadedBytes: 0,
  totalBytes: 0,
  percent: 0,
  bytesPerSecond: 0,
  etaLabel: null,
  phase: "Aguardando",
});

export default function ModelSetup({
  models,
  modelsDir,
  gpu: gpuProp,
  backend,
  onComplete,
  onStatusChange,
}: {
  models: ModelInfo[];
  modelsDir: string;
  gpu?: GpuInfo | null;
  backend?: "torch" | "mlx";
  onComplete: () => void;
  onStatusChange?: (
    models: ModelInfo[],
    modelsDir: string,
    extra?: { gpu?: GpuInfo | null; backend?: string }
  ) => void;
}) {
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [localModels, setLocalModels] = useState(models);
  const [localDir, setLocalDir] = useState(modelsDir);
  const [gpu, setGpu] = useState<GpuInfo | null | undefined>(gpuProp);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProgressState>(emptyProgress);
  const [overall, setOverall] = useState({ current: 0, total: models.length });

  useEffect(() => {
    setGpu(gpuProp);
  }, [gpuProp]);

  const missing = useMemo(() => localModels.filter((m) => !m.present), [localModels]);
  const present = useMemo(() => localModels.filter((m) => m.present), [localModels]);
  const approxTotal = useMemo(
    () => missing.reduce((sum, m) => sum + (m.approxBytes || 0), 0),
    [missing]
  );

  const showGpu = Boolean(gpu?.supported);
  const isTorch = backend === "torch" || showGpu;
  const badge = vendorBadge(gpu?.primary ?? null);
  const accelMismatch =
    showGpu &&
    gpu?.packagedAccel &&
    gpu?.recommendedAccel &&
    gpu.packagedAccel !== "mlx" &&
    gpu.packagedAccel !== gpu.recommendedAccel;

  async function refreshStatus() {
    const res = await fetch("/api/models/status");
    const body = await res.json();
    if (body.models) {
      setLocalModels(body.models);
      onStatusChange?.(body.models, body.modelsDir || localDir, {
        gpu: body.gpu ?? null,
        backend: body.backend,
      });
    }
    if (body.modelsDir) setLocalDir(body.modelsDir);
    if (body.gpu) setGpu(body.gpu);
    return body;
  }

  const allReady = localModels.every((m) => m.present);

  async function cancelDownload() {
    try {
      await fetch("/api/models/download/cancel", { method: "POST" });
      setProgress((p) => ({ ...p, phase: "Cancelando…" }));
    } catch {
      // ignore
    }
  }

  async function removeModels(ids?: string[]) {
    const label = ids?.length
      ? `Excluir ${ids.join(", ")}?`
      : "Excluir todos os modelos baixados?";
    if (!window.confirm(`${label}\n\nSerá necessário baixar de novo para narrar.`)) return;

    setDeleting(ids?.join(",") || "all");
    setError(null);
    try {
      const q = ids?.length ? `?id=${encodeURIComponent(ids.join(","))}` : "";
      const res = await fetch(`/api/models${q}`, { method: "DELETE" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      if (body.status?.models) {
        setLocalModels(body.status.models);
        onStatusChange?.(body.status.models, body.status.modelsDir || localDir, {
          gpu: body.status.gpu ?? gpu ?? null,
          backend: body.status.backend,
        });
      }
      if (body.status?.modelsDir) setLocalDir(body.status.modelsDir);
      if (body.status?.gpu) setGpu(body.status.gpu);
      setProgress(emptyProgress());
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setDeleting(null);
    }
  }

  async function startDownload() {
    setDownloading(true);
    setError(null);
    setProgress({
      ...emptyProgress(),
      phase: "Conectando ao Hugging Face…",
    });
    setOverall({ current: 0, total: Math.max(1, missing.length || localModels.length) });

    try {
      const res = await fetch("/api/models/download", { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Falha ao iniciar download (HTTP ${res.status})`);
      }
      if (!res.body) throw new Error("Resposta sem stream de progresso.");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let completedModels = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          let evt: any;
          try {
            evt = JSON.parse(line);
          } catch {
            continue;
          }

          if (evt.type === "model_start") {
            setOverall((o) => ({ ...o, current: completedModels + 1 }));
            setProgress({
              ...emptyProgress(),
              modelId: evt.model,
              modelLabel: evt.label || evt.model,
              totalBytes: evt.totalBytes || 0,
              phase: `Baixando ${evt.label || evt.model}`,
            });
          } else if (evt.type === "model_skip") {
            completedModels += 1;
            setLocalModels((prev) =>
              prev.map((m) => (m.id === evt.model ? { ...m, present: true } : m))
            );
            setOverall((o) => ({ ...o, current: completedModels }));
          } else if (evt.type === "file_start") {
            setProgress((prev) => ({
              ...prev,
              modelId: evt.model,
              modelLabel: evt.label || prev.modelLabel,
              file: evt.file,
              fileIndex: evt.fileIndex,
              fileCount: evt.fileCount,
              fileDownloadedBytes: 0,
              fileTotalBytes: evt.fileBytes || 0,
              filePercent: 0,
              downloadedBytes: evt.downloadedBytes || prev.downloadedBytes,
              totalBytes: evt.totalBytes || prev.totalBytes,
              percent: typeof evt.percent === "number" ? evt.percent : prev.percent,
              phase: "Baixando arquivo",
            }));
          } else if (evt.type === "progress") {
            setProgress((prev) => ({
              ...prev,
              modelId: evt.model,
              modelLabel: evt.label || prev.modelLabel,
              file: evt.file,
              fileIndex: evt.fileIndex,
              fileCount: evt.fileCount,
              fileDownloadedBytes: evt.fileDownloadedBytes || 0,
              fileTotalBytes: evt.fileTotalBytes || 0,
              filePercent: typeof evt.filePercent === "number" ? evt.filePercent : 0,
              downloadedBytes: evt.downloadedBytes || 0,
              totalBytes: evt.totalBytes || 0,
              percent: typeof evt.percent === "number" ? evt.percent : 0,
              bytesPerSecond: evt.bytesPerSecond || 0,
              etaLabel: evt.etaLabel ?? null,
              phase: "Baixando",
            }));
          } else if (evt.type === "file_done") {
            setProgress((prev) => ({
              ...prev,
              file: evt.file,
              fileIndex: evt.fileIndex,
              fileCount: evt.fileCount,
              filePercent: 100,
              downloadedBytes: evt.downloadedBytes || prev.downloadedBytes,
              totalBytes: evt.totalBytes || prev.totalBytes,
              percent: typeof evt.percent === "number" ? evt.percent : prev.percent,
              bytesPerSecond: evt.bytesPerSecond || prev.bytesPerSecond,
              etaLabel: evt.etaLabel ?? prev.etaLabel,
              phase: "Arquivo concluído",
            }));
          } else if (evt.type === "model_done") {
            completedModels += 1;
            setLocalModels((prev) =>
              prev.map((m) => (m.id === evt.model ? { ...m, present: true } : m))
            );
            setOverall((o) => ({ ...o, current: completedModels }));
            setProgress((p) => ({
              ...p,
              percent: 100,
              filePercent: 100,
              phase: `${evt.label || evt.model} pronto`,
            }));
          } else if (evt.type === "done") {
            await refreshStatus();
            setDownloading(false);
            setProgress((p) => ({ ...p, phase: "Download concluído", percent: 100 }));
            return;
          } else if (evt.type === "cancelled") {
            setError(evt.message || "Download cancelado.");
            setDownloading(false);
            setProgress((p) => ({ ...p, phase: "Cancelado" }));
            await refreshStatus().catch(() => undefined);
            return;
          } else if (evt.type === "error") {
            throw new Error(evt.message || "Erro no download");
          }
        }
      }

      const finalStatus = await refreshStatus();
      setDownloading(false);
      if (!finalStatus.ready) {
        throw new Error("Download terminou, mas os modelos ainda estão incompletos.");
      }
    } catch (err: any) {
      setError(err?.message || String(err));
      setDownloading(false);
      await refreshStatus().catch(() => undefined);
    }
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans selection:bg-blue-500/30 relative flex flex-col">
      <div className="pointer-events-none absolute inset-0 overflow-clip" aria-hidden>
        <div className="absolute top-[-100px] left-[-100px] w-[500px] h-[500px] bg-blue-600/15 rounded-full blur-[120px]" />
        <div className="absolute bottom-[-100px] right-[-100px] w-[600px] h-[600px] bg-indigo-600/15 rounded-full blur-[150px]" />
      </div>

      <header className="relative z-10 backdrop-blur-md bg-slate-950/40 border-b border-white/10 px-6 py-4">
        <div className="max-w-3xl mx-auto flex items-center gap-3">
          <div className="bg-gradient-to-br from-blue-500 to-indigo-600 text-white p-2.5 rounded-xl">
            <Sparkles className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight">AuraReader</h1>
            <p className="text-xs text-slate-400">Instalação dos modelos de voz</p>
          </div>
        </div>
      </header>

      <main className="relative z-10 flex-1 flex items-center justify-center px-6 py-12">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          className="w-full max-w-xl bg-white/5 border border-white/10 backdrop-blur-2xl rounded-3xl p-8 shadow-2xl"
        >
          <div className="flex items-start gap-3 mb-6">
            <div className="p-2 rounded-xl bg-amber-500/15 text-amber-300 border border-amber-400/20">
              <HardDrive className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-white mb-1">Modelos TTS necessários</h2>
              <p className="text-sm text-slate-300 leading-relaxed">
                Os pesos do Qwen3-TTS não vêm no aplicativo. Na primeira vez é preciso baixá-los
                (~{formatBytes(approxTotal || 4_000_000_000)})
                {isTorch ? " para este computador" : " para o seu Mac"}. Depois ficam salvos
                localmente e não precisam ser baixados de novo.
              </p>
            </div>
          </div>

          {showGpu && (
            <div className="mb-6 rounded-2xl border border-white/10 bg-slate-900/50 p-4 space-y-3">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="inline-flex items-center gap-1.5 text-xs text-slate-400">
                  <Cpu className="w-3.5 h-3.5" />
                  Placa de vídeo
                </span>
                <span
                  className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${badge.className}`}
                >
                  {badge.label}
                </span>
                {gpu?.recommendedAccel && (
                  <span className="inline-flex items-center rounded-full border border-white/10 bg-white/5 px-2.5 py-0.5 text-[11px] text-slate-300 font-mono">
                    sugerido: {gpu.recommendedAccel.toUpperCase()}
                  </span>
                )}
                {gpu?.packagedAccel && gpu.packagedAccel !== "mlx" && (
                  <span className="inline-flex items-center rounded-full border border-white/10 bg-white/5 px-2.5 py-0.5 text-[11px] text-slate-400 font-mono">
                    este app: {gpu.packagedAccel.toUpperCase()}
                  </span>
                )}
              </div>
              {gpu?.devices?.length ? (
                <ul className="space-y-1">
                  {gpu.devices.map((d) => (
                    <li key={d.name} className="text-xs text-slate-300 font-mono truncate">
                      {d.name}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-slate-400">Nenhuma GPU detectada.</p>
              )}
              {gpu?.summary && (
                <p className="text-xs text-slate-400 leading-relaxed">{gpu.summary}</p>
              )}
              {accelMismatch && (
                <p className="text-xs text-amber-200/90 leading-relaxed">
                  A GPU sugere o build {gpu!.recommendedAccel!.toUpperCase()}, mas este pacote é{" "}
                  {gpu!.packagedAccel!.toUpperCase()}. A narração ainda funciona (com fallback para
                  CPU se a aceleração não bater), mas o desempenho pode ficar abaixo do ideal.
                </p>
              )}
            </div>
          )}

          <ul className="space-y-3 mb-6">
            {localModels.map((m) => (
              <li
                key={m.id}
                className="flex items-center justify-between gap-3 rounded-2xl border border-white/10 bg-slate-900/40 px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-white">{m.label}</p>
                  <p className="text-xs text-slate-400 font-mono mt-0.5 truncate">{m.folder}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {m.present ? (
                    <>
                      <span className="inline-flex items-center gap-1.5 text-xs text-emerald-300">
                        <CheckCircle2 className="w-4 h-4" /> Pronto
                      </span>
                      <button
                        type="button"
                        disabled={downloading || deleting !== null}
                        onClick={() => removeModels([m.id])}
                        className="p-1.5 rounded-lg text-slate-400 hover:text-rose-300 hover:bg-rose-500/10 disabled:opacity-40"
                        title="Excluir este modelo"
                      >
                        {deleting === m.id ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Trash2 className="w-4 h-4" />
                        )}
                      </button>
                    </>
                  ) : (
                    <span className="text-xs text-amber-200/90">Pendente</span>
                  )}
                </div>
              </li>
            ))}
          </ul>

          <p className="text-[11px] text-slate-500 font-mono mb-5 break-all">Destino: {localDir}</p>

          {downloading && (
            <div className="mb-6 rounded-2xl border border-white/10 bg-slate-900/50 p-4 space-y-4">
              <div>
                <div className="flex justify-between text-xs text-slate-400 mb-2">
                  <span>
                    Modelo {Math.min(overall.current, overall.total)} de {overall.total}
                    {progress.modelLabel ? ` · ${progress.modelLabel}` : ""}
                  </span>
                  <span className="font-mono text-blue-300">{progress.percent.toFixed(1)}%</span>
                </div>
                <div className="w-full bg-slate-950 border border-white/10 rounded-full h-2 overflow-hidden">
                  <motion.div
                    className="h-full bg-gradient-to-r from-blue-500 to-indigo-500"
                    initial={false}
                    animate={{ width: `${Math.min(100, Math.max(0, progress.percent))}%` }}
                    transition={{ duration: 0.15 }}
                  />
                </div>
              </div>

              <div>
                <div className="flex justify-between text-xs text-slate-400 mb-2">
                  <span className="truncate mr-2">
                    Arquivo
                    {progress.fileIndex && progress.fileCount
                      ? ` ${progress.fileIndex}/${progress.fileCount}`
                      : ""}
                    {progress.file ? ` · ${progress.file}` : ""}
                  </span>
                  <span className="font-mono text-indigo-300 shrink-0">
                    {progress.filePercent.toFixed(1)}%
                  </span>
                </div>
                <div className="w-full bg-slate-950 border border-white/10 rounded-full h-1.5 overflow-hidden">
                  <motion.div
                    className="h-full bg-gradient-to-r from-cyan-400 to-blue-400"
                    initial={false}
                    animate={{ width: `${Math.min(100, Math.max(0, progress.filePercent))}%` }}
                    transition={{ duration: 0.12 }}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 text-[11px] text-slate-400 font-mono">
                <p>
                  Modelo: {formatBytes(progress.downloadedBytes)} / {formatBytes(progress.totalBytes)}
                </p>
                <p className="text-right">
                  Arquivo: {formatBytes(progress.fileDownloadedBytes)} /{" "}
                  {formatBytes(progress.fileTotalBytes)}
                </p>
                <p>Velocidade: {formatSpeed(progress.bytesPerSecond)}</p>
                <p className="text-right">Restante: {progress.etaLabel || "—"}</p>
              </div>
            </div>
          )}

          {error && (
            <div className="mb-5 p-3 rounded-xl border border-rose-500/30 bg-rose-950/40 text-rose-100 text-sm flex gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-300" />
              <span>{error}</span>
            </div>
          )}

          <div className="flex flex-col gap-3">
            {downloading ? (
              <button
                type="button"
                onClick={cancelDownload}
                className="w-full inline-flex items-center justify-center gap-2.5 rounded-2xl border border-rose-400/30 bg-rose-500/10 hover:bg-rose-500/20 text-rose-100 font-semibold px-5 py-3.5 transition-colors"
              >
                <CircleStop className="w-5 h-5 shrink-0" strokeWidth={2.25} />
                Cancelar download
              </button>
            ) : (
              <div className="flex flex-col sm:flex-row gap-3">
                {allReady ? (
                  <button
                    type="button"
                    onClick={onComplete}
                    className="w-full inline-flex items-center justify-center gap-2.5 rounded-2xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-semibold px-5 py-3.5 transition-colors"
                  >
                    <CheckCircle2 className="w-5 h-5 shrink-0" strokeWidth={2.25} />
                    Continuar para o app
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={deleting !== null}
                    onClick={startDownload}
                    className="w-full inline-flex items-center justify-center gap-2.5 rounded-2xl bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 disabled:opacity-60 disabled:cursor-not-allowed text-white font-semibold px-5 py-3.5 transition-colors"
                  >
                    <Download className="w-5 h-5 shrink-0" strokeWidth={2.25} />
                    Baixar modelos agora
                  </button>
                )}

                {present.length > 0 && (
                  <button
                    type="button"
                    disabled={deleting !== null}
                    onClick={() => removeModels()}
                    className="w-full sm:w-auto inline-flex items-center justify-center gap-2.5 rounded-2xl border border-white/10 bg-white/5 hover:bg-white/10 text-slate-200 font-medium px-5 py-3.5 transition-colors disabled:opacity-50"
                  >
                    {deleting === "all" ? (
                      <Loader2 className="w-5 h-5 shrink-0 animate-spin" strokeWidth={2.25} />
                    ) : (
                      <Trash2 className="w-5 h-5 shrink-0" strokeWidth={2.25} />
                    )}
                    Excluir todos
                  </button>
                )}
              </div>
            )}
          </div>

          <p className="text-center text-[11px] text-slate-500 mt-4">
            Requer internet na primeira instalação.
            {isTorch
              ? " Windows/Linux: use o instalador CUDA (NVIDIA) ou ROCm (AMD) correspondente à sua GPU."
              : " Apple Silicon recomendado."}
          </p>
        </motion.div>
      </main>
    </div>
  );
}
