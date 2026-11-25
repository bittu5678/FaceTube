import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { Globe2, TrendingUp, CheckCircle2, Wallet } from "lucide-react";
import { VideoHubLayout } from "@/components/videohub/VideoHubLayout";
import { useAuth } from "@/lib/auth-context";
import {
  getUserLedger,
  getGlobalIncomeSummary,
  type GlobalIncomeSummary,
  type LedgerTransaction,
} from "@/lib/ledger-service";

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

function GlobalIncomePage() {
  const { profile, dbUser, user } = useAuth();
  const userId = profile?.user_id || dbUser?.user_id || user?.email?.split("@")[0] || "FT483921";

  const [summary, setSummary] = useState<GlobalIncomeSummary | null>(null);
  const [globalTransactions, setGlobalTransactions] = useState<LedgerTransaction[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setIsLoading(true);
    Promise.all([getGlobalIncomeSummary(userId), getUserLedger(userId)])
      .then(([summaryRes, ledger]) => {
        if (!active) return;
        setSummary(summaryRes);
        setGlobalTransactions(ledger.filter((t) => !t.isStale && t.incomeType === "global_income"));
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [userId]);

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
          <div className="p-4 border-b border-border flex items-center justify-between">
            <h3 className="text-sm font-bold text-foreground">Global Income Ledger Entries</h3>
            <span className="text-xs text-muted-foreground">Live database ledger records</span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-border bg-secondary/40 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 whitespace-nowrap">Transaction ID</th>
                  <th className="px-4 py-3 whitespace-nowrap">Source Member</th>
                  <th className="px-4 py-3 whitespace-nowrap">Description</th>
                  <th className="px-4 py-3 whitespace-nowrap">Tag / Rule</th>
                  <th className="px-4 py-3 whitespace-nowrap">Amount</th>
                  <th className="px-4 py-3 text-right whitespace-nowrap">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border font-medium">
                {globalTransactions.length > 0 ? (
                  globalTransactions.map((tx) => (
                    <tr key={tx.id} className="transition hover:bg-secondary/20">
                      <td className="px-4 py-3 font-mono text-xs text-cyan-400">
                        {tx.transactionId}
                      </td>
                      <td className="px-4 py-3 text-foreground font-bold">
                        {tx.sourceUserName || tx.sourceUserId || "Global System"}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground max-w-sm truncate">
                        {tx.description}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        {tx.specialTag ? (
                          <span className="rounded-md bg-purple-500/20 px-2 py-0.5 text-[10px] font-bold text-purple-300 font-mono">
                            {tx.specialTag}
                          </span>
                        ) : (
                          <span className="text-muted-foreground text-[11px]">
                            Normal Distribution
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs font-black text-cyan-400">
                        +₹{tx.amount.toFixed(2)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 text-[10px] font-bold text-emerald-400">
                          <CheckCircle2 className="h-3 w-3" />
                          Settled
                        </span>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                      No global income distributions found for this account. Distributions occur
                      automatically when users upload Sponsor Videos.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </VideoHubLayout>
  );
}
