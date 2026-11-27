import {
  Home,
  UserPlus,
  Users,
  Wallet,
  CornerDownRight,
  ChevronDown,
  ChevronRight,
  Compass,
  Clapperboard,
  History,
  Clock,
  ThumbsUp,
  Video,
  Settings,
  CircleHelp,
  ShieldCheck,
  X,
  ArrowDownToLine,
  LogOut,
  Megaphone,
  ScrollText,
  Sparkles,
  LayoutGrid,
  Sprout,
  Smile,
  Radio,
  Share2,
  Film,
  Code,
  TrendingUp,
  Briefcase,
  Tv,
  Utensils,
  BookOpen,
  Flame,
  Coins,
  Folder,
  Loader2,
  RefreshCw,
  Music,
  Gamepad2,
  Bot,
  GraduationCap,
  HeartPulse,
  Trophy,
  Theater,
} from "lucide-react";
import { Link, useRouterState, useNavigate } from "@tanstack/react-router";
import { useState, useEffect, useCallback } from "react";
import { Logo } from "./Logo";
import { useAuth } from "@/lib/auth-context";
import { api } from "@/lib/api";

interface CategoryItem {
  id: string | number;
  name: string;
  slug: string;
  created_by?: string;
  created_at?: string;
}

function getCategoryIcon(name: string, isActive: boolean) {
  const norm = name.toLowerCase().trim();
  const iconClass = `h-3.5 w-3.5 shrink-0 ${isActive ? "text-white stroke-[2.4]" : ""}`;

  if (norm === "cartoon") {
    return <Smile className={`${iconClass} ${!isActive ? "text-amber-500" : ""}`} />;
  }
  if (norm === "agriculture") {
    return <Sprout className={`${iconClass} ${!isActive ? "text-emerald-500" : ""}`} />;
  }
  if (norm === "comedy") {
    return <Smile className={`${iconClass} ${!isActive ? "text-yellow-500" : ""}`} />;
  }
  if (norm === "coding" || norm.includes("code") || norm.includes("dev")) {
    return <Code className={`${iconClass} ${!isActive ? "text-cyan-500" : ""}`} />;
  }
  if (norm === "business") {
    return <Briefcase className={`${iconClass} ${!isActive ? "text-blue-500" : ""}`} />;
  }
  if (norm === "finance" || norm === "crypto") {
    return <Coins className={`${iconClass} ${!isActive ? "text-amber-400" : ""}`} />;
  }
  if (norm === "share market" || norm.includes("market")) {
    return <TrendingUp className={`${iconClass} ${!isActive ? "text-green-500" : ""}`} />;
  }
  if (norm === "movie") {
    return <Film className={`${iconClass} ${!isActive ? "text-purple-500" : ""}`} />;
  }
  if (norm === "entertainment") {
    return <Tv className={`${iconClass} ${!isActive ? "text-pink-500" : ""}`} />;
  }
  if (norm === "cooking") {
    return <Utensils className={`${iconClass} ${!isActive ? "text-orange-500" : ""}`} />;
  }
  if (norm === "motivational") {
    return <Flame className={`${iconClass} ${!isActive ? "text-rose-500" : ""}`} />;
  }
  if (norm === "blog") {
    return <BookOpen className={`${iconClass} ${!isActive ? "text-indigo-500" : ""}`} />;
  }
  if (norm === "music") {
    return <Music className={`${iconClass} ${!isActive ? "text-violet-500" : ""}`} />;
  }
  if (norm === "gaming" || norm.includes("game")) {
    return <Gamepad2 className={`${iconClass} ${!isActive ? "text-emerald-400" : ""}`} />;
  }
  if (norm === "travel") {
    return <Compass className={`${iconClass} ${!isActive ? "text-teal-400" : ""}`} />;
  }
  if (norm === "ai" || norm.includes("artificial intelligence")) {
    return <Bot className={`${iconClass} ${!isActive ? "text-purple-400" : ""}`} />;
  }
  if (norm === "education" || norm.includes("edu") || norm.includes("learn")) {
    return <GraduationCap className={`${iconClass} ${!isActive ? "text-amber-400" : ""}`} />;
  }
  if (norm === "health") {
    return <HeartPulse className={`${iconClass} ${!isActive ? "text-rose-500" : ""}`} />;
  }
  if (norm === "sports" || norm === "sport") {
    return <Trophy className={`${iconClass} ${!isActive ? "text-amber-500" : ""}`} />;
  }
  if (norm === "drama") {
    return <Theater className={`${iconClass} ${!isActive ? "text-purple-500" : ""}`} />;
  }
  return <Folder className={`${iconClass} ${!isActive ? "text-brand" : ""}`} />;
}

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  const { isAdmin, signOut } = useAuth();
  const navigate = useNavigate();
  const routerState = useRouterState();
  const currentPath = routerState.location.pathname;

  const isIncomeRoute =
    currentPath === "/income" ||
    currentPath === "/referral-income" ||
    currentPath === "/global-income" ||
    currentPath === "/adsense-income" ||
    currentPath === "/admob-income" ||
    currentPath === "/affiliate-income" ||
    currentPath === "/direct-referral-income" ||
    currentPath === "/team-income";

  const isYourVideosRoute =
    currentPath === "/your-videos" ||
    currentPath === "/free-videos" ||
    currentPath === "/premium-videos" ||
    currentPath === "/short-videos" ||
    currentPath === "/live-videos" ||
    currentPath === "/advertisement-videos" ||
    currentPath === "/images-uploaded";

  const [incomeExpanded, setIncomeExpanded] = useState(false);
  const [yourVideosExpanded, setYourVideosExpanded] = useState(false);
  const [categoriesExpanded, setCategoriesExpanded] = useState(false);

  // Dynamic Categories State
  const [categories, setCategories] = useState<CategoryItem[]>([]);
  const [isLoadingCategories, setIsLoadingCategories] = useState(false);
  const [categoryError, setCategoryError] = useState<string | null>(null);

  const loadCategories = useCallback(async () => {
    setIsLoadingCategories(true);
    setCategoryError(null);
    try {
      const res = await api.categories.list();
      if (res && res.success && Array.isArray(res.categories)) {
        setCategories(res.categories);
      } else {
        setCategoryError("Could not load categories");
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to load categories";
      setCategoryError(msg);
    } finally {
      setIsLoadingCategories(false);
    }
  }, []);

  useEffect(() => {
    loadCategories();

    const handleCategoryUpdate = () => {
      loadCategories();
    };
    window.addEventListener("facetube:categories-updated", handleCategoryUpdate);
    window.addEventListener("focus", handleCategoryUpdate);

    return () => {
      window.removeEventListener("facetube:categories-updated", handleCategoryUpdate);
      window.removeEventListener("focus", handleCategoryUpdate);
    };
  }, [loadCategories]);

  const searchParams = routerState.location.search as Record<string, unknown> | undefined;
  const rawCategory = searchParams?.["category"];
  const currentCategory = typeof rawCategory === "string" ? rawCategory.trim() : "";
  const isCategoriesActive = currentPath === "/" && Boolean(currentCategory);

  const isHomeActive = currentPath === "/" && !currentCategory;
  const isLiveActive = currentPath === "/live" || currentPath === "/live-videos";
  const rawTab = searchParams?.["tab"];
  const currentTab = typeof rawTab === "string" ? rawTab : "";
  const isReferAndEarnActive = currentPath === "/profile" && currentTab === "referral-link";

  const handleLogout = async () => {
    onNavigate?.();
    await signOut();
    navigate({ to: "/login" });
  };

  return (
    <nav className="flex flex-col gap-1 p-3">
      {isAdmin && (
        <Link
          to="/admin"
          onClick={onNavigate}
          className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold transition-all ${
            currentPath === "/admin"
              ? "bg-brand text-white shadow-lift font-bold"
              : "bg-brand/10 text-brand hover:bg-brand/20"
          }`}
        >
          <ShieldCheck className="h-[18px] w-[18px] shrink-0" />
          <span className="truncate">Admin Portal</span>
        </Link>
      )}

      {/* 1. Home */}
      <Link
        to="/"
        onClick={onNavigate}
        className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-all ${
          isHomeActive
            ? "bg-brand text-white shadow-sm font-bold"
            : "text-foreground/80 hover:translate-x-0.5 hover:bg-secondary hover:text-foreground font-medium"
        }`}
      >
        <Home
          className={`h-[18px] w-[18px] shrink-0 ${isHomeActive ? "text-white stroke-[2.4]" : ""}`}
        />
        <span className="truncate">Home</span>
      </Link>

      {/* 2. Live (Exposed Top-Level Sidebar Item) */}
      <Link
        to="/live"
        onClick={onNavigate}
        className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-all ${
          isLiveActive
            ? "bg-brand text-white shadow-sm font-bold"
            : "text-foreground/80 hover:translate-x-0.5 hover:bg-secondary hover:text-foreground font-medium"
        }`}
      >
        <Radio
          className={`h-[18px] w-[18px] shrink-0 ${
            isLiveActive ? "text-white stroke-[2.4]" : "text-red-500 animate-pulse"
          }`}
        />
        <span className="truncate flex-1">Live</span>
        <span className="rounded-full bg-red-500/15 px-1.5 py-0.5 text-[9px] font-black uppercase text-red-500 tracking-wider">
          LIVE
        </span>
      </Link>

      {/* 3. Refer & Earn (Consolidated link-sharing & referral dashboard) */}
      <Link
        to="/profile"
        search={{ tab: "referral-link" }}
        onClick={onNavigate}
        className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-all ${
          isReferAndEarnActive
            ? "bg-brand text-white shadow-sm font-bold"
            : "text-foreground/80 hover:translate-x-0.5 hover:bg-secondary hover:text-foreground font-medium"
        }`}
      >
        <Share2
          className={`h-[18px] w-[18px] shrink-0 ${
            isReferAndEarnActive ? "text-white stroke-[2.4]" : "text-amber-500"
          }`}
        />
        <span className="truncate flex-1">Refer & Earn</span>
        <span className="rounded-full border border-amber-400/40 bg-amber-400/15 px-2 py-0.5 text-[10px] font-bold text-amber-500 uppercase tracking-wider">
          Earn ₹
        </span>
      </Link>

      {/* 2. Referral Members */}
      <Link
        to="/referral-members"
        onClick={onNavigate}
        className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-all ${
          currentPath === "/referral-members"
            ? "bg-brand text-white shadow-sm font-bold"
            : "text-foreground/80 hover:translate-x-0.5 hover:bg-secondary hover:text-foreground font-medium"
        }`}
      >
        <UserPlus
          className={`h-[18px] w-[18px] shrink-0 ${
            currentPath === "/referral-members" ? "text-white stroke-[2.4]" : ""
          }`}
        />
        <span className="truncate">Referral Members</span>
      </Link>

      {/* 3. Team Members */}
      <Link
        to="/team-members"
        onClick={onNavigate}
        className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-all ${
          currentPath === "/team-members"
            ? "bg-brand text-white shadow-sm font-bold"
            : "text-foreground/80 hover:translate-x-0.5 hover:bg-secondary hover:text-foreground font-medium"
        }`}
      >
        <Users
          className={`h-[18px] w-[18px] shrink-0 ${
            currentPath === "/team-members" ? "text-white stroke-[2.4]" : ""
          }`}
        />
        <span className="truncate">Team Members</span>
      </Link>

      {/* 4. Income Section (Expandable / Collapsible) */}
      <div className="flex flex-col">
        <button
          type="button"
          aria-expanded={incomeExpanded}
          onClick={() => setIncomeExpanded((prev) => !prev)}
          className={`flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-sm transition-all ${
            isIncomeRoute && !incomeExpanded
              ? "bg-brand text-white shadow-sm font-bold"
              : "text-foreground/80 hover:translate-x-0.5 hover:bg-secondary hover:text-foreground font-medium"
          }`}
        >
          <div className="flex items-center gap-3 truncate">
            <Wallet
              className={`h-[18px] w-[18px] shrink-0 ${
                isIncomeRoute && !incomeExpanded ? "text-white stroke-[2.4]" : ""
              }`}
            />
            <span className="truncate">Income Section</span>
          </div>
          <ChevronDown
            className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-300 ease-in-out ${
              incomeExpanded ? "rotate-180 text-foreground" : ""
            } ${isIncomeRoute && !incomeExpanded ? "text-white" : ""}`}
          />
        </button>

        {/* Indented Submenu Items with smooth 200-300ms accordion animation */}
        <div
          className={`grid transition-all duration-300 ease-in-out ${
            incomeExpanded
              ? "grid-rows-[1fr] opacity-100"
              : "grid-rows-[0fr] opacity-0 pointer-events-none"
          }`}
        >
          <div className="overflow-hidden">
            <div className="ml-4 flex flex-col gap-1 border-l-2 border-border/60 py-1 pl-3 my-0.5">
              {/* Referral Income */}
              <Link
                to="/referral-income"
                onClick={onNavigate}
                className={`flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-xs transition-all ${
                  currentPath === "/referral-income" || currentPath === "/direct-referral-income"
                    ? "bg-brand text-white shadow-sm font-bold"
                    : "text-foreground/75 hover:translate-x-0.5 hover:bg-secondary hover:text-foreground font-medium"
                }`}
              >
                <CornerDownRight
                  className={`h-3.5 w-3.5 shrink-0 ${
                    currentPath === "/referral-income" || currentPath === "/direct-referral-income"
                      ? "text-white stroke-[2.4]"
                      : "text-muted-foreground"
                  }`}
                />
                <span className="truncate">Referral Income</span>
              </Link>

              {/* Global Income */}
              <Link
                to="/global-income"
                onClick={onNavigate}
                className={`flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-xs transition-all ${
                  currentPath === "/global-income"
                    ? "bg-brand text-white shadow-sm font-bold"
                    : "text-foreground/75 hover:translate-x-0.5 hover:bg-secondary hover:text-foreground font-medium"
                }`}
              >
                <CornerDownRight
                  className={`h-3.5 w-3.5 shrink-0 ${
                    currentPath === "/global-income"
                      ? "text-white stroke-[2.4]"
                      : "text-muted-foreground"
                  }`}
                />
                <span className="truncate">Global Income</span>
              </Link>

              {/* AdSense Income */}
              <Link
                to="/adsense-income"
                onClick={onNavigate}
                className={`flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-xs transition-all ${
                  currentPath === "/adsense-income"
                    ? "bg-brand text-white shadow-sm font-bold"
                    : "text-foreground/75 hover:translate-x-0.5 hover:bg-secondary hover:text-foreground font-medium"
                }`}
              >
                <CornerDownRight
                  className={`h-3.5 w-3.5 shrink-0 ${
                    currentPath === "/adsense-income"
                      ? "text-white stroke-[2.4]"
                      : "text-muted-foreground"
                  }`}
                />
                <span className="truncate">AdSense Income</span>
              </Link>

              {/* AdMob Income */}
              <Link
                to="/admob-income"
                onClick={onNavigate}
                className={`flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-xs transition-all ${
                  currentPath === "/admob-income"
                    ? "bg-brand text-white shadow-sm font-bold"
                    : "text-foreground/75 hover:translate-x-0.5 hover:bg-secondary hover:text-foreground font-medium"
                }`}
              >
                <CornerDownRight
                  className={`h-3.5 w-3.5 shrink-0 ${
                    currentPath === "/admob-income"
                      ? "text-white stroke-[2.4]"
                      : "text-muted-foreground"
                  }`}
                />
                <span className="truncate">AdMob Income</span>
              </Link>

              {/* Affiliate Income */}
              <Link
                to="/affiliate-income"
                onClick={onNavigate}
                className={`flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-xs transition-all ${
                  currentPath === "/affiliate-income"
                    ? "bg-brand text-white shadow-sm font-bold"
                    : "text-foreground/75 hover:translate-x-0.5 hover:bg-secondary hover:text-foreground font-medium"
                }`}
              >
                <CornerDownRight
                  className={`h-3.5 w-3.5 shrink-0 ${
                    currentPath === "/affiliate-income"
                      ? "text-white stroke-[2.4]"
                      : "text-muted-foreground"
                  }`}
                />
                <span className="truncate">Affiliate Income</span>
              </Link>
            </div>
          </div>
        </div>
      </div>

      {/* 5. Explore */}
      <Link
        to="/explore"
        onClick={onNavigate}
        className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-all ${
          currentPath === "/explore"
            ? "bg-brand text-white shadow-sm font-bold"
            : "text-foreground/80 hover:translate-x-0.5 hover:bg-secondary hover:text-foreground font-medium"
        }`}
      >
        <Compass
          className={`h-[18px] w-[18px] shrink-0 ${
            currentPath === "/explore" ? "text-white stroke-[2.4]" : ""
          }`}
        />
        <span className="truncate">Explore</span>
      </Link>

      {/* 6. Subscriptions */}
      <Link
        to="/subscriptions"
        onClick={onNavigate}
        className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-all ${
          currentPath === "/subscriptions"
            ? "bg-brand text-white shadow-sm font-bold"
            : "text-foreground/80 hover:translate-x-0.5 hover:bg-secondary hover:text-foreground font-medium"
        }`}
      >
        <Clapperboard
          className={`h-[18px] w-[18px] shrink-0 ${
            currentPath === "/subscriptions" ? "text-white stroke-[2.4]" : ""
          }`}
        />
        <span className="truncate">Subscriptions</span>
      </Link>

      {/* 7. History */}
      <Link
        to="/history"
        onClick={onNavigate}
        className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-all ${
          currentPath === "/history"
            ? "bg-brand text-white shadow-sm font-bold"
            : "text-foreground/80 hover:translate-x-0.5 hover:bg-secondary hover:text-foreground font-medium"
        }`}
      >
        <History
          className={`h-[18px] w-[18px] shrink-0 ${
            currentPath === "/history" ? "text-white stroke-[2.4]" : ""
          }`}
        />
        <span className="truncate">History</span>
      </Link>

      {/* 8. Watch Later */}
      <Link
        to="/watch-later"
        onClick={onNavigate}
        className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-all ${
          currentPath === "/watch-later"
            ? "bg-brand text-white shadow-sm font-bold"
            : "text-foreground/80 hover:translate-x-0.5 hover:bg-secondary hover:text-foreground font-medium"
        }`}
      >
        <Clock
          className={`h-[18px] w-[18px] shrink-0 ${
            currentPath === "/watch-later" ? "text-white stroke-[2.4]" : ""
          }`}
        />
        <span className="truncate">Watch Later</span>
      </Link>

      {/* 9. Liked Videos */}
      <Link
        to="/liked-videos"
        onClick={onNavigate}
        className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-all ${
          currentPath === "/liked-videos"
            ? "bg-brand text-white shadow-sm font-bold"
            : "text-foreground/80 hover:translate-x-0.5 hover:bg-secondary hover:text-foreground font-medium"
        }`}
      >
        <ThumbsUp
          className={`h-[18px] w-[18px] shrink-0 ${
            currentPath === "/liked-videos" ? "text-white stroke-[2.4]" : ""
          }`}
        />
        <span className="truncate">Liked Videos</span>
      </Link>

      {/* 10. Your Videos (Expandable / Collapsible) */}
      <div className="flex flex-col">
        <button
          type="button"
          aria-expanded={yourVideosExpanded}
          onClick={() => setYourVideosExpanded((prev) => !prev)}
          className={`flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-sm transition-all ${
            isYourVideosRoute && !yourVideosExpanded
              ? "bg-brand text-white shadow-sm font-bold"
              : "text-foreground/80 hover:translate-x-0.5 hover:bg-secondary hover:text-foreground font-medium"
          }`}
        >
          <div className="flex items-center gap-3 truncate">
            <Video
              className={`h-[18px] w-[18px] shrink-0 ${
                isYourVideosRoute && !yourVideosExpanded ? "text-white stroke-[2.4]" : ""
              }`}
            />
            <span className="truncate">Your Videos</span>
          </div>
          <ChevronDown
            className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-300 ease-in-out ${
              yourVideosExpanded ? "rotate-180 text-foreground" : ""
            } ${isYourVideosRoute && !yourVideosExpanded ? "text-white" : ""}`}
          />
        </button>

        {/* Indented Submenu Items with smooth 200-300ms accordion animation */}
        <div
          className={`grid transition-all duration-300 ease-in-out ${
            yourVideosExpanded
              ? "grid-rows-[1fr] opacity-100"
              : "grid-rows-[0fr] opacity-0 pointer-events-none"
          }`}
        >
          <div className="overflow-hidden">
            <div className="ml-4 flex flex-col gap-1 border-l-2 border-border/60 py-1 pl-3 my-0.5">
              {/* Free Videos */}
              <Link
                to="/free-videos"
                onClick={onNavigate}
                className={`flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-xs transition-all ${
                  currentPath === "/free-videos"
                    ? "bg-brand text-white shadow-sm font-bold"
                    : "text-foreground/75 hover:translate-x-0.5 hover:bg-secondary hover:text-foreground font-medium"
                }`}
              >
                <CornerDownRight
                  className={`h-3.5 w-3.5 shrink-0 ${
                    currentPath === "/free-videos"
                      ? "text-white stroke-[2.4]"
                      : "text-muted-foreground"
                  }`}
                />
                <span className="truncate">Free Videos</span>
              </Link>

              {/* Sponsor Videos */}
              <Link
                to="/premium-videos"
                onClick={onNavigate}
                className={`flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-xs transition-all ${
                  currentPath === "/premium-videos"
                    ? "bg-brand text-white shadow-sm font-bold"
                    : "text-foreground/75 hover:translate-x-0.5 hover:bg-secondary hover:text-foreground font-medium"
                }`}
              >
                <CornerDownRight
                  className={`h-3.5 w-3.5 shrink-0 ${
                    currentPath === "/premium-videos"
                      ? "text-white stroke-[2.4]"
                      : "text-muted-foreground"
                  }`}
                />
                <span className="truncate">Sponsor Videos</span>
              </Link>

              {/* Short Videos */}
              <Link
                to="/short-videos"
                onClick={onNavigate}
                className={`flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-xs transition-all ${
                  currentPath === "/short-videos"
                    ? "bg-brand text-white shadow-sm font-bold"
                    : "text-foreground/75 hover:translate-x-0.5 hover:bg-secondary hover:text-foreground font-medium"
                }`}
              >
                <CornerDownRight
                  className={`h-3.5 w-3.5 shrink-0 ${
                    currentPath === "/short-videos"
                      ? "text-white stroke-[2.4]"
                      : "text-muted-foreground"
                  }`}
                />
                <span className="truncate">Short Videos</span>
              </Link>

              {/* Live Videos */}
              <Link
                to="/live-videos"
                onClick={onNavigate}
                className={`flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-xs transition-all ${
                  currentPath === "/live-videos"
                    ? "bg-brand text-white shadow-sm font-bold"
                    : "text-foreground/75 hover:translate-x-0.5 hover:bg-secondary hover:text-foreground font-medium"
                }`}
              >
                <CornerDownRight
                  className={`h-3.5 w-3.5 shrink-0 ${
                    currentPath === "/live-videos"
                      ? "text-white stroke-[2.4]"
                      : "text-muted-foreground"
                  }`}
                />
                <span className="truncate">Live Videos</span>
              </Link>

              {/* Advertisement Videos */}
              <Link
                to="/advertisement-videos"
                onClick={onNavigate}
                className={`flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-xs transition-all ${
                  currentPath === "/advertisement-videos"
                    ? "bg-brand text-white shadow-sm font-bold"
                    : "text-foreground/75 hover:translate-x-0.5 hover:bg-secondary hover:text-foreground font-medium"
                }`}
              >
                <CornerDownRight
                  className={`h-3.5 w-3.5 shrink-0 ${
                    currentPath === "/advertisement-videos"
                      ? "text-white stroke-[2.4]"
                      : "text-muted-foreground"
                  }`}
                />
                <span className="truncate">Ad Videos</span>
              </Link>

              {/* Images Uploaded */}
              <Link
                to="/images-uploaded"
                onClick={onNavigate}
                className={`flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-xs transition-all ${
                  currentPath === "/images-uploaded"
                    ? "bg-brand text-white shadow-sm font-bold"
                    : "text-foreground/75 hover:translate-x-0.5 hover:bg-secondary hover:text-foreground font-medium"
                }`}
              >
                <CornerDownRight
                  className={`h-3.5 w-3.5 shrink-0 ${
                    currentPath === "/images-uploaded"
                      ? "text-white stroke-[2.4]"
                      : "text-muted-foreground"
                  }`}
                />
                <span className="truncate">Images Uploaded</span>
              </Link>
            </div>
          </div>
        </div>
      </div>

      {/* 11. Video Categories (Expandable / Collapsible) */}
      <div className="flex flex-col">
        <button
          type="button"
          aria-expanded={categoriesExpanded}
          onClick={() => {
            setCategoriesExpanded((prev) => {
              const next = !prev;
              if (next && categories.length === 0) {
                loadCategories();
              }
              return next;
            });
          }}
          className={`flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-sm transition-all ${
            isCategoriesActive && !categoriesExpanded
              ? "bg-brand text-white shadow-sm font-bold"
              : "text-foreground/80 hover:translate-x-0.5 hover:bg-secondary hover:text-foreground font-medium"
          }`}
        >
          <div className="flex items-center gap-3 truncate">
            <LayoutGrid
              className={`h-[18px] w-[18px] shrink-0 ${
                isCategoriesActive && !categoriesExpanded ? "text-white stroke-[2.4]" : ""
              }`}
            />
            <span className="truncate">Video Categories</span>
          </div>
          <ChevronRight
            className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-300 ease-in-out ${
              categoriesExpanded ? "rotate-90 text-foreground" : ""
            } ${isCategoriesActive && !categoriesExpanded ? "text-white" : ""}`}
          />
        </button>

        {/* Indented Submenu Items */}
        <div
          className={`grid transition-all duration-300 ease-in-out ${
            categoriesExpanded
              ? "grid-rows-[1fr] opacity-100"
              : "grid-rows-[0fr] opacity-0 pointer-events-none"
          }`}
        >
          <div className="overflow-hidden">
            <div className="ml-4 flex flex-col gap-1 border-l-2 border-border/60 py-1 pl-3 my-0.5">
              {/* Loading State */}
              {isLoadingCategories && categories.length === 0 && (
                <div className="flex items-center gap-2 rounded-xl px-2.5 py-2 text-xs text-muted-foreground animate-pulse">
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-brand" />
                  <span className="truncate">Loading categories...</span>
                </div>
              )}

              {/* Error State */}
              {categoryError && categories.length === 0 && !isLoadingCategories && (
                <div className="flex items-center justify-between rounded-xl px-2.5 py-1.5 text-xs text-muted-foreground bg-destructive/5 border border-destructive/20">
                  <span className="truncate text-destructive text-[11px] font-medium">
                    Failed to load
                  </span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      loadCategories();
                    }}
                    className="p-1 rounded hover:bg-destructive/10 text-destructive transition-colors"
                    title="Retry loading categories"
                  >
                    <RefreshCw className="h-3 w-3" />
                  </button>
                </div>
              )}

              {/* Empty State */}
              {!isLoadingCategories && !categoryError && categories.length === 0 && (
                <div className="px-2.5 py-2 text-xs text-muted-foreground italic">
                  No categories found
                </div>
              )}

              {/* Dynamic Categories List */}
              {categories.map((cat) => {
                const isCatActive =
                  currentPath === "/" && currentCategory.toLowerCase() === cat.name.toLowerCase();
                return (
                  <Link
                    key={String(cat.id || cat.slug || cat.name)}
                    to="/"
                    search={{ category: cat.name }}
                    onClick={onNavigate}
                    className={`flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-xs transition-all ${
                      isCatActive
                        ? "bg-brand text-white shadow-sm font-bold"
                        : "text-foreground/75 hover:translate-x-0.5 hover:bg-secondary hover:text-foreground font-medium"
                    }`}
                  >
                    {getCategoryIcon(cat.name, isCatActive)}
                    <span className="truncate">{cat.name}</span>
                  </Link>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* 12. Wallet Balance */}
      <Link
        to="/wallet-balance"
        onClick={onNavigate}
        className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-all ${
          currentPath === "/wallet-balance"
            ? "bg-brand text-white shadow-sm font-bold"
            : "text-foreground/80 hover:translate-x-0.5 hover:bg-secondary hover:text-foreground font-medium"
        }`}
      >
        <Wallet
          className={`h-[18px] w-[18px] shrink-0 ${
            currentPath === "/wallet-balance" ? "text-white stroke-[2.4]" : ""
          }`}
        />
        <span className="truncate">Wallet Balance</span>
      </Link>

      {/* 12. Withdrawal Balance */}
      <Link
        to="/withdrawal-balance"
        onClick={onNavigate}
        className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-all ${
          currentPath === "/withdrawal-balance"
            ? "bg-brand text-white shadow-sm font-bold"
            : "text-foreground/80 hover:translate-x-0.5 hover:bg-secondary hover:text-foreground font-medium"
        }`}
      >
        <ArrowDownToLine
          className={`h-[18px] w-[18px] shrink-0 ${
            currentPath === "/withdrawal-balance" ? "text-white stroke-[2.4]" : ""
          }`}
        />
        <span className="truncate">Withdrawal Balance</span>
      </Link>

      {/* Ads Promotions */}
      <Link
        to="/ads-promotions"
        onClick={onNavigate}
        className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-all ${
          currentPath === "/ads-promotions"
            ? "bg-brand text-white shadow-sm font-bold"
            : "text-foreground/80 hover:translate-x-0.5 hover:bg-secondary hover:text-foreground font-medium"
        }`}
      >
        <Megaphone
          className={`h-[18px] w-[18px] shrink-0 ${
            currentPath === "/ads-promotions" ? "text-white stroke-[2.4]" : ""
          }`}
        />
        <span className="truncate">📢 Ads Promotions</span>
      </Link>

      {/* My Certificate */}
      <Link
        to="/my-certificate"
        onClick={onNavigate}
        className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-all ${
          currentPath === "/my-certificate"
            ? "bg-brand text-white shadow-sm font-bold"
            : "text-foreground/80 hover:translate-x-0.5 hover:bg-secondary hover:text-foreground font-medium"
        }`}
      >
        <ScrollText
          className={`h-[18px] w-[18px] shrink-0 ${
            currentPath === "/my-certificate" ? "text-white stroke-[2.4]" : ""
          }`}
        />
        <span className="truncate">📜 My Certificate</span>
      </Link>

      {/* 13. Settings */}
      <Link
        to="/settings"
        onClick={onNavigate}
        className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-all ${
          currentPath === "/settings"
            ? "bg-brand text-white shadow-sm font-bold"
            : "text-foreground/80 hover:translate-x-0.5 hover:bg-secondary hover:text-foreground font-medium"
        }`}
      >
        <Settings
          className={`h-[18px] w-[18px] shrink-0 ${
            currentPath === "/settings" ? "text-white stroke-[2.4]" : ""
          }`}
        />
        <span className="truncate">Settings</span>
      </Link>

      {/* 14. Help */}
      <Link
        to="/help"
        onClick={onNavigate}
        className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-all ${
          currentPath === "/help"
            ? "bg-brand text-white shadow-sm font-bold"
            : "text-foreground/80 hover:translate-x-0.5 hover:bg-secondary hover:text-foreground font-medium"
        }`}
      >
        <CircleHelp
          className={`h-[18px] w-[18px] shrink-0 ${
            currentPath === "/help" ? "text-white stroke-[2.4]" : ""
          }`}
        />
        <span className="truncate">Help</span>
      </Link>

      {/* 15. Logout */}
      <button
        type="button"
        onClick={handleLogout}
        className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-foreground/80 transition-all hover:translate-x-0.5 hover:bg-destructive/10 hover:text-red-500"
      >
        <LogOut className="h-[18px] w-[18px] shrink-0 text-red-500" />
        <span className="truncate">Logout</span>
      </button>
    </nav>
  );
}

export function Sidebar({
  open,
  drawerOpen,
  onClose,
}: {
  open: boolean;
  drawerOpen: boolean;
  onClose: () => void;
}) {
  return (
    <>
      {/* Desktop rail */}
      <aside
        className={`sticky top-[calc(4rem+env(safe-area-inset-top,0px))] hidden h-[calc(100vh-4rem-env(safe-area-inset-top,0px))] shrink-0 overflow-y-auto border-r border-border bg-background transition-[width] duration-300 lg:block ${
          open ? "w-60" : "w-0 overflow-hidden border-r-0"
        }`}
      >
        <NavList />
        <div className="px-6 pb-8 text-xs leading-relaxed text-muted-foreground">
          <button
            type="button"
            onClick={() => window.dispatchEvent(new CustomEvent("facetube:replay-splash"))}
            className="flex items-center gap-1.5 text-xs text-muted-foreground/80 hover:text-brand transition-colors mb-3 cursor-pointer"
            title="Replay animated FaceTube splash screen"
          >
            <Sparkles className="h-3.5 w-3.5 text-brand" />
            Replay Splash Screen
          </button>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Link to="/about" className="hover:text-brand transition-colors">
              About
            </Link>
            <span>·</span>
            <Link to="/terms" className="hover:text-brand transition-colors">
              Terms
            </Link>
            <span>·</span>
            <Link to="/privacy" className="hover:text-brand transition-colors">
              Privacy
            </Link>
            <span>·</span>
            <Link to="/contact" className="hover:text-brand transition-colors">
              Contact
            </Link>
          </div>
          <p className="mt-2">© 2026 FaceTube</p>
        </div>
      </aside>

      {/* Mobile drawer */}
      <div
        className={`fixed inset-0 z-50 lg:hidden ${drawerOpen ? "" : "pointer-events-none"}`}
        aria-hidden={!drawerOpen}
      >
        <div
          onClick={onClose}
          className={`absolute inset-0 bg-black/50 transition-opacity duration-300 ${
            drawerOpen ? "opacity-100" : "opacity-0"
          }`}
        />
        <div
          className={`absolute inset-y-0 left-0 w-64 bg-background shadow-2xl transition-transform duration-300 pt-[env(safe-area-inset-top,0px)] pb-[env(safe-area-inset-bottom,0px)] ${
            drawerOpen ? "translate-x-0" : "-translate-x-full"
          }`}
        >
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <Logo size={30} />
            <button
              type="button"
              aria-label="Close menu"
              onClick={onClose}
              className="rounded-full p-2 text-muted-foreground transition hover:bg-secondary"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          <div className="overflow-y-auto max-h-[calc(100vh-60px)]">
            <NavList onNavigate={onClose} />
            <div className="px-5 py-4 border-t border-border mt-2">
              <button
                type="button"
                onClick={() => {
                  onClose();
                  window.dispatchEvent(new CustomEvent("facetube:replay-splash"));
                }}
                className="flex items-center gap-2 text-xs font-medium text-muted-foreground hover:text-brand transition-colors cursor-pointer"
              >
                <Sparkles className="h-4 w-4 text-brand" />
                Replay Splash Screen
              </button>
              <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                <Link to="/about" onClick={onClose} className="hover:text-brand transition-colors">
                  About
                </Link>
                <span>·</span>
                <Link to="/terms" onClick={onClose} className="hover:text-brand transition-colors">
                  Terms
                </Link>
                <span>·</span>
                <Link
                  to="/privacy"
                  onClick={onClose}
                  className="hover:text-brand transition-colors"
                >
                  Privacy
                </Link>
                <span>·</span>
                <Link
                  to="/contact"
                  onClick={onClose}
                  className="hover:text-brand transition-colors"
                >
                  Contact
                </Link>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
