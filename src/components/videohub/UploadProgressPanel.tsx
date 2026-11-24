import { AlertCircle, CheckCircle2, Loader2, RotateCcw, UploadCloud } from "lucide-react";
import {
  formatRemainingTime,
  formatUploadedTotalPair,
  type UploadProgressSnapshot,
} from "@/lib/upload-progress";

export interface UploadProgressPanelProps {
  snapshot: UploadProgressSnapshot;
  accent?: "sky" | "pink" | "emerald";
  compact?: boolean;
  onRetry?: (() => void) | undefined;
  retryDisabled?: boolean | undefined;
  retryLabel?: string | undefined;
  processingLabel?: string | undefined;
}

export function UploadProgressPanel({
  snapshot,
  accent = "sky",
  compact = false,
  onRetry,
  retryDisabled = false,
  retryLabel = "Retry Upload",
  processingLabel,
}: UploadProgressPanelProps) {
  if (snapshot.stage === "idle") return null;

  const isFailed = snapshot.stage === "failed";
  const isCompleted = snapshot.stage === "completed";
  const isUploadDone = snapshot.stage === "upload_completed";
  const isServerProcessing = snapshot.stage === "server_processing";
  const isUploading = snapshot.stage === "uploading";

  const accentBarClass =
    accent === "pink"
      ? "bg-gradient-to-r from-pink-500 to-rose-400"
      : accent === "emerald"
        ? "bg-gradient-to-r from-emerald-500 to-teal-400"
        : "bg-gradient-to-r from-sky-500 to-emerald-400";

  const accentBadgeClass =
    accent === "pink"
      ? "bg-pink-500/15 text-pink-600 dark:text-pink-300 border-pink-500/30"
      : accent === "emerald"
        ? "bg-emerald-500/15 text-emerald-500 border-emerald-500/30"
        : "bg-sky-500/15 text-sky-400 border-sky-500/30";

  const containerToneClass = isFailed
    ? "border-rose-500/40 bg-rose-500/10"
    : isCompleted
      ? "border-emerald-500/40 bg-emerald-500/10"
      : "border-border bg-secondary/30";

  const statusText = isFailed
    ? "Upload failed"
    : isCompleted
      ? "Upload & processing completed"
      : isServerProcessing
        ? processingLabel || "Server-side processing..."
        : isUploadDone
          ? "Upload completed"
          : snapshot.isIndeterminate
            ? "Uploading (real-time byte progress unavailable in this browser)"
            : "Uploading...";

  const percentageLabel =
    isCompleted || isUploadDone || isServerProcessing
      ? "100%"
      : snapshot.percentage !== null
        ? `${snapshot.percentage}%`
        : "Uploading";

  const barWidth =
    isCompleted || isUploadDone || isServerProcessing
      ? 100
      : snapshot.percentage !== null
        ? snapshot.percentage
        : null;

  const byteSummary =
    snapshot.totalBytes > 0 || snapshot.loadedBytes > 0
      ? formatUploadedTotalPair(snapshot.loadedBytes, snapshot.totalBytes)
      : null;

  const etaText = isUploading ? formatRemainingTime(snapshot.estimatedRemainingSeconds) : null;

  return (
    <div
      role="status"
      aria-live="polite"
      className={`rounded-2xl border ${compact ? "p-3 space-y-2" : "p-4 space-y-2.5"} ${containerToneClass}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="flex items-center gap-2 min-w-0 font-bold text-foreground">
          {isFailed ? (
            <AlertCircle className="h-4 w-4 shrink-0 text-rose-400" />
          ) : isCompleted || isUploadDone ? (
            <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
          ) : isServerProcessing ? (
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-emerald-400" />
          ) : (
            <UploadCloud className="h-4 w-4 shrink-0 text-sky-400" />
          )}
          <span className="truncate">{statusText}</span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {isServerProcessing && (
            <span className="rounded-md border border-emerald-500/30 bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold text-emerald-400">
              Transfer 100% · Processing
            </span>
          )}
          {isUploadDone && (
            <span className="rounded-md border border-emerald-500/30 bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold text-emerald-400">
              Upload completed
            </span>
          )}
          {!isFailed && (
            <span
              className={`rounded-md border px-2 py-0.5 text-[11px] font-mono font-bold ${
                isCompleted || isUploadDone || isServerProcessing
                  ? "border-emerald-500/30 bg-emerald-500/15 text-emerald-400"
                  : accentBadgeClass
              }`}
            >
              {percentageLabel}
            </span>
          )}
        </div>
      </div>

      {/* Progress Bar */}
      {!isFailed && (
        <div
          className="h-2 w-full overflow-hidden rounded-full bg-secondary"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={barWidth !== null ? barWidth : undefined}
        >
          {barWidth !== null ? (
            <div
              className={`h-full transition-all duration-150 ${
                isCompleted || isUploadDone || isServerProcessing
                  ? "bg-emerald-500"
                  : accentBarClass
              }`}
              style={{ width: `${barWidth}%` }}
            />
          ) : (
            <div className={`h-full w-1/3 animate-pulse rounded-full ${accentBarClass}`} />
          )}
        </div>
      )}

      {/* Byte Transfer & Remaining Time Row */}
      {!isFailed && (byteSummary || etaText || isUploading) && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono text-muted-foreground">
          <span>{byteSummary || "Preparing upload..."}</span>
          <span>
            {isUploading
              ? snapshot.isIndeterminate
                ? "Indeterminate progress"
                : etaText || "Calculating remaining time..."
              : isUploadDone
                ? "File transfer complete"
                : isServerProcessing
                  ? "Finalizing on FaceTube servers..."
                  : "Done"}
          </span>
        </div>
      )}

      {/* Error & Duplicate-Safe Retry */}
      {isFailed && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-rose-300">
          <span className="min-w-0 break-words">
            {snapshot.errorMessage || "Video upload failed. Please try again."}
          </span>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              disabled={retryDisabled}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-rose-500 transition shadow-sm disabled:opacity-50"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              <span>{retryLabel}</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
