import {
  Video,
  Sparkles,
  Megaphone,
  Image as ImageIcon,
  X,
  ArrowRight,
  Zap,
  DollarSign,
  TrendingUp,
} from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { MainUploadMode } from "@/routes/upload";
import { useAuth } from "@/lib/auth-context";
import {
  calculateUploadOptionsTotalEarnings,
  getUserWallet,
  type UserWallet,
} from "@/lib/ledger-service";
import { resolveAuthenticatedUserId } from "@/lib/video-service";

interface UploadOptionItem {
  id: "free" | "premium" | "ad_promotion" | "image";
  title: string;
  subtitle: string;
  badge: string;
  icon: typeof Video;
  accentClass: string;
  iconBgClass: string;
  description: string;
  isPremium?: boolean;
}

const UPLOAD_OPTIONS_LIST: UploadOptionItem[] = [
  {
    id: "free",
    title: "Free",
    subtitle: "Free Short & Long Videos · Fee: ₹0",
    badge: "Free · ₹0",
    icon: Video,
    accentClass: "border-sky-500/30 hover:border-sky-500/60 bg-sky-500/5 hover:bg-sky-500/10",
    iconBgClass: "bg-sky-500/20 text-sky-400 ring-1 ring-sky-500/30",
    description: "Publish standard public videos with ₹0 upload fee and no payment required.",
  },
  {
    id: "premium",
    title: "Sponsor",
    subtitle: "Sponsor Short & Long Videos · Fee: ₹6",
    badge: "Sponsor · ₹6",
    icon: Sparkles,
    isPremium: true,
    accentClass:
      "border-pink-500/50 hover:border-pink-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pink-500/50 bg-gradient-to-r from-pink-500/15 via-card to-card hover:from-pink-500/20 ring-1 ring-pink-500/30 shadow-[0_0_20px_rgba(236,72,153,0.12)]",
    iconBgClass:
      "bg-gradient-to-br from-pink-500 to-pink-600 text-white ring-1 ring-pink-400/60 font-black",
    description:
      "Monetized video upload unlocking Direct Referral (₹1) and Global Income Pool (₹3).",
  },
  {
    id: "ad_promotion",
    title: "Ad",
    subtitle: "Short & Long Videos (Ads) · 7d ₹100, 15d ₹200...",
    badge: "Ads",
    icon: Megaphone,
    accentClass:
      "border-emerald-500/30 hover:border-emerald-500/60 bg-emerald-500/5 hover:bg-emerald-500/10",
    iconBgClass: "bg-emerald-500/20 text-emerald-400 ring-1 ring-emerald-500/30",
    description: "Launch targeted demographic promotion campaigns with verified payment tracking.",
  },
  {
    id: "image",
    title: "Image Upload",
    subtitle: "JPG, PNG, WEBP · Media Library",
    badge: "Image Upload",
    icon: ImageIcon,
    accentClass: "border-teal-500/30 hover:border-teal-500/60 bg-teal-500/5 hover:bg-teal-500/10",
    iconBgClass: "bg-teal-500/20 text-teal-400 ring-1 ring-teal-500/30",
    description: "Upload independent image assets: thumbnails, channel graphics, and photo posts.",
  },
];

interface UploadOptionsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function UploadOptionsModal({ isOpen, onClose }: UploadOptionsModalProps) {
  const { user, profile, dbUser } = useAuth();
  const userId = resolveAuthenticatedUserId({ user, profile, dbUser });

  const [wallet, setWallet] = useState<UserWallet | null>(null);
  const [isLoadingWallet, setIsLoadingWallet] = useState(false);
  const adEarnings = calculateUploadOptionsTotalEarnings(wallet);

  useEffect(() => {
    if (!isOpen) return;
    if (!userId) {
      setWallet(null);
      setIsLoadingWallet(false);
      return;
    }

    let isMounted = true;
    const requestedUserId = userId.trim().toUpperCase();
    // Clear previous user's wallet immediately when switching authenticated accounts
    setWallet((prev) =>
      prev && prev.userId.trim().toUpperCase() === requestedUserId ? prev : null,
    );

    const fetchWallet = (showSpinner: boolean) => {
      if (showSpinner) setIsLoadingWallet(true);
      getUserWallet(userId)
        .then((w) => {
          if (!isMounted) return;
          const respUid = w.userId ? w.userId.trim().toUpperCase() : "";
          if (!respUid || respUid === requestedUserId) {
            setWallet(w);
          }
        })
        .catch((err) => {
          console.error("Failed to fetch wallet in UploadOptionsModal:", err);
        })
        .finally(() => {
          if (isMounted && showSpinner) setIsLoadingWallet(false);
        });
    };

    fetchWallet(true);

    const handleFocus = () => fetchWallet(false);
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") fetchWallet(false);
    };
    const handleWalletUpdated = () => fetchWallet(false);

    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("facetube:wallet-updated", handleWalletUpdated);

    return () => {
      isMounted = false;
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("facetube:wallet-updated", handleWalletUpdated);
    };
  }, [isOpen, userId]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-4">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/65 backdrop-blur-sm transition-opacity animate-in fade-in"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Modal / Sheet Container */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="upload-options-title"
        className="relative z-10 w-full max-w-lg rounded-t-3xl border border-border bg-card p-5 shadow-2xl transition-all animate-in slide-in-from-bottom-5 sm:rounded-3xl sm:p-6"
      >
        {/* Mobile Drag Indicator Bar */}
        <div className="mx-auto -mt-2 mb-4 h-1.5 w-12 rounded-full bg-muted-foreground/30 sm:hidden" />

        {/* Header */}
        <div className="mb-4 flex items-start justify-between border-b border-border/60 pb-3">
          <div>
            <div className="inline-flex items-center gap-1.5 rounded-full border border-brand/30 bg-brand/10 px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wider text-brand">
              <Sparkles className="h-3 w-3" />
              FaceTube Studio
            </div>
            <h2
              id="upload-options-title"
              className="mt-1.5 text-lg font-bold text-foreground sm:text-xl"
            >
              Upload Options
            </h2>
            <p className="text-xs text-muted-foreground">Select one of the 4 publishing pathways</p>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="grid h-8 w-8 place-items-center rounded-full text-muted-foreground transition hover:bg-secondary hover:text-foreground active:scale-95"
            aria-label="Close upload options"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Professional Daily Upload Promotional Banner */}
        <div className="mb-3.5 rounded-2xl border border-brand/25 bg-gradient-to-r from-brand/15 via-brand/5 to-card/60 p-3 sm:p-3.5 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand/15 text-brand border border-brand/30">
              <TrendingUp className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-xs font-bold text-foreground sm:text-sm tracking-tight leading-snug">
                One Video a Day. Take Your Channel Higher.
              </div>
              <p className="mt-0.5 text-[11px] text-muted-foreground sm:text-xs leading-snug">
                Stay consistent, reach more viewers, and grow with FaceTube.
              </p>
            </div>
          </div>
        </div>

        {/* Combined Total Ad Earnings (All 6 Credited Income Sources) Display Card */}
        <div className="mb-4 flex items-center justify-between rounded-2xl border border-emerald-500/30 bg-gradient-to-r from-emerald-500/10 via-card to-card p-3.5 shadow-sm">
          <div className="flex items-center gap-3 min-w-0">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
              <DollarSign className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-400 block truncate">
                Total Ad Earnings
              </span>
              <p className="text-xs text-muted-foreground truncate">
                {userId ? "All 6 credited income streams" : "Sign in to view credited earnings"}
              </p>
            </div>
          </div>
          <div className="text-right shrink-0 pl-2">
            <div className="text-lg font-black text-emerald-400 sm:text-xl font-mono">
              {isLoadingWallet ? (
                <span className="text-xs text-muted-foreground animate-pulse">Loading...</span>
              ) : (
                `₹${adEarnings.totalAdEarnings.toFixed(2)}`
              )}
            </div>
            <span className="text-[10px] text-muted-foreground block">
              {userId ? `UID: ${userId}` : "₹0.00 base"}
            </span>
          </div>
        </div>

        {/* 4 Upload Options List */}
        <div className="space-y-2.5 max-h-[60vh] overflow-y-auto pr-1">
          {UPLOAD_OPTIONS_LIST.map((opt) => {
            const Icon = opt.icon;
            return (
              <Link
                key={opt.id}
                to="/upload"
                search={{ mode: opt.id as MainUploadMode }}
                onClick={onClose}
                className={`group flex items-center justify-between rounded-2xl border p-3.5 text-left transition-all active:scale-[0.99] ${opt.accentClass}`}
              >
                <div className="flex items-center gap-3.5 min-w-0 pr-2">
                  <div
                    className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl ${opt.iconBgClass} transition group-hover:scale-105`}
                  >
                    <Icon className="h-5 w-5" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-bold text-foreground group-hover:text-brand transition-colors truncate">
                        {opt.title}
                      </span>
                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${
                          opt.isPremium
                            ? "border border-pink-500/40 bg-pink-500/15 text-pink-600 dark:text-pink-300"
                            : "bg-secondary/80 text-muted-foreground"
                        }`}
                      >
                        {opt.badge}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground truncate mt-0.5">{opt.subtitle}</p>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0 ml-auto">
                  {opt.isPremium && (
                    <div className="relative flex items-center justify-center">
                      <span className="absolute -inset-1 rounded-full bg-pink-400/35 blur-sm animate-pulse" />
                      <div className="relative flex items-center gap-1 rounded-full border border-pink-400/60 bg-gradient-to-r from-pink-500/25 via-pink-400/35 to-pink-500/25 px-2 py-0.5 text-[10px] font-black tracking-wide text-pink-600 dark:text-pink-300">
                        <Zap className="h-3.5 w-3.5 fill-pink-500 text-pink-500 dark:fill-pink-400 dark:text-pink-300 animate-pulse" />
                        <span>SPONSOR</span>
                      </div>
                    </div>
                  )}

                  <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground transition group-hover:translate-x-1 group-hover:text-brand ml-1" />
                </div>
              </Link>
            );
          })}
        </div>

        {/* Direct Studio Link Footer */}
        <div className="mt-4 pt-3 border-t border-border/60 flex items-center justify-between">
          <Link
            to="/upload"
            search={{ mode: "bulk" }}
            onClick={onClose}
            className="inline-flex items-center gap-1 text-xs font-bold text-sky-400 hover:text-sky-300 transition"
          >
            <span>Bulk Video Upload</span>
            <ArrowRight className="h-3 w-3" />
          </Link>
          <Link
            to="/upload"
            onClick={onClose}
            className="inline-flex items-center gap-1.5 rounded-full bg-secondary px-3.5 py-1.5 text-xs font-semibold text-foreground transition hover:bg-brand hover:text-white"
          >
            Open Full Studio
            <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
      </div>
    </div>
  );
}
