import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import ModelSetup from "./ModelSetup.tsx";
import "./index.css";
import { Loader2, Sparkles } from "lucide-react";

type GpuInfo = {
  supported: boolean;
  devices: Array<{ name: string; vendor: string }>;
  primary: "nvidia" | "amd" | "intel" | "unknown" | null;
  recommendedAccel: "cuda" | "rocm" | "cpu" | null;
  packagedAccel: "cuda" | "rocm" | "cpu" | "mlx" | null;
  summary: string;
};

type EngineId = "qwen3" | "kokoro";

type EngineInfo = {
  ready: boolean;
  modelsReady?: boolean;
  runtimeReady?: boolean;
  modelsDir: string;
  label: string;
  description: string;
  models: Array<{
    id: string;
    folder: string;
    label: string;
    present: boolean;
    approxBytes: number;
  }>;
};

type ModelsStatus = {
  ready: boolean;
  modelsReady?: boolean;
  runtimeReady?: boolean;
  modelsDir: string;
  engine?: EngineId;
  kokoroDevice?: "cpu" | "gpu";
  kokoroBackend?: "mlx" | "onnx";
  kokoroAccel?: {
    requested: "cpu" | "gpu";
    effective: "gpu" | "cpu";
    gpuReady: boolean;
    availableProviders: string[];
    hint: string | null;
  };
  backend?: "torch" | "mlx" | "onnx";
  platform?: string;
  gpu?: GpuInfo;
  engines?: {
    qwen3: EngineInfo;
    kokoro: EngineInfo;
  };
  models: Array<{
    id: string;
    folder: string;
    label: string;
    present: boolean;
    approxBytes: number;
  }>;
};

function Root() {
  const [status, setStatus] = useState<ModelsStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manageModels, setManageModels] = useState(false);

  const refreshStatus = useCallback(async () => {
    const res = await fetch("/api/models/status");
    const body = (await res.json()) as ModelsStatus;
    setStatus(body);
    return body;
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const body = await refreshStatus();
        if (cancelled) return;
        if (!body.ready) setManageModels(true);
      } catch (err: any) {
        if (!cancelled) setError(err?.message || "Não foi possível verificar os modelos.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshStatus]);

  if (error) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-6">
        <div className="max-w-md text-center space-y-3">
          <p className="text-rose-300 text-sm">{error}</p>
          <button
            type="button"
            className="text-sm text-blue-300 underline"
            onClick={() => window.location.reload()}
          >
            Tentar de novo
          </button>
        </div>
      </div>
    );
  }

  if (!status) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-slate-300">
          <div className="bg-gradient-to-br from-blue-500 to-indigo-600 text-white p-3 rounded-2xl">
            <Sparkles className="w-5 h-5" />
          </div>
          <div className="inline-flex items-center gap-2 text-sm">
            <Loader2 className="w-4 h-4 animate-spin" />
            Verificando modelos TTS…
          </div>
        </div>
      </div>
    );
  }

  if (!status.ready || manageModels) {
    return (
      <ModelSetup
        models={status.models}
        modelsDir={status.modelsDir}
        gpu={status.gpu}
        backend={status.backend}
        engine={status.engine || "qwen3"}
        engines={status.engines}
        kokoroDevice={status.kokoroDevice || "gpu"}
        kokoroBackend={
          status.kokoroBackend || (status.platform === "darwin" ? "mlx" : "onnx")
        }
        kokoroAccel={status.kokoroAccel}
        platform={status.platform}
        runtimeReady={status.runtimeReady !== false}
        onStatusChange={(models, modelsDir, extra) => {
          setStatus((s) =>
            s
              ? {
                  ...s,
                  models,
                  modelsDir,
                  ready:
                    typeof extra?.ready === "boolean"
                      ? extra.ready
                      : models.every((m) => m.present),
                  ...(extra?.modelsReady !== undefined
                    ? { modelsReady: extra.modelsReady }
                    : {}),
                  ...(extra?.runtimeReady !== undefined
                    ? { runtimeReady: extra.runtimeReady }
                    : {}),
                  ...(extra?.gpu !== undefined ? { gpu: extra.gpu ?? undefined } : {}),
                  ...(extra?.backend
                    ? { backend: extra.backend as ModelsStatus["backend"] }
                    : {}),
                  ...(extra?.engine ? { engine: extra.engine } : {}),
                  ...(extra?.engines ? { engines: extra.engines } : {}),
                  ...(extra?.kokoroDevice ? { kokoroDevice: extra.kokoroDevice } : {}),
                  ...(extra?.kokoroBackend
                    ? { kokoroBackend: extra.kokoroBackend }
                    : {}),
                  ...(extra?.kokoroAccel !== undefined
                    ? { kokoroAccel: extra.kokoroAccel ?? undefined }
                    : {}),
                }
              : s
          );
        }}
        onComplete={async () => {
          const body = await refreshStatus();
          if (body.ready) setManageModels(false);
        }}
      />
    );
  }

  return <App onManageModels={() => setManageModels(true)} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>
);
