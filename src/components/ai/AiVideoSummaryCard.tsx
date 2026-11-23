import { useEffect, useState } from "react";
import { Sparkles, Loader2, AlertCircle, ChevronDown, ChevronUp, ShieldCheck } from "lucide-react";
import { api } from "@/lib/api";

interface AiVideoSummaryCardProps {
  videoId: string;
  visibility?: "public" | "unlisted" | "private" | string;
}

export function AiVideoSummaryCard({ videoId, visibility = "public" }: AiVideoSummaryCardProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [consentChecked, setConsentChecked] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [summary, setSummary] = useState<{
    shortSummary: string;
    keyPoints: string[];
  } | null>(null);

  useEffect(() => {
    setSummary(null);
    setErrorMsg(null);
    setConsentChecked(false);
    setOpen(false);
  }, [videoId]);

  const normalizedVisibility = String(visibility || "public")
    .trim()
    .toLowerCase();
  const requiresConsent = normalizedVisibility === "private" || normalizedVisibility === "unlisted";

  const handleSummarize = async () => {
    if (requiresConsent && !consentChecked) {
      setErrorMsg("Please confirm consent before sending this non-public video for AI summary.");
      return;
    }
    setOpen(true);
    setLoading(true);
    setErrorMsg(null);
    try {
      const res = await api.ai.summarizeVideo({
        videoId,
        aiConsent: requiresConsent ? consentChecked : true,
      });
      if (!res?.success || !res?.summary?.shortSummary) {
        throw new Error(res?.error || "Could not summarize this video.");
      }
      setSummary({
        shortSummary: res.summary.shortSummary,
        keyPoints: Array.isArray(res.summary.keyPoints) ? res.summary.keyPoints : [],
      });
    } catch (err: any) {
      setSummary(null);
      setErrorMsg(err?.message || "This video could not be summarized right now.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="mt-4 rounded-2xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="grid h-8 w-8 place-items-center rounded-xl bg-brand/10 text-brand">
            <Sparkles className="h-4 w-4" />
          </span>
          <div>
            <h2 className="text-sm font-bold text-foreground">AI Video Summary</h2>
            <p className="text-xs text-muted-foreground">
              Summarizes the actual video stream using Google Gemini AI
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {!summary && (
            <button
              type="button"
              onClick={handleSummarize}
              disabled={loading || (requiresConsent && !consentChecked)}
              className="inline-flex items-center gap-1.5 rounded-full bg-brand px-4 py-1.5 text-xs font-semibold text-brand-foreground transition hover:bg-brand-dark disabled:opacity-50"
            >
              {loading ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span>Summarizing…</span>
                </>
              ) : (
                <>
                  <Sparkles className="h-3.5 w-3.5" />
                  <span>Summarize Video</span>
                </>
              )}
            </button>
          )}
          {summary && (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="inline-flex items-center gap-1 rounded-full bg-secondary px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-muted"
            >
              {open ? (
                <>
                  <span>Hide</span>
                  <ChevronUp className="h-3.5 w-3.5" />
                </>
              ) : (
                <>
                  <span>Show Summary</span>
                  <ChevronDown className="h-3.5 w-3.5" />
                </>
              )}
            </button>
          )}
        </div>
      </div>

      {requiresConsent && !summary && (
        <label className="mt-3 flex items-start gap-2 rounded-xl border border-border/70 bg-secondary/40 p-2.5 text-xs text-foreground cursor-pointer">
          <input
            type="checkbox"
            checked={consentChecked}
            onChange={(e) => {
              setConsentChecked(e.target.checked);
              if (e.target.checked) setErrorMsg(null);
            }}
            className="mt-0.5 h-3.5 w-3.5 accent-brand"
          />
          <span className="flex items-start gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-brand mt-0.5" />
            <span>
              This video is <strong>{normalizedVisibility}</strong>. Confirm sending its video
              content to Google Gemini AI to generate a summary.
            </span>
          </span>
        </label>
      )}

      {errorMsg && (
        <div
          role="alert"
          className="mt-3 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300"
        >
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>{errorMsg}</span>
        </div>
      )}

      {open && summary && (
        <div className="mt-3 space-y-3 border-t border-border/70 pt-3">
          <p className="text-sm leading-relaxed text-foreground/90">{summary.shortSummary}</p>
          {summary.keyPoints.length > 0 && (
            <div>
              <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-1.5">
                Key Takeaways
              </h3>
              <ul className="space-y-1.5 text-sm text-foreground/85 list-disc pl-5">
                {summary.keyPoints.map((pt, idx) => (
                  <li key={`${idx}-${pt.slice(0, 16)}`}>{pt}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
