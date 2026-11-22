import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { Globe2, TrendingUp, CheckCircle2, Wallet } from "lucide-react";
import { VideoHubLayout } from "@/components/videohub/VideoHubLayout";
import { useAuth } from "@/lib/auth-context";
import {
  getUserLedger,
  getUserWallet,
  getEligibleGlobalIncomeUsers,
  type LedgerTransaction,
  type UserWallet,
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

  const [wallet, setWallet] = useState<UserWallet | null>(null);
  const [globalTransactions, setGlobalTransactions] = useState<LedgerTransaction[]>([]);
  const [eligibleCreators, setEligibleCreators] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setIsLoading(true);
    Promise.all([getUserWallet(userId), getUserLedger(userId), getEligibleGlobalIncomeUsers()])
      .then(([w, ledger, eligible]) => {
        if (!active) return;
        setWallet(w);
        setGlobalTransactions(ledger.filter((t) => t.incomeType === "global_income"));
        setEligibleCreators(eligible);
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [userId]);

  const hasLiveWallet = Boolean(wallet && !wallet.isStale);

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
                Automated platform revenue share distributed across eligible Sponsor Video creators
                by ad earnings weight
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

        {/* ------------------------------------------------------------------ */}
        {/* REQUIREMENT 8: SPONSOR VIDEO ALLOCATION OVERVIEW (UNIFORM ₹6 SPLIT)*/}
        {/* ------------------------------------------------------------------ */}
        <div className="rounded-3xl border border-cyan-500/40 bg-gradient-to-br from-cyan-500/10 via-card to-card p-6 shadow-card space-y-5">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-border/70 pb-4">
            <div>
              <span className="text-[11px] font-bold uppercase tracking-wider text-cyan-400">
                Uniform Database-Driven Rule
              </span>
              <h2 className="text-xl font-black text-foreground mt-0.5">
                Sponsor Video Allocation Overview
              </h2>
            </div>
            <span className="text-xs font-semibold text-muted-foreground font-mono">
              Every ₹6.00 transaction
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4 text-xs">
            {/* ₹1.00 Referral */}
            <div className="rounded-2xl border border-border bg-background/60 p-4 space-y-1">
              <span className="text-muted-foreground text-[11px] block">Referral</span>
              <div className="text-xl font-black text-emerald-400">₹1.00</div>
              <p className="text-[11px] text-muted-foreground">
                Direct commission to frontline inviter
              </p>
            </div>

            {/* ₹1.00 Admin */}
            <div className="rounded-2xl border border-border bg-background/60 p-4 space-y-1">
              <span className="text-muted-foreground text-[11px] block">Admin</span>
              <div className="text-xl font-black text-foreground">₹1.00</div>
              <p className="text-[11px] text-muted-foreground">
                Company infrastructure &amp; servers
              </p>
            </div>

            {/* ₹1.00 GST + PG */}
            <div className="rounded-2xl border border-border bg-background/60 p-4 space-y-1">
              <span className="text-muted-foreground text-[11px] block">GST + PG</span>
              <div className="text-xl font-black text-amber-400">₹1.00</div>
              <p className="text-[11px] text-muted-foreground">₹0.90 GST + ₹0.10 PG Fee</p>
            </div>

            {/* ₹3.00 Global Distribution */}
            <div className="rounded-2xl border border-border bg-background/60 p-4 space-y-1">
              <span className="text-muted-foreground text-[11px] block">Global Distribution</span>
              <div className="text-xl font-black text-cyan-400">₹3.00</div>
              <p className="text-[11px] text-muted-foreground">
                Weighted pool for eligible Sponsor videos (held in reserve if none)
              </p>
            </div>

            {/* ₹6.00 Total Transaction */}
            <div className="rounded-2xl border border-cyan-500/40 bg-cyan-500/10 p-4 space-y-1">
              <span className="text-cyan-300 text-[11px] font-semibold block">
                Total Transaction
              </span>
              <div className="text-xl font-black text-foreground">₹6.00</div>
              <p className="text-[11px] text-muted-foreground">Uniform split on every payment</p>
            </div>
          </div>
        </div>

        {/* Financial Highlights */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div className="rounded-2xl border border-border bg-card p-4 space-y-1 shadow-card">
            <span className="text-xs text-muted-foreground font-medium">Your Global Income</span>
            <p className="text-2xl font-black text-cyan-400">
              {isLoading
                ? "Loading..."
                : hasLiveWallet && wallet
                  ? `₹${wallet.globalIncome.toFixed(2)}`
                  : "Unavailable"}
            </p>
            <p className="text-[11px] text-emerald-400 font-semibold flex items-center gap-1">
              <TrendingUp className="h-3 w-3" />{" "}
              {isLoading
                ? "Fetching server balance"
                : hasLiveWallet
                  ? "Eligible creator share"
                  : "Live wallet balance unavailable"}
            </p>
          </div>

          <div className="rounded-2xl border border-border bg-card p-4 space-y-1 shadow-card">
            <span className="text-xs text-muted-foreground font-medium">Eligible Creators</span>
            <p className="text-2xl font-black text-foreground">
              {isLoading ? "Loading..." : eligibleCreators.length}
            </p>
            <p className="text-[11px] text-muted-foreground">Sponsor uploaders only</p>
          </div>

          <div className="rounded-2xl border border-border bg-card p-4 space-y-1 shadow-card">
            <span className="text-xs text-muted-foreground font-medium">Pool Avg / Creator</span>
            <p className="text-2xl font-black text-foreground">
              {isLoading
                ? "Loading..."
                : eligibleCreators.length > 0
                  ? `₹${(3.0 / eligibleCreators.length).toFixed(2)}`
                  : "Unavailable"}
            </p>
            <p className="text-[11px] text-muted-foreground">₹3.00 pool weighted by ad earnings</p>
          </div>

          <div className="rounded-2xl border border-border bg-card p-4 space-y-1 shadow-card">
            <span className="text-xs text-muted-foreground font-medium">Distribution Status</span>
            <p className="text-2xl font-black text-emerald-400">Automated</p>
            <p className="text-[11px] text-muted-foreground">Server ledger synced</p>
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
