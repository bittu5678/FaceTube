import { api } from "./api";
import {
  resolveVideoThumbnail,
  getCategoryFallbackThumbnail,
  captureAndUploadThumbnail,
} from "./thumbnail-service";
import { resolveMediaUrl } from "./media-url";
import { computeChannelInitials } from "./channel-branding";
import type { Video } from "@/data/videos";
import type { ShortItem } from "@/data/shorts";

export type VideoType = "free" | "premium";
export type ContentType = "short" | "long";
export type VideoPaymentStatus = "not_required" | "pending" | "paid" | "failed";
export type VideoPromotionStatus = "none" | "active" | "expired";
export type VideoVisibility = "public" | "unlisted" | "private";

export const VIDEO_CATEGORIES = [
  "Cartoon",
  "Agriculture",
  "Motivational",
  "Comedy",
  "Blog",
  "Movie",
  "Entertainment",
  "Cooking",
  "Finance",
  "Share Market",
  "Business",
  "Crypto",
  "Coding",
  "Music",
  "Gaming",
  "Travel",
  "AI",
  "Education",
  "Health",
  "Sports",
  "Drama",
] as const;

export type VideoCategory = (typeof VIDEO_CATEGORIES)[number];

export interface CategoryRecord {
  id: string | number;
  name: string;
  slug: string;
  created_by?: string;
  created_at?: string;
}

/**
 * Loads managed categories from the API with graceful fallback to static VIDEO_CATEGORIES.
 * Preserves API/admin-created categories while guaranteeing all baseline categories are present without duplicates.
 */
export async function getAvailableCategories(): Promise<string[]> {
  try {
    const res = await api.categories.list();
    if (res?.categories && res.categories.length > 0) {
      const seen = new Set<string>();
      const merged: string[] = [];
      for (const name of [...res.categories.map((c) => c.name), ...VIDEO_CATEGORIES]) {
        const trimmed = String(name || "").trim();
        if (!trimmed) continue;
        const norm = trimmed.toLowerCase();
        if (!seen.has(norm)) {
          seen.add(norm);
          merged.push(trimmed);
        }
      }
      if (merged.length > 0) {
        return merged;
      }
    }
  } catch (_err) {
    // Fallback to static baseline while migration is pending
  }
  return [...VIDEO_CATEGORIES];
}

export interface UploadedVideo {
  id: string;
  userId: string; // e.g. "FT102857" or UUID
  creatorName: string;
  channelName?: string | undefined;
  channelLogoUrl?: string | undefined;
  title: string;
  description: string;
  videoUrl: string;
  thumbnailUrl: string;
  videoType: VideoType; // "free" | "premium"
  contentType: ContentType; // "short" | "long"
  category: string;
  duration: string;
  views: number;
  likes: number;
  paymentStatus: VideoPaymentStatus;
  paymentId?: string | undefined;
  paymentAmount: number; // e.g. 0 for free, 6 for premium
  isPromoted: boolean;
  isBlocked?: boolean | undefined;
  promotionPlan?: string | undefined;
  promotionExpiresAt?: string | undefined;
  visibility?: VideoVisibility | undefined;
  countryCode?: string | undefined;
  createdAt: string;
  updatedAt: string;
  isStale?: boolean | undefined;
}

export interface VideoCategoryCounts {
  freeShort: number;
  freeLong: number;
  premiumShort: number;
  premiumLong: number;
  totalFree: number;
  totalPremium: number;
  totalUploaded: number;
}

const LOCAL_STORAGE_VIDEOS_KEY = "facetube_uploaded_videos_v3";
const OWNER_VIDEO_CACHE_PREFIX = "facetube_owner_videos_v1:";
const OWNER_VIDEO_CACHE_INDEX_KEY = "facetube_owner_cache_users_v1";
const SESSION_STORAGE_KEY = "facetube_session_v2";
const AUTH_TOKEN_STORAGE_KEY = "facetube_auth_token";

export function normalizeVideoVisibility(
  value: unknown,
  fallback: VideoVisibility = "public",
): VideoVisibility {
  if (typeof value === "string") {
    const clean = value.trim().toLowerCase();
    if (clean === "public" || clean === "unlisted" || clean === "private") {
      return clean;
    }
  }
  return fallback;
}

export function resolveStoredVideoVisibility(value: unknown): VideoVisibility {
  if (value === null || value === undefined) return "public";
  const clean = String(value).trim().toLowerCase();
  if (clean === "") return "public";
  if (clean === "public" || clean === "unlisted" || clean === "private") {
    return clean;
  }
  return "private";
}

export function resolveInitialVideoVisibility(
  existing?: { visibility?: unknown } | null,
): VideoVisibility {
  return resolveStoredVideoVisibility(existing?.visibility);
}

/**
 * Resolves the canonical authenticated user ID from active session objects only.
 * Never falls back to hardcoded demo IDs or unverified email prefixes.
 */
export function resolveAuthenticatedUserId(session: {
  user?: { user_id?: string | null; user_metadata?: Record<string, unknown> | null } | null;
  profile?: { user_id?: string | null } | null;
  dbUser?: { user_id?: string | null } | null;
}): string {
  const candidates = [
    session.profile?.user_id,
    session.dbUser?.user_id,
    session.user?.user_id,
    typeof session.user?.user_metadata?.["user_id"] === "string"
      ? session.user.user_metadata["user_id"]
      : undefined,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      const trimmed = candidate.trim();
      if (trimmed) return trimmed;
    }
  }
  return "";
}

export function isPubliclyCacheableVideo(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  const rec = v as Record<string, unknown>;
  const visVal = rec["visibility"];
  const rawVis = visVal === undefined || visVal === null ? "" : String(visVal).trim().toLowerCase();
  if (rawVis !== "" && rawVis !== "public") {
    return false;
  }

  const rawBlocked = rec["isBlocked"] ?? rec["is_blocked"];
  if (
    rawBlocked !== undefined &&
    rawBlocked !== null &&
    rawBlocked !== false &&
    rawBlocked !== 0 &&
    String(rawBlocked).trim() !== "0" &&
    String(rawBlocked).trim().toLowerCase() !== "false" &&
    String(rawBlocked).trim() !== ""
  ) {
    return false;
  }

  const vType = String(rec["videoType"] ?? rec["video_type"] ?? "free")
    .trim()
    .toLowerCase();
  const rawPaymentStatus = rec["paymentStatus"] ?? rec["payment_status"];
  const pStatus =
    rawPaymentStatus === undefined || rawPaymentStatus === null
      ? ""
      : String(rawPaymentStatus).trim().toLowerCase();

  if (vType === "premium") {
    return pStatus === "paid";
  }
  if (vType === "" || vType === "free") {
    return pStatus === "" || pStatus === "not_required" || pStatus === "paid";
  }
  return false;
}

function sanitizeCachedVideo(v: UploadedVideo): UploadedVideo {
  const rec = v as unknown as Record<string, unknown>;
  const resolvedType = (
    String(v.videoType || rec["video_type"] || "free")
      .trim()
      .toLowerCase() === "premium"
      ? "premium"
      : "free"
  ) as VideoType;
  const defaultPaymentStatus: VideoPaymentStatus =
    resolvedType === "premium" ? "pending" : "not_required";
  const clean: UploadedVideo = {
    id: String(v.id),
    userId: String(v.userId || rec["user_id"] || ""),
    creatorName: String(v.creatorName || rec["creator_name"] || "FaceTube Creator"),
    ...(v.channelName ? { channelName: String(v.channelName) } : {}),
    ...(v.channelLogoUrl ? { channelLogoUrl: String(v.channelLogoUrl) } : {}),
    title: String(v.title || "Untitled Video"),
    description: String(v.description || ""),
    videoUrl: String(v.videoUrl || rec["video_url"] || ""),
    thumbnailUrl: String(v.thumbnailUrl || rec["thumbnail_url"] || ""),
    videoType: resolvedType,
    contentType: (v.contentType || rec["content_type"] || "long") as ContentType,
    category: String(v.category || "General"),
    duration: String(v.duration || "0:00"),
    views: Number(v.views) || 0,
    likes: Number(v.likes) || 0,
    paymentStatus: (v.paymentStatus ||
      rec["payment_status"] ||
      defaultPaymentStatus) as VideoPaymentStatus,
    ...(v.paymentId ? { paymentId: String(v.paymentId) } : {}),
    paymentAmount: Number(v.paymentAmount ?? rec["payment_amount"]) || 0,
    isPromoted: Boolean(v.isPromoted ?? rec["is_promoted"]),
    ...((v.isBlocked ?? rec["is_blocked"]) ? { isBlocked: true } : {}),
    ...(v.promotionPlan ? { promotionPlan: String(v.promotionPlan) } : {}),
    ...(v.promotionExpiresAt ? { promotionExpiresAt: String(v.promotionExpiresAt) } : {}),
    visibility: resolveStoredVideoVisibility(v.visibility ?? rec["visibility"]),
    createdAt: String(v.createdAt || new Date().toISOString()),
    updatedAt: String(v.updatedAt || v.createdAt || new Date().toISOString()),
  };
  return clean;
}

function getCurrentAuthenticatedCacheIdentity(): { userId: string; isAdmin: boolean } | null {
  if (typeof window === "undefined" || typeof localStorage === "undefined") {
    return null;
  }
  try {
    const rawSession = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!rawSession) return null;
    const parsed = JSON.parse(rawSession) as {
      user?: { user_id?: string; user_metadata?: { user_id?: string } };
      profile?: { user_id?: string };
      dbUser?: { user_id?: string; role?: string };
      role?: string;
      token?: string;
    } | null;
    if (!parsed) return null;
    const tokenRaw =
      localStorage.getItem(AUTH_TOKEN_STORAGE_KEY) ||
      (typeof parsed.token === "string" ? parsed.token : "");
    const token = tokenRaw ? tokenRaw.trim() : "";
    if (!token || token === "null" || token === "undefined") {
      return null;
    }
    const uid =
      parsed.profile?.user_id ||
      parsed.dbUser?.user_id ||
      parsed.user?.user_id ||
      parsed.user?.user_metadata?.user_id ||
      "";
    const normUid = typeof uid === "string" ? uid.trim().toUpperCase() : "";
    if (!normUid) return null;
    const isAdmin =
      String(parsed.role || parsed.dbUser?.role || "")
        .trim()
        .toLowerCase() === "admin";
    return { userId: normUid, isAdmin };
  } catch {
    return null;
  }
}

export function getOwnerVideoCacheKey(userId: string): string {
  return `${OWNER_VIDEO_CACHE_PREFIX}${userId.trim().toUpperCase()}`;
}

function getTrackedOwnerCacheUserIds(): string[] {
  if (typeof window === "undefined" || typeof localStorage === "undefined") return [];
  const tracked = new Set<string>();
  try {
    const indexRaw = localStorage.getItem(OWNER_VIDEO_CACHE_INDEX_KEY);
    if (indexRaw) {
      const arr = JSON.parse(indexRaw);
      if (Array.isArray(arr)) {
        for (const uid of arr) {
          if (typeof uid === "string" && uid.trim()) {
            tracked.add(uid.trim().toUpperCase());
          }
        }
      }
    }
    if (typeof localStorage.length === "number" && typeof localStorage.key === "function") {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(OWNER_VIDEO_CACHE_PREFIX)) {
          const uid = k.slice(OWNER_VIDEO_CACHE_PREFIX.length).trim().toUpperCase();
          if (uid) tracked.add(uid);
        }
      }
    }
  } catch {
    // ignore storage errors
  }
  return Array.from(tracked);
}

function trackOwnerCacheUserId(userId: string): void {
  if (typeof window === "undefined" || typeof localStorage === "undefined") return;
  const norm = userId.trim().toUpperCase();
  if (!norm) return;
  try {
    const existing = new Set(getTrackedOwnerCacheUserIds());
    existing.add(norm);
    localStorage.setItem(OWNER_VIDEO_CACHE_INDEX_KEY, JSON.stringify(Array.from(existing)));
  } catch {
    // ignore
  }
}

export function getOwnerStoredVideos(userId: string): UploadedVideo[] | null {
  if (typeof window === "undefined" || typeof localStorage === "undefined") return null;
  const norm = userId.trim().toUpperCase();
  if (!norm) return null;
  const session = getCurrentAuthenticatedCacheIdentity();
  if (!session || (session.userId !== norm && !session.isAdmin)) {
    return null;
  }
  try {
    const raw = localStorage.getItem(getOwnerVideoCacheKey(norm));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.map((v) => sanitizeCachedVideo(v as UploadedVideo));
  } catch {
    return null;
  }
}

export function saveOwnerStoredVideos(userId: string, videos: UploadedVideo[]): void {
  if (typeof window === "undefined" || typeof localStorage === "undefined") return;
  const norm = userId.trim().toUpperCase();
  if (!norm) return;
  const session = getCurrentAuthenticatedCacheIdentity();
  if (!session || (session.userId !== norm && !session.isAdmin)) {
    return;
  }
  try {
    const sanitized = videos.map((v) => sanitizeCachedVideo(v));
    localStorage.setItem(getOwnerVideoCacheKey(norm), JSON.stringify(sanitized));
    trackOwnerCacheUserId(norm);
  } catch {
    // quota error
  }
}

/**
 * Removes protected owner-scoped video caches on logout or user switch,
 * and sanitizes the public cache so only harmless public eligible videos remain.
 */
export function clearProtectedVideoCaches(options?: { keepUserId?: string | null }): void {
  if (typeof window === "undefined" || typeof localStorage === "undefined") return;
  const keepNorm = options?.keepUserId ? options.keepUserId.trim().toUpperCase() : "";
  try {
    const trackedUsers = getTrackedOwnerCacheUserIds();
    const remainingTracked: string[] = [];
    for (const uid of trackedUsers) {
      if (keepNorm && uid === keepNorm) {
        remainingTracked.push(uid);
      } else {
        localStorage.removeItem(getOwnerVideoCacheKey(uid));
      }
    }
    if (remainingTracked.length > 0) {
      localStorage.setItem(OWNER_VIDEO_CACHE_INDEX_KEY, JSON.stringify(remainingTracked));
    } else {
      localStorage.removeItem(OWNER_VIDEO_CACHE_INDEX_KEY);
    }

    // Sanitize shared public cache without discarding harmless public videos
    const publicRaw = localStorage.getItem(LOCAL_STORAGE_VIDEOS_KEY);
    if (publicRaw) {
      const parsed = JSON.parse(publicRaw);
      if (Array.isArray(parsed)) {
        const sanitizedPublic = parsed
          .filter(isPubliclyCacheableVideo)
          .map((v) => sanitizeCachedVideo(v as UploadedVideo));
        localStorage.setItem(LOCAL_STORAGE_VIDEOS_KEY, JSON.stringify(sanitizedPublic));
      }
    }
  } catch {
    // ignore storage errors
  }
}

// Initial seed videos reflecting real user accounts and the four required video classifications
export const INITIAL_SEED_VIDEOS: UploadedVideo[] = [
  // 1. Free Short Video (FT483921 - Alex Rivera)
  {
    id: "vid-seed-001",
    userId: "FT483921",
    creatorName: "Alex Rivera",
    title: "10 Coding Shortcuts Every React Dev Must Know #Shorts",
    description: "Lightning-fast developer workflow hacks in under 45 seconds.",
    videoUrl: "https://vjs.zencdn.net/v/oceans.mp4",
    thumbnailUrl:
      "https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=800&auto=format&fit=crop&q=60",
    videoType: "free",
    contentType: "short",
    category: "Technology",
    duration: "0:42",
    views: 45200,
    likes: 3120,
    paymentStatus: "not_required",
    paymentAmount: 0,
    isPromoted: false,
    createdAt: new Date(Date.now() - 12 * 24 * 60 * 60 * 1000).toISOString(),
    updatedAt: new Date(Date.now() - 12 * 24 * 60 * 60 * 1000).toISOString(),
  },
  // 2. Free Long Video (FT483921 - Alex Rivera)
  {
    id: "vid-seed-002",
    userId: "FT483921",
    creatorName: "Alex Rivera",
    title: "Full Stack App Architecture from Scratch: Zero to Production",
    description:
      "Deep-dive 45-minute comprehensive architectural masterclass covering scalable backend and modern UI.",
    videoUrl: "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4",
    thumbnailUrl:
      "https://images.unsplash.com/photo-1555066931-4365d14bab8c?w=800&auto=format&fit=crop&q=60",
    videoType: "free",
    contentType: "long",
    category: "Education",
    duration: "42:15",
    views: 98400,
    likes: 8400,
    paymentStatus: "not_required",
    paymentAmount: 0,
    isPromoted: false,
    createdAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
    updatedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
  },
  // 3. Premium Short Video (FT483921 - Alex Rivera)
  {
    id: "vid-seed-003",
    userId: "FT483921",
    creatorName: "Alex Rivera",
    title: "Pro Monetization Hack: Unlocking High-CPM Niches #Shorts",
    description:
      "Exclusive creator strategy breakdown for maximum algorithmic engagement and monetization yield.",
    videoUrl: "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/friday.mp4",
    thumbnailUrl:
      "https://images.unsplash.com/photo-1526304640581-d334cdbbf45e?w=800&auto=format&fit=crop&q=60",
    videoType: "premium",
    contentType: "short",
    category: "Business",
    duration: "0:58",
    views: 62100,
    likes: 5490,
    paymentStatus: "paid",
    paymentId: "pay_rzp_seed_001",
    paymentAmount: 6,
    isPromoted: true,
    promotionPlan: "plan-15-days",
    promotionExpiresAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString(),
    createdAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
    updatedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
  },
  // 4. Premium Long Video (FT483921 - Alex Rivera)
  {
    id: "vid-seed-004",
    userId: "FT483921",
    creatorName: "Alex Rivera",
    title: "Executive Masterclass: Building ₹10L/Month Video Funnels",
    description:
      "Full 1-hour verified premium course with step-by-step case studies and downloadable resources.",
    videoUrl: "https://vjs.zencdn.net/v/oceans.mp4",
    thumbnailUrl:
      "https://images.unsplash.com/photo-1551836022-d5d88e9218df?w=800&auto=format&fit=crop&q=60",
    videoType: "premium",
    contentType: "long",
    category: "Masterclass",
    duration: "58:30",
    views: 31400,
    likes: 2980,
    paymentStatus: "paid",
    paymentId: "pay_rzp_seed_002",
    paymentAmount: 6,
    isPromoted: false,
    createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    updatedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
  },
  // 5. Free Short Video (FT900431 - Maya Lin)
  {
    id: "vid-seed-005",
    userId: "FT900431",
    creatorName: "Maya Lin",
    title: "Cinematic Color Grading in 30 Seconds #Shorts",
    description: "LUT color correction tricks for mobile videographers.",
    videoUrl: "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4",
    thumbnailUrl:
      "https://images.unsplash.com/photo-1574717024653-61fd2cf4d44d?w=800&auto=format&fit=crop&q=60",
    videoType: "free",
    contentType: "short",
    category: "Film",
    duration: "0:30",
    views: 18200,
    likes: 1200,
    paymentStatus: "not_required",
    paymentAmount: 0,
    isPromoted: false,
    createdAt: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString(),
    updatedAt: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString(),
  },
  // 6. Premium Short Video (FT900431 - Maya Lin)
  {
    id: "vid-seed-006",
    userId: "FT900431",
    creatorName: "Maya Lin",
    title: "Secret Lighting Setup for 4K Vertical Video #Shorts",
    description: "Lighting angles and diffusers used by professional film studios.",
    videoUrl: "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/friday.mp4",
    thumbnailUrl:
      "https://images.unsplash.com/photo-1492691527719-9d1e07e534b4?w=800&auto=format&fit=crop&q=60",
    videoType: "premium",
    contentType: "short",
    category: "Film",
    duration: "0:45",
    views: 29500,
    likes: 2100,
    paymentStatus: "paid",
    paymentId: "pay_rzp_seed_003",
    paymentAmount: 6,
    isPromoted: false,
    createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
    updatedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
  },
  // 7. Free Long Video - Cartoon Category
  {
    id: "vid-seed-007",
    userId: "FT483921",
    creatorName: "Animation Studio X",
    title: "The Great Forest Mystery — Animated Cartoon Adventure",
    description:
      "Classic animated adventure featuring funny cartoon characters, slapstick comedy, and heartwarming moments for all ages.",
    videoUrl: "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/friday.mp4",
    thumbnailUrl:
      "https://images.unsplash.com/photo-1534447677768-be436bb09401?w=800&auto=format&fit=crop&q=60",
    videoType: "free",
    contentType: "long",
    category: "Cartoon",
    duration: "14:20",
    views: 89000,
    likes: 6700,
    paymentStatus: "not_required",
    paymentAmount: 0,
    isPromoted: false,
    createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    updatedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
  },
  // 8. Free Long Video - Agriculture Category
  {
    id: "vid-seed-008",
    userId: "FT483921",
    creatorName: "Green Earth Agri",
    title: "Smart Organic Farming & High-Yield Agriculture Techniques",
    description:
      "Modern agricultural technologies, organic drip irrigation, soil health management, and sustainable crop cultivation techniques.",
    videoUrl: "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4",
    thumbnailUrl:
      "https://images.unsplash.com/photo-1500937386664-56d1dfef3854?w=800&auto=format&fit=crop&q=60",
    videoType: "free",
    contentType: "long",
    category: "Agriculture",
    duration: "21:45",
    views: 54000,
    likes: 4300,
    paymentStatus: "not_required",
    paymentAmount: 0,
    isPromoted: false,
    createdAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
    updatedAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
  },
];

/**
 * Loads public uploaded videos from local cache (strictly excluding private, unlisted,
 * blocked, and unpaid Sponsor videos).
 */
export function getStoredVideos(): UploadedVideo[] {
  if (typeof window === "undefined" || typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_VIDEOS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isPubliclyCacheableVideo)
      .map((v) => sanitizeCachedVideo(v as UploadedVideo));
  } catch (_e) {
    return [];
  }
}

export function saveStoredVideos(videos: UploadedVideo[]): void {
  if (typeof window === "undefined" || typeof localStorage === "undefined") return;
  try {
    const publicOnly = videos.filter(isPubliclyCacheableVideo).map((v) => sanitizeCachedVideo(v));
    localStorage.setItem(LOCAL_STORAGE_VIDEOS_KEY, JSON.stringify(publicOnly));
  } catch (_e) {
    // quota error
  }
}

function reconcilePublicCacheByVideoType(videoType: VideoType, liveVideos: UploadedVideo[]): void {
  if (typeof window === "undefined" || typeof localStorage === "undefined") return;
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_VIDEOS_KEY);
    let existingOtherTypes: UploadedVideo[] = [];
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        existingOtherTypes = parsed
          .filter(
            (v) => isPubliclyCacheableVideo(v) && (v as UploadedVideo).videoType !== videoType,
          )
          .map((v) => sanitizeCachedVideo(v as UploadedVideo));
      }
    }
    const eligibleLive = liveVideos
      .filter((v) => isPubliclyCacheableVideo(v) && v.videoType === videoType)
      .map((v) => sanitizeCachedVideo(v));
    saveStoredVideos([...eligibleLive, ...existingOtherTypes]);
  } catch {
    // ignore storage errors
  }
}

function reconcileEmptyPublicShortsCache(videoType?: VideoType): void {
  if (typeof window === "undefined" || typeof localStorage === "undefined") return;
  try {
    const remaining = getStoredVideos().filter((v) => {
      const isShort = isShortVideo({ contentType: v.contentType, duration: v.duration });
      if (!isShort) return true;
      return Boolean(videoType && v.videoType !== videoType);
    });
    saveStoredVideos(remaining);
  } catch {
    // ignore storage errors
  }
}

export interface FetchVideosOptions {
  userId?: string;
  videoType?: VideoType;
  contentType?: ContentType;
  category?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

/**
 * Safely evaluates whether an ad promotion is currently active.
 * An ad promotion is active ONLY IF:
 * 1. Marked as promoted (isPromoted / is_promoted is true)
 * 2. Expiry timestamp is present, valid, and strictly in the future (> Date.now())
 *
 * Expired promotions, or those with null/missing/invalid expiry timestamps, return false.
 */
export function isPromotionActive(video: {
  isPromoted?: boolean | number | null | undefined;
  is_promoted?: boolean | number | null | undefined;
  promotionExpiresAt?: string | null | undefined;
  promotion_expires_at?: string | null | undefined;
}): boolean {
  const isMarked = Boolean(video.isPromoted ?? video.is_promoted);
  if (!isMarked) return false;
  const expiryRaw = video.promotionExpiresAt || video.promotion_expires_at;
  if (!expiryRaw) return false;
  const expiryTime = new Date(expiryRaw).getTime();
  if (Number.isNaN(expiryTime)) return false;
  return expiryTime > Date.now();
}

/**
 * Fetches videos from the production PHP REST API / MySQL database.
 * Falls back to local stored cache if offline, and syncs newly retrieved items.
 */
export async function fetchUploadedVideos(
  optionsOrUserId?: string | FetchVideosOptions,
): Promise<UploadedVideo[]> {
  const opts: FetchVideosOptions =
    typeof optionsOrUserId === "string" ? { userId: optionsOrUserId } : optionsOrUserId || {};

  try {
    const listParams: Parameters<typeof api.videos.list>[0] = {};
    if (opts.userId) listParams.userId = opts.userId;
    if (opts.videoType) listParams.videoType = opts.videoType;
    if (opts.contentType) listParams.contentType = opts.contentType;
    if (opts.category) listParams.category = opts.category;
    if (opts.search) listParams.search = opts.search;
    if (opts.limit !== undefined) listParams.limit = opts.limit;
    if (opts.offset !== undefined) listParams.offset = opts.offset;

    const res = await api.videos.list(listParams);

    if (res && res.success !== false && res.videos && Array.isArray(res.videos)) {
      const mapped = res.videos.map((d: any) => {
        const active = isPromotionActive({
          isPromoted: d.is_promoted ?? d.isPromoted,
          promotionExpiresAt: d.promotion_expires_at || d.promotionExpiresAt,
        });

        const channelName =
          d.channel_name || d.channelName || d.creator_name || d.creatorName || "FaceTube Creator";
        const rawLogo = d.channel_logo_url || d.channelLogoUrl || "";
        const channelLogoUrl = rawLogo ? resolveMediaUrl(rawLogo) || undefined : undefined;

        return {
          id: String(d.id),
          userId: String(d.user_id || d.userId || ""),
          creatorName: channelName,
          channelName,
          channelLogoUrl,
          title: d.title || "Untitled Video",
          description: d.description || "",
          videoUrl: resolveMediaUrl(d.video_url || d.videoUrl || ""),
          thumbnailUrl: resolveVideoThumbnail({
            thumbnailUrl: d.thumbnail_url || d.thumbnailUrl,
            category: d.category,
          }),
          videoType: (d.video_type || d.videoType || "free") as VideoType,
          contentType: (d.content_type || d.contentType || "long") as ContentType,
          category: d.category || "General",
          duration: d.duration || "0:00",
          views: Number(d.views) || 0,
          likes: Number(d.likes) || 0,
          paymentStatus: (d.payment_status ||
            d.paymentStatus ||
            "not_required") as VideoPaymentStatus,
          paymentId: d.payment_id || d.paymentId,
          paymentAmount: Number(d.payment_amount || d.paymentAmount) || 0,
          isPromoted: active,
          isBlocked: Boolean(d.is_blocked ?? d.isBlocked),
          promotionPlan: d.promotion_plan || d.promotionPlan,
          promotionExpiresAt: d.promotion_expires_at || d.promotionExpiresAt,
          visibility: resolveStoredVideoVisibility(d.visibility),
          createdAt: d.created_at || d.createdAt || new Date().toISOString(),
          updatedAt: d.updated_at || d.updatedAt || d.created_at || new Date().toISOString(),
          isStale: false,
        };
      });

      const visibleResults = opts.userId ? mapped : mapped.filter(isPubliclyCacheableVideo);

      // Partition cache cleanly:
      // - Public discovery (no userId filter): cache ONLY publicly eligible videos in global cache
      //   and clear stale cached entries when live API returns empty results (including per-videoType feeds)
      // - Owner-scoped queries: NEVER overwrite global public cache; cache only in owner partition
      const isUnpaginated =
        !opts.offset && (opts.limit === undefined || mapped.length < opts.limit);
      if (!opts.contentType && !opts.category && !opts.search && isUnpaginated) {
        if (opts.userId && !opts.videoType) {
          saveOwnerStoredVideos(opts.userId, mapped);
        } else if (!opts.userId) {
          if (!opts.videoType) {
            saveStoredVideos(visibleResults);
          } else {
            reconcilePublicCacheByVideoType(opts.videoType, visibleResults);
          }
        }
      } else if (
        !opts.userId &&
        opts.contentType === "short" &&
        !opts.category &&
        !opts.search &&
        isUnpaginated &&
        visibleResults.length === 0
      ) {
        reconcileEmptyPublicShortsCache(opts.videoType);
      }

      return visibleResults;
    }
  } catch (err) {
    console.warn("fetchUploadedVideos API warning, reading local cache:", err);
  }

  // Fallback to partitioned local stored videos cache, explicitly tagged as stale/offline
  let all: UploadedVideo[] = [];
  if (opts.userId) {
    const ownerCached = getOwnerStoredVideos(opts.userId);
    if (ownerCached) {
      all = ownerCached.map((v) => ({ ...v, isStale: true }));
    } else {
      const norm = opts.userId.trim().toUpperCase();
      all = getStoredVideos()
        .filter((v) => v.userId.trim().toUpperCase() === norm)
        .map((v) => ({ ...v, isStale: true }));
    }
  } else {
    all = getStoredVideos().map((v) => ({ ...v, isStale: true }));
  }

  if (opts.videoType) {
    all = all.filter((v) => v.videoType === opts.videoType);
  }
  if (opts.contentType) {
    all = all.filter((v) => v.contentType === opts.contentType);
  }
  if (opts.category && opts.category !== "All") {
    all = all.filter(
      (v) => (v.category || "General").toLowerCase() === opts.category!.toLowerCase(),
    );
  }
  if (opts.search) {
    const s = opts.search.toLowerCase();
    all = all.filter(
      (v) =>
        v.title.toLowerCase().includes(s) ||
        v.description.toLowerCase().includes(s) ||
        v.creatorName.toLowerCase().includes(s),
    );
  }

  // Prioritize active promotions at top of feeds
  all.sort((a, b) => {
    const pA = isPromotionActive(a) ? 1 : 0;
    const pB = isPromotionActive(b) ? 1 : 0;
    if (pA !== pB) return pB - pA;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  return all;
}

/**
 * Loads public videos for Free or Sponsor feeds from the live API without merging
 * stale localStorage entries on success. Falls back to sanitized cached records
 * only when the API is unavailable/errors out.
 */
export async function fetchPublicVideosFeed(videoType: VideoType): Promise<UploadedVideo[]> {
  try {
    const vids = await fetchUploadedVideos({ videoType });
    return vids.filter((v) => v.videoType === videoType && isPubliclyCacheableVideo(v));
  } catch (err) {
    console.warn(`Failed to fetch ${videoType} videos from API, reading sanitized cache:`, err);
    return getStoredVideos()
      .filter((v) => v.videoType === videoType && isPubliclyCacheableVideo(v))
      .map((v) => ({ ...v, isStale: true }));
  }
}

/**
 * Calculates dynamically the FOUR separate video counts:
 * 1. Free Short Video
 * 2. Free Long Video
 * 3. Premium Short Video
 * 4. Premium Long Video
 */
export async function calculateUserVideoCounts(userId?: string): Promise<VideoCategoryCounts> {
  const videos = await fetchUploadedVideos(userId);

  let freeShort = 0;
  let freeLong = 0;
  let premiumShort = 0;
  let premiumLong = 0;

  for (const v of videos) {
    if (v.videoType === "free") {
      if (v.contentType === "short") {
        freeShort++;
      } else {
        freeLong++;
      }
    } else if (v.videoType === "premium") {
      // Must be paid/active
      if (v.paymentStatus === "paid" || v.paymentStatus === "not_required") {
        if (v.contentType === "short") {
          premiumShort++;
        } else {
          premiumLong++;
        }
      }
    }
  }

  const totalFree = freeShort + freeLong;
  const totalPremium = premiumShort + premiumLong;
  const totalUploaded = totalFree + totalPremium;

  return {
    freeShort,
    freeLong,
    premiumShort,
    premiumLong,
    totalFree,
    totalPremium,
    totalUploaded,
  };
}

/**
 * Creates and records a newly uploaded video with strict payment and server verification
 */
export async function recordNewVideoUpload(params: {
  id?: string;
  userId: string;
  creatorName: string;
  title: string;
  description: string;
  videoUrl: string;
  thumbnailUrl?: string | null | undefined;
  videoType: VideoType; // "free" | "premium"
  contentType: ContentType; // "short" | "long"
  category?: string;
  duration?: string;
  paymentStatus?: VideoPaymentStatus;
  paymentId?: string;
  paymentAmount?: number;
  visibility?: "public" | "unlisted" | "private";
}): Promise<UploadedVideo> {
  const isPremium = params.videoType === "premium";

  const normalizedUserId = (params.userId || "").trim();
  if (!normalizedUserId) {
    throw new Error("Authentication required. Please log in before uploading a video.");
  }

  if (!params.videoUrl || !params.videoUrl.trim()) {
    throw new Error(
      "Cannot publish video: videoUrl is missing. Video must be uploaded to storage first.",
    );
  }

  const videoId = params.id || `vid-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const resolvedCategory = params.category || "Entertainment";
  const resolvedThumbnailUrl = resolveVideoThumbnail({
    thumbnailUrl: params.thumbnailUrl,
    category: resolvedCategory,
  });

  const hasExplicitVisibility =
    params.visibility !== undefined &&
    params.visibility !== null &&
    String(params.visibility).trim() !== "";
  let fallbackVisibility: VideoVisibility = "public";
  if (params.id && !hasExplicitVisibility) {
    const existingOwner = getOwnerStoredVideos(normalizedUserId)?.find((v) => v.id === params.id);
    const existingPublic = getStoredVideos().find((v) => v.id === params.id);
    fallbackVisibility = resolveInitialVideoVisibility(existingOwner || existingPublic);
  }
  const resolvedVisibility: VideoVisibility = normalizeVideoVisibility(
    params.visibility,
    fallbackVisibility,
  );

  const newVideo: UploadedVideo = {
    id: videoId,
    userId: normalizedUserId,
    creatorName: params.creatorName,
    title: params.title.trim(),
    description: params.description.trim(),
    videoUrl: params.videoUrl.trim(),
    thumbnailUrl: resolvedThumbnailUrl,
    videoType: params.videoType,
    contentType: params.contentType,
    category: resolvedCategory,
    duration: params.duration || (params.contentType === "short" ? "0:45" : "12:30"),
    views: 0,
    likes: 0,
    paymentStatus: isPremium ? params.paymentStatus || "pending" : "not_required",
    ...(params.paymentId ? { paymentId: params.paymentId } : {}),
    paymentAmount: isPremium ? (params.paymentAmount ?? 6) : 0,
    isPromoted: false,
    visibility: resolvedVisibility,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  // 1. Production API & Database Insertion - Must confirm success before publishing
  const apiRes = await api.videos.create({
    id: newVideo.id,
    user_id: newVideo.userId,
    creator_name: newVideo.creatorName,
    title: newVideo.title,
    description: newVideo.description,
    video_url: newVideo.videoUrl,
    thumbnail_url: newVideo.thumbnailUrl,
    video_type: newVideo.videoType,
    content_type: newVideo.contentType,
    category: newVideo.category,
    duration: newVideo.duration,
    payment_status: newVideo.paymentStatus,
    payment_id: newVideo.paymentId,
    payment_amount: newVideo.paymentAmount,
    ...(hasExplicitVisibility ? { visibility: resolvedVisibility } : {}),
    is_promoted: false,
  });

  if (!apiRes || !apiRes.success) {
    throw new Error(
      (apiRes as any)?.error || "Server rejected video creation. Video was not published.",
    );
  }

  const serverVideo = apiRes.video as Record<string, any> | undefined;
  const confirmedVideo: UploadedVideo = serverVideo
    ? {
        ...newVideo,
        id: String(serverVideo["id"] || newVideo.id),
        userId: String(serverVideo["user_id"] || serverVideo["userId"] || newVideo.userId),
        paymentStatus: (serverVideo["payment_status"] ||
          serverVideo["paymentStatus"] ||
          newVideo.paymentStatus) as VideoPaymentStatus,
        paymentAmount: Number(
          serverVideo["payment_amount"] ?? serverVideo["paymentAmount"] ?? newVideo.paymentAmount,
        ),
        visibility:
          serverVideo["visibility"] !== undefined &&
          serverVideo["visibility"] !== null &&
          String(serverVideo["visibility"]).trim() !== ""
            ? resolveStoredVideoVisibility(serverVideo["visibility"])
            : resolvedVisibility,
        isPromoted: Boolean(serverVideo["is_promoted"] ?? serverVideo["isPromoted"] ?? false),
        isBlocked: Boolean(serverVideo["is_blocked"] ?? serverVideo["isBlocked"] ?? false),
        ...(typeof (serverVideo["country_code"] ?? serverVideo["countryCode"]) === "string" &&
        String(serverVideo["country_code"] ?? serverVideo["countryCode"]).trim() !== ""
          ? {
              countryCode: String(serverVideo["country_code"] ?? serverVideo["countryCode"])
                .trim()
                .toUpperCase(),
            }
          : {}),
      }
    : newVideo;

  // 2. Partitioned caching:
  // - Only publicly eligible videos enter the shared public cache (never private/unlisted/pending!)
  // - Non-public videos remain isolated in the owner's partition only
  const publicAll = getStoredVideos();
  if (isPubliclyCacheableVideo(confirmedVideo)) {
    const filteredPublic = publicAll.filter((v) => v.id !== confirmedVideo.id);
    saveStoredVideos([confirmedVideo, ...filteredPublic]);
  } else if (publicAll.some((v) => v.id === confirmedVideo.id)) {
    // If an updated video became private/unlisted/blocked, remove it from public cache
    saveStoredVideos(publicAll.filter((v) => v.id !== confirmedVideo.id));
  }

  const existingOwnerCache = getOwnerStoredVideos(confirmedVideo.userId);
  if (existingOwnerCache) {
    const filteredOwner = existingOwnerCache.filter((v) => v.id !== confirmedVideo.id);
    saveOwnerStoredVideos(confirmedVideo.userId, [confirmedVideo, ...filteredOwner]);
  } else {
    saveOwnerStoredVideos(confirmedVideo.userId, [confirmedVideo]);
  }

  return confirmedVideo;
}

/**
 * Reconciles shared public cache and owner-scoped cache after a server-confirmed visibility update.
 * Removes non-public, blocked, or unpaid Sponsor videos from the shared public cache immediately.
 */
export function syncVideoVisibilityInCaches(confirmedVideo: UploadedVideo): void {
  const publicAll = getStoredVideos();
  if (isPubliclyCacheableVideo(confirmedVideo)) {
    const idx = publicAll.findIndex((v) => v.id === confirmedVideo.id);
    if (idx >= 0) {
      const next = [...publicAll];
      next[idx] = confirmedVideo;
      saveStoredVideos(next);
    } else {
      saveStoredVideos([confirmedVideo, ...publicAll]);
    }
  } else if (publicAll.some((v) => v.id === confirmedVideo.id)) {
    saveStoredVideos(publicAll.filter((v) => v.id !== confirmedVideo.id));
  }

  const ownerUid = (confirmedVideo.userId || "").trim();
  if (!ownerUid) return;
  const existingOwnerCache = getOwnerStoredVideos(ownerUid);
  if (existingOwnerCache) {
    const idx = existingOwnerCache.findIndex((v) => v.id === confirmedVideo.id);
    if (idx >= 0) {
      const nextOwner = [...existingOwnerCache];
      nextOwner[idx] = confirmedVideo;
      saveOwnerStoredVideos(ownerUid, nextOwner);
    } else {
      saveOwnerStoredVideos(ownerUid, [confirmedVideo, ...existingOwnerCache]);
    }
  } else {
    const session = getCurrentAuthenticatedCacheIdentity();
    if (session && session.userId === ownerUid.toUpperCase()) {
      saveOwnerStoredVideos(ownerUid, [confirmedVideo]);
    }
  }
}

/**
 * Updates video visibility on the backend and reconciles public/owner caches ONLY after confirmed success.
 */
export async function updateVideoVisibility(params: {
  videoId: string;
  visibility: VideoVisibility;
}): Promise<UploadedVideo> {
  const videoId = String(params.videoId || "").trim();
  if (!videoId) {
    throw new Error("Video ID is required.");
  }

  const apiRes = await api.videos.updateVisibility({
    videoId,
    visibility: params.visibility,
  });

  if (!apiRes || !apiRes.success || !apiRes.video) {
    throw new Error((apiRes as any)?.error || "Failed to update video visibility on the server.");
  }

  const d = apiRes.video as Record<string, any>;
  const resolvedType = (
    String(d["video_type"] || d["videoType"] || "free")
      .trim()
      .toLowerCase() === "premium"
      ? "premium"
      : "free"
  ) as VideoType;
  const channelName = String(
    d["channel_name"] ||
      d["channelName"] ||
      d["creator_name"] ||
      d["creatorName"] ||
      "FaceTube Creator",
  );
  const rawLogo = d["channel_logo_url"] || d["channelLogoUrl"] || "";
  const channelLogoUrl = rawLogo ? resolveMediaUrl(String(rawLogo)) || undefined : undefined;

  const confirmedVideo: UploadedVideo = {
    id: String(d["id"] || videoId),
    userId: String(d["user_id"] || d["userId"] || ""),
    creatorName: channelName,
    channelName,
    channelLogoUrl,
    title: String(d["title"] || "Untitled Video"),
    description: String(d["description"] || ""),
    videoUrl: resolveMediaUrl(String(d["video_url"] || d["videoUrl"] || "")),
    thumbnailUrl: resolveVideoThumbnail({
      thumbnailUrl: d["thumbnail_url"] || d["thumbnailUrl"],
      category: d["category"],
    }),
    videoType: resolvedType,
    contentType: (d["content_type"] || d["contentType"] || "long") as ContentType,
    category: String(d["category"] || "General"),
    duration: String(d["duration"] || "0:00"),
    views: Number(d["views"]) || 0,
    likes: Number(d["likes"]) || 0,
    paymentStatus: (d["payment_status"] ||
      d["paymentStatus"] ||
      (resolvedType === "premium" ? "pending" : "not_required")) as VideoPaymentStatus,
    ...(d["payment_id"] || d["paymentId"]
      ? { paymentId: String(d["payment_id"] || d["paymentId"]) }
      : {}),
    paymentAmount: Number(d["payment_amount"] ?? d["paymentAmount"]) || 0,
    isPromoted: Boolean(d["is_promoted"] ?? d["isPromoted"] ?? false),
    isBlocked: Boolean(d["is_blocked"] ?? d["isBlocked"] ?? false),
    ...(d["promotion_plan"] || d["promotionPlan"]
      ? { promotionPlan: String(d["promotion_plan"] || d["promotionPlan"]) }
      : {}),
    ...(d["promotion_expires_at"] || d["promotionExpiresAt"]
      ? { promotionExpiresAt: String(d["promotion_expires_at"] || d["promotionExpiresAt"]) }
      : {}),
    visibility: resolveStoredVideoVisibility(d["visibility"] ?? params.visibility),
    createdAt: String(d["created_at"] || d["createdAt"] || new Date().toISOString()),
    updatedAt: String(d["updated_at"] || d["updatedAt"] || new Date().toISOString()),
    isStale: false,
  };

  syncVideoVisibilityInCaches(confirmedVideo);
  return confirmedVideo;
}

/* -------------------------------------------------------------------------- */
/* BULK VIDEO UPLOAD SERVICE LAYER (Shorts & Long Videos)                     */
/* -------------------------------------------------------------------------- */

export interface BulkVideoFileValidation {
  valid: boolean;
  error?: string;
}

/**
 * Validates a video file against size (<= 150MB) and supported formats (MP4, WebM, OGG, MOV, M4V, MKV).
 */
export function validateVideoFileForUpload(file: File): BulkVideoFileValidation {
  if (!file) {
    return { valid: false, error: "No file selected." };
  }
  const maxSizeBytes = 150 * 1024 * 1024; // 150MB limit
  if (file.size <= 0) {
    return { valid: false, error: `File "${file.name}" is empty (0 bytes).` };
  }
  if (file.size > maxSizeBytes) {
    return {
      valid: false,
      error: `File "${file.name}" exceeds 150MB limit (${(file.size / (1024 * 1024)).toFixed(1)} MB).`,
    };
  }
  const validExts = [".mp4", ".webm", ".ogg", ".mov", ".m4v", ".mkv"];
  const ext = "." + (file.name.split(".").pop() || "").toLowerCase();
  const validMimes = [
    "video/mp4",
    "video/webm",
    "video/ogg",
    "video/quicktime",
    "video/x-m4v",
    "video/x-matroska",
    "application/octet-stream",
  ];
  const isExtValid = validExts.includes(ext);
  const isMimeValid =
    !file.type || file.type.startsWith("video/") || validMimes.includes(file.type);
  if (!isExtValid && !isMimeValid) {
    return {
      valid: false,
      error: `File "${file.name}" has unsupported format (${ext || file.type || "unknown"}). Supported formats: MP4, WebM, OGG, MOV.`,
    };
  }
  return { valid: true };
}

export interface BulkUploadItemPayload {
  id: string; // unique item id in queue
  file: File;
  title: string;
  description?: string;
  category: string;
  contentType: ContentType; // "short" | "long"
  visibility?: "public" | "unlisted" | "private";
  customThumbnailFile?: File | null;
  thumbnailUrl?: string;
  detectedDuration?: string;
  videoType?: VideoType; // "free" | "premium"
  paymentStatus?: VideoPaymentStatus;
  paymentId?: string;
  paymentAmount?: number;
}

export interface BulkUploadItemResult {
  id: string;
  title: string;
  success: boolean;
  video?: UploadedVideo;
  error?: string;
  fileSize: number;
  duration?: string;
}

export interface BulkUploadProgressState {
  itemId: string;
  progress: number;
  phase:
    "validating" | "uploading_video" | "uploading_thumbnail" | "publishing" | "complete" | "error";
  error?: string;
}

/**
 * Processes an individual item from a bulk upload batch:
 * 1. Validates the video file
 * 2. Uploads the video file via api.uploads.uploadVideo
 * 3. Handles custom thumbnail file upload (or captured thumbnail / category fallback)
 * 4. Calls recordNewVideoUpload to persist the video record
 * 5. Returns the published UploadedVideo
 */
export async function uploadSingleBulkVideoItem(
  item: BulkUploadItemPayload,
  creatorInfo: { userId: string; creatorName: string },
  onProgress?: (state: BulkUploadProgressState) => void,
): Promise<UploadedVideo> {
  // 1. Auth & Validation
  const normalizedUserId = (creatorInfo?.userId || "").trim();
  if (!normalizedUserId) {
    throw new Error("Authentication required. Please log in before uploading videos.");
  }
  onProgress?.({ itemId: item.id, progress: 10, phase: "validating" });
  const validation = validateVideoFileForUpload(item.file);
  if (!validation.valid) {
    throw new Error(validation.error || "Invalid video file.");
  }

  // 2. Upload video binary to storage via production API
  onProgress?.({ itemId: item.id, progress: 25, phase: "uploading_video" });
  const uploadRes = await api.uploads.uploadVideo(item.file);
  if (!uploadRes || !uploadRes.url) {
    const errMsg =
      (uploadRes as any)?.error ||
      (uploadRes as any)?.message ||
      (uploadRes as any)?.msg ||
      "Server storage upload failed without a valid video URL.";
    throw new Error(errMsg);
  }
  onProgress?.({ itemId: item.id, progress: 65, phase: "uploading_thumbnail" });

  // 3. Resolve / upload thumbnail
  let finalThumbnailUrl = item.thumbnailUrl || "";
  if (item.customThumbnailFile) {
    try {
      const imgRes = await api.uploads.uploadImage(item.customThumbnailFile);
      if (imgRes && imgRes.url) {
        finalThumbnailUrl = imgRes.url;
      }
    } catch (_imgErr) {
      // Fallback
    }
  }
  if (!finalThumbnailUrl) {
    try {
      finalThumbnailUrl = await captureAndUploadThumbnail(item.file, item.category);
    } catch (_thumbErr) {
      finalThumbnailUrl = getCategoryFallbackThumbnail(item.category);
    }
  }

  // 4. Publish video record to production database
  onProgress?.({ itemId: item.id, progress: 85, phase: "publishing" });
  const published = await recordNewVideoUpload({
    userId: creatorInfo.userId,
    creatorName: creatorInfo.creatorName,
    title: item.title.trim() || item.file.name.replace(/\.[^/.]+$/, ""),
    description: (item.description || "").trim(),
    videoUrl: uploadRes.url,
    thumbnailUrl: finalThumbnailUrl,
    videoType: item.videoType || "free",
    contentType: item.contentType,
    category: item.category || "Entertainment",
    duration: item.detectedDuration || (item.contentType === "short" ? "0:45" : "12:30"),
    paymentStatus: item.paymentStatus || (item.videoType === "premium" ? "paid" : "not_required"),
    ...(item.paymentId ? { paymentId: item.paymentId } : {}),
    paymentAmount: item.videoType === "premium" ? (item.paymentAmount ?? 6) : 0,
    visibility: normalizeVideoVisibility(item.visibility, "public"),
  });

  onProgress?.({ itemId: item.id, progress: 100, phase: "complete" });
  return published;
}

export interface BulkQueueSelectableItem {
  id: string;
  status: "queued" | "uploading" | "success" | "error";
}

/**
 * Resolves the exact queued or retryable bulk upload item synchronously from current state/ref,
 * avoiding React 19 state-updater side effects and skipping already-uploading or completed items.
 */
export function selectBulkQueueItemForUpload<T extends BulkQueueSelectableItem>(
  queue: readonly T[],
  itemId: string,
): T | undefined {
  const match = queue.find((it) => it.id === itemId);
  if (!match || match.status === "success" || match.status === "uploading") {
    return undefined;
  }
  return match;
}

/**
 * Executes a batch upload queue sequentially:
 * - Skips items that have already succeeded (prevents duplicate submissions)
 * - Reports progress per item
 * - Collects results for all items (failed items are reported without interrupting remaining items)
 * - Allows subsequent retries for only failed items
 */
export async function executeBulkVideoUploadQueue(
  items: BulkUploadItemPayload[],
  creatorInfo: { userId: string; creatorName: string },
  callbacks?: {
    onItemStart?: (item: BulkUploadItemPayload) => void;
    onItemProgress?: (state: BulkUploadProgressState) => void;
    onItemSuccess?: (item: BulkUploadItemPayload, video: UploadedVideo) => void;
    onItemError?: (item: BulkUploadItemPayload, error: Error) => void;
  },
): Promise<BulkUploadItemResult[]> {
  const results: BulkUploadItemResult[] = [];

  for (const item of items) {
    callbacks?.onItemStart?.(item);
    try {
      const video = await uploadSingleBulkVideoItem(item, creatorInfo, callbacks?.onItemProgress);
      callbacks?.onItemSuccess?.(item, video);
      results.push({
        id: item.id,
        title: item.title,
        success: true,
        video,
        fileSize: item.file.size,
        duration: video.duration,
      });
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      callbacks?.onItemError?.(item, err instanceof Error ? err : new Error(errorMsg));
      callbacks?.onItemProgress?.({
        itemId: item.id,
        progress: 0,
        phase: "error",
        error: errorMsg,
      });
      results.push({
        id: item.id,
        title: item.title,
        success: false,
        error: errorMsg,
        fileSize: item.file.size,
      });
    }
  }

  return results;
}

/**
 * Activates promotion on an existing or new video upon verified payment
 */
export async function markVideoPromoted(params: {
  videoId: string;
  planId: string;
  durationDays: number;
  paymentId: string;
}): Promise<boolean> {
  const promoRes = await api.videos.promote({
    videoId: params.videoId,
    planId: params.planId,
    durationDays: params.durationDays,
    paymentId: params.paymentId,
  });

  if (!promoRes || !promoRes.success) {
    throw new Error(
      (promoRes as any)?.error ||
        "Server failed to activate video promotion. Promotion was not confirmed.",
    );
  }

  const all = getStoredVideos();
  const index = all.findIndex((v) => v.id === params.videoId);
  const expiresAt =
    promoRes.promotionExpiresAt ||
    new Date(Date.now() + params.durationDays * 24 * 60 * 60 * 1000).toISOString();

  if (index !== -1) {
    const video = all[index];
    if (video) {
      video.isPromoted = true;
      video.promotionPlan = params.planId;
      video.promotionExpiresAt = expiresAt;
      video.updatedAt = new Date().toISOString();
      saveStoredVideos(all);
    }
  }

  const session = getCurrentAuthenticatedCacheIdentity();
  if (session) {
    const ownerVideos = getOwnerStoredVideos(session.userId);
    if (ownerVideos) {
      const ownerIdx = ownerVideos.findIndex((v) => v.id === params.videoId);
      const ownerVideo = ownerIdx !== -1 ? ownerVideos[ownerIdx] : undefined;
      if (ownerVideo) {
        ownerVideo.isPromoted = true;
        ownerVideo.promotionPlan = params.planId;
        ownerVideo.promotionExpiresAt = expiresAt;
        ownerVideo.updatedAt = new Date().toISOString();
        saveOwnerStoredVideos(session.userId, ownerVideos);
      }
    }
  }

  return true;
}

/**
 * Converts an UploadedVideo into standard catalog Video format, ensuring
 * safe thumbnail URLs, playback links, and display attributes.
 */
export function convertUploadedToCatalogVideo(v: UploadedVideo): Video {
  const thumbUrl = resolveVideoThumbnail({
    thumbnailUrl: v.thumbnailUrl,
    thumbnail_url: (v as any).thumbnail_url,
    category: v.category,
  });

  const rawVideoUrl = resolveMediaUrl(v.videoUrl || (v as any).video_url || "");
  const channelName =
    v.channelName || (v as any).channel_name || v.creatorName || "FaceTube Creator";
  const rawChannelLogo = v.channelLogoUrl || (v as any).channel_logo_url || "";
  const channelLogoUrl = rawChannelLogo ? resolveMediaUrl(rawChannelLogo) || undefined : undefined;

  return {
    id: String(v.id),
    title: v.title || "Untitled Video",
    channel: channelName,
    channelName,
    channelLogoUrl,
    channel_logo_url: channelLogoUrl,
    initials: computeChannelInitials(channelName, "FT"),
    views: `${(Number(v.views) || 0).toLocaleString()} views`,
    age: v.createdAt ? new Date(v.createdAt).toLocaleDateString() : "Recently uploaded",
    duration: v.duration || "0:00",
    thumb: thumbUrl,
    thumbnail: thumbUrl,
    thumbnailUrl: thumbUrl,
    tint: v.videoType === "premium" ? "oklch(0.6 0.22 45)" : "oklch(0.5 0.18 20)",
    category: v.category || "General",
    description: v.description || "",
    videoUrl: rawVideoUrl,
    videoType: v.videoType || "free",
    contentType:
      v.contentType ||
      (isShortVideo({ contentType: v.contentType, duration: v.duration }) ? "short" : "long"),
    isPromoted: isPromotionActive(v),
    userId: String(v.userId || (v as any).user_id || ""),
    ...(v.visibility !== undefined
      ? { visibility: resolveStoredVideoVisibility(v.visibility) }
      : {}),
  };
}

export function parseCatalogViews(views: string | number | null | undefined): number {
  if (typeof views === "number") return Number.isFinite(views) ? views : 0;
  if (!views) return 0;
  const raw = String(views).trim();
  const digits = raw.replace(/[^0-9.]/g, "");
  const num = parseFloat(digits);
  if (Number.isNaN(num)) return 0;
  if (/m\b/i.test(raw)) return Math.round(num * 1_000_000);
  if (/k\b/i.test(raw)) return Math.round(num * 1_000);
  return Math.round(num);
}

export function buildPublicFeedVideos(
  videos: readonly UploadedVideo[],
  options?: {
    videoType?: VideoType;
    contentType?: ContentType;
    category?: string;
  },
): Video[] {
  const seen = new Set<string>();
  const result: Video[] = [];
  const targetCat = options?.category?.trim().toLowerCase();

  for (const v of videos) {
    if (!v || !v.id || seen.has(v.id)) continue;
    if (!isPubliclyCacheableVideo(v)) continue;
    if (options?.videoType && v.videoType !== options.videoType) continue;
    if (options?.videoType === "premium" && v.paymentStatus !== "paid") continue;
    if (
      options?.contentType === "short" &&
      !isShortVideo({ contentType: v.contentType, duration: v.duration })
    ) {
      continue;
    }
    if (
      options?.contentType === "long" &&
      isShortVideo({ contentType: v.contentType, duration: v.duration })
    ) {
      continue;
    }
    if (
      targetCat &&
      targetCat !== "all" &&
      (v.category || "General").trim().toLowerCase() !== targetCat
    ) {
      continue;
    }
    seen.add(v.id);
    result.push(convertUploadedToCatalogVideo(v));
  }
  return result;
}

export function buildPublicHomeSections(
  videos: readonly UploadedVideo[],
  homeShortsSource?: readonly UploadedVideo[],
): {
  allCombinedVideos: Video[];
  recommendedVideos: Video[];
  trendingVideos: Video[];
  recentVideos: Video[];
  shortItems: ShortItem[];
} {
  const eligibleUploads = videos.filter((v) => v && v.id && isPubliclyCacheableVideo(v));
  const allCombinedVideos = buildPublicFeedVideos(eligibleUploads);
  const recommendedVideos = allCombinedVideos;
  const trendingVideos = [...allCombinedVideos].sort(
    (a, b) => parseCatalogViews(b.views) - parseCatalogViews(a.views),
  );
  const recentUploadsSorted = [...eligibleUploads].sort((a, b) => {
    const ta = new Date(a.createdAt || 0).getTime() || 0;
    const tb = new Date(b.createdAt || 0).getTime() || 0;
    return tb - ta;
  });
  const recentVideos = buildPublicFeedVideos(recentUploadsSorted);

  const shortsInput = homeShortsSource ?? eligibleUploads;
  const seenShorts = new Set<string>();
  const shortItems: ShortItem[] = [];
  for (const v of shortsInput) {
    if (!v || !v.id || seenShorts.has(v.id)) continue;
    if (!isPubliclyCacheableVideo(v)) continue;
    if (!isShortVideo({ contentType: v.contentType, duration: v.duration })) continue;
    seenShorts.add(v.id);
    shortItems.push(convertVideoToShortItem(v));
  }

  return {
    allCombinedVideos,
    recommendedVideos,
    trendingVideos,
    recentVideos,
    shortItems,
  };
}

/**
 * Checks whether a video item is a Short video based on metadata or duration (<= 60 seconds).
 */
export function isShortVideo(video: { contentType?: string; duration?: string }): boolean {
  if (video.contentType === "short") return true;
  if (video.contentType === "long") return false;
  if (!video.duration) return false;
  const raw = video.duration.trim();
  const parts = raw.split(":").map(Number);
  if (parts.some(isNaN)) return false;
  if (parts.length === 2) {
    const minutes = parts[0];
    const seconds = parts[1];
    if (minutes !== undefined && seconds !== undefined) {
      return minutes * 60 + seconds <= 60;
    }
  }
  return false;
}

/**
 * Checks whether a video item is a Long video.
 */
export function isLongVideo(video: { contentType?: string; duration?: string }): boolean {
  return !isShortVideo(video);
}

export interface VideoBadgeLabels {
  /**
   * Free videos: must appear normally; no Premium, Sponsored, or price labels.
   */
  isFree: boolean;
  /**
   * For videos uploaded under paid/premium upload option, show small "Sponsored" label beside channel name.
   * Never show "Premium" or upload fees like "₹6" as public video-card label.
   */
  showSponsorLabel: boolean;
  /**
   * For videos genuinely classified as advertising/promotional content by metadata or Ads upload.
   * Shown as a small "Ads" label immediately below title.
   */
  showAdsLabel: boolean;
  /**
   * Regression requirement: Video thumbnails MUST NOT display an "Ads" overlay badge or text.
   * Always false across all cards and feeds.
   */
  showThumbnailAdsOverlay: false;
  /**
   * Strictly public badge texts.
   */
  badges: Array<{
    type: "sponsor" | "ads";
    label: string;
  }>;
}

/**
 * Centrally determines the public badge labels for a video according to FaceTube guidelines:
 * 1. Free videos: must appear normally. No Premium, Sponsored, or price labels.
 * 2. Paid/premium uploads: show small "Sponsored" label beside channel name. No "Premium" or "₹6".
 * 3. Ads videos: show small "Ads" label only for genuine advertising/promotional content.
 * 4. Thumbnail overlays: zero Ads badge overlay on thumbnails across all cards and feeds.
 * 5. Duration is never used to determine sponsor or ad status.
 */
export function getVideoBadgeLabels(video: {
  videoType?: string | null | undefined;
  video_type?: string | null | undefined;
  isPromoted?: boolean | number | null | undefined;
  is_promoted?: boolean | number | null | undefined;
  promotionExpiresAt?: string | null | undefined;
  promotion_expires_at?: string | null | undefined;
  duration?: string | null | undefined;
  contentType?: string | null | undefined;
}): VideoBadgeLabels {
  const videoType = (video.videoType ?? video.video_type ?? "free").toLowerCase();
  const isPaidPremium = videoType === "premium";

  // Check if genuinely active advertising / promotional content
  const hasPromotedFlag = Boolean(video.isPromoted ?? video.is_promoted);
  let showAds = false;
  if (hasPromotedFlag) {
    const expiry = video.promotionExpiresAt ?? video.promotion_expires_at;
    if (expiry) {
      showAds = isPromotionActive({
        isPromoted: hasPromotedFlag,
        promotionExpiresAt: expiry,
      });
    } else {
      showAds = true;
    }
  }

  const showSponsor = isPaidPremium;
  const isFree = !showSponsor && !showAds;

  const badges: Array<{ type: "sponsor" | "ads"; label: string }> = [];
  if (showSponsor) {
    badges.push({ type: "sponsor", label: "Sponsored" });
  }
  if (showAds) {
    badges.push({ type: "ads", label: "Ads" });
  }

  return {
    isFree,
    showSponsorLabel: showSponsor,
    showAdsLabel: showAds,
    showThumbnailAdsOverlay: false,
    badges,
  };
}

/**
 * Converts a Video or UploadedVideo into ShortItem format for display in ShortsShelf and /shorts.
 */
export function convertVideoToShortItem(v: Video | UploadedVideo): ShortItem {
  const thumbUrl =
    (v as any).thumb ||
    (v as any).thumbnail ||
    (v as any).thumbnailUrl ||
    resolveVideoThumbnail({
      thumbnailUrl: (v as any).thumbnailUrl,
      category: (v as any).category,
    });
  const channel =
    (v as any).channelName ||
    (v as any).channel_name ||
    (v as any).channel ||
    (v as any).creatorName ||
    "FaceTube Creator";
  const rawChannelLogo = (v as any).channelLogoUrl || (v as any).channel_logo_url || "";
  const channelLogoUrl = rawChannelLogo ? resolveMediaUrl(rawChannelLogo) || undefined : undefined;
  const views =
    typeof (v as any).views === "number"
      ? `${(v as any).views.toLocaleString()} views`
      : String((v as any).views || "0 views");

  const rawVideoType = (v as any).videoType ?? (v as any).video_type;
  const normalizedVideoType: "free" | "premium" | undefined =
    typeof rawVideoType === "string" && rawVideoType.trim().toLowerCase() === "premium"
      ? "premium"
      : typeof rawVideoType === "string" && rawVideoType.trim().toLowerCase() === "free"
        ? "free"
        : undefined;
  const isPromotedRaw = (v as any).isPromoted ?? (v as any).is_promoted;
  const promotionExpiresAt = (v as any).promotionExpiresAt ?? (v as any).promotion_expires_at;

  return {
    id: String(v.id),
    title: v.title || "FaceTube Short",
    creator: channel,
    creatorHandle: `@${channel.toLowerCase().replace(/[^a-z0-9]/g, "") || "creator"}`,
    initials: computeChannelInitials(channel, "FT"),
    views: views,
    likes: (v as any).likes ? `${(v as any).likes.toLocaleString?.() || (v as any).likes}` : "1.2K",
    comments: "48",
    shares: "16",
    soundTrack: `${channel} · Original Audio`,
    tags: [(v as any).category || "Shorts"],
    thumb: thumbUrl,
    aspectColor: "from-blue-900/60 to-purple-900/80",
    videoUrl: (v as any).videoUrl,
    userId: (v as any).userId || (v as any).user_id,
    channelLogoUrl,
    ...(normalizedVideoType ? { videoType: normalizedVideoType } : {}),
    ...(typeof rawVideoType === "string" ? { video_type: rawVideoType } : {}),
    ...(isPromotedRaw !== undefined ? { isPromoted: Boolean(isPromotedRaw) } : {}),
    ...(promotionExpiresAt ? { promotionExpiresAt: String(promotionExpiresAt) } : {}),
  };
}

export interface DerivedCreator {
  key: string;
  userId?: string | undefined;
  name: string;
  initials: string;
  channelLogoUrl?: string | undefined;
  category: string;
  uploadCount: number;
}

function sanitizeCreatorText(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  const lower = trimmed.toLowerCase();
  if (lower === "null" || lower === "undefined" || lower === "nan") return "";
  return trimmed;
}

function sanitizeCreatorLogoUrl(value: unknown): string | undefined {
  const cleaned = sanitizeCreatorText(value);
  if (!cleaned) return undefined;
  const resolved = resolveMediaUrl(cleaned);
  return resolved || undefined;
}

function computeCreatorInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    const first = parts[0]?.charAt(0) ?? "";
    const second = parts[1]?.charAt(0) ?? "";
    const combined = `${first}${second}`.toUpperCase();
    if (combined) return combined;
  }
  return (name.trim().slice(0, 2) || "FT").toUpperCase();
}

/**
 * Pure helper to derive unique live creator entries from uploaded videos.
 * - Ignores stale seed/cache records (`isStale === true` or unconfirmed seed IDs)
 * - Deduplicates case-insensitively by `userId`, falling back to normalized channel name
 * - Prefers `channelName || creatorName`
 * - Sanitizes null, empty, "null", and "undefined" logo URLs
 * - Excludes all private user fields / PII
 */
export function deriveCreatorsFromVideos(
  videos: readonly UploadedVideo[] | null | undefined,
): DerivedCreator[] {
  if (!Array.isArray(videos) || videos.length === 0) {
    return [];
  }

  const creatorMap = new Map<string, DerivedCreator>();
  const hasExplicitChannelName = new Set<string>();

  for (const rawVideo of videos) {
    if (!rawVideo || typeof rawVideo !== "object") continue;

    // Never treat stale seed/cache data as confirmed live database creators
    if (rawVideo.isStale === true) continue;
    const rawId = typeof rawVideo.id === "string" ? rawVideo.id.trim() : "";
    if (rawVideo.isStale !== false && rawId.startsWith("vid-seed-")) {
      continue;
    }

    const rawRecord = rawVideo as unknown as Record<string, unknown>;
    const userId = sanitizeCreatorText(rawVideo.userId ?? rawRecord["user_id"]);
    const channelName = sanitizeCreatorText(rawVideo.channelName ?? rawRecord["channel_name"]);
    const creatorName = sanitizeCreatorText(rawVideo.creatorName ?? rawRecord["creator_name"]);
    const displayName = channelName || creatorName;

    if (!userId && !displayName) {
      continue;
    }

    const safeName = displayName || "FaceTube Creator";
    const normalizedNameKey = safeName.toLowerCase().replace(/\s+/g, " ");
    const dedupeKey = userId ? `uid:${userId.toUpperCase()}` : `name:${normalizedNameKey}`;

    const logoUrl = sanitizeCreatorLogoUrl(
      rawVideo.channelLogoUrl ?? rawRecord["channel_logo_url"],
    );
    const category = sanitizeCreatorText(rawVideo.category) || "General";

    const existing = creatorMap.get(dedupeKey);
    if (existing) {
      existing.uploadCount += 1;
      if (!existing.channelLogoUrl && logoUrl) {
        existing.channelLogoUrl = logoUrl;
      }
      if (
        channelName &&
        (!hasExplicitChannelName.has(dedupeKey) || existing.name === "FaceTube Creator")
      ) {
        existing.name = channelName;
        existing.initials = computeCreatorInitials(channelName);
        hasExplicitChannelName.add(dedupeKey);
      }
      if ((!existing.category || existing.category === "General") && category !== "General") {
        existing.category = category;
      }
      continue;
    }

    if (channelName) {
      hasExplicitChannelName.add(dedupeKey);
    }

    creatorMap.set(dedupeKey, {
      key: dedupeKey,
      ...(userId ? { userId } : {}),
      name: safeName,
      initials: computeCreatorInitials(safeName),
      ...(logoUrl ? { channelLogoUrl: logoUrl } : {}),
      category,
      uploadCount: 1,
    });
  }

  return Array.from(creatorMap.values());
}
