const RECENT_WATCHED_IDS_KEY = "facetube_recent_watched_ids_v1";
const WATCH_HISTORY_PAUSED_KEY = "facetube_watch_history_paused_v1";
const MAX_RECENT_WATCHED = 20;

export function isWatchHistoryPaused(): boolean {
  if (typeof window === "undefined" || typeof localStorage === "undefined") return false;
  try {
    return localStorage.getItem(WATCH_HISTORY_PAUSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function setWatchHistoryPaused(paused: boolean): void {
  if (typeof window === "undefined" || typeof localStorage === "undefined") return;
  try {
    if (paused) {
      localStorage.setItem(WATCH_HISTORY_PAUSED_KEY, "1");
    } else {
      localStorage.removeItem(WATCH_HISTORY_PAUSED_KEY);
    }
  } catch {
    // Ignore storage errors
  }
}

export function getRecentWatchedVideoIds(): string[] {
  if (typeof window === "undefined" || typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(RECENT_WATCHED_IDS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((id) => (typeof id === "string" ? id.trim() : ""))
      .filter(Boolean)
      .slice(0, MAX_RECENT_WATCHED);
  } catch {
    return [];
  }
}

export function recordWatchedVideoId(videoId: string): void {
  if (typeof window === "undefined" || typeof localStorage === "undefined") return;
  const cleanId = String(videoId || "").trim();
  if (!cleanId || isWatchHistoryPaused()) return;
  try {
    const existing = getRecentWatchedVideoIds().filter((id) => id !== cleanId);
    const updated = [cleanId, ...existing].slice(0, MAX_RECENT_WATCHED);
    localStorage.setItem(RECENT_WATCHED_IDS_KEY, JSON.stringify(updated));
  } catch {
    // Ignore storage errors
  }
}

export function clearRecentWatchedVideoIds(): void {
  if (typeof window === "undefined" || typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(RECENT_WATCHED_IDS_KEY);
  } catch {
    // Ignore storage errors
  }
}
