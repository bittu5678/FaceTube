export type PlayerAspectMode = "standard" | "short";

export interface FittedVideoBox {
  baseWidth: number;
  baseHeight: number;
  visualWidth: number;
  visualHeight: number;
}

/**
 * Resolves the player's container aspect mode from video contentType.
 * Normal videos default to responsive 16:9 ("standard"), while Shorts retain 9:16 ("short").
 */
export function resolvePlayerAspectMode(
  contentType?: "short" | "long" | string | null,
): PlayerAspectMode {
  return String(contentType || "")
    .trim()
    .toLowerCase() === "short"
    ? "short"
    : "standard";
}

export interface PlayerIntrinsicDimensions {
  width: number;
  height: number;
  aspectRatio: number;
}

/**
 * Resolves the effective intrinsic width, height, and aspect ratio of a video,
 * swapping dimensions for 90deg / 270deg quarter-turn rotations.
 * Returns null until valid metadata dimensions (> 0) are available.
 */
export function resolveEffectiveVideoDimensions(
  videoW: number,
  videoH: number,
  rotationDeg = 0,
): PlayerIntrinsicDimensions | null {
  if (!Number.isFinite(videoW) || !Number.isFinite(videoH) || videoW <= 0 || videoH <= 0) {
    return null;
  }
  const isQuarterTurn = Math.abs(rotationDeg % 180) === 90;
  const width = isQuarterTurn ? videoH : videoW;
  const height = isQuarterTurn ? videoW : videoH;
  return {
    width,
    height,
    aspectRatio: width / height,
  };
}

/**
 * Returns responsive inline CSS dimensions for FaceTubeVideoPlayer once video metadata is loaded.
 * Preserves the exact effective intrinsic aspect ratio (portrait, square, landscape, ultrawide)
 * while clamping width against both 100% of available column width and 80vh height so there is
 * no overflow and no unnecessary black letterboxing above/below the video.
 * Returns null in fullscreen or before metadata loads so fallback classes apply.
 */
export function getPlayerIntrinsicContainerStyle(
  videoW: number,
  videoH: number,
  rotationDeg = 0,
  isFullscreen = false,
): { width: string; maxWidth: string; aspectRatio: string } | null {
  if (isFullscreen) return null;
  const dims = resolveEffectiveVideoDimensions(videoW, videoH, rotationDeg);
  if (!dims) return null;
  return {
    width: `min(100%, calc(80vh * ${dims.width} / ${dims.height}))`,
    maxWidth: "100%",
    aspectRatio: `${dims.width} / ${dims.height}`,
  };
}

/**
 * Computes the exact fitted width and height for a video inside a container
 * while preserving the original video aspect ratio (no stretching or cropping),
 * including 90deg / 270deg quarter-turn rotations.
 */
export function computeFittedVideoBox(
  containerW: number,
  containerH: number,
  videoW: number,
  videoH: number,
  rotationDeg: number,
  aspectMode: PlayerAspectMode = "standard",
): FittedVideoBox | null {
  if (containerW <= 0 || containerH <= 0) return null;
  const fallbackW = aspectMode === "short" ? 9 : 16;
  const fallbackH = aspectMode === "short" ? 16 : 9;
  const effectiveW = videoW > 0 ? videoW : fallbackW;
  const effectiveH = videoH > 0 ? videoH : fallbackH;
  const isQuarterTurn = Math.abs(rotationDeg % 180) === 90;

  if (isQuarterTurn) {
    const scale = Math.min(containerW / effectiveH, containerH / effectiveW);
    const baseWidth = effectiveW * scale;
    const baseHeight = effectiveH * scale;
    return {
      baseWidth,
      baseHeight,
      visualWidth: baseHeight,
      visualHeight: baseWidth,
    };
  }

  const scale = Math.min(containerW / effectiveW, containerH / effectiveH);
  const baseWidth = effectiveW * scale;
  const baseHeight = effectiveH * scale;
  return {
    baseWidth,
    baseHeight,
    visualWidth: baseWidth,
    visualHeight: baseHeight,
  };
}

/**
 * Returns responsive container classes for FaceTubeVideoPlayer:
 * - Fullscreen fills the viewport cleanly without locking an external aspect box
 * - Normal ("standard") videos use responsive 16:9 (`aspect-video w-full`)
 * - Shorts ("short") retain vertical 9:16 presentation across desktop, tablet, and mobile
 */
export function getPlayerContainerClass(
  aspectMode: PlayerAspectMode,
  isFullscreen: boolean,
): string {
  if (isFullscreen) {
    return "h-full w-full rounded-none";
  }
  if (aspectMode === "short") {
    return "mx-auto aspect-[9/16] w-[min(420px,calc(80vh*9/16),100%)] rounded-2xl";
  }
  return "aspect-video w-full rounded-2xl";
}

/**
 * Returns the responsive 9:16 card container classes for the vertical Shorts player route.
 * Width scales dynamically against both viewport height and width so aspect-[9/16] is never distorted.
 */
export function getShortsStageCardClass(): string {
  return "relative w-[min(420px,calc((100vh-160px)*9/16),calc(100vw-24px))] aspect-[9/16] rounded-3xl overflow-hidden bg-black shadow-2xl border border-border/70 flex flex-col justify-between select-none";
}

/**
 * Returns responsive aspect-preserving preview classes for upload preview video elements.
 */
export function getUploadPreviewVideoClass(contentType?: "short" | "long" | string | null): string {
  if (resolvePlayerAspectMode(contentType) === "short") {
    return "mx-auto aspect-[9/16] max-h-56 w-auto max-w-full rounded-2xl bg-black object-contain border border-border shadow-sm";
  }
  return "mx-auto aspect-video w-full max-w-md rounded-2xl bg-black object-contain border border-border shadow-sm";
}
