import { api } from "./api";
import { resolveMediaUrl } from "./media-url";
import { getLocalDbUsers } from "./user-service";
import { getStoredVideos } from "./video-service";
import {
  getUserLedger,
  isAdsPromotionTransaction,
  isDirectReferralTransaction,
  isSettledDirectPremiumCommission,
} from "./ledger-service";

export interface ReferralMemberSummary {
  id: string;
  userId: string;
  name: string;
  channelName?: string | null;
  channelLogoUrl?: string | null;
  email: string;
  mobile: string;
  joinedAt: string;
  status: "Active" | "Pending";
  tier: string;
  freeVideosCount: number;
  premiumVideosCount: number;
  totalVideosCount: number;
  directCommissionEarned: number;
  access: "Granted" | "Restricted";
}

export interface ReferralDashboardData {
  directReferralsCount: number;
  teamMembersCount: number; // MUST be labeled Team Members
  referralIncome: number; // Verified Direct Premium Upload commission in ₹
  directReferralIncome?: number | undefined;
  adsPromotionIncome?: number | undefined;
  pendingReferralIncome?: number | undefined;
  totalReferralIncome?: number | undefined;
  levelCounts?: Record<string, number> | undefined;
  referralCode: string;
  referralNumber: string;
  referralLink: string;
  members: ReferralMemberSummary[];
  isStale?: boolean | undefined;
}

/**
 * Calculates referral network data from the actual database/users/ledger records
 */
export async function getReferralDashboardData(
  currentUserId: string,
): Promise<ReferralDashboardData> {
  const normId = currentUserId.trim().toUpperCase();

  try {
    const res = await api.referrals.getDashboard(normId);
    if (res && res.dashboard) {
      const d = res.dashboard;
      const directIncome = Number(d.directReferralIncome ?? d.referralIncome) || 0;
      const adsIncome = Number(d.adsPromotionIncome) || 0;
      const pendingIncome = Number(d.pendingReferralIncome) || 0;
      const totalIncome =
        d.totalReferralIncome !== undefined
          ? Number(d.totalReferralIncome) || 0
          : Math.round((directIncome + adsIncome) * 100) / 100;
      const refCode = d.referralCode || normId;

      return {
        directReferralsCount: Number(d.directReferralsCount) || 0,
        teamMembersCount: Number(d.teamMembersCount) || 0,
        referralIncome: directIncome,
        directReferralIncome: directIncome,
        adsPromotionIncome: adsIncome,
        pendingReferralIncome: pendingIncome,
        totalReferralIncome: totalIncome,
        levelCounts: d.levelCounts,
        referralCode: refCode,
        referralNumber: d.referralNumber || normId,
        referralLink:
          d.referralLink || `https://facetube.online/auth?ref=${encodeURIComponent(refCode)}`,
        members: (d.members || []).map((m: any) => {
          const rawChannelName =
            typeof (m.channelName ?? m.channel_name) === "string"
              ? String(m.channelName ?? m.channel_name).trim()
              : "";
          const rawName = typeof m.name === "string" ? m.name.trim() : "";
          const channelName = rawChannelName || rawName || "FaceTube Creator";
          const rawLogo = m.channelLogoUrl ?? m.channel_logo_url;
          const channelLogoUrl =
            typeof rawLogo === "string" && rawLogo.trim() !== ""
              ? resolveMediaUrl(rawLogo) || null
              : null;

          return {
            id: m.id,
            userId: m.userId || m.user_id,
            name: m.name,
            channelName,
            channelLogoUrl,
            email: m.email,
            mobile: m.mobile,
            joinedAt: m.joinedAt || m.created_at || "Recent",
            status: m.status || "Active",
            tier: m.tier || "Creator Pro",
            freeVideosCount: Number(m.freeVideosCount) || 0,
            premiumVideosCount: Number(m.premiumVideosCount) || 0,
            totalVideosCount: Number(m.totalVideosCount) || 0,
            directCommissionEarned: Number(m.directCommissionEarned) || 0,
            access: m.access || "Granted",
          };
        }),
        isStale: false,
      };
    }
  } catch (_e) {
    // fallback to local calculation
  }

  const dbUsers = getLocalDbUsers();
  const allVideos = getStoredVideos();
  const ledger = await getUserLedger(normId);

  // Direct referrals: users registered with referral_code matching this user's user_id or verified promotional alias
  const currentUserRecord = dbUsers.find((u) => u.user_id.toUpperCase() === normId);
  const knownAliases: Record<string, string[]> = {
    FT102857: ["FTVIP"],
    FT483921: ["CREATOR50"],
  };
  const mySponsorCodes = new Set([
    normId,
    ...(knownAliases[normId] || []).map((a) => a.toUpperCase()),
  ]);
  const shareCode = knownAliases[normId]?.[0] || normId;

  // Find direct referrals from genuine database / stored users
  const directUsers = dbUsers.filter(
    (u) =>
      u.user_id.toUpperCase() !== normId &&
      Boolean(u.referral_code && mySponsorCodes.has(u.referral_code.toUpperCase())),
  );

  // Calculate multi-level downline across Levels 1–10 for fallback
  const visited = new Set<string>([normId]);
  let currentParents: string[] = [];
  const allDescendantIds = new Set<string>();
  const levelCounts: Record<string, number> = {};
  for (let lvl = 1; lvl <= 10; lvl++) {
    levelCounts[String(lvl)] = 0;
  }

  for (const u of directUsers) {
    const uid = u.user_id.toUpperCase();
    visited.add(uid);
    allDescendantIds.add(uid);
    currentParents.push(uid);
  }
  levelCounts["1"] = directUsers.length;

  for (let lvl = 2; lvl <= 10; lvl++) {
    if (currentParents.length === 0) break;
    const parentCodeSet = new Set<string>();
    for (const pId of currentParents) {
      parentCodeSet.add(pId);
      const aliases = knownAliases[pId] || [];
      for (const a of aliases) {
        parentCodeSet.add(a.toUpperCase());
      }
    }
    const nextLevelUsers = dbUsers.filter((u) => {
      const uid = u.user_id.toUpperCase();
      if (visited.has(uid)) return false;
      const ref = (u.referral_code || "").toUpperCase();
      return Boolean(ref && parentCodeSet.has(ref));
    });
    if (nextLevelUsers.length === 0) break;
    currentParents = [];
    for (const u of nextLevelUsers) {
      const uid = u.user_id.toUpperCase();
      visited.add(uid);
      allDescendantIds.add(uid);
      currentParents.push(uid);
    }
    levelCounts[String(lvl)] = nextLevelUsers.length;
  }

  const teamMembersCount = allDescendantIds.size;

  // Calculate direct commission strictly from settled direct referral ledger entries
  // (excluding pending, failed, and Ads Promotion entries)
  const directCommByMember = new Map<string, number>();
  for (const t of ledger) {
    if (
      !isDirectReferralTransaction(t) ||
      t.status !== "settled" ||
      String(t.transactionId || "")
        .trim()
        .toUpperCase()
        .startsWith("TX_REF_PENDING_")
    ) {
      continue;
    }
    const srcId = String(t.sourceUserId || "")
      .trim()
      .toUpperCase();
    if (!srcId) continue;
    directCommByMember.set(
      srcId,
      Math.round(((directCommByMember.get(srcId) || 0) + (Number(t.amount) || 0)) * 100) / 100,
    );
  }

  const adsPromotionIncome =
    Math.round(
      ledger
        .filter((t) => isAdsPromotionTransaction(t) && t.status === "settled")
        .reduce((acc, curr) => acc + (Number(curr.amount) || 0), 0) * 100,
    ) / 100;

  const pendingReferralIncome =
    Math.round(
      ledger
        .filter(
          (t) =>
            (isDirectReferralTransaction(t) || isAdsPromotionTransaction(t)) &&
            t.status === "pending",
        )
        .reduce((acc, curr) => acc + (Number(curr.amount) || 0), 0) * 100,
    ) / 100;

  // Build member rows from genuine direct users only
  let directCommissionTotal = 0;
  const members: ReferralMemberSummary[] = directUsers.map((m) => {
    const mIdUpper = m.user_id.toUpperCase();
    const memberVideos = allVideos.filter((v) => v.userId.toUpperCase() === mIdUpper);
    const freeCount = memberVideos.filter((v) => v.videoType === "free").length;
    const premiumCount = memberVideos.filter(
      (v) => v.videoType === "premium" && v.paymentStatus === "paid",
    ).length;

    const directComm = Math.round((directCommByMember.get(mIdUpper) || 0) * 100) / 100;
    directCommissionTotal = Math.round((directCommissionTotal + directComm) * 100) / 100;
    const rawChannelName = typeof m.channel_name === "string" ? m.channel_name.trim() : "";
    const channelName = rawChannelName || m.name || "FaceTube Creator";
    const rawLogo = typeof m.channel_logo_url === "string" ? m.channel_logo_url.trim() : "";
    const channelLogoUrl =
      rawLogo !== "" && rawLogo.toLowerCase() !== "null" && rawLogo.toLowerCase() !== "undefined"
        ? resolveMediaUrl(rawLogo) || null
        : null;

    return {
      id: m.id || `mem_${m.user_id}`,
      userId: m.user_id,
      name: m.name,
      channelName,
      channelLogoUrl,
      email: m.email,
      mobile: m.mobile || "",
      joinedAt: m.created_at || "Recent",
      status: "Active",
      tier: m.role === "admin" ? "Admin" : "Creator",
      freeVideosCount: freeCount,
      premiumVideosCount: premiumCount,
      totalVideosCount: freeCount + premiumCount,
      directCommissionEarned: directComm,
      access: "Granted",
    };
  });

  const directReferralsCount = directUsers.length;
  const referralNumber = currentUserRecord?.mobile || "";
  const referralCode = shareCode;
  const referralLink = `https://facetube.online/auth?ref=${encodeURIComponent(referralCode)}`;

  return {
    directReferralsCount,
    teamMembersCount,
    referralIncome: directCommissionTotal,
    directReferralIncome: directCommissionTotal,
    adsPromotionIncome,
    pendingReferralIncome,
    totalReferralIncome: Math.round((directCommissionTotal + adsPromotionIncome) * 100) / 100,
    levelCounts,
    referralCode,
    referralNumber,
    referralLink,
    members,
    isStale: true,
  };
}

export interface TeamMemberSummary {
  id: string;
  userId: string;
  name: string;
  channelName?: string | null;
  channelLogoUrl?: string | null;
  level: number;
  sponsor: string;
  sponsorUserId: string;
  joinedAt: string;
  role: string;
  rank: string;
  teamSize: number;
  status: "Active" | "Inactive";
  access: "Granted" | "Restricted";
}

/**
 * Retrieves multi-level team members (Levels 1–10) from the authenticated API.
 */
export async function getTeamMembers(userId?: string, level?: number | "all") {
  const res = await api.referrals.getTeam(userId, level);
  const normalizedMembers: TeamMemberSummary[] = (res.members || []).map((m) => {
    const rawChannelName =
      typeof (m.channelName ?? m.channel_name) === "string"
        ? String(m.channelName ?? m.channel_name).trim()
        : "";
    const rawName = typeof m.name === "string" ? m.name.trim() : "";
    const channelName = rawChannelName || rawName || "FaceTube Creator";

    const rawLogo = m.channelLogoUrl ?? m.channel_logo_url;
    const trimmedLogo = typeof rawLogo === "string" ? rawLogo.trim() : "";
    const channelLogoUrl =
      trimmedLogo !== "" &&
      trimmedLogo.toLowerCase() !== "null" &&
      trimmedLogo.toLowerCase() !== "undefined"
        ? resolveMediaUrl(trimmedLogo) || null
        : null;

    return {
      id: m.id,
      userId: m.userId,
      name: m.name,
      channelName,
      channelLogoUrl,
      level: m.level,
      sponsor: m.sponsor,
      sponsorUserId: m.sponsorUserId,
      joinedAt: m.joinedAt,
      role: m.role,
      rank: m.rank,
      teamSize: m.teamSize,
      status: m.status,
      access: m.access,
    };
  });

  return {
    ...res,
    members: normalizedMembers,
  };
}

const PENDING_REFERRAL_KEY = "facetube_pending_ref";

/**
 * Persists a referral code from an incoming URL (?ref=...) so attribution
 * survives navigation to /auth or app install/registration.
 */
export function persistPendingReferral(refCode: string | null | undefined) {
  if (typeof window === "undefined" || !refCode) return;
  const cleaned = refCode.trim();
  if (!cleaned) return;
  try {
    localStorage.setItem(PENDING_REFERRAL_KEY, cleaned);
  } catch {
    // ignore storage errors
  }
}

export function getPendingReferral(): string {
  if (typeof window === "undefined") return "";
  try {
    return localStorage.getItem(PENDING_REFERRAL_KEY) || "";
  } catch {
    return "";
  }
}

export function buildVideoSharePayload(params: {
  videoTitle: string;
  videoUrl: string;
  referralCode?: string | null;
  origin?: string;
}) {
  const origin =
    params.origin ||
    (typeof window !== "undefined" ? window.location.origin : "https://facetube.online");
  const code = params.referralCode?.trim();

  if (!code) {
    return {
      title: params.videoTitle,
      url: params.videoUrl,
      text: `Watch "${params.videoTitle}" on FaceTube:\n${params.videoUrl}`,
      referralLink: null as string | null,
    };
  }

  // Append ref to video URL so opening the video preserves referral attribution
  const videoUrlObj = new URL(params.videoUrl, origin);
  videoUrlObj.searchParams.set("ref", code);
  const attributedVideoUrl = videoUrlObj.toString();

  // Personal referral registration link (opens app if installed/configured, else web /auth)
  const referralLink = `${origin}/auth?ref=${encodeURIComponent(code)}`;

  const text = [
    `Watch "${params.videoTitle}" on FaceTube!`,
    `Video: ${attributedVideoUrl}`,
    `Join FaceTube & Download the App with my referral link: ${referralLink}`,
  ].join("\n\n");

  return {
    title: params.videoTitle,
    url: attributedVideoUrl,
    text,
    referralLink,
  };
}
