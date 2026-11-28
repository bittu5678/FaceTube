import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState, useEffect, useCallback, useRef } from "react";
import {
  Clapperboard,
  Radio,
  Check,
  Users,
  Crown,
  Sparkles,
  ShieldCheck,
  Loader2,
  Lock,
  ArrowRight,
  Star,
  CheckCircle2,
  AlertCircle,
  Calendar,
  Clock,
  CreditCard,
  History,
  RotateCcw,
  Copy,
  ExternalLink,
  ShieldAlert,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { VideoHubLayout } from "@/components/videohub/VideoHubLayout";
import { ChannelAvatar } from "@/components/videohub/ChannelAvatar";
import { VideoCard } from "@/components/videohub/VideoCard";
import type { Video } from "@/data/videos";
import {
  convertUploadedToCatalogVideo,
  deriveCreatorsFromVideos,
  fetchUploadedVideos,
  isPubliclyCacheableVideo,
  type DerivedCreator,
} from "@/lib/video-service";
import { useAuth } from "@/lib/auth-context";
import { api } from "@/lib/api";
import { initiatePaidSubscriptionPayment, preloadRazorpayScript } from "@/lib/razorpay-service";

export const Route = createFileRoute("/subscriptions")({
  head: () => ({
    meta: [
      { title: "Subscriptions & Memberships — FaceTube" },
      {
        name: "description",
        content:
          "Subscribe to your favorite channels, unlock verified FaceTube Creator Memberships, and manage your active subscriptions and payment history.",
      },
    ],
  }),
  component: SubscriptionsPage,
});

export interface SubscriberPlan {
  id: string | number;
  plan_id: string;
  name: string;
  price: number;
  duration_days: number;
  perks: string[];
  is_active: boolean;
  created_at?: string;
}

export interface UserSubscriptionItem {
  subscriptionId: string;
  userId: string;
  planId: string;
  planName: string;
  orderId: string;
  paymentId: string;
  amount: number;
  currency: string;
  status: string;
  isExpired: boolean;
  remainingDays: number;
  startsAt: string;
  expiresAt: string;
  createdAt?: string;
}

export interface UserRefundRequest {
  id: string;
  subscriptionId: string;
  userId: string;
  userName: string;
  userEmail: string;
  planId: string;
  planName: string;
  paymentId: string;
  orderId: string;
  amount: number;
  currency: string;
  reason: string;
  status: "pending" | "approved" | "rejected" | "processing" | "refunded";
  gatewayStatus: string;
  gatewayRefundId?: string | null;
  adminNote?: string | null;
  reviewedBy?: string | null;
  reviewedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

// Fallback baseline plans matching Phase 2A database seed
const DEFAULT_PLANS: SubscriberPlan[] = [
  {
    id: 1,
    plan_id: "member-monthly",
    name: "Creator Member",
    price: 49,
    duration_days: 30,
    perks: [
      "Custom channel member badge",
      "Early access to new videos",
      "Exclusive member-only live stream chat",
    ],
    is_active: true,
    created_at: "2026-11-04 00:00:00",
  },
  {
    id: 2,
    plan_id: "member-vip-monthly",
    name: "VIP Supporter",
    price: 149,
    duration_days: 30,
    perks: [
      "All Creator Member perks",
      "Priority comment replies",
      "Exclusive behind-the-scenes content",
      "VIP live badge",
    ],
    is_active: true,
    created_at: "2026-11-04 00:00:00",
  },
  {
    id: 3,
    plan_id: "member-annual",
    name: "All-Access Annual",
    price: 999,
    duration_days: 365,
    perks: [
      "All VIP Supporter perks",
      "365 days uninterrupted access",
      "Golden verified supporter badge",
      "VIP live stream superchats",
    ],
    is_active: true,
    created_at: "2026-11-04 00:00:00",
  },
];

function SubscriptionsPage() {
  const navigate = useNavigate();
  const { user } = useAuth();

  // Navigation tab: "plans" (Explore plans & channel feed) vs "my" (My Subscriptions & Payment History)
  const [activeTab, setActiveTab] = useState<"plans" | "my">(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      return params.get("tab") === "my" ? "my" : "plans";
    }
    return "plans";
  });

  const [selectedFilter, setSelectedFilter] = useState<"All" | "Today" | "Live" | "Continue">(
    "All",
  );
  const [selectedCreator, setSelectedCreator] = useState<string | null>(null);
  const [channelVideos, setChannelVideos] = useState<Video[]>([]);
  const [channelCreators, setChannelCreators] = useState<DerivedCreator[]>([]);

  useEffect(() => {
    let active = true;
    fetchUploadedVideos()
      .then((uploaded) => {
        if (!active) return;
        const publicUploads = uploaded.filter(isPubliclyCacheableVideo);
        setChannelVideos(publicUploads.map(convertUploadedToCatalogVideo));
        setChannelCreators(deriveCreatorsFromVideos(publicUploads));
      })
      .catch(() => {
        if (!active) return;
        setChannelVideos([]);
        setChannelCreators([]);
      });
    return () => {
      active = false;
    };
  }, []);

  // Subscriber Plans state
  const [plans, setPlans] = useState<SubscriberPlan[]>(DEFAULT_PLANS);
  const [isLoadingPlans, setIsLoadingPlans] = useState<boolean>(true);
  const [subscribingPlanId, setSubscribingPlanId] = useState<string | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const isSubscribingRef = useRef<boolean>(false);

  // Phase 2D: My Subscriptions & History state
  const [activeSubscription, setActiveSubscription] = useState<UserSubscriptionItem | null>(null);
  const [subscriptionHistory, setSubscriptionHistory] = useState<UserSubscriptionItem[]>([]);
  const [isLoadingSubscriptions, setIsLoadingSubscriptions] = useState<boolean>(false);
  const [subscriptionsError, setSubscriptionsError] = useState<string | null>(null);

  // Phase 2F: User Refund Request state
  const [userRefundRequests, setUserRefundRequests] = useState<UserRefundRequest[]>([]);
  const [selectedSubForRefund, setSelectedSubForRefund] = useState<UserSubscriptionItem | null>(
    null,
  );
  const [refundReason, setRefundReason] = useState<string>("");
  const [isSubmittingRefund, setIsSubmittingRefund] = useState<boolean>(false);
  const [refundError, setRefundError] = useState<string | null>(null);

  // Fetch authenticated user's submitted refund requests
  const fetchRefundRequests = useCallback(async () => {
    if (!user) {
      setUserRefundRequests([]);
      return;
    }
    try {
      const res = await api.subscriptions.getRefundRequests();
      if (res?.success && Array.isArray(res.requests)) {
        setUserRefundRequests(res.requests as UserRefundRequest[]);
      } else {
        setUserRefundRequests([]);
      }
    } catch (_err) {
      setUserRefundRequests([]);
    }
  }, [user]);

  // Locates existing refund request for a specific subscription or payment
  const getExistingRefund = useCallback(
    (subId?: string, paymentId?: string): UserRefundRequest | undefined => {
      if (!subId && !paymentId) return undefined;
      return userRefundRequests.find(
        (r) =>
          (subId && (r.subscriptionId === subId || r.id === subId)) ||
          (paymentId && r.paymentId === paymentId),
      );
    },
    [userRefundRequests],
  );

  const openRefundDialog = (sub: UserSubscriptionItem) => {
    setSelectedSubForRefund(sub);
    setRefundReason("");
    setRefundError(null);
  };

  const closeRefundDialog = () => {
    if (isSubmittingRefund) return;
    setSelectedSubForRefund(null);
    setRefundReason("");
    setRefundError(null);
  };

  const handleSubmitRefund = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedSubForRefund) return;

    const trimmed = refundReason.trim();
    if (trimmed.length < 5) {
      setRefundError("Please provide a detailed reason (minimum 5 characters).");
      return;
    }
    if (trimmed.length > 1000) {
      setRefundError("Reason must not exceed 1000 characters.");
      return;
    }

    setIsSubmittingRefund(true);
    setRefundError(null);

    try {
      const targetId = selectedSubForRefund.subscriptionId || selectedSubForRefund.paymentId;
      const res = await api.subscriptions.requestRefund({
        subscriptionId: targetId,
        reason: trimmed,
      });

      if (res && res.success) {
        toast.success(
          res.message ||
            "Refund request submitted successfully. It will be reviewed by an administrator.",
        );
        setSelectedSubForRefund(null);
        setRefundReason("");
        await Promise.all([fetchUserSubscriptions(), fetchRefundRequests()]);
      } else {
        const msg = res?.error || "Failed to submit refund request.";
        setRefundError(msg);
        toast.error(msg);
      }
    } catch (err: any) {
      const msg = err?.data?.error || err?.message || "Failed to submit refund request.";
      setRefundError(msg);
      toast.error(msg);
    } finally {
      setIsSubmittingRefund(false);
    }
  };

  // Fetch active plans catalog from backend API
  const fetchPlans = useCallback(async () => {
    setIsLoadingPlans(true);
    try {
      const res = await api.subscriptions.listPlans();
      if (res?.success && Array.isArray(res.plans) && res.plans.length > 0) {
        setPlans(res.plans.filter((p) => p.is_active));
      } else {
        setPlans(DEFAULT_PLANS);
      }
    } catch (_err) {
      setPlans(DEFAULT_PLANS);
    } finally {
      setIsLoadingPlans(false);
    }
  }, []);

  // Fetch authenticated user's active subscription and previous history
  const fetchUserSubscriptions = useCallback(async () => {
    if (!user) {
      setActiveSubscription(null);
      setSubscriptionHistory([]);
      setIsLoadingSubscriptions(false);
      setSubscriptionsError(null);
      return;
    }

    setIsLoadingSubscriptions(true);
    setSubscriptionsError(null);

    try {
      const res = await api.subscriptions.getMy();
      if (res?.success) {
        const active = (res.activeSubscription ||
          res.subscription ||
          null) as UserSubscriptionItem | null;
        setActiveSubscription(active);
        setSubscriptionHistory(
          Array.isArray(res.history) ? (res.history as UserSubscriptionItem[]) : [],
        );
      } else {
        // Fallback to getActive endpoint
        const actRes = await api.subscriptions.getActive();
        if (actRes?.hasActiveSubscription && actRes.subscription) {
          setActiveSubscription(actRes.subscription as any);
        } else {
          setActiveSubscription(null);
        }
        setSubscriptionHistory([]);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to load user subscriptions.";
      setSubscriptionsError(msg);
    } finally {
      setIsLoadingSubscriptions(false);
    }
  }, [user]);

  useEffect(() => {
    preloadRazorpayScript();
    fetchPlans();
    if (user) {
      fetchUserSubscriptions();
      fetchRefundRequests();
    } else {
      setActiveSubscription(null);
      setSubscriptionHistory([]);
      setUserRefundRequests([]);
    }
  }, [user, fetchPlans, fetchUserSubscriptions, fetchRefundRequests]);

  // Handle URL tab changes if user navigates back/forward
  useEffect(() => {
    const handlePopState = () => {
      const params = new URLSearchParams(window.location.search);
      setActiveTab(params.get("tab") === "my" ? "my" : "plans");
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const switchTab = (tab: "plans" | "my") => {
    setActiveTab(tab);
    if (typeof window !== "undefined" && window.history) {
      const url = tab === "my" ? "/subscriptions?tab=my" : "/subscriptions";
      window.history.pushState({}, "", url);
    }
  };

  const copyToClipboard = (text: string, label: string) => {
    if (navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(text);
      toast.success(`${label} copied to clipboard!`);
    }
  };

  // Handle subscribe action (Phase 2C checkout)
  const handleSubscribe = async (plan: SubscriberPlan) => {
    if (isSubscribingRef.current || subscribingPlanId) return;

    if (!user || !user.id) {
      toast.error("Please sign in to subscribe to a membership plan.", {
        description: "An active FaceTube account is required to activate membership perks.",
        action: {
          label: "Sign In",
          onClick: () => navigate({ to: "/auth" }),
        },
      });
      return;
    }

    if (activeSubscription?.status === "active" && activeSubscription.planId === plan.plan_id) {
      toast.info(`You already have an active ${plan.name} subscription.`, {
        description: `Expires on ${new Date(activeSubscription.expiresAt).toLocaleDateString()}.`,
      });
      return;
    }

    isSubscribingRef.current = true;
    setCheckoutError(null);
    setSubscribingPlanId(plan.plan_id);
    preloadRazorpayScript();

    try {
      const effectiveUserId = user.user_metadata?.user_id || user.id;
      const effectiveUserName =
        user.user_metadata?.full_name ||
        user.user_metadata?.name ||
        user.email?.split("@")[0] ||
        "FaceTube Member";

      const paymentParams: {
        userId: string;
        userName?: string;
        userEmail?: string;
        userMobile?: string;
        planId: string;
        planName?: string;
        onSuccess: (result: {
          paymentId: string;
          orderId: string;
          subscription?: any;
          message?: string;
        }) => void;
        onFailure: (errorMsg: string) => void;
        onCancel?: () => void;
      } = {
        userId: effectiveUserId,
        userName: effectiveUserName,
        planId: plan.plan_id,
        planName: plan.name,
        onSuccess: async (result) => {
          isSubscribingRef.current = false;
          setSubscribingPlanId(null);
          setCheckoutError(null);
          toast.success(`🎉 Subscription Activated! Welcome to ${plan.name}!`, {
            description: `Payment ID: ${result.paymentId}. Your membership perks have been successfully unlocked.`,
            duration: 6000,
          });
          // Refresh subscriptions and switch to My Subscriptions tab
          await fetchUserSubscriptions();
          switchTab("my");
        },
        onFailure: (errorMsg) => {
          isSubscribingRef.current = false;
          setSubscribingPlanId(null);
          const msg = errorMsg || "Payment verification failed. Please try again.";
          setCheckoutError(msg);
          toast.error(msg);
        },
        onCancel: () => {
          isSubscribingRef.current = false;
          setSubscribingPlanId(null);
          toast.info("Payment cancelled. Your subscription was not activated.");
        },
      };
      if (user.email) {
        paymentParams.userEmail = user.email;
      }
      if (user.user_metadata?.mobile) {
        paymentParams.userMobile = user.user_metadata.mobile;
      }

      await initiatePaidSubscriptionPayment(paymentParams);
    } catch (err: unknown) {
      isSubscribingRef.current = false;
      setSubscribingPlanId(null);
      const msg = err instanceof Error ? err.message : "Could not initialize checkout.";
      setCheckoutError(msg);
      toast.error(msg);
    }
  };

  const filteredVideos = channelVideos.filter((v) => {
    if (selectedCreator) {
      return v.channel === selectedCreator;
    }
    return true;
  });

  return (
    <VideoHubLayout>
      <div className="px-4 py-6 sm:px-6 lg:px-8 space-y-6 max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-border pb-4">
          <div className="flex items-center gap-3">
            <div className="grid h-12 w-12 place-items-center rounded-2xl bg-brand/10 text-brand">
              <Clapperboard className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-2xl font-extrabold tracking-tight text-foreground sm:text-3xl">
                Subscriptions & Memberships
              </h1>
              <p className="text-sm text-muted-foreground">
                Support creators, unlock exclusive badges, and manage your active memberships
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => switchTab("my")}
              className={`inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-xs font-semibold transition ${
                activeTab === "my"
                  ? "bg-brand text-white border-brand shadow-sm"
                  : "border-border bg-secondary/80 text-foreground hover:bg-secondary"
              }`}
            >
              <ShieldCheck className="h-3.5 w-3.5" />
              <span>My Subscriptions</span>
              {activeSubscription && (
                <span className="rounded-full bg-emerald-500/20 px-1.5 py-0.2 text-[10px] font-bold text-emerald-400">
                  Active
                </span>
              )}
            </button>
            <Link
              to="/live"
              className="inline-flex items-center gap-1.5 rounded-full bg-red-500/10 px-3.5 py-1.5 text-xs font-bold text-red-500 transition hover:bg-red-500/20"
            >
              <Radio className="h-3.5 w-3.5" />
              Live Now
            </Link>
          </div>
        </div>

        {/* Primary Navigation Tabs */}
        <div className="flex items-center gap-2 border-b border-border/80 pb-2">
          <button
            type="button"
            onClick={() => switchTab("plans")}
            className={`inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-xs sm:text-sm font-bold transition-all ${
              activeTab === "plans"
                ? "bg-brand text-white shadow-sm"
                : "text-muted-foreground hover:bg-secondary hover:text-foreground"
            }`}
          >
            <Crown className="h-4 w-4" />
            <span>Membership Plans & Feeds</span>
          </button>

          <button
            type="button"
            onClick={() => switchTab("my")}
            className={`inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-xs sm:text-sm font-bold transition-all ${
              activeTab === "my"
                ? "bg-brand text-white shadow-sm"
                : "text-muted-foreground hover:bg-secondary hover:text-foreground"
            }`}
          >
            <ShieldCheck className="h-4 w-4" />
            <span>My Subscriptions & History</span>
            {activeSubscription && (
              <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] font-black uppercase tracking-wider text-emerald-300">
                Active
              </span>
            )}
          </button>
        </div>

        {/* ============================================================== */}
        {/* VIEW 1: MY SUBSCRIPTIONS & PAYMENT HISTORY (Phase 2D)         */}
        {/* ============================================================== */}
        {activeTab === "my" && (
          <div className="space-y-8 animate-fadeIn">
            {/* Top Bar with Refresh & Title */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-secondary/30 rounded-2xl p-4 border border-border/60">
              <div>
                <h2 className="text-lg sm:text-xl font-extrabold text-foreground flex items-center gap-2">
                  <ShieldCheck className="h-5 w-5 text-brand" />
                  My FaceTube Subscriptions
                </h2>
                <p className="text-xs sm:text-sm text-muted-foreground mt-0.5">
                  View your current membership perks, validity period, and verified payment records.
                </p>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={fetchUserSubscriptions}
                  disabled={isLoadingSubscriptions}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-1.5 text-xs font-semibold text-foreground transition hover:bg-secondary disabled:opacity-50"
                >
                  <RotateCcw
                    className={`h-3.5 w-3.5 ${isLoadingSubscriptions ? "animate-spin text-brand" : ""}`}
                  />
                  <span>Refresh</span>
                </button>

                <button
                  type="button"
                  onClick={() => switchTab("plans")}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-brand px-3 py-1.5 text-xs font-bold text-white transition hover:bg-brand/90"
                >
                  <Crown className="h-3.5 w-3.5" />
                  <span>Browse Plans</span>
                </button>
              </div>
            </div>

            {/* Error State */}
            {subscriptionsError && (
              <div className="rounded-2xl border border-destructive/30 bg-destructive/10 p-5 text-destructive">
                <div className="flex items-start gap-3">
                  <AlertCircle className="h-5 w-5 shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <h3 className="font-bold text-sm">Could not load subscriptions</h3>
                    <p className="text-xs text-muted-foreground mt-0.5">{subscriptionsError}</p>
                    <button
                      type="button"
                      onClick={fetchUserSubscriptions}
                      className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-destructive px-3 py-1 text-xs font-semibold text-destructive-foreground hover:bg-destructive/90"
                    >
                      <RotateCcw className="h-3 w-3" />
                      Try Again
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Loading State */}
            {isLoadingSubscriptions && (
              <div className="space-y-4">
                <div className="rounded-2xl border border-border bg-card p-6 space-y-4 animate-pulse">
                  <div className="h-6 w-48 bg-muted rounded-md" />
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    <div className="h-16 bg-muted rounded-xl" />
                    <div className="h-16 bg-muted rounded-xl" />
                    <div className="h-16 bg-muted rounded-xl" />
                  </div>
                </div>
              </div>
            )}

            {/* Unauthenticated State */}
            {!isLoadingSubscriptions && !user && (
              <div className="rounded-2xl border border-border bg-card p-8 text-center max-w-lg mx-auto space-y-4 shadow-sm">
                <div className="grid h-14 w-14 place-items-center rounded-2xl bg-brand/10 text-brand mx-auto">
                  <Lock className="h-7 w-7" />
                </div>
                <div>
                  <h3 className="text-lg font-bold text-foreground">Sign In Required</h3>
                  <p className="text-xs sm:text-sm text-muted-foreground mt-1">
                    Please log in to your FaceTube account to view your active channel
                    subscriptions, membership status, and payment receipts.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => navigate({ to: "/auth" })}
                  className="inline-flex items-center justify-center gap-2 rounded-xl bg-brand px-5 py-2.5 text-xs font-bold text-white transition hover:bg-brand/90"
                >
                  <span>Sign In Now</span>
                  <ArrowRight className="h-4 w-4" />
                </button>
              </div>
            )}

            {/* Authenticated Content */}
            {!isLoadingSubscriptions && user && (
              <div className="space-y-8">
                {/* 1. Active Subscription Card */}
                <section aria-labelledby="active-subscription-heading" className="space-y-3">
                  <h3
                    id="active-subscription-heading"
                    className="text-base sm:text-lg font-bold text-foreground flex items-center gap-2"
                  >
                    <Crown className="h-5 w-5 text-amber-500" />
                    Active Membership
                  </h3>

                  {activeSubscription ? (
                    <div className="rounded-2xl border border-emerald-500/40 bg-gradient-to-br from-emerald-500/10 via-card to-card p-6 shadow-sm relative overflow-hidden space-y-6">
                      {/* Top Header Row */}
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-border/60 pb-5">
                        <div className="flex items-start gap-4">
                          <div className="grid h-12 w-12 place-items-center rounded-2xl bg-emerald-500/20 text-emerald-400 shrink-0">
                            <ShieldCheck className="h-7 w-7" />
                          </div>
                          <div>
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="rounded-full bg-emerald-500/20 px-2.5 py-0.5 text-[11px] font-black uppercase tracking-wider text-emerald-400">
                                {activeSubscription.status.toUpperCase()}
                              </span>
                              <h4 className="text-xl font-extrabold text-foreground">
                                {activeSubscription.planName || activeSubscription.planId}
                              </h4>
                            </div>
                            <p className="text-xs text-muted-foreground mt-1">
                              Subscription ID:{" "}
                              <span className="font-mono text-foreground font-semibold">
                                {activeSubscription.subscriptionId}
                              </span>
                            </p>
                          </div>
                        </div>

                        {/* Remaining Days Counter */}
                        <div className="flex items-center gap-3 bg-secondary/80 rounded-xl px-4 py-2 border border-border/70 shrink-0">
                          <Clock className="h-4 w-4 text-emerald-400" />
                          <div>
                            <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                              Validity Status
                            </div>
                            <div className="text-sm font-extrabold text-foreground">
                              {activeSubscription.remainingDays > 0 ? (
                                <span className="text-emerald-400">
                                  {activeSubscription.remainingDays}{" "}
                                  {activeSubscription.remainingDays === 1 ? "Day" : "Days"}{" "}
                                  Remaining
                                </span>
                              ) : (
                                <span className="text-amber-500">Expires Today</span>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Details Grid: Amount, Dates, Payment ID, Order ID */}
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                        {/* Amount Paid */}
                        <div className="rounded-xl border border-border/70 bg-card/60 p-4 space-y-1">
                          <div className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                            <CreditCard className="h-3.5 w-3.5 text-brand" />
                            Amount Paid
                          </div>
                          <div className="text-xl font-black text-foreground">
                            ₹{Number(activeSubscription.amount).toFixed(2)}
                          </div>
                          <div className="text-[11px] text-muted-foreground">
                            Currency: {activeSubscription.currency || "INR"} (Non-refundable)
                          </div>
                        </div>

                        {/* Started On */}
                        <div className="rounded-xl border border-border/70 bg-card/60 p-4 space-y-1">
                          <div className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                            <Calendar className="h-3.5 w-3.5 text-blue-400" />
                            Start Date
                          </div>
                          <div className="text-sm font-bold text-foreground">
                            {new Date(activeSubscription.startsAt).toLocaleDateString(undefined, {
                              year: "numeric",
                              month: "short",
                              day: "numeric",
                            })}
                          </div>
                          <div className="text-[11px] text-muted-foreground">
                            {new Date(activeSubscription.startsAt).toLocaleTimeString([], {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </div>
                        </div>

                        {/* Expiry Date */}
                        <div className="rounded-xl border border-border/70 bg-card/60 p-4 space-y-1">
                          <div className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                            <Clock className="h-3.5 w-3.5 text-amber-400" />
                            Expiry Date
                          </div>
                          <div className="text-sm font-bold text-foreground">
                            {new Date(activeSubscription.expiresAt).toLocaleDateString(undefined, {
                              year: "numeric",
                              month: "short",
                              day: "numeric",
                            })}
                          </div>
                          <div className="text-[11px] text-muted-foreground">
                            {new Date(activeSubscription.expiresAt).toLocaleTimeString([], {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </div>
                        </div>

                        {/* Payment ID */}
                        <div className="rounded-xl border border-border/70 bg-card/60 p-4 space-y-1">
                          <div className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground flex items-center justify-between">
                            <span>Payment ID</span>
                            <button
                              type="button"
                              onClick={() =>
                                copyToClipboard(activeSubscription.paymentId, "Payment ID")
                              }
                              className="text-muted-foreground hover:text-foreground"
                              title="Copy Payment ID"
                            >
                              <Copy className="h-3 w-3" />
                            </button>
                          </div>
                          <div className="font-mono text-xs font-semibold text-foreground truncate">
                            {activeSubscription.paymentId}
                          </div>
                          <div className="text-[10px] text-muted-foreground truncate">
                            Order: {activeSubscription.orderId}
                          </div>
                        </div>
                      </div>

                      {/* Included Perks for this Plan */}
                      {plans.find((p) => p.plan_id === activeSubscription.planId) && (
                        <div className="rounded-xl border border-border/60 bg-secondary/30 p-4 space-y-2.5">
                          <div className="text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                            <Star className="h-3.5 w-3.5 text-amber-500 fill-amber-500" />
                            Unlocked Perks & Benefits
                          </div>
                          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                            {plans
                              .find((p) => p.plan_id === activeSubscription.planId)!
                              .perks.map((perk, idx) => (
                                <div
                                  key={idx}
                                  className="flex items-center gap-2 text-xs text-foreground/90 bg-card/50 rounded-lg p-2 border border-border/40"
                                >
                                  <Check className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                                  <span>{perk}</span>
                                </div>
                              ))}
                          </div>
                        </div>
                      )}

                      {/* Active Subscription Refund Status or Request Button */}
                      {(() => {
                        const existingRefund = getExistingRefund(
                          activeSubscription.subscriptionId,
                          activeSubscription.paymentId,
                        );
                        const isRefunded =
                          activeSubscription.status === "refunded" ||
                          existingRefund?.status === "refunded";

                        return (
                          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-3 border-t border-border/60">
                            <div className="text-xs">
                              {existingRefund ? (
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                                    Refund Status:
                                  </span>
                                  {existingRefund.status === "pending" && (
                                    <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 border border-amber-500/30 px-2.5 py-0.5 text-xs font-bold text-amber-500">
                                      <Clock className="h-3 w-3" />
                                      Request Pending Administrator Review
                                    </span>
                                  )}
                                  {existingRefund.status === "approved" && (
                                    <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-500/10 border border-blue-500/30 px-2.5 py-0.5 text-xs font-bold text-blue-500">
                                      <CheckCircle2 className="h-3 w-3" />
                                      Approved by Admin (Disbursement:{" "}
                                      {existingRefund.gatewayStatus})
                                    </span>
                                  )}
                                  {existingRefund.status === "refunded" && (
                                    <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/30 px-2.5 py-0.5 text-xs font-bold text-emerald-400">
                                      <RotateCcw className="h-3 w-3" />
                                      Refund Processed{" "}
                                      {existingRefund.gatewayRefundId
                                        ? `(${existingRefund.gatewayRefundId})`
                                        : ""}
                                    </span>
                                  )}
                                  {existingRefund.status === "rejected" && (
                                    <span className="inline-flex items-center gap-1.5 rounded-full bg-destructive/10 border border-destructive/30 px-2.5 py-0.5 text-xs font-bold text-destructive">
                                      <AlertCircle className="h-3 w-3" />
                                      Request Rejected
                                    </span>
                                  )}
                                </div>
                              ) : isRefunded ? (
                                <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/30 px-2.5 py-0.5 text-xs font-bold text-emerald-400">
                                  <RotateCcw className="h-3 w-3" />
                                  Subscription Refunded
                                </span>
                              ) : (
                                <span className="text-muted-foreground text-[11px]">
                                  Need assistance with this membership? You can submit an
                                  administrative refund request.
                                </span>
                              )}
                            </div>

                            {!existingRefund && !isRefunded && (
                              <button
                                type="button"
                                onClick={() => openRefundDialog(activeSubscription)}
                                className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-secondary/50 px-3.5 py-1.5 text-xs font-bold text-foreground transition hover:bg-secondary shrink-0 cursor-pointer"
                              >
                                <RotateCcw className="h-3.5 w-3.5 text-amber-500" />
                                <span>Request Refund</span>
                              </button>
                            )}
                          </div>
                        );
                      })()}
                    </div>
                  ) : (
                    /* Empty Active Subscription State */
                    <div className="rounded-2xl border border-border bg-card p-8 text-center space-y-4 shadow-sm">
                      <div className="grid h-12 w-12 place-items-center rounded-2xl bg-secondary text-muted-foreground mx-auto">
                        <ShieldAlert className="h-6 w-6" />
                      </div>
                      <div className="max-w-md mx-auto">
                        <h4 className="text-base font-bold text-foreground">
                          No Active Subscription
                        </h4>
                        <p className="text-xs sm:text-sm text-muted-foreground mt-1">
                          You currently do not have an active creator membership. Support your
                          favorite channels and unlock custom badges, priority replies, and
                          exclusive content.
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => switchTab("plans")}
                        className="inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2 text-xs font-bold text-white transition hover:bg-brand/90"
                      >
                        <Crown className="h-3.5 w-3.5" />
                        <span>Explore Membership Plans</span>
                      </button>
                    </div>
                  )}
                </section>

                {/* 2. Previous / Expired Subscriptions History Section */}
                <section aria-labelledby="subscription-history-heading" className="space-y-3">
                  <div className="flex items-center justify-between">
                    <h3
                      id="subscription-history-heading"
                      className="text-base sm:text-lg font-bold text-foreground flex items-center gap-2"
                    >
                      <History className="h-5 w-5 text-muted-foreground" />
                      Subscription Payment History
                    </h3>
                    <span className="text-xs text-muted-foreground">
                      {subscriptionHistory.length}{" "}
                      {subscriptionHistory.length === 1 ? "past record" : "past records"}
                    </span>
                  </div>

                  {subscriptionHistory.length > 0 ? (
                    <div className="rounded-2xl border border-border bg-card overflow-hidden shadow-sm">
                      <div className="overflow-x-auto">
                        <table className="w-full text-left text-xs">
                          <thead className="bg-secondary/60 text-muted-foreground font-semibold border-b border-border">
                            <tr>
                              <th className="py-3 px-4">Plan Name</th>
                              <th className="py-3 px-4">Amount</th>
                              <th className="py-3 px-4">Period</th>
                              <th className="py-3 px-4">Payment ID</th>
                              <th className="py-3 px-4">Status</th>
                              <th className="py-3 px-4 text-right">Refund Action</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-border/60">
                            {subscriptionHistory.map((item) => {
                              const existing = getExistingRefund(
                                item.subscriptionId,
                                item.paymentId,
                              );
                              const isRefunded =
                                item.status === "refunded" || existing?.status === "refunded";

                              return (
                                <tr
                                  key={item.subscriptionId || item.paymentId}
                                  className="hover:bg-secondary/20 transition-colors"
                                >
                                  <td className="py-3.5 px-4 font-bold text-foreground">
                                    <div className="flex items-center gap-2">
                                      <Clapperboard className="h-3.5 w-3.5 text-brand shrink-0" />
                                      <span>{item.planName || item.planId}</span>
                                    </div>
                                  </td>
                                  <td className="py-3.5 px-4 font-extrabold text-foreground">
                                    ₹{Number(item.amount).toFixed(2)}
                                  </td>
                                  <td className="py-3.5 px-4 text-muted-foreground">
                                    <span>
                                      {new Date(item.startsAt).toLocaleDateString(undefined, {
                                        month: "short",
                                        day: "numeric",
                                        year: "numeric",
                                      })}
                                    </span>
                                    {" → "}
                                    <span>
                                      {new Date(item.expiresAt).toLocaleDateString(undefined, {
                                        month: "short",
                                        day: "numeric",
                                        year: "numeric",
                                      })}
                                    </span>
                                  </td>
                                  <td className="py-3.5 px-4 font-mono text-[11px] text-muted-foreground">
                                    <div className="flex items-center gap-1.5">
                                      <span>{item.paymentId}</span>
                                      <button
                                        type="button"
                                        onClick={() =>
                                          copyToClipboard(item.paymentId, "Payment ID")
                                        }
                                        className="text-muted-foreground hover:text-foreground cursor-pointer"
                                        title="Copy Payment ID"
                                      >
                                        <Copy className="h-3 w-3" />
                                      </button>
                                    </div>
                                  </td>
                                  <td className="py-3.5 px-4">
                                    <span className="rounded-full bg-secondary px-2.5 py-0.5 text-[10px] font-bold text-muted-foreground uppercase tracking-wider">
                                      {item.status.toUpperCase()}
                                    </span>
                                  </td>
                                  <td className="py-3.5 px-4 text-right">
                                    {existing ? (
                                      existing.status === "pending" ? (
                                        <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2.5 py-0.5 text-[10px] font-bold text-amber-500">
                                          <Clock className="h-3 w-3" />
                                          Pending Review
                                        </span>
                                      ) : existing.status === "approved" ? (
                                        <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/10 px-2.5 py-0.5 text-[10px] font-bold text-blue-500">
                                          <CheckCircle2 className="h-3 w-3" />
                                          Approved
                                        </span>
                                      ) : existing.status === "refunded" ? (
                                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-[10px] font-bold text-emerald-400">
                                          <RotateCcw className="h-3 w-3" />
                                          Refunded
                                        </span>
                                      ) : (
                                        <span className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2.5 py-0.5 text-[10px] font-bold text-destructive">
                                          <AlertCircle className="h-3 w-3" />
                                          Rejected
                                        </span>
                                      )
                                    ) : isRefunded ? (
                                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-[10px] font-bold text-emerald-400">
                                        <RotateCcw className="h-3 w-3" />
                                        Refunded
                                      </span>
                                    ) : (
                                      <button
                                        type="button"
                                        onClick={() => openRefundDialog(item)}
                                        className="inline-flex items-center gap-1 rounded-lg border border-border bg-background px-2.5 py-1 text-[11px] font-semibold text-foreground hover:bg-secondary transition cursor-pointer"
                                      >
                                        <RotateCcw className="h-3 w-3 text-amber-500" />
                                        <span>Request Refund</span>
                                      </button>
                                    )}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ) : (
                    /* Empty History State */
                    <div className="rounded-2xl border border-dashed border-border/80 bg-card/40 p-6 text-center space-y-2">
                      <History className="h-6 w-6 text-muted-foreground mx-auto" />
                      <p className="text-xs sm:text-sm font-semibold text-muted-foreground">
                        No previous subscription history found.
                      </p>
                      <p className="text-[11px] text-muted-foreground">
                        Expired or past membership terms and payment transaction receipts will
                        appear here automatically.
                      </p>
                    </div>
                  )}
                </section>
              </div>
            )}
          </div>
        )}

        {/* ============================================================== */}
        {/* VIEW 2: PLANS CATALOG & FEED (Phase 2A, 2B, 2C)               */}
        {/* ============================================================== */}
        {activeTab === "plans" && (
          <div className="space-y-8 animate-fadeIn">
            {/* Active Membership Banner (if user has active subscription) */}
            {activeSubscription && activeSubscription.status === "active" && (
              <div
                id="active-subscription-banner"
                className="rounded-2xl border border-emerald-500/30 bg-gradient-to-r from-emerald-500/15 via-emerald-500/5 to-transparent p-5 shadow-sm relative overflow-hidden"
              >
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div className="flex items-start gap-3.5">
                    <div className="grid h-11 w-11 place-items-center rounded-xl bg-emerald-500/20 text-emerald-400 shrink-0">
                      <ShieldCheck className="h-6 w-6" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs font-bold uppercase tracking-wider text-emerald-500 bg-emerald-500/10 px-2.5 py-0.5 rounded-full">
                          Active Member
                        </span>
                        <h2 className="text-base sm:text-lg font-bold text-foreground">
                          {activeSubscription.planName ||
                            plans.find((p) => p.plan_id === activeSubscription.planId)?.name ||
                            activeSubscription.planId}
                        </h2>
                      </div>
                      <p className="text-xs sm:text-sm text-muted-foreground mt-1">
                        Your membership is active and valid until{" "}
                        <span className="font-semibold text-foreground">
                          {new Date(activeSubscription.expiresAt).toLocaleDateString(undefined, {
                            year: "numeric",
                            month: "short",
                            day: "numeric",
                          })}
                        </span>
                        {activeSubscription.remainingDays > 0 && (
                          <span className="text-emerald-400 font-semibold">
                            {" "}
                            ({activeSubscription.remainingDays} days remaining)
                          </span>
                        )}
                        . Payment ID:{" "}
                        <span className="font-mono text-xs">{activeSubscription.paymentId}</span>
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => switchTab("my")}
                      className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-3.5 py-1.5 text-xs font-bold text-emerald-300 transition hover:bg-emerald-500/20"
                    >
                      <ShieldCheck className="h-3.5 w-3.5" />
                      View Details & History
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Paid Subscriber Plans Section */}
            <section aria-labelledby="membership-plans-heading" className="space-y-5">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div>
                  <div className="flex items-center gap-2">
                    <Crown className="h-5 w-5 text-amber-500" />
                    <h2
                      id="membership-plans-heading"
                      className="text-lg font-extrabold text-foreground sm:text-xl"
                    >
                      FaceTube Subscriber Memberships
                    </h2>
                  </div>
                  <p className="text-xs sm:text-sm text-muted-foreground mt-0.5">
                    Choose a plan to support creators and unlock verified supporter badges, live
                    chat access, and early videos
                  </p>
                </div>

                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Lock className="h-3.5 w-3.5 text-emerald-500" />
                  <span>Razorpay Secure 256-bit Encrypted Checkout</span>
                </div>
              </div>

              {/* Checkout Error Banner */}
              {checkoutError && (
                <div
                  role="alert"
                  className="flex items-start gap-2.5 rounded-2xl border border-destructive/30 bg-destructive/10 p-4 text-xs text-destructive"
                >
                  <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                  <span>{checkoutError}</span>
                </div>
              )}

              {/* Pricing Grid */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
                {plans.map((plan) => {
                  const isSubscribing = subscribingPlanId === plan.plan_id;
                  const isCurrentActive =
                    activeSubscription?.status === "active" &&
                    activeSubscription.planId === plan.plan_id;
                  const isPopular = plan.plan_id === "member-vip-monthly";
                  const isBestValue = plan.plan_id === "member-annual";

                  return (
                    <div
                      key={plan.plan_id}
                      className={`relative flex flex-col justify-between rounded-2xl border p-6 transition-all duration-200 ${
                        isCurrentActive
                          ? "border-emerald-500 bg-emerald-500/5 ring-1 ring-emerald-500/40"
                          : isPopular
                            ? "border-brand/40 bg-card shadow-lg shadow-brand/5 ring-1 ring-brand/30"
                            : isBestValue
                              ? "border-amber-500/40 bg-card shadow-md ring-1 ring-amber-500/20"
                              : "border-border bg-card hover:border-border/80"
                      }`}
                    >
                      {/* Badge Header */}
                      {isPopular && (
                        <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-brand px-3 py-0.5 text-[11px] font-black uppercase tracking-wider text-white shadow-sm flex items-center gap-1">
                          <Sparkles className="h-3 w-3" />
                          Most Popular
                        </div>
                      )}
                      {isBestValue && (
                        <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-amber-500 px-3 py-0.5 text-[11px] font-black uppercase tracking-wider text-black shadow-sm flex items-center gap-1">
                          <Star className="h-3 w-3 fill-black" />
                          Best Value • Save 44%
                        </div>
                      )}

                      <div className="space-y-4">
                        {/* Plan Name & Tag */}
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <h3 className="text-lg font-bold text-foreground">{plan.name}</h3>
                            <p className="text-xs text-muted-foreground mt-0.5">
                              {plan.duration_days === 365
                                ? "Full year supporter access"
                                : "Monthly recurring access"}
                            </p>
                          </div>
                          {isCurrentActive && (
                            <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-bold text-emerald-400 shrink-0">
                              Active
                            </span>
                          )}
                        </div>

                        {/* Price Block */}
                        <div className="border-b border-border/60 pb-4">
                          <div className="flex items-baseline gap-1">
                            <span className="text-3xl font-black tracking-tight text-foreground sm:text-4xl">
                              ₹{plan.price}
                            </span>
                            <span className="text-xs text-muted-foreground font-medium">
                              / {plan.duration_days} days
                            </span>
                          </div>
                          <p className="text-[11px] text-muted-foreground mt-1">
                            {plan.duration_days === 365
                              ? `₹${(plan.price / 365).toFixed(2)}/day • Authoritative price`
                              : `₹${(plan.price / plan.duration_days).toFixed(2)}/day • Authoritative price`}
                          </p>
                        </div>

                        {/* Perks List */}
                        <div className="space-y-2.5 py-1">
                          <div className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                            Included Perks:
                          </div>
                          <ul className="space-y-2 text-xs text-foreground/90">
                            {plan.perks.map((perk, idx) => (
                              <li key={idx} className="flex items-start gap-2">
                                <Check className="h-4 w-4 text-emerald-500 shrink-0 mt-0.5" />
                                <span>{perk}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      </div>

                      {/* Action Button */}
                      <div className="pt-6">
                        {isCurrentActive ? (
                          <button
                            type="button"
                            onClick={() => switchTab("my")}
                            className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-500/15 border border-emerald-500/30 px-4 py-2.5 text-xs font-bold text-emerald-400 hover:bg-emerald-500/25 transition cursor-pointer"
                          >
                            <ShieldCheck className="h-4 w-4" />
                            Current Plan • View Details
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => handleSubscribe(plan)}
                            disabled={subscribingPlanId !== null}
                            className={`w-full inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-xs font-bold transition shadow-sm ${
                              isPopular
                                ? "bg-brand text-white hover:bg-brand/90 disabled:opacity-50"
                                : isBestValue
                                  ? "bg-amber-500 text-black hover:bg-amber-400 disabled:opacity-50"
                                  : "bg-foreground text-background hover:bg-foreground/90 disabled:opacity-50"
                            }`}
                          >
                            {isSubscribing ? (
                              <>
                                <Loader2 className="h-4 w-4 animate-spin" />
                                Processing Checkout...
                              </>
                            ) : (
                              <>
                                <span>Subscribe • ₹{plan.price}</span>
                                <ArrowRight className="h-3.5 w-3.5" />
                              </>
                            )}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>

            {/* Channels Stories / Avatars Bar */}
            <div className="space-y-3 pt-2">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-bold uppercase tracking-wider text-muted-foreground">
                  Channels You Follow
                </h2>
              </div>

              <div className="flex items-center gap-4 overflow-x-auto pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                <button
                  type="button"
                  onClick={() => setSelectedCreator(null)}
                  className={`flex flex-col items-center gap-1.5 shrink-0 transition ${
                    selectedCreator === null ? "opacity-100" : "opacity-70 hover:opacity-100"
                  }`}
                >
                  <div
                    className={`grid h-14 w-14 place-items-center rounded-full border-2 transition ${
                      selectedCreator === null
                        ? "border-brand bg-brand text-white shadow-md"
                        : "border-border bg-secondary text-foreground"
                    }`}
                  >
                    <Users className="h-5 w-5" />
                  </div>
                  <span className="text-[11px] font-semibold text-foreground max-w-[64px] truncate">
                    All
                  </span>
                </button>

                {channelCreators.map((c) => {
                  const isSelected = selectedCreator === c.name;
                  return (
                    <button
                      key={c.key}
                      type="button"
                      onClick={() => setSelectedCreator(isSelected ? null : c.name)}
                      className={`relative flex flex-col items-center gap-1.5 shrink-0 group transition ${
                        isSelected ? "opacity-100 scale-105" : "opacity-80 hover:opacity-100"
                      }`}
                    >
                      <div
                        className={`relative grid h-14 w-14 place-items-center rounded-full font-bold text-sm text-white shadow-sm transition-all ${
                          isSelected
                            ? "ring-4 ring-brand bg-gradient-to-br from-brand to-brand-dark"
                            : "ring-2 ring-border bg-gradient-to-br from-neutral-800 to-neutral-700 group-hover:ring-brand/50"
                        }`}
                      >
                        <ChannelAvatar
                          src={c.channelLogoUrl}
                          name={c.name}
                          initials={c.initials}
                          sizeClassName="h-14 w-14"
                          imageRingClassName=""
                          fallbackClassName="bg-transparent text-sm font-bold text-white"
                        />
                      </div>
                      <span className="text-[11px] font-medium text-foreground max-w-[64px] truncate">
                        {c.name}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Filter Pills */}
            <div className="flex gap-2 border-b border-border/70 pb-3">
              {(["All", "Today", "Live", "Continue"] as const).map((filter) => (
                <button
                  key={filter}
                  type="button"
                  onClick={() => setSelectedFilter(filter)}
                  className={`rounded-full px-4 py-1 text-xs font-semibold transition ${
                    selectedFilter === filter
                      ? "bg-foreground text-background shadow-sm"
                      : "bg-secondary text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {filter}
                </button>
              ))}
            </div>

            {/* Subscribed Feed Grid */}
            <section className="space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-bold text-foreground sm:text-lg">
                  {selectedCreator ? `Uploads from ${selectedCreator}` : "Recent Uploads"}
                </h2>
                <span className="text-xs text-muted-foreground">
                  {filteredVideos.length} videos available
                </span>
              </div>

              {filteredVideos.length === 0 ? (
                <p className="rounded-2xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
                  No creator uploads available right now.
                </p>
              ) : (
                <div className="grid grid-cols-1 gap-x-4 gap-y-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {filteredVideos.map((v) => (
                    <VideoCard key={`sub-video-${v.id}`} video={v} />
                  ))}
                </div>
              )}
            </section>
          </div>
        )}

        {/* USER REFUND SUBMISSION MODAL (Phase 2F) */}
        {selectedSubForRefund && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm animate-fadeIn"
            onClick={closeRefundDialog}
          >
            <div
              className="relative w-full max-w-lg rounded-2xl border border-border bg-card p-6 shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-start justify-between border-b border-border pb-4">
                <div className="flex items-center gap-2.5">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-500/10 text-amber-500">
                    <RotateCcw className="h-5 w-5" />
                  </div>
                  <div>
                    <h3 className="text-base font-bold text-foreground">
                      Request Subscription Refund
                    </h3>
                    <p className="text-xs text-muted-foreground font-mono truncate max-w-[280px] sm:max-w-sm">
                      Payment ID: {selectedSubForRefund.paymentId}
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={closeRefundDialog}
                  disabled={isSubmittingRefund}
                  className="rounded-lg p-1 text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-50 cursor-pointer"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              <form onSubmit={handleSubmitRefund} className="mt-4 space-y-4">
                {/* Subscription Summary */}
                <div className="rounded-xl border border-border bg-secondary/30 p-3 text-xs space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Membership Plan:</span>
                    <span className="font-bold text-foreground">
                      {selectedSubForRefund.planName || selectedSubForRefund.planId}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Original Payment Amount:</span>
                    <span className="font-extrabold text-foreground">
                      ₹{Number(selectedSubForRefund.amount).toFixed(2)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-muted-foreground">Order ID:</span>
                    <span className="font-mono text-muted-foreground truncate max-w-[250px]">
                      {selectedSubForRefund.orderId}
                    </span>
                  </div>
                </div>

                {/* Reason Textarea */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <label
                      htmlFor="refund-reason-textarea"
                      className="text-xs font-bold text-foreground"
                    >
                      Reason for Refund Request
                    </label>
                    <span
                      className={`text-[11px] font-mono ${
                        refundReason.trim().length < 5
                          ? "text-amber-500"
                          : refundReason.trim().length > 1000
                            ? "text-destructive"
                            : "text-muted-foreground"
                      }`}
                    >
                      {refundReason.trim().length}/1000 characters (min 5)
                    </span>
                  </div>
                  <textarea
                    id="refund-reason-textarea"
                    rows={4}
                    value={refundReason}
                    onChange={(e) => {
                      setRefundReason(e.target.value);
                      if (refundError) setRefundError(null);
                    }}
                    placeholder="Please explain in detail why you are requesting a refund on this subscription (minimum 5 characters)..."
                    disabled={isSubmittingRefund}
                    className="w-full rounded-xl border border-border bg-background p-3 text-xs text-foreground placeholder:text-muted-foreground focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand disabled:opacity-50 resize-none"
                  />
                </div>

                {refundError && (
                  <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive flex items-center gap-2">
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    <span>{refundError}</span>
                  </div>
                )}

                {/* Disclaimer Notice */}
                <div className="rounded-xl border border-border/60 bg-secondary/20 p-3 text-[11px] text-muted-foreground flex items-start gap-2">
                  <ShieldAlert className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
                  <span>
                    Refund requests are queued for administrative evaluation and compliance
                    verification. Submitting a request does not immediately disburse or guarantee a
                    refund.
                  </span>
                </div>

                {/* Actions */}
                <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
                  <button
                    type="button"
                    onClick={closeRefundDialog}
                    disabled={isSubmittingRefund}
                    className="rounded-xl border border-border bg-secondary px-4 py-2 text-xs font-semibold text-foreground hover:bg-secondary/80 disabled:opacity-50 cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={
                      isSubmittingRefund ||
                      refundReason.trim().length < 5 ||
                      refundReason.trim().length > 1000
                    }
                    className="inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2 text-xs font-bold text-white hover:bg-brand/90 transition disabled:opacity-50 cursor-pointer"
                  >
                    {isSubmittingRefund ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        <span>Submitting...</span>
                      </>
                    ) : (
                      <>
                        <RotateCcw className="h-3.5 w-3.5" />
                        <span>Submit Refund Request</span>
                      </>
                    )}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    </VideoHubLayout>
  );
}
