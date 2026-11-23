import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, useEffect, useCallback } from "react";
import {
  TrendingUp,
  Layers,
  Award,
  Users,
  ArrowUpRight,
  AlertCircle,
  RefreshCw,
  LogIn,
  Lock,
  Info,
  Clock,
  CheckCircle2,
} from "lucide-react";
import { VideoHubLayout } from "@/components/videohub/VideoHubLayout";
import { useAuth } from "@/lib/auth-context";
import { api, getStoredAuthToken } from "@/lib/api";
import { resolveAuthenticatedUserId } from "@/lib/video-service";
import {
  extractAdsPromotionLevel,
  getUserLedger,
  isAdsPromotionTransaction,
  isDirectReferralTransaction,
  isSettledDirectPremiumCommission,
  type LedgerTransaction,
} from "@/lib/ledger-service";
import { getReferralDashboardData, getTeamMembers } from "@/lib/referral-service";
import { calculateRankFromSubscribers } from "@/lib/certificate-service";

export const Route = createFileRoute("/team-income")({
  head: () => ({
    meta: [
      { title: "Team Income — FaceTube" },
      {
        name: "description",
        content:
          "Track your verified referral commissions, 7-level Ads Promotion overrides, and team network hierarchy on FaceTube.",
      },
    ],
  }),
  component: TeamIncomePage,
});

interface LevelSummary {
  level: number;
  label: string;
  membersCount: number;
  adsIncome: number;
  adsTxCount: number;
  directIncome: number;
}

function TeamIncomePage() {
  const { user, profile, dbUser, isLoading: isAuthLoading } = useAuth();
  const [hasToken, setHasToken] = useState(false);

  useEffect(() => {
    if (typeof window !== "undefined") {
      setHasToken(Boolean(getStoredAuthToken()));
    }
  }, []);

  const userId = resolveAuthenticatedUserId({ user, profile, dbUser });
  const isAuthenticated = Boolean((user || hasToken) && userId);

  const [isLoading, setIsLoading] = useState(true);
  const [apiError, setApiError] = useState<string | null>(null);
  const [isSessionExpired, setIsSessionExpired] = useState(false);
  const [isStale, setIsStale] = useState(false);

  const [directIncome, setDirectIncome] = useState(0);
  const [adsPromotionIncome, setAdsPromotionIncome] = useState(0);
  const [pendingReferralIncome, setPendingReferralIncome] = useState(0);
  const [globalPoolIncome, setGlobalPoolIncome] = useState(0);
  const [totalTeamCount, setTotalTeamCount] = useState(0);
  const [directCount, setDirectCount] = useState(0);
  const [levelCounts, setLevelCounts] = useState<Record<number, number>>({});
  const [adsByLevel, setAdsByLevel] = useState<Record<number, { amount: number; count: number }>>(
    {},
  );
  const [unleveledAdsIncome, setUnleveledAdsIncome] = useState(0);
  const [subscriberCount, setSubscriberCount] = useState<number | null>(null);

  const loadTeamIncome = useCallback(async () => {
    if (!userId) {
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setApiError(null);
    setIsSessionExpired(false);

    try {
      const [teamRes, dashRes, ledgerRes, subRes] = await Promise.allSettled([
        getTeamMembers(undefined),
        getReferralDashboardData(userId),
        getUserLedger(userId),
        api.channel.getSubscriberCount(userId),
      ]);

      // Check authentication failure on primary team API
      if (teamRes.status === "rejected") {
        const err = teamRes.reason as { status?: number; message?: string };
        const msg = err?.message || "Failed to load authenticated team data.";
        if (
          err?.status === 401 ||
          msg.toLowerCase().includes("authentication required") ||
          msg.toLowerCase().includes("session token")
        ) {
          setIsSessionExpired(true);
          setApiError(
            "Your authentication session has expired. Please sign in again to view team earnings.",
          );
          setIsLoading(false);
          return;
        }
        setApiError(msg);
      }

      const countsMap: Record<number, number> = {};
      if (teamRes.status === "fulfilled" && teamRes.value?.success) {
        setTotalTeamCount(Number(teamRes.value.totalTeamCount) || 0);
        setDirectCount(Number(teamRes.value.directCount) || 0);
        if (teamRes.value.levelCounts) {
          for (const [k, v] of Object.entries(teamRes.value.levelCounts)) {
            countsMap[Number(k)] = Number(v) || 0;
          }
        }
      } else if (dashRes.status === "fulfilled") {
        setTotalTeamCount(dashRes.value.teamMembersCount);
        setDirectCount(dashRes.value.directReferralsCount);
        if (dashRes.value.levelCounts) {
          for (const [k, v] of Object.entries(dashRes.value.levelCounts)) {
            countsMap[Number(k)] = Number(v) || 0;
          }
        }
      }
      setLevelCounts(countsMap);

      const ledgerList: LedgerTransaction[] =
        ledgerRes.status === "fulfilled" && Array.isArray(ledgerRes.value) ? ledgerRes.value : [];

      const ledgerDirectSettled = ledgerList
        .filter((tx) => isSettledDirectPremiumCommission(tx))
        .reduce((sum, tx) => sum + (Number(tx.amount) || 0), 0);

      const settledAdsTxs = ledgerList.filter(
        (tx) => isAdsPromotionTransaction(tx) && tx.status === "settled",
      );
      const ledgerAdsSettled = settledAdsTxs.reduce((sum, tx) => sum + (Number(tx.amount) || 0), 0);

      const levelMap: Record<number, { amount: number; count: number }> = {};
      let otherAds = 0;
      for (const tx of settledAdsTxs) {
        const lvl = extractAdsPromotionLevel(tx);
        const amt = Number(tx.amount) || 0;
        if (lvl !== null) {
          const prev = levelMap[lvl] || { amount: 0, count: 0 };
          levelMap[lvl] = {
            amount: Math.round((prev.amount + amt) * 100) / 100,
            count: prev.count + 1,
          };
        } else {
          otherAds = Math.round((otherAds + amt) * 100) / 100;
        }
      }
      setAdsByLevel(levelMap);
      setUnleveledAdsIncome(otherAds);

      const ledgerPending = ledgerList
        .filter(
          (tx) =>
            (isDirectReferralTransaction(tx) || isAdsPromotionTransaction(tx)) &&
            tx.status === "pending",
        )
        .reduce((sum, tx) => sum + (Number(tx.amount) || 0), 0);

      const ledgerGlobal = ledgerList
        .filter((tx) => tx.incomeType === "global_income" && tx.status === "settled")
        .reduce((sum, tx) => sum + (Number(tx.amount) || 0), 0);
      setGlobalPoolIncome(Math.round(ledgerGlobal * 100) / 100);

      if (dashRes.status === "fulfilled") {
        const dash = dashRes.value;
        setIsStale(Boolean(dash.isStale));
        setDirectIncome(
          Math.round(
            Number(dash.directReferralIncome ?? dash.referralIncome ?? ledgerDirectSettled) * 100,
          ) / 100,
        );
        setAdsPromotionIncome(
          Math.round(Number(dash.adsPromotionIncome ?? ledgerAdsSettled) * 100) / 100,
        );
        setPendingReferralIncome(
          Math.round(Number(dash.pendingReferralIncome ?? ledgerPending) * 100) / 100,
        );
      } else {
        setIsStale(true);
        setDirectIncome(Math.round(ledgerDirectSettled * 100) / 100);
        setAdsPromotionIncome(Math.round(ledgerAdsSettled * 100) / 100);
        setPendingReferralIncome(Math.round(ledgerPending * 100) / 100);
      }

      if (subRes.status === "fulfilled" && subRes.value?.success) {
        setSubscriberCount(Number(subRes.value.subscriber_count) || 0);
      } else {
        setSubscriberCount(null);
      }
    } catch (err) {
      setApiError(err instanceof Error ? err.message : "Failed to load team income data.");
    } finally {
      setIsLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    if (!isAuthLoading) {
      if (isAuthenticated) {
        loadTeamIncome();
      } else {
        setIsLoading(false);
      }
    }
  }, [isAuthLoading, isAuthenticated, loadTeamIncome]);

  const totalVerifiedTeamAndReferral = Math.round((directIncome + adsPromotionIncome) * 100) / 100;
  const rankInfo = subscriberCount !== null ? calculateRankFromSubscribers(subscriberCount) : null;

  const adsLevels: LevelSummary[] = [1, 2, 3, 4, 5, 6, 7].map((level) => ({
    level,
    label: level === 1 ? "Level 1 (Direct Referrals)" : `Level ${level}`,
    membersCount: levelCounts[level] ?? 0,
    adsIncome: adsByLevel[level]?.amount ?? 0,
    adsTxCount: adsByLevel[level]?.count ?? 0,
    directIncome: level === 1 ? directIncome : 0,
  }));

  const deepLevelMembers = (levelCounts[8] ?? 0) + (levelCounts[9] ?? 0) + (levelCounts[10] ?? 0);

  return (
    <VideoHubLayout>
      <div className="px-4 py-6 sm:px-6 lg:px-8 space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-border pb-4">
          <div className="flex items-center gap-3">
            <div className="grid h-12 w-12 place-items-center rounded-2xl bg-brand/10 text-brand">
              <TrendingUp className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-2xl font-extrabold tracking-tight text-foreground sm:text-3xl">
                Team Income
              </h1>
              <p className="text-sm text-muted-foreground">
                Verified Direct Premium Upload commissions, 7-level Ads Promotion overrides, and
                downline breakdown
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Link
              to="/team-members"
              className="inline-flex items-center justify-center gap-2 rounded-full border border-border bg-secondary/80 px-4 py-2 text-xs font-bold text-foreground transition hover:bg-secondary active:scale-95"
            >
              <Users className="h-3.5 w-3.5" />
              Team Members
            </Link>
            <Link
              to="/direct-referral-income"
              className="inline-flex items-center justify-center gap-2 rounded-full bg-brand px-4 py-2 text-xs font-bold text-white shadow-lift transition hover:bg-brand-dark active:scale-95"
            >
              Direct Income
              <ArrowUpRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </div>

        {/* Unauthenticated State */}
        {!isAuthLoading && !isAuthenticated ? (
          <div className="rounded-3xl border border-border bg-card p-8 text-center space-y-4 shadow-card">
            <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-brand/10 text-brand">
              <Lock className="h-6 w-6" />
            </div>
            <div className="space-y-1">
              <h2 className="text-lg font-bold text-foreground">Sign in required</h2>
              <p className="text-xs text-muted-foreground max-w-md mx-auto">
                Sign in with your FaceTube creator account to view your authenticated team network,
                verified referral commissions, and level-by-level ledger breakdown.
              </p>
            </div>
            <Link
              to="/auth"
              className="inline-flex items-center gap-2 rounded-full bg-brand px-5 py-2.5 text-xs font-bold text-white shadow-lift transition hover:bg-brand-dark"
            >
              <LogIn className="h-4 w-4" />
              Sign In
            </Link>
          </div>
        ) : (
          <>
            {apiError && (
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-2xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-xs text-rose-300">
                <div className="flex items-center gap-2">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  <span>{apiError}</span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {isSessionExpired ? (
                    <Link
                      to="/auth"
                      className="rounded-lg bg-rose-500 px-3 py-1.5 font-bold text-white hover:bg-rose-600 transition"
                    >
                      Sign In Again
                    </Link>
                  ) : (
                    <button
                      type="button"
                      onClick={loadTeamIncome}
                      className="inline-flex items-center gap-1 rounded-lg border border-rose-500/40 px-3 py-1.5 font-bold hover:bg-rose-500/20 transition"
                    >
                      <RefreshCw className="h-3 w-3" />
                      Retry
                    </button>
                  )}
                </div>
              </div>
            )}

            {isStale && !apiError && (
              <div className="flex items-center gap-2 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-300">
                <AlertCircle className="h-4 w-4 shrink-0" />
                <span>
                  Live referral summary could not be refreshed from the server. Showing cached
                  settled ledger figures only.
                </span>
              </div>
            )}

            {/* Highlight Cards */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div className="rounded-2xl border border-border bg-card p-4 space-y-1 shadow-card">
                <span className="text-xs text-muted-foreground font-medium">
                  Verified Team & Referral Income
                </span>
                <p className="text-2xl font-black text-emerald-400">
                  {isLoading ? "..." : `₹${totalVerifiedTeamAndReferral.toFixed(2)}`}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  Direct ₹{directIncome.toFixed(2)} + Ads Promo ₹{adsPromotionIncome.toFixed(2)}
                </p>
              </div>

              <div className="rounded-2xl border border-border bg-card p-4 space-y-1 shadow-card">
                <span className="text-xs text-muted-foreground font-medium">
                  7-Level Ads Promotion Income
                </span>
                <p className="text-2xl font-black text-sky-400">
                  {isLoading ? "..." : `₹${adsPromotionIncome.toFixed(2)}`}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  Across {totalTeamCount} team members ({directCount} direct)
                </p>
              </div>

              <Link
                to="/my-certificate"
                className="rounded-2xl border border-amber-500/30 bg-card p-4 space-y-1 shadow-card hover:border-amber-500/60 transition group"
              >
                <span className="text-xs text-muted-foreground font-medium flex items-center justify-between">
                  <span>Current Creator Rank</span>
                  <Award className="h-3.5 w-3.5 text-amber-400 group-hover:scale-110 transition-transform" />
                </span>
                <p className="text-xl font-black text-amber-400">
                  {isLoading ? "..." : rankInfo ? rankInfo.awardName : "Unavailable"}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  {subscriberCount !== null
                    ? `${subscriberCount.toLocaleString()} channel subscribers`
                    : "Subscriber count unavailable"}
                </p>
              </Link>

              <div className="rounded-2xl border border-border bg-card p-4 space-y-1 shadow-card">
                <span className="text-xs text-muted-foreground font-medium">
                  Monthly Team Volume
                </span>
                <p className="text-xl font-black text-muted-foreground">Unavailable</p>
                <p className="text-[11px] text-muted-foreground flex items-center gap-1">
                  <Info className="h-3 w-3 shrink-0" />
                  Not supported by backend ledger
                </p>
              </div>
            </div>

            {/* Multi-Level Verified Breakdown */}
            <div className="rounded-2xl border border-border bg-card p-6 space-y-4 shadow-card">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div>
                  <h2 className="text-base font-extrabold text-foreground flex items-center gap-2">
                    <Layers className="h-4 w-4 text-brand" />
                    Multi-Level Network & Settled Earnings Breakdown
                  </h2>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Actual downline member counts and settled ledger commissions by tier (Levels
                    1–7)
                  </p>
                </div>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-3 py-1 text-xs font-bold text-emerald-400 self-start sm:self-auto">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  Verified Settled Ledger
                </span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 pt-2">
                {adsLevels.map((tier) => (
                  <div
                    key={tier.level}
                    className="rounded-xl border border-border bg-secondary/30 p-4 space-y-2 relative overflow-hidden"
                  >
                    <div className="flex items-center justify-between">
                      <span className="rounded-md bg-brand/20 px-2 py-0.5 text-[10px] font-black text-brand uppercase">
                        Level {tier.level}
                      </span>
                      <span className="text-[11px] font-semibold text-muted-foreground">
                        {tier.adsTxCount} ads {tier.adsTxCount === 1 ? "credit" : "credits"}
                      </span>
                    </div>

                    <div className="space-y-0.5 pt-1">
                      <div className="text-lg font-black text-foreground">
                        {isLoading ? "..." : `₹${tier.adsIncome.toFixed(2)}`}
                      </div>
                      <div className="text-[11px] text-muted-foreground">Settled Ads Promotion</div>
                      {tier.level === 1 && (
                        <div className="text-[11px] font-semibold text-emerald-400 pt-0.5">
                          + Direct Upload: ₹{tier.directIncome.toFixed(2)}
                        </div>
                      )}
                    </div>

                    <div className="border-t border-border/50 pt-2 text-[11px] text-muted-foreground flex justify-between">
                      <span>Members at Level {tier.level}:</span>
                      <strong className="text-foreground">
                        {isLoading ? "..." : tier.membersCount}
                      </strong>
                    </div>
                  </div>
                ))}

                {/* Pending / Deep Levels Summary Tile */}
                <div className="rounded-xl border border-border bg-secondary/20 p-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="rounded-md bg-amber-500/20 px-2 py-0.5 text-[10px] font-black text-amber-400 uppercase">
                      Pending & Summary
                    </span>
                    <Clock className="h-3.5 w-3.5 text-amber-400" />
                  </div>
                  <div className="space-y-0.5 pt-1">
                    <div className="text-lg font-black text-amber-400">
                      {isLoading ? "..." : `₹${pendingReferralIncome.toFixed(2)}`}
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      Pending referral entries (excluded from settled totals)
                    </div>
                    {unleveledAdsIncome > 0 && (
                      <div className="text-[11px] text-sky-400 pt-0.5">
                        Other Ads Promo: ₹{unleveledAdsIncome.toFixed(2)}
                      </div>
                    )}
                  </div>
                  <div className="border-t border-border/50 pt-2 text-[11px] text-muted-foreground flex justify-between">
                    <span>Levels 8–10 Members:</span>
                    <strong className="text-foreground">
                      {isLoading ? "..." : deepLevelMembers}
                    </strong>
                  </div>
                </div>
              </div>
            </div>

            {/* Honest Unavailable State for Unsupported Rank Pool / Team Volume Metrics */}
            <div className="rounded-2xl border border-border bg-secondary/20 p-6 space-y-3 shadow-card">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="flex items-start gap-3">
                  <div className="grid h-9 w-9 place-items-center rounded-xl bg-secondary text-muted-foreground shrink-0">
                    <Info className="h-5 w-5" />
                  </div>
                  <div className="space-y-1">
                    <h3 className="text-sm font-bold text-foreground">
                      Team Volume & Rank Bonus Pool — Unavailable
                    </h3>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      Monthly team sales volume and rank-based bonus pool percentages are not
                      tracked or paid by any backend ledger rule. Only verified settled Direct
                      Premium Upload commissions (₹1 per verified ₹6 upload), 7-Level Ads Promotion
                      commissions, and Global Pool distributions are active and counted.
                    </p>
                  </div>
                </div>
                <div className="rounded-xl border border-border bg-card px-4 py-2.5 text-right shrink-0">
                  <span className="block text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                    Verified Global Pool
                  </span>
                  <span className="text-sm font-black text-cyan-400">
                    {isLoading ? "..." : `₹${globalPoolIncome.toFixed(2)}`}
                  </span>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </VideoHubLayout>
  );
}
