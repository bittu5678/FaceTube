import { useRef, useState } from "react";
import { Sparkles, Check, Copy, Loader2, AlertCircle, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";

const MAX_CLIENT_VIDEO_ANALYSIS_BYTES = 12 * 1024 * 1024; // 12 MB
const SUPPORTED_VIDEO_EXTENSIONS = [".mp4", ".webm", ".mov", ".m4v", ".mpeg", ".mpg", ".3gp"];

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const idx = result.indexOf(",");
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = () => reject(new Error("Could not read selected video file."));
    reader.readAsDataURL(file);
  });
}

function isSupportedForVideoAi(file: File | null): boolean {
  if (!file) return false;
  const ext = "." + (file.name.split(".").pop() || "").toLowerCase();
  const mime = (file.type || "").toLowerCase();
  return (
    SUPPORTED_VIDEO_EXTENSIONS.includes(ext) ||
    mime === "video/mp4" ||
    mime === "video/webm" ||
    mime === "video/quicktime" ||
    mime === "video/mpeg" ||
    mime === "video/3gpp"
  );
}

interface AiMetadataAssistantProps {
  titleDraft: string;
  descriptionDraft: string;
  category: string;
  contentType: "short" | "long";
  visibility: "public" | "unlisted" | "private";
  videoFile: File | null;
  duration?: string;
  accentClassName?: string;
  onApplyTitle: (newTitle: string) => void;
  onApplyDescription: (newDescription: string) => void;
  onApplyBoth: (newTitle: string, newDescription: string) => void;
}

export function AiMetadataAssistant({
  titleDraft,
  descriptionDraft,
  category,
  contentType,
  visibility,
  videoFile,
  duration,
  accentClassName = "border-brand/30 bg-brand/5",
  onApplyTitle,
  onApplyDescription,
  onApplyBoth,
}: AiMetadataAssistantProps) {
  const [analyzeVideoConsent, setAnalyzeVideoConsent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [suggestedTitle, setSuggestedTitle] = useState("");
  const [suggestedDescription, setSuggestedDescription] = useState("");
  const [suggestedTags, setSuggestedTags] = useState<string[]>([]);
  const [analysisMode, setAnalysisMode] = useState<"video_content" | "metadata_only" | null>(null);
  const inFlightRef = useRef(false);

  const canAnalyzeFileBytes =
    Boolean(videoFile) &&
    (videoFile?.size || 0) > 0 &&
    (videoFile?.size || 0) <= MAX_CLIENT_VIDEO_ANALYSIS_BYTES &&
    isSupportedForVideoAi(videoFile);

  const isNonPublic = visibility === "private" || visibility === "unlisted";

  const handleGenerate = async () => {
    if (inFlightRef.current || loading) return;
    setErrorMsg(null);
    if (!titleDraft.trim() && !descriptionDraft.trim() && !videoFile) {
      toast.error("Add a video file or draft title/notes first so AI can generate suggestions.");
      return;
    }

    inFlightRef.current = true;
    setLoading(true);
    try {
      let videoBase64: string | undefined;
      let videoMimeType: string | undefined;

      if (analyzeVideoConsent && videoFile && canAnalyzeFileBytes) {
        videoBase64 = await readFileAsBase64(videoFile);
        videoMimeType = videoFile.type || "video/mp4";
      }

      const res = await api.ai.generateVideoMetadata({
        titleDraft: titleDraft.trim(),
        descriptionDraft: descriptionDraft.trim(),
        category,
        contentType,
        ...(videoFile?.name ? { fileName: videoFile.name } : {}),
        ...(duration ? { duration } : {}),
        ...(videoBase64 ? { videoBase64 } : {}),
        ...(videoMimeType ? { videoMimeType } : {}),
        aiConsent: Boolean(analyzeVideoConsent && videoBase64),
      });

      if (!res?.success || !res?.suggestions) {
        throw new Error(res?.error || "Could not generate metadata suggestions.");
      }

      setSuggestedTitle(res.suggestions.title || "");
      setSuggestedDescription(res.suggestions.description || "");
      setSuggestedTags(Array.isArray(res.suggestions.tags) ? res.suggestions.tags : []);
      setAnalysisMode(res.suggestions.analysisMode);
      toast.success("AI suggestions ready. Review and edit before applying.");
    } catch (err: any) {
      const msg = err?.message || "Failed to generate AI metadata suggestions.";
      setErrorMsg(msg);
      toast.error(msg);
    } finally {
      inFlightRef.current = false;
      setLoading(false);
    }
  };

  const handleCopyTags = async () => {
    if (suggestedTags.length === 0) return;
    const formatted = suggestedTags.map((t) => `#${t.replace(/\s+/g, "")}`).join(" ");
    try {
      await navigator.clipboard.writeText(formatted);
      toast.success("Tags copied to clipboard!");
    } catch {
      toast.error("Could not copy tags.");
    }
  };

  const handleAppendTagsToDraft = () => {
    if (suggestedTags.length === 0) return;
    const tagLine = suggestedTags.map((t) => `#${t.replace(/\s+/g, "")}`).join(" ");
    const base = (suggestedDescription || descriptionDraft).trim();
    const nextDesc = base ? `${base}\n\nTags: ${tagLine}` : `Tags: ${tagLine}`;
    onApplyDescription(nextDesc);
    toast.success("Tags added to your video description.");
  };

  return (
    <div className={`rounded-2xl border p-4 space-y-3 ${accentClassName}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand/15 text-brand">
            <Sparkles className="h-4 w-4" />
          </span>
          <div>
            <h3 className="text-xs font-bold text-foreground uppercase tracking-wide">
              AI Title, Description &amp; Tags Assistant
            </h3>
            <p className="text-[11px] text-muted-foreground">
              Generates editable suggestions — never overwrites your fields automatically.
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={handleGenerate}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-xl bg-brand px-3.5 py-2 text-xs font-bold text-brand-foreground transition hover:bg-brand-dark disabled:opacity-50"
        >
          {loading ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span>Generating…</span>
            </>
          ) : (
            <>
              <Sparkles className="h-3.5 w-3.5" />
              <span>Suggest Title &amp; Description</span>
            </>
          )}
        </button>
      </div>

      {videoFile && (
        <div className="rounded-xl border border-border/70 bg-background/60 p-3 space-y-1.5">
          {canAnalyzeFileBytes ? (
            <label className="flex items-start gap-2 cursor-pointer text-xs text-foreground">
              <input
                type="checkbox"
                checked={analyzeVideoConsent}
                onChange={(e) => setAnalyzeVideoConsent(e.target.checked)}
                className="mt-0.5 h-3.5 w-3.5 rounded border-border accent-brand"
              />
              <span>
                <span className="font-semibold">
                  Analyze uploaded video content with Google Gemini AI
                </span>{" "}
                <span className="text-muted-foreground">
                  ({(videoFile.size / (1024 * 1024)).toFixed(1)} MB
                  {isNonPublic ? ` · ${visibility} video — requires explicit consent` : ""}). Leave
                  unchecked to generate from your draft title, category, and filename only.
                </span>
              </span>
            </label>
          ) : (
            <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span>
                {videoFile.size > MAX_CLIENT_VIDEO_ANALYSIS_BYTES
                  ? `Video is ${(videoFile.size / (1024 * 1024)).toFixed(1)} MB (over 12 MB inline analysis limit). AI will generate suggestions from your draft notes and filename.`
                  : "AI will generate suggestions from your draft metadata and filename."}
              </span>
            </p>
          )}
        </div>
      )}

      {errorMsg && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300"
        >
          <AlertCircle className="h-4 w-4 shrink-0 text-red-400 mt-0.5" />
          <span>{errorMsg}</span>
        </div>
      )}

      {(suggestedTitle || suggestedDescription || suggestedTags.length > 0) && (
        <div className="space-y-3 rounded-xl border border-border bg-card p-3.5">
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span className="font-semibold text-foreground">
              Editable AI Suggestions{" "}
              {analysisMode === "video_content"
                ? "(Analyzed from video content)"
                : "(Based on your draft metadata)"}
            </span>
          </div>

          <div>
            <label className="block text-[11px] font-semibold text-muted-foreground mb-1">
              Suggested Title
            </label>
            <input
              type="text"
              value={suggestedTitle}
              onChange={(e) => setSuggestedTitle(e.target.value)}
              className="w-full rounded-lg border border-border bg-secondary/30 px-3 py-1.5 text-xs text-foreground focus:border-brand focus:outline-none"
            />
          </div>

          <div>
            <label className="block text-[11px] font-semibold text-muted-foreground mb-1">
              Suggested Description
            </label>
            <textarea
              rows={3}
              value={suggestedDescription}
              onChange={(e) => setSuggestedDescription(e.target.value)}
              className="w-full rounded-lg border border-border bg-secondary/30 px-3 py-1.5 text-xs text-foreground focus:border-brand focus:outline-none"
            />
          </div>

          {suggestedTags.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[11px] font-semibold text-muted-foreground">
                  Suggested Tags
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleCopyTags}
                    className="inline-flex items-center gap-1 text-[11px] font-semibold text-muted-foreground hover:text-foreground"
                  >
                    <Copy className="h-3 w-3" />
                    Copy Tags
                  </button>
                  <button
                    type="button"
                    onClick={handleAppendTagsToDraft}
                    className="text-[11px] font-semibold text-brand hover:underline"
                  >
                    Add Tags to Description
                  </button>
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {suggestedTags.map((tag) => (
                  <span
                    key={tag}
                    className="rounded-md border border-border bg-secondary/60 px-2 py-0.5 text-[11px] font-medium text-foreground"
                  >
                    #{tag}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-border/60">
            <button
              type="button"
              onClick={() => {
                onApplyTitle(suggestedTitle);
                toast.success("Suggested title applied.");
              }}
              disabled={!suggestedTitle.trim()}
              className="inline-flex items-center gap-1 rounded-lg border border-border bg-secondary px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-secondary/80 disabled:opacity-50"
            >
              <Check className="h-3.5 w-3.5 text-emerald-500" />
              Apply Title
            </button>
            <button
              type="button"
              onClick={() => {
                onApplyDescription(suggestedDescription);
                toast.success("Suggested description applied.");
              }}
              disabled={!suggestedDescription.trim()}
              className="inline-flex items-center gap-1 rounded-lg border border-border bg-secondary px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-secondary/80 disabled:opacity-50"
            >
              <Check className="h-3.5 w-3.5 text-emerald-500" />
              Apply Description
            </button>
            <button
              type="button"
              onClick={() => {
                onApplyBoth(suggestedTitle, suggestedDescription);
                toast.success("Suggested title and description applied.");
              }}
              disabled={!suggestedTitle.trim() && !suggestedDescription.trim()}
              className="inline-flex items-center gap-1 rounded-lg bg-brand px-3.5 py-1.5 text-xs font-bold text-brand-foreground hover:bg-brand-dark disabled:opacity-50"
            >
              <Check className="h-3.5 w-3.5" />
              Apply Both
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
