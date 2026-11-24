export type UploadStage =
  "idle" | "uploading" | "upload_completed" | "server_processing" | "completed" | "failed";

export interface UploadProgressSnapshot {
  stage: UploadStage;
  loadedBytes: number;
  totalBytes: number;
  percentage: number | null;
  isIndeterminate: boolean;
  bytesPerSecond: number | null;
  estimatedRemainingSeconds: number | null;
  errorMessage?: string | undefined;
}

export interface UploadProgressTracker {
  startTimeMs: number;
  lastSampleTimeMs: number;
  lastSampleBytes: number;
  ewmaBytesPerSec: number | null;
}

export interface BrowserUploadProgressInput {
  loaded: number;
  total: number;
  lengthComputable: boolean;
}

export interface BatchProgressItemInput {
  fileSize: number;
  status: "queued" | "uploading" | "success" | "error";
  uploadStage?: UploadStage | undefined;
  loadedBytes?: number | undefined;
  totalBytes?: number | undefined;
  isIndeterminate?: boolean | undefined;
  bytesPerSecond?: number | null | undefined;
}

export interface OverallBatchProgressSnapshot {
  totalFiles: number;
  completedFiles: number;
  failedFiles: number;
  activeFiles: number;
  totalBytes: number;
  uploadedBytes: number;
  percentage: number | null;
  isIndeterminate: boolean;
  estimatedRemainingSeconds: number | null;
}

const KB = 1024;
const MB = 1024 * 1024;
const GB = 1024 * 1024 * 1024;

/**
 * Formats a byte count cleanly for upload progress display (e.g. "45 MB", "45.5 MB", "512 KB").
 */
export function formatUploadBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  if (bytes >= GB) {
    const val = bytes / GB;
    return `${Number(val.toFixed(2))} GB`;
  }
  if (bytes >= MB) {
    const val = bytes / MB;
    return `${Number(val.toFixed(1))} MB`;
  }
  if (bytes >= KB) {
    return `${Math.round(bytes / KB)} KB`;
  }
  return `${Math.round(bytes)} B`;
}

/**
 * Formats uploaded vs total bytes, e.g. "45 MB / 100 MB".
 * When totalBytes is unavailable (<= 0), returns only the uploaded amount when > 0.
 */
export function formatUploadedTotalPair(loadedBytes: number, totalBytes: number): string {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
    if (Number.isFinite(loadedBytes) && loadedBytes > 0) {
      return `${formatUploadBytes(loadedBytes)} uploaded`;
    }
    return "Calculating size...";
  }
  const safeLoaded = Math.max(0, Math.min(loadedBytes, totalBytes));
  return `${formatUploadBytes(safeLoaded)} / ${formatUploadBytes(totalBytes)}`;
}

/**
 * Formats an estimated remaining time in seconds into human-readable copy,
 * e.g. "Approximately 35 seconds remaining".
 */
export function formatRemainingTime(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return null;
  }
  const rounded = Math.ceil(seconds);
  if (rounded <= 0) {
    return "Less than 1 second remaining";
  }
  if (rounded < 60) {
    return `Approximately ${rounded} second${rounded === 1 ? "" : "s"} remaining`;
  }
  const mins = Math.floor(rounded / 60);
  const remSecs = rounded % 60;
  if (remSecs === 0) {
    return `Approximately ${mins} minute${mins === 1 ? "" : "s"} remaining`;
  }
  return `Approximately ${mins} minute${mins === 1 ? "" : "s"} ${remSecs} second${
    remSecs === 1 ? "" : "s"
  } remaining`;
}

export function createUploadProgressTracker(nowMs: number = Date.now()): UploadProgressTracker {
  return {
    startTimeMs: nowMs,
    lastSampleTimeMs: nowMs,
    lastSampleBytes: 0,
    ewmaBytesPerSec: null,
  };
}

/**
 * Computes a real-time UploadProgressSnapshot strictly from actual browser progress events.
 * - Never shows 100% while loaded < total.
 * - Returns an honest indeterminate snapshot if lengthComputable is false or total <= 0.
 */
export function computeUploadProgressFromEvent(
  tracker: UploadProgressTracker,
  event: BrowserUploadProgressInput,
  nowMs: number = Date.now(),
): UploadProgressSnapshot {
  const safeLoaded = Number.isFinite(event.loaded) && event.loaded > 0 ? event.loaded : 0;
  const safeTotal = Number.isFinite(event.total) && event.total > 0 ? event.total : 0;

  if (!event.lengthComputable || safeTotal <= 0) {
    return {
      stage: "uploading",
      loadedBytes: safeLoaded,
      totalBytes: 0,
      percentage: null,
      isIndeterminate: true,
      bytesPerSecond: null,
      estimatedRemainingSeconds: null,
    };
  }

  const clampedLoaded = Math.min(safeLoaded, safeTotal);
  const transferDone = clampedLoaded >= safeTotal;

  // Compute smoothed transfer throughput from actual byte/time deltas
  const dtSec = (nowMs - tracker.lastSampleTimeMs) / 1000;
  const dBytes = clampedLoaded - tracker.lastSampleBytes;
  if (dtSec >= 0.15 && dBytes >= 0) {
    const instantRate = dBytes / dtSec;
    if (instantRate > 0) {
      tracker.ewmaBytesPerSec =
        tracker.ewmaBytesPerSec === null
          ? instantRate
          : tracker.ewmaBytesPerSec * 0.7 + instantRate * 0.3;
    }
    tracker.lastSampleTimeMs = nowMs;
    tracker.lastSampleBytes = clampedLoaded;
  } else if (tracker.ewmaBytesPerSec === null && clampedLoaded > 0) {
    const totalElapsedSec = (nowMs - tracker.startTimeMs) / 1000;
    if (totalElapsedSec >= 0.25) {
      tracker.ewmaBytesPerSec = clampedLoaded / totalElapsedSec;
    }
  }

  const bytesPerSecond =
    tracker.ewmaBytesPerSec !== null && tracker.ewmaBytesPerSec > 0
      ? tracker.ewmaBytesPerSec
      : null;

  // Never show 100% before transfer actually finishes
  const rawPct = Math.round((clampedLoaded / safeTotal) * 100);
  const percentage = transferDone ? 100 : Math.min(99, Math.max(0, rawPct));

  const remainingBytes = Math.max(0, safeTotal - clampedLoaded);
  const estimatedRemainingSeconds = transferDone
    ? 0
    : bytesPerSecond !== null && remainingBytes > 0
      ? remainingBytes / bytesPerSecond
      : null;

  return {
    stage: transferDone ? "upload_completed" : "uploading",
    loadedBytes: clampedLoaded,
    totalBytes: safeTotal,
    percentage,
    isIndeterminate: false,
    bytesPerSecond,
    estimatedRemainingSeconds,
  };
}

export function createInitialUploadSnapshot(totalBytes: number): UploadProgressSnapshot {
  const hasKnownTotal = Number.isFinite(totalBytes) && totalBytes > 0;
  return {
    stage: "uploading",
    loadedBytes: 0,
    totalBytes: hasKnownTotal ? totalBytes : 0,
    percentage: hasKnownTotal ? 0 : null,
    isIndeterminate: !hasKnownTotal,
    bytesPerSecond: null,
    estimatedRemainingSeconds: null,
  };
}

export function createIndeterminateUploadSnapshot(totalBytes = 0): UploadProgressSnapshot {
  const safeTotal = Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes : 0;
  return {
    stage: "uploading",
    loadedBytes: 0,
    totalBytes: safeTotal,
    percentage: null,
    isIndeterminate: true,
    bytesPerSecond: null,
    estimatedRemainingSeconds: null,
  };
}

/**
 * Computes overall progress across multiple files in a bulk upload queue.
 */
export function computeOverallBatchProgress(
  items: readonly BatchProgressItemInput[],
): OverallBatchProgressSnapshot {
  const totalFiles = items.length;
  let completedFiles = 0;
  let failedFiles = 0;
  let activeFiles = 0;
  let totalBytes = 0;
  let uploadedBytes = 0;
  let hasIndeterminateActive = false;
  let activeRateBytesPerSec: number | null = null;
  let pendingAndActiveRemainingBytes = 0;

  for (const item of items) {
    const fileSize = Number.isFinite(item.fileSize) && item.fileSize > 0 ? item.fileSize : 0;
    totalBytes += fileSize;

    if (item.status === "success") {
      completedFiles += 1;
      uploadedBytes += fileSize;
    } else if (item.status === "error") {
      failedFiles += 1;
    } else if (item.status === "uploading") {
      activeFiles += 1;
      if (item.isIndeterminate) {
        hasIndeterminateActive = true;
      } else {
        const itemTotal = item.totalBytes && item.totalBytes > 0 ? item.totalBytes : fileSize;
        const itemLoaded = Math.max(0, Math.min(item.loadedBytes ?? 0, itemTotal));
        const itemDoneInServerProcessing =
          item.uploadStage === "upload_completed" || item.uploadStage === "server_processing";
        const effectiveLoaded = itemDoneInServerProcessing ? fileSize : itemLoaded;
        uploadedBytes += effectiveLoaded;
        pendingAndActiveRemainingBytes += Math.max(0, fileSize - effectiveLoaded);
      }
      if (item.bytesPerSecond && item.bytesPerSecond > 0) {
        activeRateBytesPerSec = item.bytesPerSecond;
      }
    } else {
      pendingAndActiveRemainingBytes += fileSize;
    }
  }

  if (totalFiles === 0) {
    return {
      totalFiles: 0,
      completedFiles: 0,
      failedFiles: 0,
      activeFiles: 0,
      totalBytes: 0,
      uploadedBytes: 0,
      percentage: 0,
      isIndeterminate: false,
      estimatedRemainingSeconds: null,
    };
  }

  if (hasIndeterminateActive || totalBytes <= 0) {
    return {
      totalFiles,
      completedFiles,
      failedFiles,
      activeFiles,
      totalBytes,
      uploadedBytes,
      percentage: null,
      isIndeterminate: true,
      estimatedRemainingSeconds: null,
    };
  }

  const allCompleted = completedFiles === totalFiles;
  const rawPct = Math.round((uploadedBytes / totalBytes) * 100);
  const percentage = allCompleted ? 100 : Math.min(99, Math.max(0, rawPct));
  const estimatedRemainingSeconds =
    activeFiles > 0 && activeRateBytesPerSec && pendingAndActiveRemainingBytes > 0
      ? pendingAndActiveRemainingBytes / activeRateBytesPerSec
      : null;

  return {
    totalFiles,
    completedFiles,
    failedFiles,
    activeFiles,
    totalBytes,
    uploadedBytes,
    percentage,
    isIndeterminate: false,
    estimatedRemainingSeconds,
  };
}

/**
 * Generates a stable key for a File instance to detect when a retry uses the same file
 * (so an already-uploaded storage URL can be reused without creating duplicate uploads).
 */
export function getUploadFileIdentityKey(file: File): string {
  return `${file.name}::${file.size}::${file.lastModified}::${file.type}`;
}
