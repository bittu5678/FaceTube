import type { Video } from "@/data/videos";
import { api } from "./api";
import { resolveMediaUrl } from "./media-url";
import { resolveVideoThumbnail } from "./thumbnail-service";
import { isPubliclyCacheableVideo, resolveStoredVideoVisibility } from "./video-service";
import { computeChannelInitials } from "./channel-branding";

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

function resolveViewerLikedFlag(raw: Record<string, unknown>): boolean {
  const explicit =
    raw["viewerLiked"] ??
    raw["viewer_liked"] ??
    (typeof raw["liked"] === "boolean" ? raw["liked"] : undefined);
  if (typeof explicit === "boolean") return explicit;
  if (typeof explicit === "number") return explicit === 1;
  if (typeof explicit === "string") {
    const clean = explicit.trim().toLowerCase();
    return clean === "true" || clean === "1";
  }
  return false;
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
  const viewerLiked = resolveViewerLikedFlag(v);

  return {
    id: String(v["id"]),
    title: v["title"] || "Untitled Video",
    channel: channelName,
    channelName,
    channelLogoUrl,
    channel_logo_url: channelLogoUrl,
    initials: computeChannelInitials(channelName, "FT"),
    views: `${(Number(v["views"]) || 0).toLocaleString()} views`,
    viewsCount: Number(v["views"]) || 0,
    likes: Number(v["likes"]) || 0,
    liked: viewerLiked,
    viewerLiked,
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
    visibility: resolveStoredVideoVisibility(v["visibility"]),
    userId: String(v["user_id"] || v["userId"] || ""),
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

    const channelName =
      match.channelName ||
      match.channel_name ||
      match.creatorName ||
      match.creator_name ||
      "FaceTube Creator";
    const rawChannelLogo = match.channelLogoUrl || match.channel_logo_url || "";
    const channelLogoUrl = rawChannelLogo
      ? resolveMediaUrl(rawChannelLogo) || undefined
      : undefined;

    return {
      id: match.id,
      title: match.title,
      channel: channelName,
      channelName,
      channelLogoUrl,
      channel_logo_url: channelLogoUrl,
      initials: computeChannelInitials(channelName, "FC"),
      views: `${(Number(match.views) || 0).toLocaleString()} views`,
      viewsCount: Number(match.views) || 0,
      likes: Number(match.likes) || 0,
      liked: false,
      viewerLiked: false,
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
      visibility: resolveStoredVideoVisibility(match.visibility),
      userId: String(match.userId || match.user_id || ""),
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
 * - Returns `not_found` when the server returns 404 (never falls back to static demo videos).
 */
export async function resolveWatchVideo(id: string): Promise<WatchVideoResolution> {
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
