import type { User, DbUser, Profile, RoleType, UserWithRole } from "../types/auth.ts";
import { resolveMediaUrl } from "./media-url.ts";

export const LOCAL_STORAGE_SESSION_KEY = "facetube_session_v2";

export interface CachedAuthSession {
  user: User | null;
  profile: Profile | null;
  dbUser: DbUser | null;
  role: RoleType;
  token?: string | null | undefined;
}

export function computeUpdatedChannelSession(params: {
  user: User | null;
  profile: Profile | null;
  dbUser: DbUser | null;
  role: RoleType;
  usersList?: (UserWithRole & { password?: string; user_id?: string })[];
  cachedSession?: CachedAuthSession | null;
  token?: string | null;
  updates: {
    channel_logo_url?: string | null;
    channel_name?: string | null;
    channel_description?: string | null;
  };
}) {
  const {
    user,
    profile,
    dbUser,
    role,
    usersList = [],
    cachedSession = null,
    token = null,
    updates,
  } = params;

  const baseProfile = profile || cachedSession?.profile || null;
  const baseDbUser = dbUser || cachedSession?.dbUser || null;
  const baseUser = user || cachedSession?.user || null;

  const hasLogo = updates.channel_logo_url !== undefined;
  const hasName = updates.channel_name !== undefined;
  const hasDescription = updates.channel_description !== undefined;
  const nextLogo =
    hasLogo && updates.channel_logo_url
      ? resolveMediaUrl(updates.channel_logo_url) || updates.channel_logo_url
      : updates.channel_logo_url;
  const nextDescription =
    hasDescription && typeof updates.channel_description === "string"
      ? updates.channel_description.trim() || null
      : (updates.channel_description ?? null);

  const updatedProfile: Profile | null = baseProfile
    ? {
        ...baseProfile,
        ...(hasLogo ? { channel_logo_url: nextLogo ?? null } : {}),
        ...(hasName ? { channel_name: updates.channel_name ?? null } : {}),
        ...(hasDescription ? { channel_description: nextDescription } : {}),
      }
    : null;

  const updatedDbUser: DbUser | null = baseDbUser
    ? {
        ...baseDbUser,
        ...(hasLogo ? { channel_logo_url: nextLogo ?? null } : {}),
        ...(hasName ? { channel_name: updates.channel_name ?? null } : {}),
        ...(hasDescription ? { channel_description: nextDescription } : {}),
      }
    : null;

  const updatedAuthUser: User | null = baseUser
    ? {
        ...baseUser,
        user_metadata: {
          ...baseUser.user_metadata,
          ...(hasLogo ? { channel_logo_url: nextLogo ?? null } : {}),
          ...(hasName ? { channel_name: updates.channel_name ?? null } : {}),
          ...(hasDescription ? { channel_description: nextDescription } : {}),
        },
      }
    : null;

  const activeUserId = baseProfile?.user_id || baseDbUser?.user_id || baseUser?.user_id;
  const updatedUsersList = activeUserId
    ? usersList.map((u) => {
        if (u.user_id?.toUpperCase() === activeUserId.toUpperCase()) {
          return {
            ...u,
            ...(hasLogo ? { channel_logo_url: nextLogo ?? null } : {}),
            ...(hasName ? { channel_name: updates.channel_name ?? null } : {}),
            ...(hasDescription ? { channel_description: nextDescription } : {}),
          };
        }
        return u;
      })
    : usersList;

  const resolvedToken = token || cachedSession?.token || undefined;
  const sessionToPersist: CachedAuthSession | null =
    updatedAuthUser || updatedProfile || updatedDbUser || cachedSession
      ? {
          ...(cachedSession || {}),
          user: updatedAuthUser,
          profile: updatedProfile,
          dbUser: updatedDbUser,
          role: cachedSession?.role || role,
          ...(resolvedToken ? { token: resolvedToken } : {}),
        }
      : null;

  return {
    updatedProfile,
    updatedDbUser,
    updatedAuthUser,
    updatedUsersList,
    activeUserId,
    nextLogo,
    sessionToPersist,
  };
}

export const CHANNEL_BRANDING_UPDATED_EVENT = "facetube:channel-branding-updated";

const PUBLIC_VIDEOS_CACHE_KEY = "facetube_uploaded_videos_v3";
const OWNER_VIDEOS_CACHE_PREFIX = "facetube_owner_videos_v1:";

function sanitizeIdentityText(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  const lower = trimmed.toLowerCase();
  if (lower === "null" || lower === "undefined" || lower === "nan") return "";
  return trimmed;
}

export interface ChannelIdentitySources {
  user?: User | null | undefined;
  profile?: Profile | null | undefined;
  dbUser?: DbUser | null | undefined;
}

/**
 * Resolves the channel display name using a consistent fallback chain:
 * channel_name -> full_name -> name -> username -> email-derived fallback -> fallback
 */
export function resolveChannelDisplayName(
  sources: ChannelIdentitySources,
  fallback = "Creator",
): string {
  const { user, profile, dbUser } = sources;
  const meta = user?.user_metadata as Record<string, unknown> | undefined;

  const emailRaw =
    sanitizeIdentityText(user?.email) ||
    sanitizeIdentityText(profile?.email) ||
    sanitizeIdentityText(dbUser?.email);
  const emailDerived = emailRaw.includes("@") ? emailRaw.split("@")[0]?.trim() || "" : emailRaw;

  const candidates = [
    // 1. Saved channel_name
    profile?.channel_name,
    dbUser?.channel_name,
    meta?.["channel_name"],
    // 2. full_name
    profile?.full_name,
    meta?.["full_name"],
    // 3. name
    profile?.name,
    dbUser?.name,
    meta?.["name"],
    // 4. username
    profile?.username,
    meta?.["username"],
    // 5. email-derived fallback
    emailDerived,
  ];

  for (const candidate of candidates) {
    const clean = sanitizeIdentityText(candidate);
    if (clean) return clean;
  }

  return fallback;
}

/**
 * Resolves the channel avatar/logo URL, checking channel_logo_url first
 * and optionally falling back to avatar_url when channel_logo_url is unavailable.
 */
export function resolveChannelAvatarUrl(
  sources: ChannelIdentitySources,
  options?: { includeAvatarFallback?: boolean },
): string | undefined {
  const { user, profile, dbUser } = sources;
  const meta = user?.user_metadata as Record<string, unknown> | undefined;

  const logoCandidates = [
    profile?.channel_logo_url,
    dbUser?.channel_logo_url,
    meta?.["channel_logo_url"],
  ];

  for (const candidate of logoCandidates) {
    const clean = sanitizeIdentityText(candidate);
    if (clean) {
      const resolved = resolveMediaUrl(clean);
      if (resolved) return resolved;
    }
  }

  if (options?.includeAvatarFallback !== false) {
    const dbUserAvatar = (dbUser as { avatar_url?: string | null } | null | undefined)?.avatar_url;
    const avatarCandidates = [profile?.avatar_url, dbUserAvatar, meta?.["avatar_url"]];
    for (const candidate of avatarCandidates) {
      const clean = sanitizeIdentityText(candidate);
      if (clean) {
        const resolved = resolveMediaUrl(clean);
        if (resolved) return resolved;
      }
    }
  }

  return undefined;
}

export function computeChannelInitials(name: string | null | undefined, fallback = "FT"): string {
  const clean = sanitizeIdentityText(name);
  if (!clean) return fallback;
  const parts = clean.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    const combined = `${parts[0]?.charAt(0) ?? ""}${parts[1]?.charAt(0) ?? ""}`.toUpperCase();
    if (combined) return combined;
  }
  return (clean.slice(0, 2) || fallback).toUpperCase();
}

function updateCachedVideoListForBranding(
  list: unknown[],
  normalizedUserId: string,
  updates: { channelName?: string | null | undefined; channelLogoUrl?: string | null | undefined },
): { updatedList: unknown[]; updatedCount: number } {
  let updatedCount = 0;
  const hasNameUpdate = updates.channelName !== undefined;
  const hasLogoUpdate = updates.channelLogoUrl !== undefined;
  const cleanName = sanitizeIdentityText(updates.channelName);
  const cleanLogo = sanitizeIdentityText(updates.channelLogoUrl);
  const resolvedLogo = cleanLogo ? resolveMediaUrl(cleanLogo) || cleanLogo : "";

  const updatedList = list.map((entry) => {
    if (!entry || typeof entry !== "object") return entry;
    const rec = entry as Record<string, unknown>;
    const recUid = sanitizeIdentityText(rec["userId"] ?? rec["user_id"]).toUpperCase();
    if (!recUid || recUid !== normalizedUserId) {
      return entry;
    }

    const next: Record<string, unknown> = { ...rec };
    if (hasNameUpdate) {
      if (cleanName) {
        next["channelName"] = cleanName;
        next["creatorName"] = cleanName;
        if ("channel_name" in next) next["channel_name"] = cleanName;
        if ("creator_name" in next) next["creator_name"] = cleanName;
      } else {
        delete next["channelName"];
        delete next["channel_name"];
      }
    }
    if (hasLogoUpdate) {
      if (resolvedLogo) {
        next["channelLogoUrl"] = resolvedLogo;
        if ("channel_logo_url" in next) next["channel_logo_url"] = resolvedLogo;
      } else {
        delete next["channelLogoUrl"];
        delete next["channel_logo_url"];
      }
    }
    updatedCount += 1;
    return next;
  });

  return { updatedList, updatedCount };
}

/**
 * Synchronizes channel_name and channel_logo_url on matching owner records in local video caches
 * without altering video metadata, security visibility flags, or unrelated creators' records.
 */
export function syncCachedVideosChannelBranding(params: {
  userId?: string | null | undefined;
  channelName?: string | null | undefined;
  channelLogoUrl?: string | null | undefined;
  storage?: Pick<Storage, "getItem" | "setItem"> | null | undefined;
}): { publicUpdated: number; ownerUpdated: number } {
  const normalizedUserId = sanitizeIdentityText(params.userId).toUpperCase();
  if (!normalizedUserId) {
    return { publicUpdated: 0, ownerUpdated: 0 };
  }

  const storage =
    params.storage !== undefined
      ? params.storage
      : typeof globalThis !== "undefined" && "localStorage" in globalThis
        ? (globalThis as { localStorage?: Pick<Storage, "getItem" | "setItem"> }).localStorage
        : undefined;

  if (!storage) {
    return { publicUpdated: 0, ownerUpdated: 0 };
  }

  let publicUpdated = 0;
  let ownerUpdated = 0;

  const syncKey = (key: string): number => {
    try {
      const raw = storage.getItem(key);
      if (!raw) return 0;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return 0;
      const { updatedList, updatedCount } = updateCachedVideoListForBranding(
        parsed,
        normalizedUserId,
        {
          channelName: params.channelName,
          channelLogoUrl: params.channelLogoUrl,
        },
      );
      if (updatedCount > 0) {
        storage.setItem(key, JSON.stringify(updatedList));
      }
      return updatedCount;
    } catch {
      return 0;
    }
  };

  publicUpdated = syncKey(PUBLIC_VIDEOS_CACHE_KEY);
  ownerUpdated = syncKey(`${OWNER_VIDEOS_CACHE_PREFIX}${normalizedUserId}`);

  return { publicUpdated, ownerUpdated };
}
