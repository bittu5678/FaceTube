import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, useEffect, useMemo } from "react";
import {
  Globe2,
  TrendingUp,
  CheckCircle2,
  Clock,
  AlertCircle,
  Wallet,
  Film,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { VideoHubLayout } from "@/components/videohub/VideoHubLayout";
import { useAuth } from "@/lib/auth-context";
import {
  getUserLedger,
  getGlobalIncomeSummary,
  deduplicateGlobalIncomeTransactions,
  extractGlobalIncomeEntryMeta,
  groupGlobalIncomeTransactions,
  paginateGroupedGlobalIncomeEntries,
  resolveGlobalIncomeSourceMember,
  type GlobalIncomeSummary,
  type GroupedGlobalIncomeEntry,
  type GroupedGlobalIncomeStatus,
  type LedgerTransaction,
} from "@/lib/ledger-service";
import { resolveAuthenticatedUserId } from "@/lib/video-service";

export const Route = createFileRoute("/global-income")({
  head: () => ({
    meta: [
      { title: "Global Income — FaceTube" },
      {
        name: "description",
        content:
          "Worldwide revenue share, database-driven Sponsor Video distributions, and automated creator earnings on FaceTube.",
      },
    ],
  }),
  component: GlobalIncomePage,
});

const PAYMENTS_PER_PAGE = 25;

function renderGlobalTxStatus(
  status: GroupedGlobalIncomeStatus,
  statusCounts?: GroupedGlobalIncomeEntry["statusCounts"],
) {
  const normalized = String(status || "settled")
    .trim()
    .toLowerCase();
  if (normalized === "mixed") {
    const parts: string[] = [];
    if (statusCounts?.settled) parts.push(`${statusCounts.settled} Settled`);
    if (statusCounts?.pending) parts.push(`${statusCounts.pending} Pending`);
    if (statusCounts?.failed) parts.push(`${statusCounts.failed} Failed`);
    return (
      <div className="inline-flex flex-col items-end gap-0.5">
        <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-0.5 text-[10px] font-bold text-amber-400">
          <Clock className="h-3 w-3" />
          Mixed
        </span>
        {parts.length > 0 && (
          <span className="text-[10px] text-muted-foreground font-normal">{parts.join(" · ")}</span>
        )}
      </div>
    );
  }
  if (normalized === "pending") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-0.5 text-[10px] font-bold text-amber-400">
        <Clock className="h-3 w-3" />
        Pending
      </span>
    );
  }
  if (normalized === "failed") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-rose-500/30 bg-rose-500/10 px-2.5 py-0.5 text-[10px] font-bold text-rose-400">
        <AlertCircle className="h-3 w-3" />
        Failed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 text-[10px] font-bold text-emerald-400">
      <CheckCircle2 className="h-3 w-3" />
      Settled
    </span>
  );
}

function GlobalIncomePage() {
  const { profile, dbUser, user } = useAuth();
  const userId = resolveAuthenticatedUserId({ user, profile, dbUser });

  const [summary, setSummary] = useState<GlobalIncomeSummary | null>(null);
  const [globalTransactions, setGlobalTransactions] = useState<LedgerTransaction[]>([]);
  const [currentPage, setCurrentPage] = useState(1);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let active = true;
    if (!userId) {
      setSummary(null);
      setGlobalTransactions([]);
      setCurrentPage(1);
      setIsLoading(false);
      return () => {
        active = false;
      };
    }

    setIsLoading(true);
    setCurrentPage(1);
    Promise.all([getGlobalIncomeSummary(userId), getUserLedger(userId)])
      .then(([summaryRes, ledger]) => {
        if (!active) return;
        setSummary(summaryRes);
        setGlobalTransactions(deduplicateGlobalIncomeTransactions(ledger));
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [userId]);

  const groupedTransactions = useMemo(
    () => groupGlobalIncomeTransactions(globalTransactions),
    [globalTransactions],
  );
  const paginated = useMemo(
    () => paginateGroupedGlobalIncomeEntries(groupedTransactions, currentPage, PAYMENTS_PER_PAGE),
    [groupedTransactions, currentPage],
  );

  const hasLiveSummary = Boolean(summary);

  return (
    <VideoHubLayout>
      <div className="px-4 py-6 sm:px-6 lg:px-8 space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-border pb-4">
          <div className="flex items-center gap-3">
            <div className="grid h-12 w-12 place-items-center rounded-2xl bg-cyan-500/10 text-cyan-400">
              <Globe2 className="h-6 w-6" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-2xl font-extrabold tracking-tight text-foreground sm:text-3xl">
                  Global Income
                </h1>
                <span className="rounded-full border border-cyan-500/30 bg-cyan-500/10 px-2.5 py-0.5 text-[10px] font-bold text-cyan-400">
                  Automated Allocation
                </span>
              </div>
              <p className="text-sm text-muted-foreground">
                Verified creator earnings synchronized directly from the backend ledger
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Link
              to="/wallet-balance"
              className="inline-flex items-center justify-center gap-2 rounded-full bg-brand px-4 py-2 text-xs font-bold text-white shadow-lift transition hover:bg-brand-dark active:scale-95"
            >
              <Wallet className="h-3.5 w-3.5" />
              Transfer to Wallet
            </Link>
          </div>
        </div>

        {/* Total Income Summary Card */}
        <div className="rounded-3xl border border-cyan-500/40 bg-gradient-to-br from-cyan-500/10 via-card to-card p-6 shadow-card">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="space-y-1">
              <span className="text-[11px] font-bold uppercase tracking-wider text-cyan-400">
                Verified Backend Total
              </span>
              <h2 className="text-xl font-black text-foreground">Total Income</h2>
              <p className="text-xs text-emerald-400 font-semibold flex items-center gap-1.5">
                <TrendingUp className="h-3.5 w-3.5" />
                {isLoading
                  ? "Fetching backend total income..."
                  : hasLiveSummary && summary
                    ? "Authoritative server balance"
                    : "Live total income unavailable"}
              </p>
            </div>

            <div className="sm:text-right">
              <p className="text-3xl sm:text-4xl font-black tracking-tight text-cyan-400">
                {isLoading
                  ? "Loading..."
                  : hasLiveSummary && summary
                    ? `₹${summary.personal.totalIncome.toFixed(2)}`
                    : "Unavailable"}
              </p>
            </div>
          </div>
        </div>

        {/* Global Income Ledger Transactions */}
        <div className="rounded-2xl border border-border bg-card overflow-hidden shadow-card">
          <div className="p-4 border-b border-border flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-bold text-foreground">Global Income Ledger Entries</h3>
              <p className="text-xs text-muted-foreground">
                Live database ledger records — video-level payouts from the same Sponsor Video
                payment are combined into one row
              </p>
            </div>
            <span className="text-xs text-muted-foreground font-mono">
              {groupedTransactions.length}{" "}
              {groupedTransactions.length === 1 ? "payment" : "payments"} (
              {globalTransactions.length} {globalTransactions.length === 1 ? "entry" : "entries"})
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-border bg-secondary/40 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 whitespace-nowrap">Transaction / Payment</th>
                  <th className="px-4 py-3 whitespace-nowrap">Rewarded Video</th>
                  <th className="px-4 py-3 whitespace-nowrap">Source Member</th>
                  <th className="px-4 py-3 whitespace-nowrap">Description</th>
                  <th className="px-4 py-3 whitespace-nowrap">Tag / Rule</th>
                  <th className="px-4 py-3 whitespace-nowrap">Date</th>
                  <th className="px-4 py-3 whitespace-nowrap">Amount</th>
                  <th className="px-4 py-3 text-right whitespace-nowrap">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border font-medium">
                {paginated.items.length > 0 ? (
                  paginated.items.map((group) => {
                    const singleEntry = group.entryCount === 1 ? group.entries[0] : undefined;
                    const singleMeta = singleEntry
                      ? extractGlobalIncomeEntryMeta(singleEntry)
                      : null;
                    const sourcePaymentId =
                      group.sourcePaymentId || singleMeta?.sourcePaymentId || null;
                    const settlementBatchId =
                      group.settlementBatchId || singleMeta?.settlementBatchId || null;
                    const rewardedVideoId =
                      group.videoIds[0] || singleMeta?.rewardedVideoId || null;

                    return (
                      <tr key={group.groupKey} className="transition hover:bg-secondary/20">
                        <td className="px-4 py-3 font-mono text-xs text-cyan-400 align-top">
                          <div className="break-all">{group.displayTransactionId}</div>
                          {sourcePaymentId && (
                            <div className="text-[10px] text-muted-foreground mt-0.5">
                              Payment: {sourcePaymentId}
                            </div>
                          )}
                          {settlementBatchId && !sourcePaymentId && (
                            <div className="text-[10px] text-muted-foreground mt-0.5">
                              Batch: {settlementBatchId}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap align-top">
                          {group.videoAllocationCount > 1 ? (
                            <span className="inline-flex items-center gap-1 rounded-md border border-cyan-500/30 bg-cyan-500/10 px-2 py-0.5 text-[10px] font-mono font-bold text-cyan-300">
                              <Film className="h-3 w-3" />
                              {group.videoAllocationCount} video allocations
                            </span>
                          ) : rewardedVideoId ? (
                            <span className="inline-flex items-center gap-1 rounded-md border border-cyan-500/30 bg-cyan-500/10 px-2 py-0.5 text-[10px] font-mono font-bold text-cyan-300">
                              <Film className="h-3 w-3" />#{rewardedVideoId}
                            </span>
                          ) : (
                            <span className="text-muted-foreground text-[11px]">Pool Entry</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-foreground font-bold whitespace-nowrap align-top">
                          {resolveGlobalIncomeSourceMember(group)}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground max-w-md whitespace-normal break-words align-top">
                          {group.description}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap align-top">
                          {group.specialTag ? (
                            <span className="rounded-md bg-purple-500/20 px-2 py-0.5 text-[10px] font-bold text-purple-300 font-mono">
                              {group.specialTag}
                            </span>
                          ) : (
                            <span className="text-muted-foreground text-[11px]">
                              Normal Distribution
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground whitespace-nowrap align-top">
                          {group.createdAt ? new Date(group.createdAt).toLocaleDateString() : "—"}
                        </td>
                        <td className="px-4 py-3 font-mono text-xs font-black text-cyan-400 whitespace-nowrap align-top">
                          +₹{group.amount.toFixed(2)}
                        </td>
                        <td className="px-4 py-3 text-right whitespace-nowrap align-top">
                          {renderGlobalTxStatus(group.status, group.statusCounts)}
                        </td>
                      </tr>
                    );
                  })
                ) : (
                  <tr>
                    <td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">
                      No global income distributions found for this account. Distributions occur
                      automatically when users upload Sponsor Videos.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {paginated.totalPages > 1 && (
            <div className="flex items-center justify-between border-t border-border px-4 py-3 text-xs text-muted-foreground">
              <span>
                Page {paginated.page} of {paginated.totalPages} ({paginated.totalGroups} payments)
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={paginated.page <= 1}
                  onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                  className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 font-medium text-foreground transition hover:bg-secondary/40 disabled:opacity-40"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                  Prev
                </button>
                <button
                  type="button"
                  disabled={paginated.page >= paginated.totalPages}
                  onClick={() => setCurrentPage((p) => Math.min(paginated.totalPages, p + 1))}
                  className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 font-medium text-foreground transition hover:bg-secondary/40 disabled:opacity-40"
                >
                  Next
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </VideoHubLayout>
  );
}
