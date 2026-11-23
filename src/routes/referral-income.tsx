import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import {
  DollarSign,
  Users,
  CheckCircle2,
  Clock,
  Wallet,
  AlertCircle,
  Lock,
  LogIn,
} from "lucide-react";
import { VideoHubLayout } from "@/components/videohub/VideoHubLayout";
import { useAuth } from "@/lib/auth-context";
import { getStoredAuthToken } from "@/lib/api";
import { resolveAuthenticatedUserId } from "@/lib/video-service";
import {
  extractAdsPromotionLevel,
  getUserLedger,
  isAdsPromotionTransaction,
  isDirectReferralTransaction,
  type LedgerTransaction,
} from "@/lib/ledger-service";
import { getReferralDashboardData, type ReferralDashboardData } from "@/lib/referral-service";

export const Route = createFileRoute("/referral-income")({
  head: () => ({
    meta: [
      { title: "Referral Income — FaceTube" },
      {
        name: "description",
        content:
          "Track your verified direct referral earnings, Ads Promotion commissions, and payout ledger records on FaceTube.",
      },
    ],
  }),
  component: ReferralIncomePage,
});

function renderTxStatus(status: LedgerTransaction["status"]) {
  if (status === "settled") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold text-emerald-400">
        <CheckCircle2 className="h-3 w-3" /> Settled
      </span>
    );
  }
  if (status === "pending") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-bold text-amber-400">
        <Clock className="h-3 w-3" /> Pending
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-rose-500/10 px-2 py-0.5 text-[10px] font-bold text-rose-400">
      <AlertCircle className="h-3 w-3" /> Failed
    </span>
  );
}

function ReferralIncomePage() {
  const { profile, dbUser, user, isLoading: isAuthLoading } = useAuth();
  const [hasToken, setHasToken] = useState(false);

  useEffect(() => {
    if (typeof window !== "undefined") {
      setHasToken(Boolean(getStoredAuthToken()));
    }
  }, []);

  const userId = resolveAuthenticatedUserId({ user, profile, dbUser });
  const isAuthenticated = Boolean((user || hasToken) && userId);

  const [referralSummary, setReferralSummary] = useState<ReferralDashboardData | null>(null);
  const [transactions, setTransactions] = useState<LedgerTransaction[]>([]);
  const [categoryFilter, setCategoryFilter] = useState<"all" | "direct" | "ads">("all");
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    if (!isAuthLoading && !isAuthenticated) {
      setReferralSummary(null);
      setTransactions([]);
      setIsLoading(false);
      return;
    }
    if (!userId) return;

    setIsLoading(true);
    async function loadData() {
      try {
        const [refData, txList] = await Promise.all([
          getReferralDashboardData(userId),
          getUserLedger(userId),
        ]);
        if (mounted) {
          setReferralSummary(refData);
          const relevantTxs = txList.filter(
            (t) => isDirectReferralTransaction(t) || isAdsPromotionTransaction(t),
          );
          setTransactions(relevantTxs);
          setIsLoading(false);
        }
      } catch (err) {
        console.error("Failed to load referral income data:", err);
        if (mounted) setIsLoading(false);
      }
    }
    loadData();
    return () => {
      mounted = false;
    };
  }, [userId, isAuthLoading, isAuthenticated]);

  const directTxs = transactions.filter((t) => isDirectReferralTransaction(t));
  const adsTxs = transactions.filter((t) => isAdsPromotionTransaction(t));

  const ledgerSettledDirect =
    Math.round(
      directTxs
        .filter(
          (t) =>
            t.status === "settled" &&
            !String(t.transactionId || "")
              .trim()
              .toUpperCase()
              .startsWith("TX_REF_PENDING_"),
        )
        .reduce((acc, t) => acc + (Number(t.amount) || 0), 0) * 100,
    ) / 100;

  const ledgerSettledAds =
    Math.round(
      adsTxs
        .filter((t) => t.status === "settled")
        .reduce((acc, t) => acc + (Number(t.amount) || 0), 0) * 100,
    ) / 100;

  const pendingTotal =
    Math.round(
      transactions
        .filter((t) => t.status === "pending")
        .reduce((acc, t) => acc + (Number(t.amount) || 0), 0) * 100,
    ) / 100;

  const directCommissionTotal =
    referralSummary && !referralSummary.isStale
      ? Math.round(
          Number(referralSummary.directReferralIncome ?? referralSummary.referralIncome ?? 0) * 100,
        ) / 100
      : ledgerSettledDirect;

  const adsPromotionTotal =
    referralSummary && !referralSummary.isStale
      ? Math.round(Number(referralSummary.adsPromotionIncome ?? 0) * 100) / 100
      : ledgerSettledAds;

  const totalSettledReferralAndAds =
    Math.round((directCommissionTotal + adsPromotionTotal) * 100) / 100;

  const directCount = referralSummary?.directReferralsCount ?? 0;
  const teamCount = referralSummary?.teamMembersCount ?? 0;

  const displayedTransactions = transactions.filter((t) => {
    if (categoryFilter === "direct") return isDirectReferralTransaction(t);
    if (categoryFilter === "ads") return isAdsPromotionTransaction(t);
    return true;
  });

  return (
    <VideoHubLayout>
      <div className="px-4 py-6 sm:px-6 lg:px-8 space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-border pb-4">
          <div className="flex items-center gap-3">
            <div className="grid h-12 w-12 place-items-center rounded-2xl bg-emerald-500/10 text-emerald-400">
              <DollarSign className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-2xl font-extrabold tracking-tight text-foreground sm:text-3xl">
                Referral Income
              </h1>
              <p className="text-sm text-muted-foreground">
                Verified Direct Premium Upload commissions, Ads Promotion overrides, and actual
                ledger statuses
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Link
              to="/referral-members"
              className="inline-flex items-center justify-center gap-2 rounded-full border border-border bg-secondary/80 px-4 py-2 text-xs font-bold text-foreground transition hover:bg-secondary active:scale-95"
            >
              <Users className="h-3.5 w-3.5" />
              Referral Members
            </Link>
            <Link
              to="/wallet-balance"
              className="inline-flex items-center justify-center gap-2 rounded-full bg-brand px-4 py-2 text-xs font-bold text-white shadow-lift transition hover:bg-brand-dark active:scale-95"
            >
              <Wallet className="h-3.5 w-3.5" />
              Wallet Balance
            </Link>
          </div>
        </div>

        {!isAuthLoading && !isAuthenticated ? (
          <div className="rounded-3xl border border-border bg-card p-8 text-center space-y-4 shadow-card">
            <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-brand/10 text-brand">
              <Lock className="h-6 w-6" />
            </div>
            <div className="space-y-1">
              <h2 className="text-lg font-bold text-foreground">Sign in required</h2>
              <p className="text-xs text-muted-foreground max-w-md mx-auto">
                Sign in with your FaceTube creator account to view your referral and Ads Promotion
                income history.
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
            {/* Stats */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div className="rounded-2xl border border-border bg-card p-4 space-y-1 shadow-card">
                <span className="text-xs text-muted-foreground font-medium">
                  Total Settled Referral & Ads
                </span>
                <p className="text-2xl font-black text-emerald-400">
                  {isLoading ? "..." : `₹${totalSettledReferralAndAds.toFixed(2)}`}
                </p>
                <p className="text-[11px] text-amber-400">
                  Pending: ₹{pendingTotal.toFixed(2)} (excluded)
                </p>
              </div>
              <div className="rounded-2xl border border-border bg-card p-4 space-y-1 shadow-card">
                <span className="text-xs text-muted-foreground font-medium">
                  Direct Upload Commission
                </span>
                <p className="text-2xl font-black text-foreground">
                  {isLoading ? "..." : `₹${directCommissionTotal.toFixed(2)}`}
                </p>
                <p className="text-[11px] text-muted-foreground">Verified Sponsor Video uploads</p>
              </div>
              <div className="rounded-2xl border border-border bg-card p-4 space-y-1 shadow-card">
                <span className="text-xs text-muted-foreground font-medium">
                  Ads Promotion Commission
                </span>
                <p className="text-2xl font-black text-sky-400">
                  {isLoading ? "..." : `₹${adsPromotionTotal.toFixed(2)}`}
                </p>
                <p className="text-[11px] text-muted-foreground">Multi-level ad boost overrides</p>
              </div>
              <div className="rounded-2xl border border-border bg-card p-4 space-y-1 shadow-card">
                <span className="text-xs text-muted-foreground font-medium">Network Size</span>
                <p className="text-2xl font-black text-foreground">{directCount} Direct</p>
                <p className="text-[11px] text-muted-foreground">{teamCount} Total team members</p>
              </div>
            </div>

            {/* Transactions Table */}
            <div className="rounded-2xl border border-border bg-card overflow-hidden shadow-card">
              <div className="px-5 py-4 border-b border-border flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-bold text-foreground">
                    Referral & Ads Promotion Ledger
                  </h3>
                  <span className="text-xs text-muted-foreground">
                    Verified audit ledger records with real status and category
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  {(
                    [
                      { key: "all", label: `All (${transactions.length})` },
                      { key: "direct", label: `Direct Upload (${directTxs.length})` },
                      { key: "ads", label: `Ads Promotion (${adsTxs.length})` },
                    ] as const
                  ).map((tab) => (
                    <button
                      key={tab.key}
                      type="button"
                      onClick={() => setCategoryFilter(tab.key)}
                      className={`rounded-full px-3 py-1 text-[11px] font-bold transition ${
                        categoryFilter === tab.key
                          ? "bg-brand text-white"
                          : "border border-border bg-secondary/50 text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-border bg-secondary/40 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                    <tr>
                      <th className="px-4 py-3">Transaction ID</th>
                      <th className="px-4 py-3">Category</th>
                      <th className="px-4 py-3">Source Member</th>
                      <th className="px-4 py-3">Description</th>
                      <th className="px-4 py-3">Date</th>
                      <th className="px-4 py-3">Status</th>
                      <th className="px-4 py-3 text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {displayedTransactions.length > 0 ? (
                      displayedTransactions.map((tx) => {
                        const isAds = isAdsPromotionTransaction(tx);
                        const adsLevel = isAds ? extractAdsPromotionLevel(tx) : null;
                        return (
                          <tr key={tx.id} className="transition hover:bg-secondary/20">
                            <td className="px-4 py-3.5 font-mono text-xs text-amber-400 font-bold">
                              {tx.transactionId}
                            </td>
                            <td className="px-4 py-3.5 whitespace-nowrap">
                              {isAds ? (
                                <span className="inline-flex items-center rounded-full bg-sky-500/10 border border-sky-500/30 px-2 py-0.5 text-[10px] font-bold text-sky-400">
                                  Ads Promotion{adsLevel ? ` · L${adsLevel}` : ""}
                                </span>
                              ) : (
                                <span className="inline-flex items-center rounded-full bg-emerald-500/10 border border-emerald-500/30 px-2 py-0.5 text-[10px] font-bold text-emerald-400">
                                  Direct Upload
                                </span>
                              )}
                            </td>
                            <td className="px-4 py-3.5 font-bold text-foreground">
                              {tx.sourceUserName || tx.sourceUserId || "Referred Creator"}
                            </td>
                            <td className="px-4 py-3.5 text-muted-foreground max-w-xs truncate">
                              {tx.description}
                            </td>
                            <td className="px-4 py-3.5 text-muted-foreground whitespace-nowrap">
                              {new Date(tx.createdAt).toLocaleDateString()}
                            </td>
                            <td className="px-4 py-3.5">{renderTxStatus(tx.status)}</td>
                            <td
                              className={`px-4 py-3.5 text-right font-black text-sm ${
                                tx.status === "settled"
                                  ? "text-emerald-400"
                                  : tx.status === "pending"
                                    ? "text-amber-400"
                                    : "text-rose-400"
                              }`}
                            >
                              +₹{tx.amount.toFixed(2)}
                            </td>
                          </tr>
                        );
                      })
                    ) : (
                      <tr>
                        <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                          {isLoading
                            ? "Loading referral & Ads Promotion transactions..."
                            : "No referral commission transactions yet. Earnings will appear automatically when referred members complete verified paid uploads or ad promotions."}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>
    </VideoHubLayout>
  );
}
