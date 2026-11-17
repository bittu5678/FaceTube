import { createFileRoute, Link } from "@tanstack/react-router";
import {
  Share2,
  TrendingUp,
  DollarSign,
  ExternalLink,
  ShoppingBag,
  MousePointerClick,
  CheckCircle2,
  Copy,
  Check,
  Link2,
  AlertCircle,
  Sparkles,
  Loader2,
  Info,
  ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";
import { VideoHubLayout } from "@/components/videohub/VideoHubLayout";

export const Route = createFileRoute("/affiliate-income")({
  head: () => ({
    meta: [
      { title: "Affiliate Income — FaceTube" },
      {
        name: "description",
        content:
          "Track affiliate sales commissions, sponsored product clicks, and conversion earnings on FaceTube.",
      },
    ],
  }),
  component: AffiliateIncomePage,
});

const affiliateLinks = [
  {
    name: "Sony FX3 Cinema Camera Bundle",
    partner: "B&H Photo Video",
    clicks: "1,420",
    sales: "18",
    rate: "6.0%",
    earned: "₹420.00",
  },
  {
    name: "Shure SM7B Vocal Microphone",
    partner: "Amazon Associates",
    clicks: "3,180",
    sales: "42",
    rate: "4.0%",
    earned: "₹210.80",
  },
  {
    name: "Complete UI/UX Design System Course",
    partner: "FaceTube Academy",
    clicks: "890",
    sales: "26",
    rate: "25.0%",
    earned: "₹310.00",
  },
];

interface SupportedNetwork {
  id: "amazon" | "impact" | "earnkaro";
  name: string;
  tagline: string;
  allowedDomains: string[];
  exampleUrl: string;
  badgeClass: string;
  description: string;
}

const SUPPORTED_AFFILIATE_NETWORKS: SupportedNetwork[] = [
  {
    id: "amazon",
    name: "Amazon Associates",
    tagline: "E-Commerce & Tech",
    allowedDomains: ["amazon.in", "amazon.com", "amzn.to", "amzn.eu", "amzn.asia"],
    exampleUrl: "https://www.amazon.in/dp/B08N5WRWNW",
    badgeClass: "bg-amber-500/10 text-amber-500 border-amber-500/20",
    description: "Earn commissions on physical and digital products across Amazon stores.",
  },
  {
    id: "impact",
    name: "Impact",
    tagline: "Brands & SaaS Gear",
    allowedDomains: ["impact.com", "sjv.io", "ojrq.net", "pxf.io", "evyy.net"],
    exampleUrl: "https://brand.sjv.io/c/12345/67890/1234",
    badgeClass: "bg-purple-500/10 text-purple-400 border-purple-500/20",
    description: "Partner campaigns, camera gear, software tools, and direct brand sponsorships.",
  },
  {
    id: "earnkaro",
    name: "EarnKaro",
    tagline: "Deals & Cashback",
    allowedDomains: ["earnkaro.com", "ekaro.in"],
    exampleUrl: "https://ekaro.in/enkr2026",
    badgeClass: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
    description: "Curated deal recommendations, electronics, fashion, and shopping cashback.",
  },
];

function getDomainValidation(urlStr: string, allowedDomains: string[]) {
  const trimmed = urlStr.trim();
  if (!trimmed) return { status: "empty" as const, message: "" };
  try {
    const parsed = new URL(trimmed);
    const host = parsed.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1") {
      return {
        status: "invalid" as const,
        message: "Localhost or loopback addresses are forbidden.",
      };
    }
    const isAllowed = allowedDomains.some(
      (d) => host === d.toLowerCase() || host.endsWith("." + d.toLowerCase()),
    );
    if (isAllowed) {
      return { status: "valid" as const, host, message: `Approved host: ${host}` };
    }
    return {
      status: "invalid" as const,
      host,
      message: `Host '${host}' is not in approved whitelist (${allowedDomains.join(", ")}).`,
    };
  } catch {
    return {
      status: "invalid" as const,
      message: "Please enter a valid URL with https:// or http://",
    };
  }
}

import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { api } from "@/lib/api";

function AffiliateIncomePage() {
  const { user, profile, dbUser } = useAuth();
  const userId = profile?.user_id || dbUser?.user_id || user?.user_id;
  const [wallet, setWallet] = useState<any>(null);
  const [affiliateTransactions, setAffiliateTransactions] = useState<any[]>([]);
  const [marketingPercentage, setMarketingPercentage] = useState<number>(10);
  const [isLoading, setIsLoading] = useState(true);

  // Affiliate Link Generator State
  const [selectedNetwork, setSelectedNetwork] = useState<"amazon" | "impact" | "earnkaro">(
    "amazon",
  );
  const [targetUrl, setTargetUrl] = useState("");
  const [videoContextId, setVideoContextId] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [copiedLink, setCopiedLink] = useState(false);
  const [generatedLinkData, setGeneratedLinkData] = useState<{
    tracking_url: string;
    relative_tracking_path: string;
    network_name: string;
    creator_user_id: string;
    target_url: string;
    network: string;
  } | null>(null);

  const activeNetworkConfig =
    SUPPORTED_AFFILIATE_NETWORKS.find((n) => n.id === selectedNetwork) ||
    SUPPORTED_AFFILIATE_NETWORKS[0]!;

  const liveValidation = getDomainValidation(targetUrl, activeNetworkConfig.allowedDomains);

  const handleGenerateLink = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!targetUrl.trim()) {
      setGenError("Please enter a valid product destination URL.");
      return;
    }
    if (liveValidation.status === "invalid") {
      setGenError(liveValidation.message);
      return;
    }
    setIsGenerating(true);
    setGenError(null);
    try {
      const genParams: { network: string; target_url: string; video_id?: string } = {
        network: selectedNetwork,
        target_url: targetUrl.trim(),
      };
      if (videoContextId.trim()) {
        genParams.video_id = videoContextId.trim();
      }
      const res = await api.affiliate.generateLink(genParams);
      if (res && res.success && res.tracking_url) {
        setGeneratedLinkData({
          tracking_url: res.tracking_url,
          relative_tracking_path: res.relative_tracking_path,
          network_name: res.network_name || activeNetworkConfig.name,
          creator_user_id: res.creator_user_id,
          target_url: res.target_url,
          network: res.network,
        });
        toast.success("Affiliate tracking link generated successfully!");
      } else {
        setGenError(res?.error || "Failed to generate affiliate tracking link.");
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to generate affiliate link.";
      setGenError(msg);
      toast.error(msg);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleCopyLink = async (urlToCopy: string) => {
    try {
      await navigator.clipboard.writeText(urlToCopy);
      setCopiedLink(true);
      toast.success("Tracking link copied to clipboard!");
      setTimeout(() => setCopiedLink(false), 2500);
    } catch (_err) {
      toast.error("Failed to copy link to clipboard.");
    }
  };

  useEffect(() => {
    let isMounted = true;
    async function loadData() {
      setIsLoading(true);
      try {
        const [wRes, txRes, settingsRes] = await Promise.all([
          api.wallet.getBalance(userId),
          api.wallet.getTransactions(userId, 50),
          api.admin.getSettings().catch(() => null),
        ]);
        if (isMounted) {
          if (wRes && wRes.success && wRes.wallet) {
            setWallet(wRes.wallet);
          }
          if (settingsRes && settingsRes.success && settingsRes.settings) {
            setMarketingPercentage(settingsRes.settings.marketing_income_percentage ?? 10);
          }
          if (txRes && txRes.success && Array.isArray(txRes.transactions)) {
            const filtered = txRes.transactions.filter(
              (t: any) =>
                t.income_type === "affiliate_income" ||
                t.income_type === "marketing_income" ||
                t.incomeType === "affiliate_income" ||
                t.incomeType === "marketing_income" ||
                t.purpose === "affiliate_income" ||
                t.purpose === "marketing_income" ||
                String(t.description || "")
                  .toLowerCase()
                  .includes("affiliate") ||
                String(t.description || "")
                  .toLowerCase()
                  .includes("marketing") ||
                String(t.description || "")
                  .toLowerCase()
                  .includes("ad promotion"),
            );
            setAffiliateTransactions(filtered);
          }
        }
      } catch (err) {
        console.error("Failed to load user Affiliate data:", err);
      } finally {
        if (isMounted) setIsLoading(false);
      }
    }
    loadData();
    return () => {
      isMounted = false;
    };
  }, [userId]);

  const affiliateRevenue = Number(wallet?.affiliate_income ?? 0);
  const totalEarned = Number(wallet?.total_earned ?? 0);
  const walletBalance = Number(wallet?.balance ?? 0);

  return (
    <VideoHubLayout>
      <div className="px-4 py-6 sm:px-6 lg:px-8 space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-border pb-4">
          <div className="flex items-center gap-3">
            <div className="grid h-12 w-12 place-items-center rounded-2xl bg-indigo-500/10 text-indigo-400">
              <Share2 className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-2xl font-extrabold tracking-tight text-foreground sm:text-3xl">
                Affiliate &amp; Marketing Income
              </h1>
              <p className="text-sm text-muted-foreground">
                Commissions earned from Ad Promotion marketing ({marketingPercentage}% platform
                rate), gear recommendations, and campaign referrals backed by your Hostinger ledger.
              </p>
            </div>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div className="rounded-2xl border border-border bg-card p-4 space-y-1 shadow-card">
            <span className="text-xs text-muted-foreground font-medium">
              Total Affiliate Earnings
            </span>
            <p className="text-2xl font-black text-indigo-400">₹{affiliateRevenue.toFixed(2)}</p>
            <p className="text-[11px] text-emerald-400 font-semibold flex items-center gap-1">
              <TrendingUp className="h-3 w-3" /> Authoritative ledger total
            </p>
          </div>
          <div className="rounded-2xl border border-border bg-card p-4 space-y-1 shadow-card">
            <span className="text-xs text-muted-foreground font-medium">Available Balance</span>
            <p className="text-2xl font-black text-foreground">₹{walletBalance.toFixed(2)}</p>
            <p className="text-[11px] text-muted-foreground">Ready for creator withdrawal</p>
          </div>
          <div className="rounded-2xl border border-border bg-card p-4 space-y-1 shadow-card">
            <span className="text-xs text-muted-foreground font-medium">Cumulative Earned</span>
            <p className="text-2xl font-black text-foreground">₹{totalEarned.toFixed(2)}</p>
            <p className="text-[11px] text-muted-foreground">Across all income streams</p>
          </div>
          <div className="rounded-2xl border border-border bg-card p-4 space-y-1 shadow-card">
            <span className="text-xs text-muted-foreground font-medium">Marketing Rate</span>
            <p className="text-2xl font-black text-emerald-400">{marketingPercentage}%</p>
            <p className="text-[11px] text-muted-foreground">Admin platform setting</p>
          </div>
        </div>

        {/* Creator Affiliate Link Generator Section */}
        <div className="rounded-2xl border border-border bg-card p-5 sm:p-6 shadow-card space-y-5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-border pb-4">
            <div>
              <div className="flex items-center gap-2">
                <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand/10 text-brand">
                  <Link2 className="h-4 w-4" />
                </span>
                <h2 className="text-lg font-bold text-foreground">
                  Create Trackable Affiliate Link
                </h2>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Generate personalized, trackable recommendation links for Amazon Associates, Impact,
                and EarnKaro. Outbound clicks redirect directly to the merchant while preserving
                your creator attribution.
              </p>
            </div>
            {userId && (
              <div className="inline-flex items-center gap-1.5 self-start sm:self-auto rounded-full bg-emerald-500/10 border border-emerald-500/20 px-3 py-1 text-xs font-semibold text-emerald-400">
                <ShieldCheck className="h-3.5 w-3.5" />
                <span>Attributed to: {userId}</span>
              </div>
            )}
          </div>

          <form onSubmit={handleGenerateLink} className="space-y-4">
            {/* 1. Network Selector */}
            <div className="space-y-2">
              <label className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                1. Select Affiliate Network
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {SUPPORTED_AFFILIATE_NETWORKS.map((net) => {
                  const isSelected = selectedNetwork === net.id;
                  return (
                    <button
                      key={net.id}
                      type="button"
                      onClick={() => {
                        setSelectedNetwork(net.id);
                        setGenError(null);
                        setGeneratedLinkData(null);
                      }}
                      className={`relative flex flex-col text-left rounded-xl p-3.5 border transition-all ${
                        isSelected
                          ? "border-brand bg-brand/5 ring-2 ring-brand/30 shadow-sm"
                          : "border-border bg-secondary/30 hover:bg-secondary/60 hover:border-border/80"
                      }`}
                    >
                      <div className="flex items-center justify-between w-full">
                        <span className="text-sm font-bold text-foreground">{net.name}</span>
                        {isSelected && <CheckCircle2 className="h-4 w-4 text-brand" />}
                      </div>
                      <span className="text-[11px] text-muted-foreground mt-0.5">
                        {net.tagline}
                      </span>
                      <div className="mt-2 flex flex-wrap gap-1">
                        {net.allowedDomains.slice(0, 3).map((d) => (
                          <span
                            key={d}
                            className="rounded-md bg-secondary px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground"
                          >
                            {d}
                          </span>
                        ))}
                        {net.allowedDomains.length > 3 && (
                          <span className="text-[10px] text-muted-foreground self-center">
                            +{net.allowedDomains.length - 3} more
                          </span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* 2. Destination URL Input */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label
                  htmlFor="affiliate-target-url"
                  className="text-xs font-bold uppercase tracking-wider text-muted-foreground"
                >
                  2. Product / Destination URL
                </label>
                <button
                  type="button"
                  onClick={() => {
                    setTargetUrl(activeNetworkConfig.exampleUrl);
                    setGenError(null);
                  }}
                  className="text-[11px] text-brand hover:underline"
                >
                  Fill Example
                </button>
              </div>

              <div className="relative">
                <input
                  id="affiliate-target-url"
                  type="url"
                  value={targetUrl}
                  onChange={(e) => {
                    setTargetUrl(e.target.value);
                    setGenError(null);
                  }}
                  placeholder={activeNetworkConfig.exampleUrl}
                  className={`w-full rounded-xl border bg-secondary/30 px-3.5 py-2.5 text-xs text-foreground placeholder:text-muted-foreground/60 focus:outline-none transition-all ${
                    liveValidation.status === "valid"
                      ? "border-emerald-500/50 focus:border-emerald-500 ring-1 ring-emerald-500/20"
                      : liveValidation.status === "invalid"
                        ? "border-amber-500/50 focus:border-amber-500 ring-1 ring-amber-500/20"
                        : "border-border focus:border-brand"
                  }`}
                />
              </div>

              {/* Dynamic Validation Feedback */}
              <div className="flex flex-wrap items-center justify-between text-[11px] gap-2 pt-0.5">
                {liveValidation.status === "valid" ? (
                  <span className="flex items-center gap-1 text-emerald-400 font-medium">
                    <CheckCircle2 className="h-3 w-3 shrink-0" />
                    <span>{liveValidation.message}</span>
                  </span>
                ) : liveValidation.status === "invalid" ? (
                  <span className="flex items-center gap-1 text-amber-400 font-medium">
                    <AlertCircle className="h-3 w-3 shrink-0" />
                    <span>{liveValidation.message}</span>
                  </span>
                ) : (
                  <span className="text-muted-foreground">
                    Allowed: {activeNetworkConfig.allowedDomains.join(", ")}
                  </span>
                )}
                <span className="text-muted-foreground/80 italic">
                  SSRF protected &amp; whitelist validated
                </span>
              </div>
            </div>

            {/* 3. Optional Video Context */}
            <div className="space-y-1.5">
              <label
                htmlFor="affiliate-video-id"
                className="text-xs font-semibold text-muted-foreground"
              >
                Attach to Specific Video (Optional)
              </label>
              <input
                id="affiliate-video-id"
                type="text"
                value={videoContextId}
                onChange={(e) => setVideoContextId(e.target.value)}
                placeholder="e.g. vid-sample-001 (optional video ID for conversion analytics)"
                className="w-full rounded-xl border border-border bg-secondary/30 px-3.5 py-2 text-xs text-foreground placeholder:text-muted-foreground/60 focus:border-brand focus:outline-none"
              />
            </div>

            {/* Error Message */}
            {genError && (
              <div className="flex items-start gap-2 rounded-xl bg-destructive/10 border border-destructive/20 p-3 text-xs text-destructive">
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                <div className="flex-1">
                  <p className="font-semibold">{genError}</p>
                </div>
              </div>
            )}

            {/* Action Buttons */}
            <div className="flex items-center gap-3 pt-1">
              <button
                type="submit"
                disabled={isGenerating || !targetUrl.trim()}
                className="inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2.5 text-xs font-bold text-white shadow-lift transition hover:bg-brand/90 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isGenerating ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    <span>Generating Link...</span>
                  </>
                ) : (
                  <>
                    <Link2 className="h-3.5 w-3.5" />
                    <span>Generate Tracking Link</span>
                  </>
                )}
              </button>

              {!userId && (
                <span className="text-xs text-amber-400 flex items-center gap-1">
                  <Info className="h-3.5 w-3.5" /> Please sign in to generate links attributed to
                  your account.
                </span>
              )}
            </div>
          </form>

          {/* Generated Result Box */}
          {generatedLinkData && (
            <div className="rounded-xl border border-brand/30 bg-brand/5 p-4 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                  <span className="text-xs font-bold text-foreground">
                    Personalized {generatedLinkData.network_name} Tracking Link Ready
                  </span>
                </div>
                <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold text-emerald-400">
                  Attributed: {generatedLinkData.creator_user_id}
                </span>
              </div>

              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                <div className="relative flex-1">
                  <input
                    type="text"
                    readOnly
                    value={generatedLinkData.tracking_url}
                    className="w-full rounded-xl border border-border bg-background px-3 py-2 font-mono text-xs text-foreground focus:outline-none"
                    onClick={(e) => (e.target as HTMLInputElement).select()}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => handleCopyLink(generatedLinkData.tracking_url)}
                    className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-foreground text-background px-3.5 py-2 text-xs font-bold hover:opacity-90 transition shadow-sm"
                  >
                    {copiedLink ? (
                      <>
                        <Check className="h-3.5 w-3.5 text-emerald-500" />
                        <span>Copied!</span>
                      </>
                    ) : (
                      <>
                        <Copy className="h-3.5 w-3.5" />
                        <span>Copy Link</span>
                      </>
                    )}
                  </button>

                  <a
                    href={generatedLinkData.tracking_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center justify-center gap-1 rounded-xl border border-border bg-secondary/60 hover:bg-secondary px-3 py-2 text-xs font-medium text-foreground transition"
                    title="Test outbound tracking redirect in a new tab"
                  >
                    <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
                    <span>Test Link</span>
                  </a>
                </div>
              </div>

              <div className="rounded-lg bg-background/60 p-2.5 text-[11px] text-muted-foreground space-y-1">
                <p>
                  <strong className="text-foreground">Destination:</strong>{" "}
                  <span className="break-all font-mono">{generatedLinkData.target_url}</span>
                </p>
                <p>
                  Share this link with your audience. When viewers click, the request logs an
                  attribution click under your creator ID and seamlessly redirects them to the
                  product.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Table */}
        <div className="rounded-2xl border border-border bg-card overflow-hidden shadow-card">
          <div className="px-5 py-4 border-b border-border flex items-center justify-between">
            <div>
              <h3 className="text-sm font-bold text-foreground">
                Authoritative Affiliate &amp; Marketing Transactions
              </h3>
              <p className="text-xs text-muted-foreground">
                Settled in Hostinger MySQL{" "}
                <code className="font-mono text-brand">income_ledger</code>
              </p>
            </div>
            <span className="text-xs text-muted-foreground font-semibold">
              {affiliateTransactions.length} records
            </span>
          </div>

          {isLoading ? (
            <div className="py-12 flex flex-col items-center justify-center gap-2 text-muted-foreground">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-brand border-t-transparent" />
              <p className="text-xs">Loading affiliate ledger...</p>
            </div>
          ) : affiliateTransactions.length === 0 ? (
            <div className="py-12 text-center text-xs text-muted-foreground space-y-2">
              <p>No settled affiliate or marketing transactions recorded yet for this account.</p>
              <p className="text-[11px]">
                Earn {marketingPercentage}% on Ad Promotion campaigns when creators register with
                your sponsor link.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-border bg-secondary/40 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3">Date</th>
                    <th className="px-4 py-3">Transaction ID</th>
                    <th className="px-4 py-3">Description / Campaign</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3 text-right">Net Commission</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {affiliateTransactions.map((tx: any) => (
                    <tr
                      key={tx.id || tx.transactionId || tx.transaction_id}
                      className="transition hover:bg-secondary/20"
                    >
                      <td className="px-4 py-3.5 text-muted-foreground">
                        {tx.created_at || tx.createdAt
                          ? new Date(tx.created_at || tx.createdAt).toLocaleDateString("en-IN", {
                              month: "short",
                              day: "numeric",
                              year: "numeric",
                            })
                          : "Settled"}
                      </td>
                      <td className="px-4 py-3.5 font-mono text-foreground font-bold">
                        {tx.transaction_id || tx.transactionId || tx.id}
                      </td>
                      <td className="px-4 py-3.5 text-muted-foreground">
                        {tx.description || "Ad Promotion Affiliate Commission"}
                      </td>
                      <td className="px-4 py-3.5">
                        <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold text-emerald-400">
                          {tx.status || "settled"}
                        </span>
                      </td>
                      <td className="px-4 py-3.5 text-right font-black text-indigo-400 text-sm font-mono">
                        +₹{Number(tx.amount || 0).toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </VideoHubLayout>
  );
}
