import type { Video } from "@/data/videos";
import { api } from "./api";
import { resolveMediaUrl } from "./media-url";
import { resolveVideoThumbnail } from "./thumbnail-service";
import { isPubliclyCacheableVideo, normalizeVideoVisibility } from "./video-service";

function checkAdPromotionActive(item: {
  isPromoted?: boolean | number | null | undefined;
  is_promoted?: boolean | number | null | undefined;
  promotionExpiresAt?: string | null | undefined;
  promotion_expires_at?: string | null | undefined;
}): boolean {
  const isMarked = Boolean(item.isPromoted ?? item.is_promoted);
  if (!isMarked) return false;
  const expiry = item.promotionExpiresAt || item.promotion_expires_at;
  if (!expiry) return false;
  const t = new Date(expiry).getTime();
  return !Number.isNaN(t) && t > Date.now();
}

export function mapApiVideoToCatalogVideo(v: Record<string, any>): Video {
  const thumbUrl = resolveVideoThumbnail({
    thumbnailUrl: v["thumbnail_url"] || v["thumbnailUrl"],
    category: v["category"],
  });
  const created = v["created_at"] || v["createdAt"];
  const parsedAge = created
    ? new Date(
        created.includes("T") ? created : created.replace(" ", "T") + "Z",
      ).toLocaleDateString()
    : "Recently uploaded";

  const channelName =
    v["channel_name"] ||
    v["channelName"] ||
    v["creator_name"] ||
    v["creatorName"] ||
    "FaceTube Creator";
  const rawChannelLogo = v["channel_logo_url"] || v["channelLogoUrl"] || "";
  const channelLogoUrl = rawChannelLogo ? resolveMediaUrl(rawChannelLogo) || undefined : undefined;

  return {
    id: String(v["id"]),
    title: v["title"] || "Untitled Video",
    channel: channelName,
    channelName,
    channelLogoUrl,
    channel_logo_url: channelLogoUrl,
    initials: channelName.slice(0, 2).toUpperCase(),
    views: `${(Number(v["views"]) || 0).toLocaleString()} views`,
    age: parsedAge,
    duration: v["duration"] || "0:00",
    thumb: thumbUrl,
    thumbnail: thumbUrl,
    thumbnailUrl: thumbUrl,
    tint: v["video_type"] === "premium" ? "oklch(0.6 0.22 45)" : "oklch(0.5 0.18 20)",
    category: v["category"] || "General",
    description: v["description"] || "",
    videoUrl: resolveMediaUrl(v["video_url"] || v["videoUrl"]),
    videoType: v["video_type"] || v["videoType"] || "free",
    contentType: v["content_type"] || v["contentType"] || "long",
    isPromoted: checkAdPromotionActive(v),
    visibility: normalizeVideoVisibility(v["visibility"], "public"),
    userId: v["user_id"] || v["userId"] || "FT483921",
  };
}

/**
 * Safely inspects the shared public localStorage cache for a given video ID,
 * rejecting any private, unlisted, blocked, or unpaid Sponsor records.
 * Used only for synchronous catalog helpers — NEVER for watch-page authorization.
 */
export function findPublicCachedVideo(id: string): Video | undefined {
  if (typeof window === "undefined" || typeof localStorage === "undefined") {
    return undefined;
  }
  try {
    const stored = localStorage.getItem("facetube_uploaded_videos_v3");
    if (!stored) return undefined;
    const list = JSON.parse(stored);
    if (!Array.isArray(list)) return undefined;
    const match = list.find((v: any) => v && v.id === id);
    if (!match || !isPubliclyCacheableVideo(match)) {
      return undefined;
    }
    const thumbUrl = resolveVideoThumbnail({
      thumbnailUrl: match.thumbnailUrl || match.thumbnail_url,
      category: match.category,
    });
    const created = match.createdAt || match.created_at;
    const parsedAge = created
      ? new Date(
          created.includes("T") ? created : created.replace(" ", "T") + "Z",
        ).toLocaleDateString()
      : "Recently uploaded";

    return {
      id: match.id,
      title: match.title,
      channel: match.creatorName || match.creator_name || "FaceTube Creator",
      initials: (match.creatorName || match.creator_name || "FC").slice(0, 2).toUpperCase(),
      views: `${(Number(match.views) || 0).toLocaleString()} views`,
      age: parsedAge,
      duration: match.duration || "0:00",
      thumb: thumbUrl,
      thumbnail: thumbUrl,
      thumbnailUrl: thumbUrl,
      tint: match.videoType === "premium" ? "oklch(0.6 0.22 45)" : "oklch(0.5 0.18 20)",
      category: match.category || "General",
      description: match.description || "",
      videoUrl: resolveMediaUrl(match.videoUrl || match.video_url),
      videoType: match.videoType || match.video_type || "free",
      contentType: match.contentType || match.content_type || "long",
      isPromoted: checkAdPromotionActive(match),
      visibility: normalizeVideoVisibility(match.visibility, "public"),
    };
  } catch {
    return undefined;
  }
}

export type WatchVideoResolution =
  | { status: "ok"; video: Video }
  | { status: "needs_client_auth"; httpStatus: number }
  | { status: "denied"; httpStatus: number }
  | { status: "not_found" }
  | { status: "error"; httpStatus?: number };

/**
 * Authoritatively resolves a video for playback via the backend `videos/get` endpoint.
 * - Never trusts or falls back to localStorage cached video records.
 * - Fails closed on 401/403/404/5xx/network failures in the browser.
 * - During SSR (where localStorage Bearer tokens are unavailable), surfaces
 *   `needs_client_auth` on 401/403 so the client can verify authorization once.
 * - Only falls back to staticShowcaseVideos (never seedVideos) when the server
 *   explicitly returns 404.
 */
export async function resolveWatchVideo(
  id: string,
  options?: { showcaseVideos?: Video[] },
): Promise<WatchVideoResolution> {
  try {
    const res = await api.videos.get(id);
    if (res && res.success && res.video) {
      return {
        status: "ok",
        video: mapApiVideoToCatalogVideo(res.video as Record<string, any>),
      };
    }
    return { status: "not_found" };
  } catch (err) {
    const httpStatus = (err as { status?: number })?.status;

    if (httpStatus === 401 || httpStatus === 403) {
      if (typeof window === "undefined") {
        return { status: "needs_client_auth", httpStatus };
      }
      return { status: "denied", httpStatus };
    }

    if (httpStatus === 404) {
      let showcaseList: Video[] | undefined = options?.showcaseVideos;
      if (!showcaseList) {
        try {
          const videosMod = await import("@/data/videos");
          showcaseList = videosMod.staticShowcaseVideos;
        } catch {
          showcaseList = undefined;
        }
      }
      const showcaseMatch = showcaseList?.find((v) => v.id === id);
      if (showcaseMatch) {
        const thumbUrl = showcaseMatch.thumb || showcaseMatch.thumbnail || "";
        return {
          status: "ok",
          video: {
            ...showcaseMatch,
            thumbnail: thumbUrl,
            thumbnailUrl: showcaseMatch.thumbnailUrl || thumbUrl,
          },
        };
      }
      return { status: "not_found" };
    }

    console.warn("resolveWatchVideo database lookup failed (failing closed):", err);
    return httpStatus !== undefined ? { status: "error", httpStatus } : { status: "error" };
  }
}

/**
 * Server-authoritative asynchronous video lookup.
 * Always checks the live backend API first and never allows localStorage cache
 * to override server 401/403/404/5xx responses.
 */
export async function findVideoAsync(id: string): Promise<Video | undefined> {
  const resolution = await resolveWatchVideo(id);
  return resolution.status === "ok" ? resolution.video : undefined;
}
