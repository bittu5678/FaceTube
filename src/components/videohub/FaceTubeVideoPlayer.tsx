import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
import {
  ArrowLeft,
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize,
  Minimize,
  RotateCcw,
  RotateCw,
  ZoomIn,
  ZoomOut,
  AlertTriangle,
  Loader2,
  Film,
  Sparkles,
  Settings,
  X,
} from "lucide-react";
import { Link } from "@tanstack/react-router";
import { resolveMediaUrl } from "@/lib/media-url";
import {
  clampSeekTime,
  computeFittedVideoBox,
  computeSwipeSeekTime,
  getPlayerContainerClass,
  getPlayerIntrinsicContainerStyle,
  resolvePlayerAspectMode,
} from "@/lib/video-player-layout";

interface FaceTubeVideoPlayerProps {
  src?: string | undefined;
  poster?: string | undefined;
  title?: string | undefined;
  duration?: string | undefined;
  contentType?: "short" | "long" | string | undefined;
  autoPlay?: boolean | undefined;
  onEnded?: (() => void) | undefined;
  onBack?: (() => void) | undefined;
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.25;

function formatTime(seconds: number): string {
  if (isNaN(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s < 10 ? "0" : ""}${s}`;
}

function getMimeType(url: string): string {
  const clean = url.split("?")[0]?.toLowerCase() || "";
  if (clean.endsWith(".webm")) return "video/webm";
  if (clean.endsWith(".ogg") || clean.endsWith(".ogv")) return "video/ogg";
  if (clean.endsWith(".mov")) return "video/quicktime";
  if (clean.endsWith(".m4v") || clean.endsWith(".mp4")) return "video/mp4";
  return "video/mp4";
}

export function FaceTubeVideoPlayer({
  src,
  poster,
  title = "Video",
  duration: initialDurationStr,
  contentType,
  autoPlay = true,
  onEnded,
  onBack,
}: FaceTubeVideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isBuffering, setIsBuffering] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [showControls, setShowControls] = useState(true);
  const [showToolsMenu, setShowToolsMenu] = useState(false);
  const [swipePreview, setSwipePreview] = useState<{
    targetTime: number;
    deltaSeconds: number;
  } | null>(null);
  const controlsTimeoutRef = useRef<number | null>(null);
  const lastTouchTimeRef = useRef<number>(0);

  // Rotation, Zoom & Pan state
  const [rotation, setRotation] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [containerSize, setContainerSize] = useState<{ width: number; height: number }>({
    width: 0,
    height: 0,
  });
  const [videoSize, setVideoSize] = useState<{ width: number; height: number }>({
    width: 0,
    height: 0,
  });

  const dragStateRef = useRef<{
    active: boolean;
    startX: number;
    startY: number;
    originPanX: number;
    originPanY: number;
    moved: boolean;
  }>({
    active: false,
    startX: 0,
    startY: 0,
    originPanX: 0,
    originPanY: 0,
    moved: false,
  });
  const suppressNextClickRef = useRef(false);
  const touchPinchRef = useRef<{
    startDist: number | null;
    startZoom: number;
    lastTouch: { x: number; y: number } | null;
    moved: boolean;
  }>({
    startDist: null,
    startZoom: 1,
    lastTouch: null,
    moved: false,
  });
  const touchSwipeRef = useRef<{
    active: boolean;
    startX: number;
    startY: number;
    startTime: number;
    horizontalLocked: boolean;
    verticalRejected: boolean;
    previewTime: number | null;
  }>({
    active: false,
    startX: 0,
    startY: 0,
    startTime: 0,
    horizontalLocked: false,
    verticalRejected: false,
    previewTime: null,
  });

  const cleanSrc = resolveMediaUrl(src);
  const cleanPoster = resolveMediaUrl(poster);
  const aspectMode = resolvePlayerAspectMode(contentType);
  const containerAspectClass = getPlayerContainerClass(aspectMode, isFullscreen);
  const intrinsicContainerStyle = useMemo(
    () =>
      getPlayerIntrinsicContainerStyle(videoSize.width, videoSize.height, rotation, isFullscreen),
    [videoSize.width, videoSize.height, rotation, isFullscreen],
  );

  const normalizedRotation = ((rotation % 360) + 360) % 360;
  const isRotated = normalizedRotation !== 0;

  // Reset playback state when source URL changes (without wiping metadata on unrelated prop renders)
  useEffect(() => {
    setIsPlaying(false);
    setIsLoading(Boolean(cleanSrc));
    setIsBuffering(false);
    setHasError(false);
    setErrorMessage("");
    setCurrentTime(0);
    setRotation(0);
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setIsDragging(false);

    const videoEl = videoRef.current;
    if (videoEl && cleanSrc && videoEl.videoWidth > 0 && videoEl.videoHeight > 0) {
      setVideoSize({ width: videoEl.videoWidth, height: videoEl.videoHeight });
      setIsLoading(false);
    } else {
      setVideoSize({ width: 0, height: 0 });
    }

    if (videoEl && cleanSrc) {
      videoEl.load();
    }
  }, [cleanSrc]);

  useEffect(() => {
    const videoEl = videoRef.current;
    if (!videoEl || !cleanSrc || !autoPlay) return;
    const playPromise = videoEl.play();
    if (playPromise !== undefined) {
      playPromise
        .then(() => setIsPlaying(true))
        .catch(() => {
          // Autoplay with sound blocked by browser policy; try muted autoplay
          if (videoRef.current) {
            videoRef.current.muted = true;
            setIsMuted(true);
            videoRef.current
              .play()
              .then(() => setIsPlaying(true))
              .catch(() => {
                setIsPlaying(false);
              });
          } else {
            setIsPlaying(false);
          }
        });
    }
  }, [cleanSrc, autoPlay]);

  // Observe container size for accurate rotation & zoom fit calculations
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const updateSize = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setContainerSize({ width: rect.width, height: rect.height });
      }
    };

    updateSize();

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (entry) {
          const { width, height } = entry.contentRect;
          if (width > 0 && height > 0) {
            setContainerSize({ width, height });
          }
        }
      });
      observer.observe(el);
    }

    window.addEventListener("resize", updateSize);
    window.addEventListener("orientationchange", updateSize);
    document.addEventListener("fullscreenchange", updateSize);
    document.addEventListener("webkitfullscreenchange", updateSize);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", updateSize);
      window.removeEventListener("orientationchange", updateSize);
      document.removeEventListener("fullscreenchange", updateSize);
      document.removeEventListener("webkitfullscreenchange", updateSize);
    };
  }, [cleanSrc, hasError]);

  // Fullscreen change listener (standard + WebKit mobile Safari support)
  useEffect(() => {
    const doc = document as Document & {
      webkitFullscreenElement?: Element | null;
      mozFullScreenElement?: Element | null;
      msFullscreenElement?: Element | null;
    };
    const videoEl = videoRef.current;

    const handleFullscreenChange = () => {
      const fsActive = Boolean(
        document.fullscreenElement ||
        doc.webkitFullscreenElement ||
        doc.mozFullScreenElement ||
        doc.msFullscreenElement,
      );
      setIsFullscreen(fsActive);
    };

    const handleWebkitBegin = () => setIsFullscreen(true);
    const handleWebkitEnd = () => setIsFullscreen(false);

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    document.addEventListener("webkitfullscreenchange", handleFullscreenChange);
    document.addEventListener("mozfullscreenchange", handleFullscreenChange);
    document.addEventListener("MSFullscreenChange", handleFullscreenChange);
    videoEl?.addEventListener("webkitbeginfullscreen", handleWebkitBegin);
    videoEl?.addEventListener("webkitendfullscreen", handleWebkitEnd);

    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
      document.removeEventListener("webkitfullscreenchange", handleFullscreenChange);
      document.removeEventListener("mozfullscreenchange", handleFullscreenChange);
      document.removeEventListener("MSFullscreenChange", handleFullscreenChange);
      videoEl?.removeEventListener("webkitbeginfullscreen", handleWebkitBegin);
      videoEl?.removeEventListener("webkitendfullscreen", handleWebkitEnd);
    };
  }, [cleanSrc, hasError]);

  const clearControlsTimer = useCallback(() => {
    if (controlsTimeoutRef.current !== null) {
      window.clearTimeout(controlsTimeoutRef.current);
      controlsTimeoutRef.current = null;
    }
  }, []);

  const showControlsTemporarily = useCallback(
    (forcePlaying?: boolean) => {
      setShowControls(true);
      clearControlsTimer();
      const activePlaying = forcePlaying ?? isPlaying;
      controlsTimeoutRef.current = window.setTimeout(() => {
        if (activePlaying && !showToolsMenu) {
          setShowControls(false);
        }
      }, 3000);
    },
    [clearControlsTimer, isPlaying, showToolsMenu],
  );

  // Cleanup auto-hide timer on unmount and reschedule when playing/tools state changes
  useEffect(() => {
    if (!isPlaying || showToolsMenu) {
      clearControlsTimer();
      setShowControls(true);
    } else if (showControls) {
      showControlsTemporarily(true);
    }
    return () => clearControlsTimer();
  }, [isPlaying, showControls, showToolsMenu, clearControlsTimer, showControlsTemporarily]);

  const handleMouseMove = () => {
    showControlsTemporarily();
  };

  const fittedBox = useMemo(
    () =>
      computeFittedVideoBox(
        containerSize.width,
        containerSize.height,
        videoSize.width,
        videoSize.height,
        rotation,
        aspectMode,
      ),
    [
      containerSize.width,
      containerSize.height,
      videoSize.width,
      videoSize.height,
      rotation,
      aspectMode,
    ],
  );

  const getPanBounds = useCallback(
    (targetZoom: number, targetRotation: number) => {
      if (targetZoom <= 1) return { maxX: 0, maxY: 0 };
      const cw = containerSize.width || containerRef.current?.clientWidth || 0;
      const ch = containerSize.height || containerRef.current?.clientHeight || 0;
      if (cw <= 0 || ch <= 0) return { maxX: 0, maxY: 0 };

      const box = computeFittedVideoBox(
        cw,
        ch,
        videoSize.width,
        videoSize.height,
        targetRotation,
        aspectMode,
      );
      if (!box) {
        return {
          maxX: Math.max(0, ((targetZoom - 1) * cw) / 2),
          maxY: Math.max(0, ((targetZoom - 1) * ch) / 2),
        };
      }
      return {
        maxX: Math.max(0, (box.visualWidth * targetZoom - cw) / 2),
        maxY: Math.max(0, (box.visualHeight * targetZoom - ch) / 2),
      };
    },
    [containerSize.width, containerSize.height, videoSize.width, videoSize.height, aspectMode],
  );

  const clampPan = useCallback(
    (x: number, y: number, targetZoom: number, targetRotation: number) => {
      const { maxX, maxY } = getPanBounds(targetZoom, targetRotation);
      return {
        x: maxX > 0 ? Math.max(-maxX, Math.min(maxX, x)) : 0,
        y: maxY > 0 ? Math.max(-maxY, Math.min(maxY, y)) : 0,
      };
    },
    [getPanBounds],
  );

  // Keep pan clamped & centered whenever zoom, rotation, or container size changes
  useEffect(() => {
    if (zoom <= 1) {
      setPan({ x: 0, y: 0 });
      return;
    }
    setPan((prev) => {
      const next = clampPan(prev.x, prev.y, zoom, rotation);
      if (next.x === prev.x && next.y === prev.y) return prev;
      return next;
    });
  }, [zoom, rotation, clampPan]);

  const currentPanBounds = useMemo(
    () => getPanBounds(zoom, rotation),
    [getPanBounds, zoom, rotation],
  );
  const canPan = zoom > 1 && (currentPanBounds.maxX > 0 || currentPanBounds.maxY > 0);

  const handleRotateLeft = () => {
    showControlsTemporarily();
    setRotation((prev) => prev - 90);
  };

  const handleRotateRight = () => {
    showControlsTemporarily();
    setRotation((prev) => prev + 90);
  };

  const handleResetRotation = () => {
    showControlsTemporarily();
    setRotation(0);
  };

  const handleZoomIn = () => {
    showControlsTemporarily();
    setZoom((prev) => Math.min(MAX_ZOOM, Number((prev + ZOOM_STEP).toFixed(2))));
  };

  const handleZoomOut = () => {
    showControlsTemporarily();
    setZoom((prev) => {
      const next = Math.max(MIN_ZOOM, Number((prev - ZOOM_STEP).toFixed(2)));
      if (next <= MIN_ZOOM) {
        setPan({ x: 0, y: 0 });
      }
      return next;
    });
  };

  const handleResetZoom = () => {
    showControlsTemporarily();
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  // Mouse/Pen pointer drag for panning zoomed video
  const handleStagePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "touch") return;
    if (e.button !== 0) return;
    showControlsTemporarily();
    if (!canPan) return;

    dragStateRef.current = {
      active: true,
      startX: e.clientX,
      startY: e.clientY,
      originPanX: pan.x,
      originPanY: pan.y,
      moved: false,
    };
    setIsDragging(true);
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Ignore if pointer capture is unsupported in synthetic test environments
    }
  };

  const handleStagePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "touch") return;
    if (!dragStateRef.current.active) return;

    const dx = e.clientX - dragStateRef.current.startX;
    const dy = e.clientY - dragStateRef.current.startY;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
      dragStateRef.current.moved = true;
    }

    const clamped = clampPan(
      dragStateRef.current.originPanX + dx,
      dragStateRef.current.originPanY + dy,
      zoom,
      rotation,
    );
    setPan(clamped);
  };

  const endPointerDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "touch") return;
    if (!dragStateRef.current.active) return;
    if (dragStateRef.current.moved) {
      suppressNextClickRef.current = true;
    }
    dragStateRef.current.active = false;
    setIsDragging(false);
    try {
      if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {
      // Ignore
    }
  };

  // Mobile touch support: 2-finger pinch-to-zoom, 1-finger pan when zoomed, 1-finger horizontal swipe-to-seek at 1x
  const handleStageTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    lastTouchTimeRef.current = Date.now();
    if (e.touches.length === 2) {
      touchSwipeRef.current.active = false;
      setSwipePreview(null);
      const t1 = e.touches[0];
      const t2 = e.touches[1];
      if (t1 && t2) {
        touchPinchRef.current.startDist = Math.hypot(
          t1.clientX - t2.clientX,
          t1.clientY - t2.clientY,
        );
        touchPinchRef.current.startZoom = zoom;
        touchPinchRef.current.lastTouch = null;
        touchPinchRef.current.moved = true;
        setIsDragging(true);
      }
    } else if (e.touches.length === 1 && canPan) {
      touchSwipeRef.current.active = false;
      setSwipePreview(null);
      const t = e.touches[0];
      if (t) {
        touchPinchRef.current.lastTouch = { x: t.clientX, y: t.clientY };
        touchPinchRef.current.startDist = null;
        touchPinchRef.current.moved = false;
        setIsDragging(true);
      }
    } else if (e.touches.length === 1 && !canPan) {
      const t = e.touches[0];
      if (t) {
        touchPinchRef.current.startDist = null;
        touchPinchRef.current.lastTouch = null;
        touchPinchRef.current.moved = false;
        touchSwipeRef.current = {
          active: true,
          startX: t.clientX,
          startY: t.clientY,
          startTime: videoRef.current?.currentTime ?? currentTime,
          horizontalLocked: false,
          verticalRejected: false,
          previewTime: null,
        };
      }
    }
  };

  const handleStageTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length === 2 && touchPinchRef.current.startDist !== null) {
      const t1 = e.touches[0];
      const t2 = e.touches[1];
      if (t1 && t2) {
        const dist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
        const ratio = dist / touchPinchRef.current.startDist;
        const nextZoom = Math.min(
          MAX_ZOOM,
          Math.max(MIN_ZOOM, Number((touchPinchRef.current.startZoom * ratio).toFixed(2))),
        );
        setZoom(nextZoom);
        if (nextZoom <= 1) {
          setPan({ x: 0, y: 0 });
        } else {
          setPan((prev) => clampPan(prev.x, prev.y, nextZoom, rotation));
        }
      }
    } else if (e.touches.length === 1 && canPan && touchPinchRef.current.lastTouch) {
      const t = e.touches[0];
      if (t) {
        const dx = t.clientX - touchPinchRef.current.lastTouch.x;
        const dy = t.clientY - touchPinchRef.current.lastTouch.y;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
          touchPinchRef.current.moved = true;
        }
        touchPinchRef.current.lastTouch = { x: t.clientX, y: t.clientY };
        setPan((prev) => clampPan(prev.x + dx, prev.y + dy, zoom, rotation));
      }
    } else if (
      e.touches.length === 1 &&
      !canPan &&
      touchSwipeRef.current.active &&
      !touchSwipeRef.current.verticalRejected
    ) {
      const t = e.touches[0];
      if (t && duration > 0) {
        const dx = t.clientX - touchSwipeRef.current.startX;
        const dy = t.clientY - touchSwipeRef.current.startY;
        if (!touchSwipeRef.current.horizontalLocked) {
          if (Math.abs(dy) > 14 && Math.abs(dy) > Math.abs(dx)) {
            touchSwipeRef.current.verticalRejected = true;
            return;
          }
          if (Math.abs(dx) > 18 && Math.abs(dx) > Math.abs(dy) * 1.2) {
            touchSwipeRef.current.horizontalLocked = true;
            touchPinchRef.current.moved = true;
          }
        }
        if (touchSwipeRef.current.horizontalLocked) {
          const targetTime = computeSwipeSeekTime(
            touchSwipeRef.current.startTime,
            dx,
            containerSize.width || containerRef.current?.clientWidth || 360,
            duration,
          );
          touchSwipeRef.current.previewTime = targetTime;
          setSwipePreview({
            targetTime,
            deltaSeconds: Math.round(targetTime - touchSwipeRef.current.startTime),
          });
        }
      }
    }
  };

  const handleStageTouchEnd = (e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length < 2) {
      touchPinchRef.current.startDist = null;
    }
    if (e.touches.length === 0) {
      if (
        touchSwipeRef.current.horizontalLocked &&
        touchSwipeRef.current.previewTime !== null &&
        videoRef.current
      ) {
        videoRef.current.currentTime = touchSwipeRef.current.previewTime;
        setCurrentTime(touchSwipeRef.current.previewTime);
        showControlsTemporarily();
      }
      if (touchPinchRef.current.moved || touchSwipeRef.current.horizontalLocked) {
        suppressNextClickRef.current = true;
      }
      touchSwipeRef.current.active = false;
      touchSwipeRef.current.horizontalLocked = false;
      touchSwipeRef.current.verticalRejected = false;
      touchSwipeRef.current.previewTime = null;
      setSwipePreview(null);
      touchPinchRef.current.lastTouch = null;
      touchPinchRef.current.moved = false;
      setIsDragging(false);
    }
  };

  const togglePlay = useCallback(() => {
    if (!videoRef.current || !cleanSrc) return;
    if (videoRef.current.paused) {
      videoRef.current
        .play()
        .then(() => {
          setIsPlaying(true);
          showControlsTemporarily(true);
        })
        .catch((err) => {
          console.warn("Playback prevented:", err);
        });
    } else {
      videoRef.current.pause();
      setIsPlaying(false);
      setShowControls(true);
    }
  }, [cleanSrc, showControlsTemporarily]);

  const skipBy = useCallback(
    (deltaSeconds: number) => {
      if (!videoRef.current) return;
      const baseTime = videoRef.current.currentTime ?? currentTime;
      const targetTime = clampSeekTime(
        baseTime + deltaSeconds,
        videoRef.current.duration || duration,
      );
      videoRef.current.currentTime = targetTime;
      setCurrentTime(targetTime);
      showControlsTemporarily();
    },
    [currentTime, duration, showControlsTemporarily],
  );

  const handleStageClick = () => {
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false;
      return;
    }
    if (showToolsMenu) {
      setShowToolsMenu(false);
      return;
    }
    const isTouchTap = Date.now() - lastTouchTimeRef.current < 500;
    if (isTouchTap) {
      if (isPlaying) {
        if (showControls) {
          clearControlsTimer();
          setShowControls(false);
        } else {
          showControlsTemporarily(true);
        }
      } else {
        togglePlay();
      }
      return;
    }
    togglePlay();
    showControlsTemporarily();
  };

  const toggleMute = useCallback(() => {
    if (!videoRef.current) return;
    setIsMuted((prev) => {
      const nextMuted = !prev;
      if (videoRef.current) {
        videoRef.current.muted = nextMuted;
      }
      return nextMuted;
    });
    showControlsTemporarily();
  }, [showControlsTemporarily]);

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newVol = parseFloat(e.target.value);
    setVolume(newVol);
    if (videoRef.current) {
      videoRef.current.volume = newVol;
      const shouldMute = newVol === 0;
      videoRef.current.muted = shouldMute;
      setIsMuted(shouldMute);
    }
    showControlsTemporarily();
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const targetTime = clampSeekTime(parseFloat(e.target.value), duration);
    setCurrentTime(targetTime);
    if (videoRef.current) {
      videoRef.current.currentTime = targetTime;
    }
    showControlsTemporarily();
  };

  const toggleFullscreen = useCallback(() => {
    const containerEl = containerRef.current as
      | (HTMLDivElement & {
          webkitRequestFullscreen?: () => Promise<void> | void;
          mozRequestFullScreen?: () => Promise<void> | void;
          msRequestFullscreen?: () => Promise<void> | void;
        })
      | null;
    const videoEl = videoRef.current as
      | (HTMLVideoElement & {
          webkitEnterFullscreen?: () => void;
          webkitExitFullscreen?: () => void;
          webkitDisplayingFullscreen?: boolean;
        })
      | null;
    const doc = document as Document & {
      webkitFullscreenElement?: Element | null;
      mozFullScreenElement?: Element | null;
      msFullscreenElement?: Element | null;
      webkitExitFullscreen?: () => Promise<void> | void;
    };

    if (!containerEl) return;
    const activeFsElement =
      document.fullscreenElement ||
      doc.webkitFullscreenElement ||
      doc.mozFullScreenElement ||
      doc.msFullscreenElement;

    if (!activeFsElement && !videoEl?.webkitDisplayingFullscreen) {
      if (containerEl.requestFullscreen) {
        containerEl.requestFullscreen().catch(() => {
          videoEl?.webkitEnterFullscreen?.();
        });
      } else if (containerEl.webkitRequestFullscreen) {
        containerEl.webkitRequestFullscreen();
      } else if (videoEl?.webkitEnterFullscreen) {
        videoEl.webkitEnterFullscreen();
      }
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen().catch(console.error);
      } else if (doc.webkitExitFullscreen) {
        doc.webkitExitFullscreen();
      } else if (videoEl?.webkitExitFullscreen) {
        videoEl.webkitExitFullscreen();
      }
    }
    showControlsTemporarily();
  }, [showControlsTemporarily]);

  const cyclePlaybackSpeed = () => {
    const speeds = [1, 1.25, 1.5, 2];
    const nextIdx = (speeds.indexOf(playbackSpeed) + 1) % speeds.length;
    const nextSpeed = speeds[nextIdx] ?? 1;
    setPlaybackSpeed(nextSpeed);
    if (videoRef.current) {
      videoRef.current.playbackRate = nextSpeed;
    }
    showControlsTemporarily();
  };

  const retryPlayback = () => {
    setHasError(false);
    setIsLoading(true);
    setIsBuffering(false);
    setErrorMessage("");
    if (videoRef.current) {
      videoRef.current.load();
      videoRef.current
        .play()
        .then(() => setIsPlaying(true))
        .catch(() => setIsPlaying(false));
    }
  };

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't intercept if user is typing in form inputs
      if (
        ["input", "textarea", "select"].includes(
          (e.target as HTMLElement)?.tagName?.toLowerCase() || "",
        )
      ) {
        return;
      }
      if (e.key === " " || e.key === "k") {
        e.preventDefault();
        togglePlay();
      } else if (e.key === "m") {
        e.preventDefault();
        toggleMute();
      } else if (e.key === "f") {
        e.preventDefault();
        toggleFullscreen();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (videoRef.current) {
          videoRef.current.currentTime = Math.max(0, videoRef.current.currentTime - 5);
        }
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        if (videoRef.current) {
          videoRef.current.currentTime = Math.min(
            duration || 1000,
            videoRef.current.currentTime + 5,
          );
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [togglePlay, toggleMute, toggleFullscreen, duration]);

  // Case 1: Empty / Missing video URL
  if (!cleanSrc) {
    return (
      <div
        className={`relative ${getPlayerContainerClass(aspectMode, false)} overflow-hidden bg-black border border-border shadow-lift flex flex-col items-center justify-center p-6 text-center select-none`}
      >
        {cleanPoster && (
          <img
            src={cleanPoster}
            alt={title}
            className="absolute inset-0 h-full w-full object-cover opacity-20 filter blur-xs"
          />
        )}
        <div className="relative z-10 max-w-md space-y-4">
          <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-brand/15 text-brand shadow-inner">
            <Film className="h-7 w-7" />
          </div>
          <div>
            <h3 className="text-lg font-bold text-white">Video Source Inactive</h3>
            <p className="mt-1 text-xs text-zinc-400 leading-relaxed">
              No video file or stream URL has been attached to this catalog record. You can watch
              other videos or upload your own in Creator Studio.
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
            <Link
              to="/"
              className="rounded-full bg-brand px-5 py-2 text-xs font-bold text-white transition hover:bg-brand-dark shadow-sm"
            >
              Browse Available Videos
            </Link>
            <Link
              to="/upload"
              className="rounded-full border border-zinc-700 bg-zinc-800/80 px-4 py-2 text-xs font-semibold text-zinc-200 transition hover:bg-zinc-700"
            >
              Upload Video
            </Link>
          </div>
        </div>
      </div>
    );
  }

  // Case 2: Playback Error Card
  if (hasError) {
    return (
      <div
        className={`relative ${getPlayerContainerClass(aspectMode, false)} overflow-hidden bg-zinc-950 border border-red-500/30 shadow-lift flex flex-col items-center justify-center p-6 text-center select-none`}
      >
        {cleanPoster && (
          <img
            src={cleanPoster}
            alt={title}
            className="absolute inset-0 h-full w-full object-cover opacity-15 filter blur-sm"
          />
        )}
        <div className="relative z-10 max-w-lg space-y-4">
          <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-red-500/15 text-red-400 border border-red-500/20">
            <AlertTriangle className="h-7 w-7" />
          </div>
          <div>
            <h3 className="text-lg font-bold text-white">Playback Error</h3>
            <p className="mt-1 text-xs text-zinc-300 leading-relaxed">
              {errorMessage ||
                "The media file could not be played. The source URL may be offline or in an unsupported format."}
            </p>
            <p className="mt-2 text-[11px] font-mono text-zinc-400 truncate max-w-md mx-auto bg-black/60 px-3 py-1 rounded-md border border-zinc-800">
              Source: {cleanSrc}
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
            <button
              type="button"
              onClick={retryPlayback}
              className="inline-flex items-center gap-2 rounded-full bg-brand px-5 py-2 text-xs font-bold text-white transition hover:bg-brand-dark shadow-sm cursor-pointer"
            >
              <RotateCcw className="h-4 w-4" />
              Retry Playback
            </button>
            <Link
              to="/"
              className="rounded-full border border-zinc-700 bg-zinc-800/80 px-4 py-2 text-xs font-semibold text-zinc-200 transition hover:bg-zinc-700"
            >
              Browse Other Videos
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const mimeType = getMimeType(cleanSrc);
  const progressPercent =
    duration > 0 ? Math.min(100, Math.max(0, (currentTime / duration) * 100)) : 0;
  const shouldUseFittedBox = Boolean(fittedBox && (isFullscreen || isRotated || zoom > 1));
  const controlsVisible = !isPlaying || showControls || showToolsMenu;
  const hasActiveTransform = zoom > MIN_ZOOM || isRotated || playbackSpeed !== 1;
  const formattedDuration = duration > 0 ? formatTime(duration) : initialDurationStr || "0:00";

  const renderTimelineScrubber = (compact = false) => (
    <div
      className={`relative group/timeline flex items-center cursor-pointer ${
        compact ? "flex-1 h-7" : "w-full h-5"
      }`}
    >
      <input
        type="range"
        min={0}
        max={duration || 100}
        step={0.1}
        value={currentTime}
        onChange={handleSeek}
        aria-label="Seek video timeline"
        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
      />
      <div
        className={`w-full rounded-full bg-white/30 overflow-hidden transition-all ${
          compact ? "h-1 group-hover/timeline:h-1.5" : "h-1.5 group-hover/timeline:h-2"
        }`}
      >
        <div
          className="h-full bg-brand transition-all duration-75"
          style={{ width: `${progressPercent}%` }}
        />
      </div>
      <div
        className={`absolute rounded-full bg-brand ring-2 ring-white shadow-md -translate-x-1/2 pointer-events-none transition-transform group-hover/timeline:scale-125 ${
          compact ? "h-3 w-3" : "h-3.5 w-3.5"
        }`}
        style={{ left: `${progressPercent}%` }}
      />
    </div>
  );

  return (
    <div
      ref={containerRef}
      onMouseMove={handleMouseMove}
      onMouseLeave={() => isPlaying && !showToolsMenu && setShowControls(false)}
      style={intrinsicContainerStyle ?? undefined}
      className={`group relative ${
        intrinsicContainerStyle ? "mx-auto rounded-none sm:rounded-2xl" : containerAspectClass
      } overflow-hidden bg-black shadow-lift select-none`}
    >
      {/* Centered Video Stage: stretches cleanly to container bounds (avoids height:auto % collapse) */}
      <div
        onPointerDown={handleStagePointerDown}
        onPointerMove={handleStagePointerMove}
        onPointerUp={endPointerDrag}
        onPointerCancel={endPointerDrag}
        onTouchStart={handleStageTouchStart}
        onTouchMove={handleStageTouchMove}
        onTouchEnd={handleStageTouchEnd}
        onClick={handleStageClick}
        className={`absolute inset-0 flex items-center justify-center overflow-hidden ${
          canPan ? (isDragging ? "cursor-grabbing" : "cursor-grab") : "cursor-pointer"
        }`}
        style={{ touchAction: zoom > 1 ? "none" : "pan-y" }}
      >
        {/* Real HTML5 Video element */}
        <video
          ref={videoRef}
          playsInline
          poster={cleanPoster}
          preload="metadata"
          onLoadStart={() => {
            setIsLoading(true);
            setHasError(false);
          }}
          onLoadedMetadata={(e) => {
            const d = e.currentTarget.duration;
            if (!isNaN(d) && d > 0) {
              setDuration(d);
            }
            const vw = e.currentTarget.videoWidth;
            const vh = e.currentTarget.videoHeight;
            if (vw > 0 && vh > 0) {
              setVideoSize({ width: vw, height: vh });
            }
            setIsLoading(false);
          }}
          onResize={(e) => {
            const vw = e.currentTarget.videoWidth;
            const vh = e.currentTarget.videoHeight;
            if (vw > 0 && vh > 0) {
              setVideoSize({ width: vw, height: vh });
            }
          }}
          onCanPlay={(e) => {
            const vw = e.currentTarget.videoWidth;
            const vh = e.currentTarget.videoHeight;
            if (vw > 0 && vh > 0 && (videoSize.width !== vw || videoSize.height !== vh)) {
              setVideoSize({ width: vw, height: vh });
            }
            setIsLoading(false);
            setIsBuffering(false);
          }}
          onWaiting={() => setIsBuffering(true)}
          onPlaying={(e) => {
            const vw = e.currentTarget.videoWidth;
            const vh = e.currentTarget.videoHeight;
            if (vw > 0 && vh > 0 && (videoSize.width !== vw || videoSize.height !== vh)) {
              setVideoSize({ width: vw, height: vh });
            }
            setIsBuffering(false);
            setIsLoading(false);
            setIsPlaying(true);
          }}
          onPause={() => setIsPlaying(false)}
          onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
          onEnded={() => {
            setIsPlaying(false);
            onEnded?.();
          }}
          onError={(_e) => {
            const demoFallbacks: Record<string, string> = {
              vid_sample_coding: "https://vjs.zencdn.net/v/oceans.mp4",
              vid_sample_nature:
                "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4",
              vid_sample_animation:
                "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/friday.mp4",
            };
            const matchedKey = Object.keys(demoFallbacks).find((k) => cleanSrc.includes(k));
            if (matchedKey && videoRef.current) {
              const fallbackUrl = demoFallbacks[matchedKey]!;
              if (videoRef.current.src !== fallbackUrl) {
                videoRef.current.src = fallbackUrl;
                videoRef.current.load();
                videoRef.current.play().catch(() => {});
                return;
              }
            }
            setIsLoading(false);
            setIsBuffering(false);
            setHasError(true);
            const err = videoRef.current?.error;
            let msg = "The video file failed to load.";
            if (err?.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) {
              msg = "The format or source codec of this video is not supported by your browser.";
            } else if (err?.code === MediaError.MEDIA_ERR_NETWORK) {
              msg = "A network error occurred while fetching the video stream.";
            }
            setErrorMessage(msg);
          }}
          className={`object-contain bg-black ${shouldUseFittedBox ? "" : "h-full w-full"} ${
            isDragging ? "transition-none" : "transition-transform duration-200 ease-out"
          }`}
          style={{
            ...(shouldUseFittedBox && fittedBox
              ? {
                  width: `${fittedBox.baseWidth}px`,
                  height: `${fittedBox.baseHeight}px`,
                  maxWidth: "none",
                  maxHeight: "none",
                  flexShrink: 0,
                }
              : {}),
            transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom}) rotate(${rotation}deg)`,
            transformOrigin: "center center",
          }}
          src={cleanSrc}
        >
          <source src={cleanSrc} type={mimeType} />
          Your browser does not support the video tag.
        </video>
      </div>

      {/* Buffering or initial loading spinner */}
      {(isLoading || isBuffering) && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center bg-black/30 backdrop-blur-xs z-20">
          <div className="flex flex-col items-center gap-2">
            <Loader2 className="h-10 w-10 animate-spin text-brand" />
            <span className="text-[11px] font-semibold text-white/90">
              {isLoading ? "Loading video stream…" : "Buffering…"}
            </span>
          </div>
        </div>
      )}

      {/* Horizontal Swipe-to-Seek live badge */}
      {swipePreview && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center z-25">
          <div className="rounded-full bg-black/75 px-4 py-1.5 text-xs font-bold text-white backdrop-blur-md shadow-lg border border-white/15 tabular-nums">
            {formatTime(swipePreview.targetTime)}{" "}
            <span className="text-brand-light ml-1">
              (
              {swipePreview.deltaSeconds >= 0
                ? `+${swipePreview.deltaSeconds}s`
                : `${swipePreview.deltaSeconds}s`}
              )
            </span>
          </div>
        </div>
      )}

      {/* Center Transport Cluster: -10s / Play-Pause / +10s (Screenshot 3 style) */}
      {!isLoading && !isBuffering && (
        <div
          className={`pointer-events-none absolute inset-0 flex items-center justify-center bg-black/25 z-10 transition-opacity duration-200 ${
            controlsVisible ? "opacity-100" : "opacity-0"
          }`}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className={`flex items-center justify-center gap-5 sm:gap-8 ${
              controlsVisible ? "pointer-events-auto" : "pointer-events-none"
            }`}
          >
            {/* Skip Back 10s */}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                skipBy(-10);
              }}
              aria-label="Skip back 10 seconds"
              title="Rewind 10s"
              className="relative grid h-11 w-11 sm:h-12 sm:w-12 place-items-center rounded-full bg-black/50 text-white backdrop-blur-md transition hover:bg-black/75 active:scale-95 cursor-pointer"
            >
              <RotateCcw className="h-5 w-5 sm:h-6 sm:w-6" />
              <span className="absolute text-[9px] font-extrabold leading-none tracking-tighter translate-y-[0.5px]">
                10
              </span>
            </button>

            {/* Primary Play / Pause */}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                togglePlay();
              }}
              aria-label={isPlaying ? "Pause video" : "Play video"}
              className="grid h-14 w-14 sm:h-16 sm:w-16 place-items-center rounded-full bg-black/55 text-white backdrop-blur-md shadow-lift ring-1 ring-white/20 transition hover:bg-brand hover:ring-brand active:scale-95 cursor-pointer"
            >
              {isPlaying ? (
                <Pause className="h-6 w-6 sm:h-7 sm:w-7 fill-current" />
              ) : (
                <Play className="h-6 w-6 sm:h-7 sm:w-7 translate-x-[1.5px] fill-current" />
              )}
            </button>

            {/* Skip Forward 10s */}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                skipBy(10);
              }}
              aria-label="Skip forward 10 seconds"
              title="Forward 10s"
              className="relative grid h-11 w-11 sm:h-12 sm:w-12 place-items-center rounded-full bg-black/50 text-white backdrop-blur-md transition hover:bg-black/75 active:scale-95 cursor-pointer"
            >
              <RotateCw className="h-5 w-5 sm:h-6 sm:w-6" />
              <span className="absolute text-[9px] font-extrabold leading-none tracking-tighter translate-y-[0.5px]">
                10
              </span>
            </button>
          </div>
        </div>
      )}

      {/* Top Overlay Header: Back, Title, FaceTube Branding & Mobile Settings/Mute */}
      <div
        onClick={(e) => e.stopPropagation()}
        className={`absolute inset-x-0 top-0 bg-gradient-to-b from-black/75 via-black/25 to-transparent px-2.5 py-2 sm:p-4 z-20 transition-opacity duration-200 ${
          controlsVisible ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        }`}
      >
        <div className="flex items-center justify-between text-white gap-2 sm:gap-3">
          <div className="flex items-center gap-2 sm:gap-2.5 min-w-0 flex-1">
            {onBack && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onBack();
                }}
                className="grid h-10 w-10 sm:h-9 sm:w-9 shrink-0 place-items-center rounded-full bg-black/50 text-white backdrop-blur-md transition hover:bg-black/80 active:scale-90 cursor-pointer"
                aria-label="Back to previous page"
                title="Back to previous page"
              >
                <ArrowLeft className="h-4 w-4 sm:h-4 sm:w-4" />
              </button>
            )}
            <p className="text-xs sm:text-sm font-bold truncate max-w-[160px] xs:max-w-xs sm:max-w-md drop-shadow">
              {title}
            </p>
            <span className="hidden sm:inline-flex shrink-0 items-center gap-1 text-[11px] font-semibold bg-white/20 backdrop-blur-md px-2.5 py-0.5 rounded-full">
              <Sparkles className="h-3 w-3 text-brand" />
              FaceTube Player
            </span>
          </div>

          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
            <span className="inline-flex sm:hidden shrink-0 items-center gap-1 text-[10px] font-semibold bg-black/45 backdrop-blur-md px-2 py-0.5 rounded-full">
              <Sparkles className="h-2.5 w-2.5 text-brand" />
              FaceTube
            </span>

            {/* Settings / Transform Tools Menu Trigger */}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setShowToolsMenu((prev) => !prev);
                showControlsTemporarily();
              }}
              aria-label="Player settings and transform tools"
              aria-expanded={showToolsMenu}
              title="Zoom, Rotation & Speed"
              className="relative grid h-10 w-10 sm:h-9 sm:w-9 place-items-center rounded-full bg-black/50 text-white backdrop-blur-md transition hover:bg-black/80 active:scale-90 cursor-pointer"
            >
              <Settings className="h-4 w-4" />
              {hasActiveTransform && (
                <span className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-brand ring-1 ring-white" />
              )}
            </button>

            {/* Top-right Mute toggle (Screenshot 3 mobile placement) */}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                toggleMute();
              }}
              aria-label={isMuted ? "Unmute" : "Mute"}
              className="grid sm:hidden h-10 w-10 place-items-center rounded-full bg-black/50 text-white backdrop-blur-md transition hover:bg-black/80 active:scale-90 cursor-pointer"
            >
              {isMuted || volume === 0 ? (
                <VolumeX className="h-4 w-4 text-red-400" />
              ) : (
                <Volume2 className="h-4 w-4" />
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Compact Player Settings & Transform Drawer (Zoom / Rotation / Playback Speed) */}
      {showToolsMenu && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="absolute bottom-12 right-2.5 sm:bottom-16 sm:right-4 z-30 w-[min(268px,calc(100%-20px))] max-h-[calc(100%-3.5rem)] overflow-y-auto rounded-xl border border-white/15 bg-zinc-950/92 p-2.5 text-white shadow-2xl backdrop-blur-md"
          role="dialog"
          aria-label="Player transform and playback settings"
        >
          <div className="mb-2 flex items-center justify-between border-b border-white/10 pb-1.5">
            <span className="text-[11px] font-bold tracking-wide text-zinc-200">
              Player Controls
            </span>
            <button
              type="button"
              onClick={() => setShowToolsMenu(false)}
              aria-label="Close player settings"
              className="grid h-6 w-6 place-items-center rounded-full hover:bg-white/15 transition cursor-pointer"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          <div className="space-y-2 text-xs">
            {/* Zoom Row */}
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-medium text-zinc-300">Zoom</span>
              <div
                className="flex items-center rounded-lg bg-white/10 p-0.5"
                role="group"
                aria-label="Mobile video zoom controls"
              >
                <button
                  type="button"
                  onClick={handleZoomOut}
                  disabled={zoom <= MIN_ZOOM}
                  aria-label="Zoom out"
                  className="grid h-8 w-8 place-items-center rounded hover:bg-white/15 disabled:opacity-40 disabled:pointer-events-none transition cursor-pointer"
                >
                  <ZoomOut className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={handleResetZoom}
                  disabled={zoom <= MIN_ZOOM}
                  aria-label="Reset zoom"
                  className={`px-2 h-8 text-[11px] font-mono font-bold rounded transition ${
                    zoom > MIN_ZOOM
                      ? "text-white bg-brand/85 hover:bg-brand cursor-pointer"
                      : "text-zinc-300 disabled:opacity-75 cursor-default"
                  }`}
                >
                  {Math.round(zoom * 100)}%
                </button>
                <button
                  type="button"
                  onClick={handleZoomIn}
                  disabled={zoom >= MAX_ZOOM}
                  aria-label="Zoom in"
                  className="grid h-8 w-8 place-items-center rounded hover:bg-white/15 disabled:opacity-40 disabled:pointer-events-none transition cursor-pointer"
                >
                  <ZoomIn className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            {/* Rotation Row */}
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-medium text-zinc-300">Rotate</span>
              <div
                className="flex items-center rounded-lg bg-white/10 p-0.5"
                role="group"
                aria-label="Mobile video rotation controls"
              >
                <button
                  type="button"
                  onClick={handleRotateLeft}
                  aria-label="Rotate left 90 degrees"
                  className="grid h-8 w-8 place-items-center rounded hover:bg-white/15 transition cursor-pointer"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={handleResetRotation}
                  disabled={!isRotated}
                  aria-label="Reset rotation"
                  className={`px-2 h-8 text-[11px] font-mono font-bold rounded transition ${
                    isRotated
                      ? "text-white bg-brand/85 hover:bg-brand cursor-pointer"
                      : "text-zinc-300 disabled:opacity-75 cursor-default"
                  }`}
                >
                  {normalizedRotation}°
                </button>
                <button
                  type="button"
                  onClick={handleRotateRight}
                  aria-label="Rotate right 90 degrees"
                  className="grid h-8 w-8 place-items-center rounded hover:bg-white/15 transition cursor-pointer"
                >
                  <RotateCw className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            {/* Playback Speed Row */}
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-medium text-zinc-300">Speed</span>
              <button
                type="button"
                onClick={cyclePlaybackSpeed}
                aria-label={`Playback speed: ${playbackSpeed}x`}
                className="rounded-lg bg-white/15 px-3 py-1.5 text-xs font-mono font-bold hover:bg-white/25 transition cursor-pointer"
              >
                {playbackSpeed}x
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bottom Controls Bar */}
      <div
        onClick={(e) => e.stopPropagation()}
        className={`absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/50 to-transparent px-2.5 sm:px-4 pb-1.5 sm:pb-3 pt-6 sm:pt-8 z-20 transition-opacity duration-200 ${
          controlsVisible ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        }`}
      >
        {/* Mobile (<640px) Single-Line Scrubber Row matching Screenshot 3 */}
        <div className="flex sm:hidden items-center gap-2 text-white">
          <span className="text-[11px] tabular-nums font-mono text-white/95 shrink-0">
            {formatTime(currentTime)}
          </span>
          {renderTimelineScrubber(true)}
          <span className="text-[11px] tabular-nums font-mono text-white/85 shrink-0">
            {formattedDuration}
          </span>
          <button
            type="button"
            onClick={toggleFullscreen}
            aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
            className="grid h-10 w-10 -mr-1.5 shrink-0 place-items-center rounded-full hover:bg-white/20 active:scale-90 transition cursor-pointer"
          >
            {isFullscreen ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}
          </button>
        </div>

        {/* Tablet & Desktop (>=640px) Stacked Scrubber + Full Controls Bar */}
        <div className="hidden sm:block">
          {renderTimelineScrubber(false)}

          <div className="mt-1.5 flex items-center justify-between gap-x-2 text-white">
            <div className="flex items-center gap-2 min-w-0">
              {/* Play/Pause toggle */}
              <button
                type="button"
                onClick={togglePlay}
                aria-label={isPlaying ? "Pause video" : "Play video"}
                className="grid h-9 w-9 place-items-center rounded-full hover:bg-white/20 transition cursor-pointer"
              >
                {isPlaying ? (
                  <Pause className="h-4 w-4 fill-current" />
                ) : (
                  <Play className="h-4 w-4 fill-current translate-x-[1px]" />
                )}
              </button>

              {/* Volume Control */}
              <div className="flex items-center gap-1.5 group/vol">
                <button
                  type="button"
                  onClick={toggleMute}
                  aria-label={isMuted ? "Unmute" : "Mute"}
                  className="grid h-9 w-9 place-items-center rounded-full hover:bg-white/20 transition cursor-pointer"
                >
                  {isMuted || volume === 0 ? (
                    <VolumeX className="h-4 w-4 text-red-400" />
                  ) : (
                    <Volume2 className="h-4 w-4" />
                  )}
                </button>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={isMuted ? 0 : volume}
                  onChange={handleVolumeChange}
                  aria-label="Volume slider"
                  className="w-16 md:w-20 h-1 accent-brand rounded-lg cursor-pointer transition-all"
                />
              </div>

              {/* Time Display */}
              <div className="text-xs tabular-nums text-zinc-200 font-mono shrink-0">
                <span>{formatTime(currentTime)}</span>
                <span className="mx-1 text-zinc-500">/</span>
                <span>{formattedDuration}</span>
              </div>
            </div>

            <div className="ml-auto flex items-center gap-1.5 shrink-0">
              {/* Zoom Controls */}
              <div
                className="flex items-center rounded-md bg-white/10 p-0.5"
                role="group"
                aria-label="Video zoom controls"
              >
                <button
                  type="button"
                  onClick={handleZoomOut}
                  disabled={zoom <= MIN_ZOOM}
                  title="Zoom out"
                  aria-label="Zoom out"
                  className="grid h-7 w-7 place-items-center rounded hover:bg-white/15 disabled:opacity-40 disabled:pointer-events-none transition cursor-pointer"
                >
                  <ZoomOut className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={handleResetZoom}
                  disabled={zoom <= MIN_ZOOM}
                  title={zoom > MIN_ZOOM ? "Reset zoom to 100%" : "Zoom: 100%"}
                  aria-label="Reset zoom"
                  className={`px-1.5 h-7 text-[11px] font-mono font-bold rounded transition ${
                    zoom > MIN_ZOOM
                      ? "text-white bg-brand/80 hover:bg-brand cursor-pointer"
                      : "text-zinc-300 disabled:opacity-75 cursor-default"
                  }`}
                >
                  {Math.round(zoom * 100)}%
                </button>
                <button
                  type="button"
                  onClick={handleZoomIn}
                  disabled={zoom >= MAX_ZOOM}
                  title="Zoom in"
                  aria-label="Zoom in"
                  className="grid h-7 w-7 place-items-center rounded hover:bg-white/15 disabled:opacity-40 disabled:pointer-events-none transition cursor-pointer"
                >
                  <ZoomIn className="h-3.5 w-3.5" />
                </button>
              </div>

              {/* Rotation Controls */}
              <div
                className="flex items-center rounded-md bg-white/10 p-0.5"
                role="group"
                aria-label="Video rotation controls"
              >
                <button
                  type="button"
                  onClick={handleRotateLeft}
                  title="Rotate left 90°"
                  aria-label="Rotate left 90 degrees"
                  className="grid h-7 w-7 place-items-center rounded hover:bg-white/15 transition cursor-pointer"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={handleResetRotation}
                  disabled={!isRotated}
                  title={isRotated ? "Reset rotation to 0°" : "Rotation: 0°"}
                  aria-label="Reset rotation"
                  className={`px-1.5 h-7 text-[11px] font-mono font-bold rounded transition ${
                    isRotated
                      ? "text-white bg-brand/80 hover:bg-brand cursor-pointer"
                      : "text-zinc-300 disabled:opacity-75 cursor-default"
                  }`}
                >
                  {normalizedRotation}°
                </button>
                <button
                  type="button"
                  onClick={handleRotateRight}
                  title="Rotate right 90°"
                  aria-label="Rotate right 90 degrees"
                  className="grid h-7 w-7 place-items-center rounded hover:bg-white/15 transition cursor-pointer"
                >
                  <RotateCw className="h-3.5 w-3.5" />
                </button>
              </div>

              {/* Playback Speed cycle */}
              <button
                type="button"
                onClick={cyclePlaybackSpeed}
                title="Playback speed"
                aria-label={`Playback speed: ${playbackSpeed}x`}
                className="rounded-md bg-white/10 px-2 h-8 text-xs font-mono font-bold hover:bg-white/20 transition cursor-pointer"
              >
                {playbackSpeed}x
              </button>

              {/* Fullscreen toggle */}
              <button
                type="button"
                onClick={toggleFullscreen}
                aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
                className="grid h-9 w-9 place-items-center rounded-full hover:bg-white/20 transition cursor-pointer"
              >
                {isFullscreen ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
