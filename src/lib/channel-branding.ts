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
