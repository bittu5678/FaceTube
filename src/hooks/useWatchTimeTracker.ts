import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import { api, getStoredAuthToken } from "@/lib/api";
import { createWatchTimeTracker } from "@/lib/watch-time-tracker";

export interface UseWatchTimeTrackerOptions {
  videoRef: RefObject<HTMLVideoElement | null>;
  videoId?: string | undefined;
  isAuthenticated: boolean;
  isReady?: boolean | undefined;
}

export function useWatchTimeTracker({
  videoRef,
  videoId,
  isAuthenticated,
  isReady = true,
}: UseWatchTimeTrackerOptions): void {
  const trackerRef = useRef<ReturnType<typeof createWatchTimeTracker> | null>(null);

  useEffect(() => {
    const videoEl = videoRef.current;
    const cleanVideoId = String(videoId || "").trim();
    const hasAuth = Boolean(isAuthenticated && getStoredAuthToken());

    if (!videoEl || !cleanVideoId || !hasAuth || !isReady) {
      return;
    }

    const tracker = createWatchTimeTracker({
      videoId: cleanVideoId,
      isAuthenticated: true,
      startSession: (id) => api.watchTime.startSession(id),
      sendHeartbeat: (payload, options) => api.watchTime.sendHeartbeat(payload, options),
    });
    trackerRef.current = tracker;

    const getPos = () => videoEl.currentTime || 0;

    const handlePlaying = () => {
      void tracker.setPlaying(true, getPos());
    };
    const handlePause = () => {
      void tracker.setPlaying(false, getPos());
    };
    const handleWaiting = () => {
      tracker.setBuffering(true, getPos());
    };
    const handleStalled = () => {
      tracker.setBuffering(true, getPos());
    };
    const handleCanPlay = () => {
      tracker.setBuffering(false, getPos());
    };
    const handleTimeUpdate = () => {
      tracker.updatePosition(getPos());
    };
    const handleEnded = () => {
      void tracker.handleEnded(getPos());
    };
    const handleError = () => {
      void tracker.setPlaying(false, getPos());
    };
    const handleVisibilityChange = () => {
      void tracker.setVisible(document.visibilityState !== "hidden", getPos());
    };
    const handlePageHide = () => {
      void tracker.flushOnUnload(getPos());
    };

    videoEl.addEventListener("playing", handlePlaying);
    videoEl.addEventListener("pause", handlePause);
    videoEl.addEventListener("waiting", handleWaiting);
    videoEl.addEventListener("stalled", handleStalled);
    videoEl.addEventListener("canplay", handleCanPlay);
    videoEl.addEventListener("timeupdate", handleTimeUpdate);
    videoEl.addEventListener("ended", handleEnded);
    videoEl.addEventListener("error", handleError);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pagehide", handlePageHide);
    window.addEventListener("beforeunload", handlePageHide);

    // If video was already playing before listener registration
    if (!videoEl.paused && !videoEl.ended && videoEl.readyState >= 3) {
      void tracker.setPlaying(true, getPos());
    }

    return () => {
      videoEl.removeEventListener("playing", handlePlaying);
      videoEl.removeEventListener("pause", handlePause);
      videoEl.removeEventListener("waiting", handleWaiting);
      videoEl.removeEventListener("stalled", handleStalled);
      videoEl.removeEventListener("canplay", handleCanPlay);
      videoEl.removeEventListener("timeupdate", handleTimeUpdate);
      videoEl.removeEventListener("ended", handleEnded);
      videoEl.removeEventListener("error", handleError);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pagehide", handlePageHide);
      window.removeEventListener("beforeunload", handlePageHide);
      void tracker.destroy();
      if (trackerRef.current === tracker) {
        trackerRef.current = null;
      }
    };
  }, [videoRef, videoId, isAuthenticated, isReady]);
}
