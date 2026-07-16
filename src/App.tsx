import React, { useState, useRef, useEffect, useCallback } from "react";
import { 
  FileText, 
  Play, 
  Pause, 
  Download, 
  Volume2, 
  VolumeX, 
  Sparkles, 
  Trash2, 
  BookOpen, 
  RotateCcw, 
  RotateCw, 
  Music, 
  AlertCircle,
  Clock,
  ArrowLeft,
  CheckCircle2,
  FileAudio,
  Loader2,
  Book,
  Square,
  Plus,
  Image as ImageIcon,
  ArrowRightLeft,
  Mic2,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import {
  ExtractCoverPanel,
  Mp3ToM4bPanel,
  M4bToMp3Panel,
} from "./ModePanels";

type AppMode = "narrate" | "extract-cover" | "mp3-to-m4b" | "m4b-to-mp3";
type OutputFormat = "mp3" | "m4b";

// Voice catalog loaded from active TTS engine
interface Voice {
  id: string;
  name: string;
  gender: "Feminino" | "Masculino";
  description: string;
  icon: string;
}

interface EpubChapter {
  index: number;
  id: string;
  title: string;
}

interface DocItem {
  id: string;
  file: File;
  fileBase64: string;
  fileType: "pdf" | "epub";
  startPage: number;
  endPage: string;
  /** PDF cover page (1-based). Empty string = no cover. */
  coverPage: string;
  pdfPageCount: number | null;
  epubChapters: EpubChapter[];
  docInfoMessage: string;
  docInfoLoading: boolean;
  editableText: string;
  extractedText: string;
  pagesNarrated: string;
  audioBase64: string | null;
  audioUrl: string | null;
  audioFormat: OutputFormat;
  coverPreviewUrl: string | null;
}

function createDocId() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function isPdfOrEpub(file: File): boolean {
  const extension = file.name.split(".").pop()?.toLowerCase();
  return (
    file.type === "application/pdf" ||
    extension === "pdf" ||
    extension === "epub" ||
    file.type === "application/epub+zip"
  );
}

function detectFileType(file: File): "pdf" | "epub" {
  const extension = file.name.split(".").pop()?.toLowerCase();
  return extension === "epub" || file.type === "application/epub+zip" ? "epub" : "pdf";
}

const FALLBACK_QWEN_VOICES: Voice[] = [
  { id: "Vivian", name: "Vivian", gender: "Feminino", description: "Narração clara e calorosa — boa para romances e não-ficção.", icon: "👩" },
  { id: "Serena", name: "Serena", gender: "Feminino", description: "Timbre suave, adequada para leituras longas.", icon: "👩‍🦰" },
  { id: "Sohee", name: "Sohee", gender: "Feminino", description: "Voz expressiva e natural.", icon: "🧑" },
  { id: "Ono_Anna", name: "Ono Anna", gender: "Feminino", description: "Dicção limpa, boa para diálogos.", icon: "👩‍🎤" },
  { id: "Ryan", name: "Ryan", gender: "Masculino", description: "Tom sereno e estável para capítulos longos.", icon: "👨" },
  { id: "Aiden", name: "Aiden", gender: "Masculino", description: "Presença mais animada e envolvente.", icon: "🧑‍💼" },
  { id: "Eric", name: "Eric", gender: "Masculino", description: "Dicção formal, boa para textos técnicos.", icon: "👨‍🏫" },
  { id: "Dylan", name: "Dylan", gender: "Masculino", description: "Tom sólido para narrativa geral.", icon: "🧔" },
  { id: "Uncle_Fu", name: "Uncle Fu", gender: "Masculino", description: "Timbre maduro e pausado.", icon: "🧓" },
];

const VOICE_STORAGE_KEY = "aura-reader-voice";
const ENGINE_VOICE_STORAGE_KEY = "aura-reader-voice-by-engine";

function loadSavedVoice(voices: Voice[], engine: string): string {
  try {
    const byEngine = JSON.parse(localStorage.getItem(ENGINE_VOICE_STORAGE_KEY) || "{}") as Record<
      string,
      string
    >;
    if (byEngine[engine] && voices.some((v) => v.id === byEngine[engine])) {
      return byEngine[engine];
    }
    const saved = localStorage.getItem(VOICE_STORAGE_KEY);
    if (saved && voices.some((v) => v.id === saved)) return saved;
    if (saved === "Ethan") return voices.find((v) => v.id === "Eric")?.id || voices[0]?.id || "Vivian";
    if (saved === "Chelsie") return voices.find((v) => v.id === "Sohee")?.id || voices[0]?.id || "Vivian";
  } catch {
    // ignore
  }
  return voices[0]?.id || (engine === "kokoro" ? "af_heart" : "Vivian");
}

function persistVoice(engine: string, voiceId: string) {
  try {
    localStorage.setItem(VOICE_STORAGE_KEY, voiceId);
    const byEngine = JSON.parse(localStorage.getItem(ENGINE_VOICE_STORAGE_KEY) || "{}") as Record<
      string,
      string
    >;
    byEngine[engine] = voiceId;
    localStorage.setItem(ENGINE_VOICE_STORAGE_KEY, JSON.stringify(byEngine));
  } catch {
    // ignore
  }
}

export default function App({ onManageModels }: { onManageModels?: () => void }) {
  const [appMode, setAppMode] = useState<AppMode>("narrate");
  const [outputFormat, setOutputFormat] = useState<OutputFormat>("mp3");

  // Multi-document state
  const [documents, setDocuments] = useState<DocItem[]>([]);
  const [activeDocId, setActiveDocId] = useState<string | null>(null);
  const [reviewDocId, setReviewDocId] = useState<string | null>(null);
  const [resultDocId, setResultDocId] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState<boolean>(false);
  const [coverPreviewLoading, setCoverPreviewLoading] = useState(false);
  const [coverPreviewMessage, setCoverPreviewMessage] = useState<string | null>(null);

  // Shared configuration
  const [voices, setVoices] = useState<Voice[]>(FALLBACK_QWEN_VOICES);
  const [ttsEngine, setTtsEngine] = useState<"qwen3" | "kokoro">("qwen3");
  const [kokoroDevice, setKokoroDevice] = useState<"cpu" | "gpu">("gpu");
  const [selectedVoice, setSelectedVoice] = useState<string>("Vivian");

  const completedDocs = documents.filter((d) => d.audioUrl);
  const activeDoc = documents.find((d) => d.id === activeDocId) ?? documents[0] ?? null;
  const reviewDoc = documents.find((d) => d.id === reviewDocId) ?? documents[0] ?? null;
  const resultDoc =
    documents.find((d) => d.id === resultDocId) ?? completedDocs[0] ?? null;
  const anyDocInfoLoading = documents.some((d) => d.docInfoLoading);
  const allDocsReady = documents.length > 0 && documents.every((d) => d.fileBase64 && !d.docInfoLoading);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/tts-engine");
        const body = await res.json();
        if (cancelled || !res.ok) return;
        const engine = body.engine === "kokoro" ? "kokoro" : "qwen3";
        const list = Array.isArray(body.voices) && body.voices.length
          ? (body.voices as Voice[])
          : FALLBACK_QWEN_VOICES;
        setTtsEngine(engine);
        if (body.kokoroDevice === "cpu" || body.kokoroDevice === "gpu") {
          setKokoroDevice(body.kokoroDevice);
        }
        setVoices(list);
        setSelectedVoice((prev) => {
          if (list.some((v) => v.id === prev)) return prev;
          return loadSavedVoice(list, engine);
        });
      } catch {
        // keep fallbacks
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    persistVoice(ttsEngine, selectedVoice);
  }, [selectedVoice, ttsEngine]);

  // Processing & Result State
  const [loading, setLoading] = useState<boolean>(false);
  const [loadingMode, setLoadingMode] = useState<"extract" | "narrate">("extract");
  const [showTextReview, setShowTextReview] = useState<boolean>(false);
  const [progressStep, setProgressStep] = useState<string>("init"); // 'init', 'extraction', 'pre_tts', 'chunks', 'tts', 'encoding', 'done'
  const [encodePercent, setEncodePercent] = useState<number | null>(null);
  const [currentChunk, setCurrentChunk] = useState<number>(0);
  const [totalChunks, setTotalChunks] = useState<number>(0);
  const [currentTaskId, setCurrentTaskId] = useState<string | null>(null);
  const [isStopping, setIsStopping] = useState<boolean>(false);
  const [processingFileIndex, setProcessingFileIndex] = useState<number>(0);
  const [processingFileTotal, setProcessingFileTotal] = useState<number>(0);
  const [processingFileName, setProcessingFileName] = useState<string>("");
  const [processingPreviewText, setProcessingPreviewText] = useState<string>("");
  const [lastSavedFileName, setLastSavedFileName] = useState<string>("");
  const [savedFilesCount, setSavedFilesCount] = useState<number>(0);
  
  const [error, setError] = useState<string | null>(null);
  const hasResults = completedDocs.length > 0;

  const buildDownloadFileName = (doc: DocItem, format?: OutputFormat) => {
    const safeName = doc.file.name.replace(/\.[^/.]+$/, "") || "narracao";
    const ext = format || doc.audioFormat || outputFormat || "mp3";
    return `${safeName}.${ext}`;
  };

  const saveAudioToDownloads = async (
    opts: { audioId?: string; audioData?: string; fileName: string; saveCover?: boolean }
  ): Promise<{ fileName: string; path: string; coverFileName?: string | null } | null> => {
    try {
      const res = await fetch("/api/save-to-downloads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audioId: opts.audioId,
          audioData: opts.audioData,
          fileName: opts.fileName,
          saveCover: opts.saveCover !== false,
        }),
      });
      const payload = await res.json();
      if (!res.ok) {
        throw new Error(payload.error || "Falha ao salvar em Downloads.");
      }
      return {
        fileName: payload.fileName as string,
        path: payload.path as string,
        coverFileName: (payload.coverFileName as string | null) ?? null,
      };
    } catch (err) {
      console.error("Erro ao salvar áudio em Downloads:", err);
      return null;
    }
  };

  // Custom Audio Player State
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [duration, setDuration] = useState<number>(0);
  const [volume, setVolume] = useState<number>(0.8);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const isStoppingRef = useRef(false);
  const stopBatchRef = useRef(false);

  // Voice preview samples
  const [previewLoadingVoice, setPreviewLoadingVoice] = useState<string | null>(null);
  const [previewPlayingVoice, setPreviewPlayingVoice] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const previewCacheRef = useRef<Record<string, string>>({});
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);

  // Persist voice selection
  useEffect(() => {
    try {
      localStorage.setItem(VOICE_STORAGE_KEY, selectedVoice);
    } catch {
      // ignore
    }
  }, [selectedVoice]);

  // Clean up voice preview audio on unmount
  useEffect(() => {
    return () => {
      if (previewAudioRef.current) {
        previewAudioRef.current.pause();
        previewAudioRef.current = null;
      }
      for (const url of Object.values(previewCacheRef.current) as string[]) {
        URL.revokeObjectURL(url);
      }
      previewCacheRef.current = {};
    };
  }, []);

  // Clean up Object URLs on unmount
  useEffect(() => {
    return () => {
      for (const doc of documents) {
        if (doc.audioUrl) URL.revokeObjectURL(doc.audioUrl);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on unmount
  }, []);

  const updateDoc = (id: string, patch: Partial<DocItem>) => {
    setDocuments((docs) => docs.map((d) => (d.id === id ? { ...d, ...patch } : d)));
  };

  // Cover preview for active document
  const refreshCoverPreview = useCallback(async (doc: DocItem) => {
    if (!doc.fileBase64) return;
    const wantsCover =
      doc.fileType === "epub" ||
      (doc.fileType === "pdf" && doc.coverPage.trim() !== "");
    if (!wantsCover) {
      if (doc.coverPreviewUrl) {
        URL.revokeObjectURL(doc.coverPreviewUrl);
        updateDoc(doc.id, { coverPreviewUrl: null });
      }
      setCoverPreviewMessage("Sem capa (página vazia)");
      return;
    }

    setCoverPreviewLoading(true);
    setCoverPreviewMessage(null);
    try {
      const res = await fetch("/api/cover-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileData: doc.fileBase64,
          fileType: doc.fileType,
          coverPage: doc.fileType === "pdf" ? doc.coverPage : undefined,
        }),
      });
      const payload = await res.json();
      if (doc.coverPreviewUrl) URL.revokeObjectURL(doc.coverPreviewUrl);
      if (!res.ok || !payload.found) {
        updateDoc(doc.id, { coverPreviewUrl: null });
        setCoverPreviewMessage(payload.error || payload.message || "Capa não encontrada");
        return;
      }
      const binary = atob(payload.imageData as string);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
      updateDoc(doc.id, { coverPreviewUrl: url });
      setCoverPreviewMessage(null);
    } catch (err: any) {
      updateDoc(doc.id, { coverPreviewUrl: null });
      setCoverPreviewMessage(err?.message || "Falha no preview da capa");
    } finally {
      setCoverPreviewLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!activeDoc?.fileBase64 || activeDoc.docInfoLoading) return;
    const t = window.setTimeout(() => {
      void refreshCoverPreview(activeDoc);
    }, 400);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refresh on cover page / file changes
  }, [
    activeDoc?.id,
    activeDoc?.fileBase64,
    activeDoc?.coverPage,
    activeDoc?.fileType,
    activeDoc?.docInfoLoading,
    refreshCoverPreview,
  ]);

  // Drag-and-drop handlers
  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      processFiles(Array.from(e.dataTransfer.files));
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      processFiles(Array.from(e.target.files));
      e.target.value = "";
    }
  };

  const loadDocumentInfo = async (docId: string, base64: string, type: "pdf" | "epub") => {
    updateDoc(docId, { docInfoLoading: true });
    try {
      const res = await fetch("/api/document-info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileData: base64, fileType: type }),
      });
      const info = await res.json();
      if (!res.ok) throw new Error(info.error || "Falha ao ler o documento.");

      if (type === "pdf") {
        const pageCount = typeof info.pageCount === "number" ? info.pageCount : null;
        updateDoc(docId, {
          docInfoMessage: info.message || "",
          pdfPageCount: pageCount,
          startPage: 1,
          endPage: pageCount != null ? String(pageCount) : "",
          docInfoLoading: false,
        });
      } else {
        const chapters = Array.isArray(info.chapters) ? info.chapters : [];
        updateDoc(docId, {
          docInfoMessage: info.message || "",
          epubChapters: chapters,
          startPage: 1,
          endPage: chapters.length > 0 ? String(chapters.length) : "",
          docInfoLoading: false,
        });
      }
    } catch (err: any) {
      console.error(err);
      updateDoc(docId, { docInfoLoading: false });
      setError(err.message || "Não foi possível inspecionar o documento.");
    }
  };

  const processFiles = (files: File[]) => {
    setError(null);
    const valid = files.filter(isPdfOrEpub);
    if (valid.length === 0) {
      setError("Por favor, adicione apenas arquivos PDF ou EPUB válidos.");
      return;
    }
    if (valid.length < files.length) {
      setError("Alguns arquivos foram ignorados. Apenas PDF e EPUB são aceitos.");
    }

    const newDocs: DocItem[] = valid.map((file) => ({
      id: createDocId(),
      file,
      fileBase64: "",
      fileType: detectFileType(file),
      startPage: 1,
      endPage: "",
      coverPage: "1",
      pdfPageCount: null,
      epubChapters: [],
      docInfoMessage: "",
      docInfoLoading: true,
      editableText: "",
      extractedText: "",
      pagesNarrated: "",
      audioBase64: null,
      audioUrl: null,
      audioFormat: outputFormat,
      coverPreviewUrl: null,
    }));

    setDocuments((prev) => [...prev, ...newDocs]);
    if (!activeDocId && newDocs.length > 0) {
      setActiveDocId(newDocs[0].id);
    }

    for (const doc of newDocs) {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        const base64 = result.split(",")[1];
        updateDoc(doc.id, { fileBase64: base64 });
        void loadDocumentInfo(doc.id, base64, doc.fileType);
      };
      reader.onerror = () => {
        updateDoc(doc.id, { docInfoLoading: false });
        setError(`Erro ao ler o arquivo ${doc.fileType.toUpperCase()}: ${doc.file.name}`);
      };
      reader.readAsDataURL(doc.file);
    }
  };

  const handleRemoveFile = (docId: string) => {
    setDocuments((prev) => {
      const target = prev.find((d) => d.id === docId);
      if (target?.audioUrl) URL.revokeObjectURL(target.audioUrl);
      if (target?.coverPreviewUrl) URL.revokeObjectURL(target.coverPreviewUrl);
      const next = prev.filter((d) => d.id !== docId);
      setActiveDocId((current) => {
        if (current !== docId) return current;
        return next[0]?.id ?? null;
      });
      setReviewDocId((current) => {
        if (current !== docId) return current;
        return next[0]?.id ?? null;
      });
      setResultDocId((current) => {
        if (current !== docId) return current;
        return next.find((d) => d.audioUrl)?.id ?? null;
      });
      if (next.length === 0) {
        setShowTextReview(false);
      }
      return next;
    });
  };

  const validatePageRange = (doc: DocItem): { start: number; end: number } | null => {
    const start = Math.max(1, doc.startPage || 1);
    if (doc.fileType === "pdf" && doc.pdfPageCount != null && start > doc.pdfPageCount) {
      setError(`${doc.file.name}: este PDF tem ${doc.pdfPageCount} página(s). A página inicial ${start} está fora do intervalo.`);
      return null;
    }
    if (doc.fileType === "epub" && doc.epubChapters.length > 0 && start > doc.epubChapters.length) {
      setError(`${doc.file.name}: este EPUB tem ${doc.epubChapters.length} seção(ões). O índice ${start} está fora do intervalo.`);
      return null;
    }

    const end = doc.endPage.trim()
      ? parseInt(doc.endPage, 10)
      : start;

    if (!Number.isFinite(end) || end < 1) {
      setError(`${doc.file.name}: a página/seção final é inválida.`);
      return null;
    }
    if (end < start) {
      setError(`${doc.file.name}: a página/seção final (${end}) não pode ser menor que a inicial (${start}).`);
      return null;
    }
    if (doc.fileType === "pdf" && doc.pdfPageCount != null && end > doc.pdfPageCount) {
      setError(`${doc.file.name}: este PDF tem ${doc.pdfPageCount} página(s). A página final ${end} está fora do intervalo.`);
      return null;
    }
    if (doc.fileType === "epub" && doc.epubChapters.length > 0 && end > doc.epubChapters.length) {
      setError(`${doc.file.name}: este EPUB tem ${doc.epubChapters.length} seção(ões). O índice ${end} está fora do intervalo.`);
      return null;
    }
    return { start, end };
  };

  // Step 1: extract text from all documents, then open editable review
  const handleExtractForReview = async () => {
    if (documents.length === 0 || !allDocsReady) return;

    const ranges: { id: string; start: number; end: number }[] = [];
    for (const doc of documents) {
      const range = validatePageRange(doc);
      if (!range) return;
      ranges.push({ id: doc.id, ...range });
    }

    setLoading(true);
    setLoadingMode("extract");
    setError(null);
    setShowTextReview(false);
    setProgressStep("extraction");
    setProcessingFileTotal(documents.length);
    setProcessingPreviewText("");

    // Clear previous audio results
    setDocuments((docs) =>
      docs.map((d) => {
        if (d.audioUrl) URL.revokeObjectURL(d.audioUrl);
        return {
          ...d,
          editableText: "",
          extractedText: "",
          pagesNarrated: "",
          audioBase64: null,
          audioUrl: null,
        };
      })
    );

    try {
      for (let i = 0; i < documents.length; i++) {
        const doc = documents[i];
        const range = ranges[i];
        setProcessingFileIndex(i + 1);
        setProcessingFileName(doc.file.name);
        setProgressStep("extraction");
        setCurrentChunk(0);
        setTotalChunks(0);

        const response = await fetch("/api/extract", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fileData: doc.fileBase64,
            fileType: doc.fileType,
            startPage: range.start,
            endPage: range.end,
          }),
        });

        const payload = await response.json();
        if (!response.ok) {
          throw new Error(`${doc.file.name}: ${payload.error || "Falha ao extrair o texto."}`);
        }

        updateDoc(doc.id, {
          extractedText: payload.extractedText,
          editableText: payload.extractedText,
          pagesNarrated: payload.pagesNarrated || "",
        });
      }

      setReviewDocId(documents[0]?.id ?? null);
      setShowTextReview(true);
    } catch (err: any) {
      console.error(err);
      setError(err.message || "Não foi possível extrair o texto do documento.");
    } finally {
      setLoading(false);
      setProcessingFileIndex(0);
      setProcessingFileTotal(0);
      setProcessingFileName("");
    }
  };

  const stopVoicePreview = () => {
    if (previewAudioRef.current) {
      previewAudioRef.current.pause();
      previewAudioRef.current.onended = null;
      previewAudioRef.current.onerror = null;
      previewAudioRef.current = null;
    }
    setPreviewPlayingVoice(null);
  };

  const playVoicePreview = async (voiceId: string) => {
    setPreviewError(null);

    if (previewPlayingVoice === voiceId) {
      stopVoicePreview();
      return;
    }

    stopVoicePreview();

    let url = previewCacheRef.current[voiceId];
    if (!url) {
      setPreviewLoadingVoice(voiceId);
      try {
        const response = await fetch("/api/voice-preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ voiceName: voiceId }),
        });
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.error || "Falha ao gerar prévia da voz.");
        }
        const binary = atob(payload.audioData as string);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const blob = new Blob([bytes], { type: payload.mimeType || "audio/mpeg" });
        url = URL.createObjectURL(blob);
        previewCacheRef.current[voiceId] = url;
      } catch (err: any) {
        console.error(err);
        setPreviewError(err.message || "Não foi possível ouvir esta voz agora.");
        setPreviewLoadingVoice(null);
        return;
      } finally {
        setPreviewLoadingVoice((current) => (current === voiceId ? null : current));
      }
    }

    const audio = new Audio(url);
    previewAudioRef.current = audio;
    setPreviewPlayingVoice(voiceId);
    audio.onended = () => {
      if (previewAudioRef.current === audio) {
        previewAudioRef.current = null;
        setPreviewPlayingVoice(null);
      }
    };
    audio.onerror = () => {
      setPreviewError("Erro ao reproduzir a prévia.");
      stopVoicePreview();
    };
    try {
      await audio.play();
    } catch (err: any) {
      setPreviewError(err?.message || "Não foi possível reproduzir o áudio.");
      stopVoicePreview();
    }
  };

  // Step 2: narrate all (possibly edited) texts sequentially
  const narrateDocument = async (doc: DocItem): Promise<void> => {
    const text = doc.editableText.trim();
    if (!text) {
      throw new Error(`${doc.file.name}: edite ou confirme um texto antes de narrar.`);
    }

    setProcessingPreviewText(text);
    setProgressStep("pre_tts");
    setEncodePercent(null);
    setCurrentChunk(0);
    setTotalChunks(0);
    setIsStopping(false);
    isStoppingRef.current = false;

    const taskId = Math.random().toString(36).substring(7);
    setCurrentTaskId(taskId);

    if (doc.audioUrl) {
      URL.revokeObjectURL(doc.audioUrl);
      updateDoc(doc.id, { audioUrl: null, audioBase64: null });
    }

    const response = await fetch("/api/narrate-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        voiceName: selectedVoice,
        taskId,
        pagesNarrated: doc.pagesNarrated,
        fileData: doc.fileBase64,
        fileType: doc.fileType,
        outputFormat,
        coverPage:
          doc.fileType === "pdf"
            ? doc.coverPage.trim() === ""
              ? null
              : doc.coverPage
            : undefined,
        includeCover:
          doc.fileType === "epub" ||
          (doc.fileType === "pdf" && doc.coverPage.trim() !== ""),
        sourceFileName: doc.file.name,
      }),
    });

    if (!response.ok) {
      throw new Error(`${doc.file.name}: erro de conexão ou falha no servidor ao iniciar a narração.`);
    }

    if (!response.body) {
      throw new Error(`${doc.file.name}: o servidor não retornou um fluxo de dados válido.`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let gotDone = false;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine || !trimmedLine.startsWith("data: ")) continue;

        const dataStr = trimmedLine.slice(6).trim();
        if (!dataStr) continue;

        try {
          const payload = JSON.parse(dataStr);

          if (payload.type === "status") {
            if (isStoppingRef.current && payload.step === "tts") {
              continue;
            }
            if (payload.step) setProgressStep(payload.step);
            if (payload.current !== undefined) setCurrentChunk(payload.current);
            if (payload.total !== undefined) setTotalChunks(payload.total);
            if (typeof payload.percent === "number") {
              setEncodePercent(payload.percent);
            } else if (payload.step && payload.step !== "encoding") {
              setEncodePercent(null);
            }
            if (typeof payload.extractedText === "string" && payload.extractedText.length > 0) {
              setProcessingPreviewText(payload.extractedText);
              updateDoc(doc.id, { extractedText: payload.extractedText });
            }
          } else if (payload.type === "done") {
            setProgressStep("done");
            gotDone = true;

            const pagesNarrated = payload.pagesNarrated || doc.pagesNarrated;
            const fmt: OutputFormat = payload.format === "m4b" ? "m4b" : "mp3";
            let url: string | null = null;

            if (typeof payload.audioUrl === "string" && payload.audioUrl) {
              const audioRes = await fetch(payload.audioUrl);
              if (!audioRes.ok) {
                throw new Error(`${doc.file.name}: falha ao baixar o áudio gerado.`);
              }
              const blob = await audioRes.blob();
              url = URL.createObjectURL(blob);
            } else if (typeof payload.audioData === "string" && payload.audioData) {
              // Legacy base64 fallback
              const binary = atob(payload.audioData);
              const bytes = new Uint8Array(binary.length);
              for (let i = 0; i < binary.length; i++) {
                bytes[i] = binary.charCodeAt(i);
              }
              const blob = new Blob([bytes], { type: "audio/mp3" });
              url = URL.createObjectURL(blob);
            } else {
              throw new Error(`${doc.file.name}: resposta sem áudio.`);
            }

            updateDoc(doc.id, {
              audioBase64: null,
              extractedText: payload.extractedText ?? doc.extractedText,
              pagesNarrated,
              audioUrl: url,
              audioFormat: fmt,
            });

            const saved = await saveAudioToDownloads({
              audioId: typeof payload.audioId === "string" ? payload.audioId : undefined,
              audioData: typeof payload.audioData === "string" ? payload.audioData : undefined,
              fileName: buildDownloadFileName(doc, fmt),
              saveCover: true,
            });
            if (saved) {
              const label = saved.coverFileName
                ? `${saved.fileName} + ${saved.coverFileName}`
                : saved.fileName;
              setLastSavedFileName(label);
              setSavedFilesCount((n) => n + 1);
            }
          } else if (payload.type === "error") {
            throw new Error(`${doc.file.name}: ${payload.error || "Ocorreu um erro durante o processamento."}`);
          }
        } catch (jsonErr: any) {
          if (jsonErr.message && !jsonErr.message.startsWith("Unexpected token")) {
            throw jsonErr;
          }
          console.error("Erro ao analisar dados do fluxo:", jsonErr);
        }
      }
    }

    if (!gotDone) {
      throw new Error(`${doc.file.name}: a narração terminou sem áudio gerado.`);
    }
  };

  const handleConfirmNarration = async () => {
    const docsSnapshot = documents.map((d) => ({ ...d }));
    const empty = docsSnapshot.find((d) => !d.editableText.trim());
    if (empty) {
      setError(`${empty.file.name}: edite ou confirme um texto antes de narrar.`);
      setReviewDocId(empty.id);
      return;
    }

    setShowTextReview(false);
    setLoading(true);
    setLoadingMode("narrate");
    setError(null);
    setProcessingFileTotal(docsSnapshot.length);
    setIsPlaying(false);
    setCurrentTime(0);
    setLastSavedFileName("");
    setSavedFilesCount(0);
    stopBatchRef.current = false;

    let lastCompletedId: string | null = null;

    try {
      for (let i = 0; i < docsSnapshot.length; i++) {
        const doc = docsSnapshot[i];
        setProcessingFileIndex(i + 1);
        setProcessingFileName(doc.file.name);
        await narrateDocument(doc);
        lastCompletedId = doc.id;

        if (stopBatchRef.current) break;

        // After each file, reset stop flag for the next one
        setIsStopping(false);
        isStoppingRef.current = false;
        setCurrentTaskId(null);
      }

      setResultDocId(lastCompletedId ?? docsSnapshot[0]?.id ?? null);
      setIsPlaying(false);
      setCurrentTime(0);
    } catch (err: any) {
      console.error(err);
      setError(err.message || "Não foi possível completar a narração. Verifique sua conexão e tente novamente.");
      // If some files already finished, show results; otherwise return to review
      if (lastCompletedId) {
        setResultDocId(lastCompletedId);
      } else {
        setShowTextReview(true);
      }
    } finally {
      setLoading(false);
      setIsStopping(false);
      isStoppingRef.current = false;
      stopBatchRef.current = false;
      setCurrentTaskId(null);
      setProcessingFileIndex(0);
      setProcessingFileTotal(0);
      setProcessingFileName("");
      setProcessingPreviewText("");
    }
  };

  // Stop current narration stream and compile whatever is completed (ends the batch)
  const handleStopNarration = async () => {
    if (!currentTaskId || isStopping) return;
    isStoppingRef.current = true;
    stopBatchRef.current = true;
    setIsStopping(true);
    // Advance UI immediately — server aborts the in-flight TTS fetch next
    setProgressStep("encoding");
    setCurrentChunk((c) => Math.max(0, c - 1)); // drop the in-progress part that will be discarded
    
    try {
      await fetch("/api/narrate-stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId: currentTaskId })
      });
    } catch (err) {
      console.error("Erro ao enviar comando de parada:", err);
    }
  };

  // Custom Audio Controls
  const togglePlay = () => {
    if (!audioRef.current) return;
    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
    } else {
      audioRef.current.play()
        .then(() => setIsPlaying(true))
        .catch(err => {
          console.error("Audio playback error:", err);
          setError("Erro ao reproduzir áudio. Verifique as permissões de áudio do seu navegador.");
        });
    }
  };

  const handleTimeUpdate = () => {
    if (!audioRef.current) return;
    setCurrentTime(audioRef.current.currentTime);
  };

  const handleLoadedMetadata = () => {
    if (!audioRef.current) return;
    setDuration(audioRef.current.duration);
  };

  const handleAudioEnded = () => {
    setIsPlaying(false);
    setCurrentTime(0);
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!audioRef.current) return;
    const time = parseFloat(e.target.value);
    audioRef.current.currentTime = time;
    setCurrentTime(time);
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!audioRef.current) return;
    const vol = parseFloat(e.target.value);
    audioRef.current.volume = vol;
    setVolume(vol);
    if (vol > 0) setIsMuted(false);
  };

  const toggleMute = () => {
    if (!audioRef.current) return;
    if (isMuted) {
      audioRef.current.volume = volume;
      setIsMuted(false);
    } else {
      audioRef.current.volume = 0;
      setIsMuted(true);
    }
  };

  const skipTime = (amount: number) => {
    if (!audioRef.current) return;
    let newTime = audioRef.current.currentTime + amount;
    if (newTime < 0) newTime = 0;
    if (newTime > duration) newTime = duration;
    audioRef.current.currentTime = newTime;
    setCurrentTime(newTime);
  };

  const formatTime = (time: number) => {
    if (isNaN(time)) return "0:00";
    const minutes = Math.floor(time / 60);
    const seconds = Math.floor(time % 60);
    return `${minutes}:${seconds < 10 ? "0" : ""}${seconds}`;
  };

  // Force physical browser download of the audio
  const downloadMp3 = (doc: DocItem | null = resultDoc) => {
    if (!doc?.audioUrl) return;
    const a = document.createElement("a");
    a.href = doc.audioUrl;
    a.download = buildDownloadFileName(doc);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const resetAll = () => {
    setShowTextReview(false);
    setResultDocId(null);
    setDocuments((docs) =>
      docs.map((d) => {
        if (d.audioUrl) URL.revokeObjectURL(d.audioUrl);
        return {
          ...d,
          editableText: "",
          extractedText: "",
          pagesNarrated: "",
          audioBase64: null,
          audioUrl: null,
          audioFormat: outputFormat,
        };
      })
    );
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
  };

  const selectResultDoc = (docId: string) => {
    if (audioRef.current) {
      audioRef.current.pause();
    }
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setResultDocId(docId);
  };

  const [stageBarPercent, setStageBarPercent] = useState(0);
  const [etaTick, setEtaTick] = useState(0);
  const [etaLabel, setEtaLabel] = useState<string | null>(null);
  const stageStartedAtRef = useRef<number>(Date.now());
  // Stable ETA: recalculate only on new evidence, countdown between ticks
  const etaSecondsRef = useRef<number | null>(null);
  const etaFinishedRef = useRef(0);
  const progressStageKey = `${loadingMode}:${progressStep}`;

  // Each stage owns the full 0–100% bar; timer fills stages without discrete units
  useEffect(() => {
    if (!loading) {
      setStageBarPercent(0);
      return;
    }

    setStageBarPercent(0);

    if (progressStep === "done") {
      setStageBarPercent(100);
      return;
    }

    // TTS uses real chunk progress — no timer fill
    if (progressStep === "tts" && totalChunks > 0) {
      return;
    }

    // Encoding uses real encoder/ffmpeg percent when available
    if (progressStep === "encoding") {
      return;
    }

    const started = Date.now();
    const tau =
      loadingMode === "extract" || progressStep === "extraction"
        ? 14
        : 3.5;

    const id = window.setInterval(() => {
      const elapsedSec = (Date.now() - started) / 1000;
      // Approaches ~92% while the stage runs; hits 100% only when the next stage starts/ends
      const p = Math.min(92, Math.round((1 - Math.exp(-elapsedSec / tau)) * 100));
      setStageBarPercent(p);
    }, 150);

    return () => window.clearInterval(id);
  }, [loading, progressStageKey, progressStep, loadingMode, totalChunks]);

  // Reset ETA clock whenever the stage changes
  useEffect(() => {
    if (!loading) {
      setEtaLabel(null);
      etaSecondsRef.current = null;
      etaFinishedRef.current = 0;
      return;
    }
    stageStartedAtRef.current = Date.now();
    etaSecondsRef.current = null;
    etaFinishedRef.current = 0;
    setEtaLabel(null);
  }, [loading, progressStageKey]);

  // Tick every second to refresh remaining-time estimate
  useEffect(() => {
    if (!loading || progressStep === "done") return;
    const id = window.setInterval(() => setEtaTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, [loading, progressStep]);

  const formatEta = (seconds: number): string => {
    const s = Math.max(0, Math.round(seconds));
    if (s <= 0) return "quase pronto";
    if (s < 60) return `~${s}s restantes`;
    const m = Math.floor(s / 60);
    const rem = s % 60;
    if (m < 60) return rem > 0 ? `~${m}m ${rem}s restantes` : `~${m}m restantes`;
    const h = Math.floor(m / 60);
    const m2 = m % 60;
    return m2 > 0 ? `~${h}h ${m2}m restantes` : `~${h}h restantes`;
  };

  // Progress bar: reset per stage; 100% of the bar = progress within the current stage only
  const getProgressPercentage = () => {
    if (!loading) return 0;
    if (progressStep === "done") return 100;

    if (progressStep === "tts") {
      if (totalChunks <= 0) return stageBarPercent;
      // Only completed parts — starts at 0% while the 1st part is running
      const finished = Math.max(0, currentChunk - 1);
      return Math.min(99, Math.round((finished / totalChunks) * 100));
    }

    if (progressStep === "encoding" && encodePercent != null) {
      return Math.min(100, Math.max(0, Math.round(encodePercent)));
    }

    return stageBarPercent;
  };

  // ETA: for TTS, average only completed parts and countdown between completions
  // (recalculating every second from growing elapsed made the estimate climb).
  useEffect(() => {
    if (!loading || progressStep === "done") {
      setEtaLabel(null);
      return;
    }

    const elapsed = (Date.now() - stageStartedAtRef.current) / 1000;
    if (elapsed < 1.5) {
      setEtaLabel(null);
      return;
    }

    if (progressStep === "tts" && totalChunks > 0) {
      const finished = Math.max(0, currentChunk - 1);
      if (finished < 1) {
        etaSecondsRef.current = null;
        etaFinishedRef.current = 0;
        setEtaLabel("Estimando após a 1ª parte…");
        return;
      }

      if (etaSecondsRef.current === null || finished !== etaFinishedRef.current) {
        etaFinishedRef.current = finished;
        const avgPerPart = elapsed / finished;
        const remainingParts = Math.max(0, totalChunks - finished);
        etaSecondsRef.current = avgPerPart * remainingParts;
      } else {
        etaSecondsRef.current = Math.max(0, etaSecondsRef.current - 1);
      }

      setEtaLabel(formatEta(etaSecondsRef.current));
      return;
    }

    const pct = getProgressPercentage();
    if (pct >= 8 && pct < 99) {
      const rawEta = elapsed * ((100 - pct) / pct);
      if (etaSecondsRef.current === null) {
        etaSecondsRef.current = rawEta;
      } else {
        // Count down; never climb within a stage (asymptotic bar made raw ETA rise)
        etaSecondsRef.current = Math.max(0, Math.min(etaSecondsRef.current - 1, rawEta));
      }
      setEtaLabel(formatEta(etaSecondsRef.current));
      return;
    }

    setEtaLabel(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- recompute on tick / chunk / bar changes
  }, [loading, progressStep, currentChunk, totalChunks, stageBarPercent, etaTick, progressStageKey, encodePercent]);

  const getStageProgressLabel = () => {
    if (loadingMode === "extract") return "Extração";
    if (progressStep === "pre_tts" || progressStep === "chunks") return "Preparação";
    if (progressStep === "tts") return "Narração";
    if (progressStep === "encoding") return "Codificação";
    if (progressStep === "done") return "Concluído";
    return "Etapa atual";
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans selection:bg-blue-500/30 selection:text-white relative flex flex-col">
      {/* Background Decor — clipped so negative offsets don't force page scrollbars */}
      <div className="pointer-events-none absolute inset-0 overflow-clip" aria-hidden>
        <div className="absolute top-[-100px] left-[-100px] w-[500px] h-[500px] bg-blue-600/15 rounded-full blur-[120px]" />
        <div className="absolute bottom-[-100px] right-[-100px] w-[600px] h-[600px] bg-purple-600/15 rounded-full blur-[150px]" />
        <div className="absolute top-[20%] right-[10%] w-[300px] h-[300px] bg-emerald-500/8 rounded-full blur-[100px]" />
      </div>

      {/* Hidden audio tag linked with React state */}
      {resultDoc?.audioUrl && (
        <audio
          key={resultDoc.id}
          ref={audioRef}
          src={resultDoc.audioUrl}
          onTimeUpdate={handleTimeUpdate}
          onLoadedMetadata={handleLoadedMetadata}
          onEnded={handleAudioEnded}
        />
      )}

      {/* Modern minimalist Header */}
      <header className="relative z-10 backdrop-blur-md bg-slate-950/40 border-b border-white/10 px-6 py-4">
        <div className="max-w-[1400px] mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="bg-gradient-to-br from-blue-500 to-purple-600 text-white p-2.5 rounded-xl shadow-lg shadow-blue-500/10">
              <Sparkles className="w-5 h-5 animate-pulse" />
            </div>
            <div>
              <h1 className="text-lg font-bold tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-white to-slate-300">
                Aura Reader
              </h1>
              <p className="text-xs text-slate-400">PDF e EPUB em narração natural com IA</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => onManageModels?.()}
            title="Gerenciar modelos TTS"
            className="text-xs font-mono text-slate-300 bg-white/5 border border-white/10 px-3 py-1.5 rounded-full hover:bg-white/10 hover:text-white hover:border-white/20 transition-colors"
          >
            {ttsEngine === "kokoro"
              ? `Kokoro · ${kokoroDevice === "gpu" ? "GPU" : "CPU"}`
              : "Qwen3 TTS · local"}
          </button>
        </div>
      </header>

      <div className="relative z-10 flex-1 flex min-h-0">
        {/* Side navigation */}
        <aside className="w-56 shrink-0 border-r border-white/10 bg-slate-950/50 backdrop-blur-md px-3 py-6 flex flex-col gap-1">
          {(
            [
              { id: "narrate" as const, label: "Narrar", icon: Mic2 },
              { id: "extract-cover" as const, label: "Extrair capa", icon: ImageIcon },
              { id: "mp3-to-m4b" as const, label: "MP3 → M4B", icon: ArrowRightLeft },
              { id: "m4b-to-mp3" as const, label: "M4B → MP3", icon: FileAudio },
            ] as const
          ).map((item) => {
            const Icon = item.icon;
            const active = appMode === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setAppMode(item.id);
                  setError(null);
                }}
                className={`flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors text-left ${
                  active
                    ? "bg-blue-500/15 text-white border border-blue-500/30"
                    : "text-slate-400 hover:text-white hover:bg-white/5 border border-transparent"
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                {item.label}
              </button>
            );
          })}
        </aside>

      <main className="flex-1 max-w-7xl w-full mx-auto px-6 py-10 relative z-10 overflow-y-auto">
        {appMode === "extract-cover" ? (
          <ExtractCoverPanel />
        ) : appMode === "mp3-to-m4b" ? (
          <Mp3ToM4bPanel />
        ) : appMode === "m4b-to-mp3" ? (
          <M4bToMp3Panel />
        ) : (
        <AnimatePresence mode="wait">
          {/* Main Error Banner */}
          {error && (
            <motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="mb-8 p-4 bg-rose-950/45 border border-rose-500/30 backdrop-blur-xl rounded-2xl flex items-start gap-3 text-rose-200"
            >
              <AlertCircle className="w-5 h-5 shrink-0 mt-0.5 text-rose-400" />
              <div className="flex-1 text-sm">
                <span className="font-semibold text-rose-100">Ops! Algo deu errado: </span>
                {error}
              </div>
              <button 
                onClick={() => setError(null)} 
                className="text-xs font-medium text-rose-300 hover:text-rose-100 px-2 py-1 rounded-md hover:bg-rose-500/10 transition-colors"
              >
                Dispensar
              </button>
            </motion.div>
          )}

          {/* Loading Serene Screen */}
          {loading ? (
            <motion.div
              key="loading"
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.98 }}
              className={`${loadingMode === "narrate" && processingPreviewText ? "max-w-5xl" : "max-w-2xl"} mx-auto bg-white/5 backdrop-blur-2xl border border-white/15 rounded-3xl shadow-2xl p-8 sm:p-12 text-center`}
            >
              <div className={`grid ${loadingMode === "narrate" && processingPreviewText ? "lg:grid-cols-2 gap-8 items-start text-left" : ""}`}>
                <div>
                  <div className="relative w-24 h-24 mx-auto mb-8 flex items-center justify-center">
                    <div className="absolute inset-0 border-4 border-blue-500/10 rounded-full animate-pulse" />
                    <div className="absolute inset-0 border-4 border-t-blue-500 rounded-full animate-spin [animation-duration:1.2s]" />
                    <FileAudio className="w-10 h-10 text-blue-400 animate-bounce" />
                  </div>

                  <h3 className="text-xl font-bold text-white mb-2 text-center">
                    {loadingMode === "extract"
                      ? (processingFileTotal > 1 ? "Extraindo textos" : "Extraindo texto")
                      : (processingFileTotal > 1 ? "Narrando seus textos" : "Narrando seu texto")}
                  </h3>

                  {processingFileName && (
                    <div className="max-w-md mx-auto mb-4 rounded-2xl border border-blue-500/25 bg-blue-500/10 px-4 py-3 text-center">
                      {processingFileTotal > 1 && (
                        <p className="text-[11px] font-semibold uppercase tracking-wider text-blue-300/90 mb-1">
                          Arquivo {processingFileIndex} de {processingFileTotal}
                        </p>
                      )}
                      <p className="text-sm font-semibold text-white truncate" title={processingFileName}>
                        {processingFileName}
                      </p>
                    </div>
                  )}

                  {loadingMode === "narrate" && savedFilesCount > 0 && lastSavedFileName && (
                    <div className="max-w-md mx-auto mb-4 rounded-2xl border border-emerald-500/25 bg-emerald-500/10 px-4 py-2.5 text-center">
                      <p className="text-[11px] font-semibold text-emerald-300 flex items-center justify-center gap-1.5">
                        <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                        Salvo em Downloads
                        {savedFilesCount > 1 ? ` (${savedFilesCount})` : ""}
                      </p>
                      <p className="text-xs text-emerald-100/90 truncate mt-0.5" title={lastSavedFileName}>
                        {lastSavedFileName}
                      </p>
                    </div>
                  )}

                  <p className="text-slate-300 text-sm max-w-md mx-auto mb-8 text-center">
                    {loadingMode === "extract"
                      ? "Em seguida você poderá revisar e editar o texto de cada arquivo antes da narração."
                      : "Cada áudio concluído é salvo automaticamente na pasta Downloads."}
                  </p>

                  {/* Progress bar: 0–100% within the current stage only */}
                  <div className="max-w-md mx-auto mb-8">
                    <div className="flex justify-between text-xs text-slate-400 mb-2">
                      <span>Progresso — {getStageProgressLabel()}</span>
                      <span className="font-mono font-bold text-blue-400">{getProgressPercentage()}%</span>
                    </div>
                    <div className="w-full bg-slate-900 border border-white/10 rounded-full h-2 overflow-hidden">
                      <motion.div
                        key={progressStageKey}
                        className="bg-gradient-to-r from-blue-500 to-indigo-500 h-full rounded-full shadow-lg shadow-blue-500/20"
                        initial={{ width: "0%" }}
                        animate={{ width: `${getProgressPercentage()}%` }}
                        transition={{ ease: "easeOut", duration: 0.25 }}
                      />
                    </div>
                    {etaLabel && (
                      <div className="mt-2 flex items-center justify-center gap-1.5 text-[11px] text-slate-400">
                        <Clock className="w-3 h-3 text-blue-400/80" />
                        <span className="font-medium text-slate-300">{etaLabel}</span>
                      </div>
                    )}
                  </div>

                  {/* Steps stay on the left only when there is no right column */}
                  {!(loadingMode === "narrate" && processingPreviewText) && (
                    <div className="bg-slate-900/40 border border-white/10 rounded-2xl p-5 max-w-md mx-auto text-left space-y-4 mb-8">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-mono text-slate-400">Etapas do Processo</span>
                        {processingFileTotal > 1 && (
                          <span className="text-xs font-semibold bg-blue-500/10 text-blue-400 border border-blue-500/20 px-2 py-0.5 rounded-full">
                            {processingFileIndex}/{processingFileTotal}
                          </span>
                        )}
                      </div>
                      <hr className="border-white/5" />
                      {loadingMode === "extract" ? (
                        <div className="flex items-center gap-3 text-sm">
                          <Loader2 className="w-4 h-4 text-blue-400 animate-spin shrink-0" />
                          <span className="text-white font-medium animate-pulse">
                            Extraindo texto do arquivo atual
                          </span>
                        </div>
                      ) : null}
                    </div>
                  )}

                  {/* Stop Button */}
                  {loadingMode === "narrate" && progressStep === "tts" && (
                    <div className="max-w-md mx-auto mb-6">
                      <button
                        onClick={handleStopNarration}
                        disabled={isStopping}
                        className="w-full bg-red-500/10 hover:bg-red-500/20 active:bg-red-500/30 border border-red-500/30 hover:border-red-500/50 disabled:opacity-50 disabled:cursor-not-allowed text-red-400 py-3 px-6 rounded-2xl text-sm font-semibold transition-all flex items-center justify-center gap-2 shadow-lg shadow-red-500/5 cursor-pointer"
                      >
                        {isStopping ? (
                          <>
                            <Loader2 className="w-4.5 h-4.5 animate-spin" />
                            <span>Compilando áudio gerado...</span>
                          </>
                        ) : (
                          <>
                            <Square className="w-4 h-4 fill-current" />
                            <span>Parar e Gerar Áudio até Aqui</span>
                          </>
                        )}
                      </button>
                      <p className="text-[11px] text-slate-400 mt-2 text-center">
                        Interrompe a narração e monta o áudio MP3 com o conteúdo processado até este momento.
                        {processingFileTotal > 1
                          ? " Os arquivos seguintes não serão narrados."
                          : ""}
                      </p>
                    </div>
                  )}

                  {!(loadingMode === "narrate" && processingPreviewText) && (
                    <p className="text-xs italic text-slate-400 mt-6 text-center">
                      "A leitura nos dá um lugar para ir quando temos que ficar onde estamos."
                    </p>
                  )}
                </div>

                {loadingMode === "narrate" && processingPreviewText && (
                  <div className="bg-slate-900/40 border border-white/10 rounded-2xl p-5 text-left space-y-4">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-mono text-slate-400">Etapas do Processo</span>
                      <div className="flex items-center gap-2 shrink-0">
                        {processingFileTotal > 1 && (
                          <span className="text-xs font-semibold bg-indigo-500/10 text-indigo-300 border border-indigo-500/20 px-2 py-0.5 rounded-full">
                            Arquivo {processingFileIndex}/{processingFileTotal}
                          </span>
                        )}
                        {(progressStep === "tts" || (progressStep === "encoding" && totalChunks > 0)) && totalChunks > 0 && (
                          <span className="text-xs font-semibold bg-blue-500/10 text-blue-400 border border-blue-500/20 px-2 py-0.5 rounded-full animate-pulse">
                            {progressStep === "encoding"
                              ? `${currentChunk} de ${totalChunks} partes`
                              : `Parte ${currentChunk} de ${totalChunks}`}
                          </span>
                        )}
                      </div>
                    </div>
                    <hr className="border-white/5" />

                    {/* Step 1 skipped — text already reviewed */}
                    <div className="flex items-center gap-3 text-sm">
                      <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                      <span className="text-slate-400">Texto revisado e confirmado</span>
                    </div>

                    {/* Step 2: Content preparation */}
                    <div className="flex items-center gap-3 text-sm">
                      {["pre_tts", "chunks"].includes(progressStep) ? (
                        <Loader2 className="w-4 h-4 text-blue-400 animate-spin shrink-0" />
                      ) : ["tts", "encoding", "done"].includes(progressStep) ? (
                        <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                      ) : (
                        <div className="w-4 h-4 rounded-full border border-white/20 shrink-0" />
                      )}
                      <span className={["pre_tts", "chunks"].includes(progressStep) ? "text-white font-medium animate-pulse" : "text-slate-400"}>
                        Estruturando e dividindo conteúdo
                      </span>
                    </div>

                    {/* Step 3: Synthesis */}
                    <div className="flex items-center gap-3 text-sm">
                      {["pre_tts", "chunks"].includes(progressStep) ? (
                        <div className="w-4 h-4 rounded-full border border-white/20 shrink-0" />
                      ) : progressStep === "tts" ? (
                        <Loader2 className="w-4 h-4 text-blue-400 animate-spin shrink-0" />
                      ) : (
                        <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                      )}
                      <span className={progressStep === "tts" ? "text-white font-medium animate-pulse" : ["pre_tts", "chunks"].includes(progressStep) ? "text-slate-500" : "text-slate-400"}>
                        Narrando com Inteligência Artificial (
                          {ttsEngine === "kokoro" ? "Kokoro" : "Qwen3 TTS"}
                        )
                      </span>
                    </div>

                    {/* Step 4: Encoding */}
                    <div className="flex items-center gap-3 text-sm">
                      {["pre_tts", "chunks", "tts"].includes(progressStep) ? (
                        <div className="w-4 h-4 rounded-full border border-white/20 shrink-0" />
                      ) : progressStep === "encoding" ? (
                        <Loader2 className="w-4 h-4 text-blue-400 animate-spin shrink-0" />
                      ) : (
                        <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                      )}
                      <span className={progressStep === "encoding" ? "text-white font-medium animate-pulse" : ["pre_tts", "chunks", "tts"].includes(progressStep) ? "text-slate-500" : "text-slate-400"}>
                        Codificando áudio ({outputFormat === "m4b" ? "M4B" : "MP3"})
                        {progressStep === "encoding" && encodePercent != null
                          ? ` — ${Math.round(encodePercent)}%`
                          : ""}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </motion.div>
          ) : showTextReview ? (
            /* Editable text review before TTS */
            <motion.div
              key="review"
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -15 }}
              className="max-w-4xl mx-auto bg-white/5 backdrop-blur-2xl border border-white/15 rounded-3xl shadow-2xl p-6 sm:p-8"
            >
              <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 mb-5">
                <div>
                  <h3 className="text-xl font-bold text-white flex items-center gap-2">
                    <BookOpen className="w-5 h-5 text-blue-400" />
                    {documents.length > 1
                      ? "Revisar textos antes de narrar"
                      : "Revisar texto antes de narrar"}
                  </h3>
                  <p className="text-sm text-slate-400 mt-1">
                    {documents.length > 1
                      ? "Valide o texto de cada arquivo. A narração usará exatamente o conteúdo revisado."
                      : "Edite o conteúdo como quiser. A narração usará exatamente este texto."}
                    {reviewDoc?.pagesNarrated ? (
                      <span className="block mt-1 text-xs text-slate-500">
                        Intervalo: {reviewDoc.pagesNarrated}
                      </span>
                    ) : null}
                  </p>
                </div>
                <button
                  onClick={() => {
                    setShowTextReview(false);
                  }}
                  className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-400 hover:text-white transition-colors cursor-pointer"
                >
                  <ArrowLeft className="w-3.5 h-3.5" />
                  Voltar
                </button>
              </div>

              {documents.length > 1 && (
                <div className="flex gap-2 overflow-x-auto pb-3 mb-4 scrollbar-thin scrollbar-thumb-white/10">
                  {documents.map((doc, index) => {
                    const isActive = (reviewDocId ?? documents[0]?.id) === doc.id;
                    const hasText = Boolean(doc.editableText.trim());
                    return (
                      <button
                        key={doc.id}
                        type="button"
                        onClick={() => setReviewDocId(doc.id)}
                        className={`shrink-0 max-w-[220px] rounded-xl border px-3 py-2 text-left transition-all cursor-pointer ${
                          isActive
                            ? "border-blue-500/60 bg-blue-500/15 text-white"
                            : "border-white/10 bg-white/5 text-slate-300 hover:border-white/20 hover:bg-white/10"
                        }`}
                        title={doc.file.name}
                      >
                        <span className="block text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-0.5">
                          Arquivo {index + 1}
                          {!hasText ? " · vazio" : ""}
                        </span>
                        <span className="block text-xs font-semibold truncate">{doc.file.name}</span>
                      </button>
                    );
                  })}
                </div>
              )}

              <textarea
                value={reviewDoc?.editableText ?? ""}
                onChange={(e) => {
                  const id = reviewDocId ?? documents[0]?.id;
                  if (!id) return;
                  updateDoc(id, { editableText: e.target.value });
                }}
                rows={18}
                className="w-full min-h-[320px] bg-slate-950/60 border border-white/10 focus:border-blue-500/60 rounded-2xl p-5 text-sm text-slate-200 leading-relaxed font-serif whitespace-pre-wrap outline-none resize-y scrollbar-thin scrollbar-thumb-white/10"
                placeholder="Texto extraído..."
              />

              <div className="mt-5 flex flex-col sm:flex-row gap-3">
                <button
                  onClick={() => {
                    setShowTextReview(false);
                  }}
                  className="sm:flex-1 bg-white/5 hover:bg-white/10 border border-white/15 text-slate-200 py-3.5 rounded-2xl text-sm font-semibold transition-all cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  onClick={handleConfirmNarration}
                  disabled={documents.some((d) => !d.editableText.trim())}
                  className="sm:flex-[2] bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white py-3.5 rounded-2xl font-bold text-sm shadow-lg shadow-blue-900/35 flex items-center justify-center gap-2.5 transition-all cursor-pointer"
                >
                  <Sparkles className="w-5 h-5" />
                  <span>
                    {documents.length > 1
                      ? `Narrar todos (${documents.length} arquivos)`
                      : "Narrar este texto"}
                  </span>
                </button>
              </div>
            </motion.div>
          ) : !hasResults ? (
            /* Upload & Configuration Panel */
            <motion.div
              key="setup"
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -15 }}
              className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start"
            >
              {/* Left Column: Upload or Document Detail */}
              <div className="lg:col-span-5 space-y-6">
                <div className="bg-white/5 backdrop-blur-2xl border border-white/15 rounded-3xl p-6 shadow-xl">
                  <h2 className="text-base font-bold text-white mb-4 flex items-center gap-2">
                    <FileText className="w-4.5 h-4.5 text-blue-400" />
                    <span>1. Documentos PDF ou EPUB</span>
                  </h2>

                  {documents.length === 0 ? (
                    // Drag and Drop Zone
                    <div
                      onDragEnter={handleDrag}
                      onDragOver={handleDrag}
                      onDragLeave={handleDrag}
                      onDrop={handleDrop}
                      className={`relative border-2 border-dashed rounded-2xl p-8 text-center transition-all ${
                        dragActive 
                          ? "border-blue-500 bg-blue-500/10" 
                          : "border-white/10 hover:border-blue-500/50 hover:bg-white/5"
                      }`}
                    >
                      <input
                        type="file"
                        id="file-upload"
                        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                        accept="application/pdf,application/epub+zip,.epub,.pdf"
                        multiple
                        onChange={handleFileChange}
                      />
                      <div className="bg-blue-500/10 text-blue-400 w-12 h-12 rounded-2xl flex items-center justify-center mx-auto mb-4">
                        <FileText className="w-6 h-6" />
                      </div>
                      <p className="text-sm font-semibold text-slate-200 mb-1">
                        Arraste PDFs ou EPUBs aqui
                      </p>
                      <p className="text-xs text-slate-400 mb-4">
                        um ou vários arquivos — clique para selecionar
                      </p>
                      <span className="inline-block bg-white/10 hover:bg-white/25 border border-white/15 rounded-lg px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-colors">
                        Escolher Arquivos
                      </span>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <div className="space-y-2">
                        {documents.map((doc, index) => {
                          const isActive = activeDocId === doc.id;
                          return (
                            <div
                              key={doc.id}
                              role="button"
                              tabIndex={0}
                              onClick={() => setActiveDocId(doc.id)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  setActiveDocId(doc.id);
                                }
                              }}
                              className={`border rounded-2xl p-3 flex items-center justify-between gap-3 cursor-pointer transition-all ${
                                isActive
                                  ? "border-blue-500/50 bg-blue-500/10"
                                  : "border-white/15 bg-white/5 hover:border-white/25"
                              }`}
                            >
                              <div className="flex items-center gap-3 overflow-hidden min-w-0">
                                <div className="bg-gradient-to-br from-red-500/20 to-red-600/20 border border-red-500/30 text-red-400 p-2 rounded-xl shrink-0">
                                  {doc.fileType === "epub" ? (
                                    <Book className="w-4 h-4 text-indigo-400" />
                                  ) : (
                                    <FileText className="w-4 h-4" />
                                  )}
                                </div>
                                <div className="overflow-hidden min-w-0">
                                  <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                                    Arquivo {index + 1}
                                  </p>
                                  <h4 className="text-sm font-semibold text-white truncate" title={doc.file.name}>
                                    {doc.file.name}
                                  </h4>
                                  <p className="text-xs text-slate-400">
                                    {(doc.file.size / (1024 * 1024)).toFixed(2)} MB • {doc.fileType.toUpperCase()}
                                    {doc.docInfoLoading ? " • lendo…" : ""}
                                  </p>
                                </div>
                              </div>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleRemoveFile(doc.id);
                                }}
                                className="bg-white/5 hover:bg-rose-500/20 text-slate-300 hover:text-rose-400 border border-white/10 rounded-xl p-2 transition-all shadow-sm shrink-0 cursor-pointer"
                                title="Remover arquivo"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          );
                        })}
                      </div>

                      <label className="relative flex items-center justify-center gap-2 rounded-xl border border-dashed border-white/15 hover:border-blue-500/40 hover:bg-white/5 px-3 py-2.5 text-xs font-semibold text-slate-300 hover:text-white transition-all cursor-pointer">
                        <Plus className="w-3.5 h-3.5" />
                        Adicionar mais arquivos
                        <input
                          type="file"
                          className="absolute inset-0 opacity-0 cursor-pointer"
                          accept="application/pdf,application/epub+zip,.epub,.pdf"
                          multiple
                          onChange={handleFileChange}
                        />
                      </label>
                    </div>
                  )}
                </div>

                {/* Page Controls Panel (Only shows if file loaded) */}
                {activeDoc && (
                  <motion.div
                    key={activeDoc.id}
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    className="bg-white/5 backdrop-blur-2xl border border-white/15 rounded-3xl p-6 shadow-xl space-y-4"
                  >
                    <h2 className="text-base font-bold text-white mb-2 flex items-center gap-2">
                      <Clock className="w-4.5 h-4.5 text-blue-400" />
                      <span>
                        2.{" "}
                        {activeDoc.fileType === "pdf" ? "Páginas do PDF" : "Capítulos do EPUB"}
                      </span>
                    </h2>
                    {documents.length > 1 && (
                      <p className="text-xs text-slate-400 -mt-2 truncate" title={activeDoc.file.name}>
                        Configurando: <span className="text-slate-200 font-medium">{activeDoc.file.name}</span>
                      </p>
                    )}

                    {activeDoc.docInfoLoading ? (
                      <div className="flex items-center gap-2 text-sm text-slate-400">
                        <Loader2 className="w-4 h-4 animate-spin text-blue-400" />
                        Lendo estrutura do documento...
                      </div>
                    ) : (
                      <>
                        {activeDoc.docInfoMessage && (
                          <p className="text-[11px] text-amber-200/90 bg-amber-500/10 border border-amber-500/20 rounded-xl px-3 py-2 leading-relaxed">
                            {activeDoc.docInfoMessage}
                            {activeDoc.fileType === "pdf" && activeDoc.pdfPageCount != null
                              ? ` Use números de 1 a ${activeDoc.pdfPageCount}.`
                              : ""}
                          </p>
                        )}

                        {activeDoc.fileType === "epub" && activeDoc.epubChapters.length > 0 ? (
                          <div className="space-y-4">
                            <div className="grid grid-cols-1 gap-4">
                              <div className="space-y-1.5">
                                <label className="text-xs font-bold text-slate-300">Capítulo / seção inicial</label>
                                <select
                                  value={activeDoc.startPage}
                                  onChange={(e) => {
                                    const next = parseInt(e.target.value, 10) || 1;
                                    const currentEnd = activeDoc.endPage
                                      ? parseInt(activeDoc.endPage, 10)
                                      : next;
                                    updateDoc(activeDoc.id, {
                                      startPage: next,
                                      endPage:
                                        !activeDoc.endPage || currentEnd < next
                                          ? String(next)
                                          : activeDoc.endPage,
                                    });
                                  }}
                                  className="w-full bg-slate-900/50 border border-white/15 text-white focus:border-blue-500 rounded-xl px-4 py-3 text-sm font-semibold outline-none"
                                >
                                  {activeDoc.epubChapters.map((ch) => (
                                    <option key={ch.id || ch.index} value={ch.index}>
                                      {ch.index}. {ch.title}
                                    </option>
                                  ))}
                                </select>
                              </div>
                              <div className="space-y-1.5">
                                <label className="text-xs font-bold text-slate-300">Capítulo / seção final</label>
                                <select
                                  value={activeDoc.endPage || String(activeDoc.startPage)}
                                  onChange={(e) =>
                                    updateDoc(activeDoc.id, { endPage: e.target.value })
                                  }
                                  className="w-full bg-slate-900/50 border border-white/15 text-white focus:border-blue-500 rounded-xl px-4 py-3 text-sm font-semibold outline-none"
                                >
                                  {activeDoc.epubChapters
                                    .filter((ch) => ch.index >= activeDoc.startPage)
                                    .map((ch) => (
                                      <option key={`end-${ch.id || ch.index}`} value={ch.index}>
                                        {ch.index}. {ch.title}
                                      </option>
                                    ))}
                                </select>
                              </div>
                            </div>
                            <p className="text-[11px] text-slate-400 leading-normal">
                              Em EPUB, “11” é o 11º capítulo da estrutura — não a página impressa 11. Um único capítulo pode ter o equivalente a muitas páginas.
                            </p>
                          </div>
                        ) : (
                          <div className="space-y-4">
                            <div className="grid grid-cols-2 gap-4">
                              <div className="space-y-1.5">
                                <label className="text-xs font-bold text-slate-300">Página inicial</label>
                                <input
                                  type="number"
                                  min={1}
                                  max={activeDoc.pdfPageCount ?? undefined}
                                  value={activeDoc.startPage}
                                  onChange={(e) =>
                                    updateDoc(activeDoc.id, {
                                      startPage: Math.max(1, parseInt(e.target.value) || 1),
                                    })
                                  }
                                  className="w-full bg-slate-900/50 border border-white/15 text-white focus:border-blue-500 focus:bg-slate-900 rounded-xl px-4 py-3 text-sm font-semibold outline-none transition-all"
                                />
                              </div>
                              <div className="space-y-1.5">
                                <label className="text-xs font-bold text-slate-300">
                                  Página final <span className="text-slate-400 font-normal">(vazio = só a inicial)</span>
                                </label>
                                <input
                                  type="number"
                                  placeholder={String(activeDoc.startPage)}
                                  min={activeDoc.startPage}
                                  max={activeDoc.pdfPageCount ?? undefined}
                                  value={activeDoc.endPage}
                                  onChange={(e) =>
                                    updateDoc(activeDoc.id, { endPage: e.target.value })
                                  }
                                  className="w-full bg-slate-900/50 border border-white/15 text-white focus:border-blue-500 focus:bg-slate-900 rounded-xl px-4 py-3 text-sm font-semibold outline-none transition-all placeholder:text-slate-500"
                                />
                              </div>
                            </div>
                            <p className="text-[11px] text-slate-400 leading-normal">
                              São páginas do arquivo PDF (como no leitor). Ex.: 11 a 12 extrai só essas duas folhas.
                            </p>
                          </div>
                        )}

                        {/* Cover page + preview */}
                        <div className="pt-2 border-t border-white/10 space-y-3">
                          <h3 className="text-sm font-bold text-white flex items-center gap-2">
                            <ImageIcon className="w-4 h-4 text-blue-400" />
                            Capa do livro
                          </h3>
                          {activeDoc.fileType === "pdf" ? (
                            <div className="space-y-1.5">
                              <label className="text-xs font-bold text-slate-300">
                                Página da capa{" "}
                                <span className="text-slate-400 font-normal">(vazio = sem capa)</span>
                              </label>
                              <input
                                type="number"
                                min={1}
                                max={activeDoc.pdfPageCount ?? undefined}
                                value={activeDoc.coverPage}
                                placeholder="1"
                                onChange={(e) =>
                                  updateDoc(activeDoc.id, { coverPage: e.target.value })
                                }
                                className="w-full bg-slate-900/50 border border-white/15 text-white focus:border-blue-500 rounded-xl px-4 py-3 text-sm font-semibold outline-none"
                              />
                            </div>
                          ) : (
                            <p className="text-[11px] text-slate-400">
                              A capa é detectada automaticamente no EPUB (metadata OPF).
                            </p>
                          )}
                          <div className="rounded-2xl border border-white/10 bg-black/20 p-3 flex items-center justify-center min-h-[140px]">
                            {coverPreviewLoading ? (
                              <Loader2 className="w-6 h-6 text-blue-400 animate-spin" />
                            ) : activeDoc.coverPreviewUrl ? (
                              <img
                                src={activeDoc.coverPreviewUrl}
                                alt="Preview da capa"
                                className="max-h-40 max-w-full object-contain rounded-lg"
                              />
                            ) : (
                              <p className="text-xs text-slate-500 text-center px-2">
                                {coverPreviewMessage || "Preview da capa"}
                              </p>
                            )}
                          </div>
                        </div>

                        {/* Output format */}
                        <div className="pt-2 border-t border-white/10 space-y-2">
                          <label className="text-xs font-bold text-slate-300">Formato de saída</label>
                          <div className="grid grid-cols-2 gap-2">
                            <button
                              type="button"
                              onClick={() => setOutputFormat("mp3")}
                              className={`rounded-xl border px-3 py-2.5 text-sm font-semibold transition-colors ${
                                outputFormat === "mp3"
                                  ? "border-blue-500/50 bg-blue-500/15 text-white"
                                  : "border-white/10 bg-white/5 text-slate-400 hover:text-white"
                              }`}
                            >
                              MP3
                            </button>
                            <button
                              type="button"
                              onClick={() => setOutputFormat("m4b")}
                              className={`rounded-xl border px-3 py-2.5 text-sm font-semibold transition-colors ${
                                outputFormat === "m4b"
                                  ? "border-violet-500/50 bg-violet-500/15 text-white"
                                  : "border-white/10 bg-white/5 text-slate-400 hover:text-white"
                              }`}
                            >
                              M4B
                            </button>
                          </div>
                          <p className="text-[11px] text-slate-500">
                            {outputFormat === "m4b"
                              ? "M4B inclui a capa (PDF) ou todas as imagens (EPUB) como artwork. Requer ffmpeg."
                              : "MP3 + JPEG da capa (mesmo nome) na pasta Downloads."}
                          </p>
                        </div>
                      </>
                    )}
                  </motion.div>
                )}
              </div>

              {/* Right Column: Voice Picker and Submit Action */}
              <div className="lg:col-span-7 space-y-6">
                <div className="bg-white/5 backdrop-blur-2xl border border-white/15 rounded-3xl p-6 shadow-xl">
                  <h2 className="text-base font-bold text-white mb-1 flex items-center gap-2">
                    <Music className="w-4.5 h-4.5 text-blue-400" />
                    <span>{documents.length > 0 ? "3. Voz do Narrador" : "2. Voz do Narrador"}</span>
                  </h2>
                  <p className="text-xs text-slate-400 mb-4">
                    {ttsEngine === "kokoro"
                      ? `Kokoro (${kokoroDevice === "gpu" ? "GPU" : "CPU"}). Escolha a voz neural para a narração.`
                      : "Motor Qwen3. A prévia em cache mantém o mesmo tom em toda a narração."}
                  </p>

                  {previewError && (
                    <div className="mb-4 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                      <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                      <span>{previewError}</span>
                    </div>
                  )}

                  <div className="space-y-4">
                    {(["Feminino", "Masculino"] as const).map((gender) => {
                      const genderVoices = voices.filter((v) => v.gender === gender);
                      return (
                        <div key={gender}>
                          <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500 mb-2 px-0.5">
                            {gender}
                          </p>
                          <div
                            className="grid grid-cols-1 sm:grid-cols-2 gap-1.5"
                            role="radiogroup"
                            aria-label={`Vozes ${gender.toLowerCase()}s`}
                          >
                            {genderVoices.map((voice) => {
                              const isSelected = selectedVoice === voice.id;
                              const isLoadingPreview = previewLoadingVoice === voice.id;
                              const isPlayingPreview = previewPlayingVoice === voice.id;
                              return (
                                <div
                                  key={voice.id}
                                  role="radio"
                                  aria-checked={isSelected}
                                  tabIndex={0}
                                  title={voice.description}
                                  onClick={() => setSelectedVoice(voice.id)}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter" || e.key === " ") {
                                      e.preventDefault();
                                      setSelectedVoice(voice.id);
                                    }
                                  }}
                                  className={`group relative flex items-center gap-2.5 rounded-xl border px-2.5 py-2 cursor-pointer transition-all ${
                                    isSelected
                                      ? "border-blue-500/60 bg-blue-500/10 shadow-[inset_0_0_0_1px_rgba(59,130,246,0.15)]"
                                      : "border-white/10 bg-white/[0.02] hover:border-white/20 hover:bg-white/[0.04]"
                                  }`}
                                >
                                  <span className="text-base leading-none shrink-0 w-6 text-center" aria-hidden>
                                    {voice.icon}
                                  </span>
                                  <div className="flex-1 min-w-0">
                                    <span className={`block text-[13px] font-semibold truncate ${isSelected ? "text-white" : "text-slate-200"}`}>
                                      {voice.name}
                                    </span>
                                    <span className="block text-[10px] text-slate-500 truncate leading-tight mt-0.5">
                                      {voice.description}
                                    </span>
                                  </div>
                                  <button
                                    type="button"
                                    title={isPlayingPreview ? "Parar prévia" : `Ouvir ${voice.name}`}
                                    aria-label={isPlayingPreview ? "Parar prévia" : `Ouvir exemplo de ${voice.name}`}
                                    disabled={isLoadingPreview || (!!previewLoadingVoice && !isLoadingPreview)}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      void playVoicePreview(voice.id);
                                    }}
                                    className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 border transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer ${
                                      isPlayingPreview
                                        ? "bg-blue-500/20 border-blue-400/40 text-blue-300"
                                        : "bg-transparent border-transparent text-slate-500 opacity-70 group-hover:opacity-100 group-hover:bg-white/5 group-hover:border-white/10 hover:text-white"
                                    }`}
                                  >
                                    {isLoadingPreview ? (
                                      <Loader2 className="w-3 h-3 animate-spin" />
                                    ) : isPlayingPreview ? (
                                      <Square className="w-2.5 h-2.5 fill-current" />
                                    ) : (
                                      <Play className="w-3 h-3 fill-current" />
                                    )}
                                  </button>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {documents.length > 0 ? (
                    <motion.div
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="mt-6 pt-6 border-t border-white/10"
                    >
                      <button
                        onClick={handleExtractForReview}
                        disabled={!allDocsReady || anyDocInfoLoading}
                        className="w-full bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white py-4 rounded-2xl font-bold text-sm shadow-lg shadow-blue-900/35 flex items-center justify-center gap-2.5 transition-all hover:scale-[1.01] active:scale-[0.99] cursor-pointer"
                      >
                        <Sparkles className="w-5 h-5" />
                        <span>
                          {documents.length > 1
                            ? `Extrair Textos para Revisar (${documents.length})`
                            : "Extrair Texto para Revisar"}
                        </span>
                      </button>
                    </motion.div>
                  ) : (
                    <div className="mt-6 p-4 bg-white/5 border border-white/10 rounded-2xl text-center">
                      <p className="text-xs text-slate-400">
                        Adicione um ou mais documentos PDF/EPUB na coluna ao lado para iniciar a narração.
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </motion.div>
          ) : (
            /* Narration Result Panel (Split-Screen Layout) */
            <motion.div
              key="result"
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.98 }}
              className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start"
            >
              {/* Left Column: Player Controls */}
              <div className="lg:col-span-5 space-y-6">
                <div className="bg-white/5 backdrop-blur-2xl border border-white/15 rounded-3xl p-6 shadow-xl">
                  <button 
                    onClick={resetAll}
                    className="mb-6 inline-flex items-center gap-1.5 text-xs font-bold text-blue-400 hover:text-blue-300 transition-colors cursor-pointer"
                  >
                    <ArrowLeft className="w-3.5 h-3.5" />
                    <span>Narrar Outro Trecho</span>
                  </button>

                  {completedDocs.length > 1 && (
                    <div className="flex gap-2 overflow-x-auto pb-3 mb-4 scrollbar-thin scrollbar-thumb-white/10">
                      {completedDocs.map((doc, index) => {
                        const isActive = resultDoc?.id === doc.id;
                        return (
                          <button
                            key={doc.id}
                            type="button"
                            onClick={() => selectResultDoc(doc.id)}
                            className={`shrink-0 max-w-[200px] rounded-xl border px-3 py-2 text-left transition-all cursor-pointer ${
                              isActive
                                ? "border-emerald-500/50 bg-emerald-500/10 text-white"
                                : "border-white/10 bg-white/5 text-slate-300 hover:border-white/20"
                            }`}
                            title={doc.file.name}
                          >
                            <span className="block text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-0.5">
                              Áudio {index + 1}
                            </span>
                            <span className="block text-xs font-semibold truncate">{doc.file.name}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}

                  <div className="text-center mb-6">
                    <div className="inline-flex bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 px-3 py-1.5 rounded-full text-xs font-bold gap-1.5 items-center mb-4">
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                      <span>
                        {completedDocs.length > 1
                          ? `${completedDocs.length} ÁUDIOS PRONTOS`
                          : `ÁUDIO ${((resultDoc?.audioFormat || outputFormat) === "m4b" ? "M4B" : "MP3")} PRONTO`}
                      </span>
                    </div>

                    <h2 className="text-lg font-bold text-white truncate px-4" title={resultDoc?.file.name}>
                      {resultDoc?.file.name}
                    </h2>
                    <p className="text-xs text-slate-400 mt-1">
                      {resultDoc?.fileType === "pdf" ? "Páginas: " : "Seções: "}
                      <strong className="text-slate-200">{resultDoc?.pagesNarrated}</strong>
                      {" • "}Voz: <strong className="text-blue-400">{selectedVoice}</strong>
                    </p>
                  </div>

                  {/* PREMIUM CUSTOM AUDIO PLAYER */}
                  <div className="bg-slate-950/40 border border-white/10 rounded-2xl p-5 mb-6">
                    {/* Progress Slider */}
                    <div className="space-y-1 mb-4">
                      <input
                        type="range"
                        min={0}
                        max={duration || 100}
                        value={currentTime}
                        onChange={handleSeek}
                        className="w-full h-1.5 bg-white/10 accent-blue-500 rounded-lg appearance-none cursor-pointer"
                      />
                      <div className="flex justify-between text-[11px] font-semibold text-slate-400">
                        <span>{formatTime(currentTime)}</span>
                        <span>{formatTime(duration)}</span>
                      </div>
                    </div>

                    {/* Controls Row */}
                    <div className="flex items-center justify-center gap-5 mb-5">
                      <button
                        onClick={() => skipTime(-10)}
                        className="text-slate-400 hover:text-white transition-colors p-2 rounded-lg hover:bg-white/5 cursor-pointer"
                        title="Voltar 10 segundos"
                      >
                        <RotateCcw className="w-5 h-5" />
                      </button>

                      <button
                        onClick={togglePlay}
                        className="bg-white text-slate-950 w-14 h-14 rounded-full flex items-center justify-center shadow-xl transition-all hover:scale-105 active:scale-95 cursor-pointer"
                        title={isPlaying ? "Pausar" : "Reproduzir"}
                      >
                        {isPlaying ? (
                          <Pause className="w-6 h-6 fill-current text-slate-950" />
                        ) : (
                          <Play className="w-6 h-6 fill-current text-slate-950 translate-x-0.5" />
                        )}
                      </button>

                      <button
                        onClick={() => skipTime(10)}
                        className="text-slate-400 hover:text-white transition-colors p-2 rounded-lg hover:bg-white/5 cursor-pointer"
                        title="Avançar 10 segundos"
                      >
                        <RotateCw className="w-5 h-5" />
                      </button>
                    </div>

                    {/* Volume and Mute row */}
                    <div className="flex items-center gap-3 border-t border-white/5 pt-3">
                      <button
                        onClick={toggleMute}
                        className="text-slate-400 hover:text-white transition-colors p-1.5 rounded-lg cursor-pointer"
                      >
                        {isMuted ? (
                          <VolumeX className="w-4 h-4" />
                        ) : (
                          <Volume2 className="w-4 h-4" />
                        )}
                      </button>
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.05}
                        value={isMuted ? 0 : volume}
                        onChange={handleVolumeChange}
                        className="flex-1 h-1 bg-white/10 accent-white rounded-lg appearance-none cursor-pointer"
                      />
                    </div>
                  </div>

                  {/* Physical Download MP3 Action */}
                  <button
                    onClick={() => downloadMp3(resultDoc)}
                    disabled={!resultDoc?.audioUrl}
                    className="w-full bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 disabled:opacity-40 disabled:cursor-not-allowed text-white py-4 rounded-2xl font-bold text-sm shadow-lg shadow-emerald-950/20 flex items-center justify-center gap-2.5 transition-all hover:scale-[1.01] active:scale-[0.99] mb-4 cursor-pointer"
                  >
                    <Download className="w-5 h-5" />
                    <span>
                      Baixar Áudio (.
                      {(resultDoc?.audioFormat || outputFormat) === "m4b" ? "m4b" : "mp3"})
                    </span>
                  </button>

                  <p className="text-[10px] text-center text-slate-400">
                    O áudio gerado pode ser reproduzido offline e é compatível com celulares e computadores.
                  </p>
                </div>
              </div>

              {/* Right Column: Extracted Text Follow-along Panel */}
              <div className="lg:col-span-7">
                <div className="bg-white/5 backdrop-blur-2xl border border-white/15 rounded-3xl p-6 shadow-xl h-[520px] flex flex-col">
                  <h3 className="text-base font-bold text-white mb-1 flex items-center gap-2 shrink-0">
                    <BookOpen className="w-4.5 h-4.5 text-blue-400" />
                    <span>Texto Narrado</span>
                  </h3>
                  <p className="text-xs text-slate-400 mb-4 shrink-0">
                    Acompanhe a leitura visual do texto extraído pela inteligência artificial.
                  </p>

                  <div className="flex-1 overflow-y-auto bg-slate-950/40 border border-white/5 rounded-2xl p-5 scrollbar-thin scrollbar-thumb-white/10">
                    <p className="text-slate-300 text-sm leading-relaxed whitespace-pre-wrap select-text font-serif">
                      {resultDoc?.extractedText}
                    </p>
                  </div>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        )}
      </main>
      </div>

    </div>
  );
}
