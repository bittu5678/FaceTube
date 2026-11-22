import { useState, useEffect, useCallback, useMemo } from "react";
import { Link } from "@tanstack/react-router";
import {
  LayoutGrid,
  HeartPulse,
  Trophy,
  Theater,
  ArrowUpRight,
  X,
  Video as VideoIcon,
  Loader2,
  Folder,
} from "lucide-react";
import { api } from "@/lib/api";
import {
  VIDEO_CATEGORIES,
  fetchUploadedVideos,
  convertUploadedToCatalogVideo,
  isPubliclyCacheableVideo,
} from "@/lib/video-service";
import {
  buildDashboardCategoryCatalog,
  toCategorySlug,
  type ApiCategoryRecord,
} from "@/lib/dashboard-categories";
import type { Video } from "@/data/videos";
import { VideoCard } from "./VideoCard";

function getFeaturedCategoryMeta(name: string) {
  const norm = name.trim().toLowerCase();
  if (norm === "health") {
    return {
      icon: HeartPulse,
      iconBg: "bg-rose-500/15 text-rose-500",
      subtitle: "Wellness & fitness",
    };
  }
  if (norm === "sports") {
    return {
      icon: Trophy,
      iconBg: "bg-amber-500/15 text-amber-500",
      subtitle: "Matches & athletics",
    };
  }
  if (norm === "drama") {
    return {
      icon: Theater,
      iconBg: "bg-purple-500/15 text-purple-500",
      subtitle: "Stories & series",
    };
  }
  return {
    icon: Folder,
    iconBg: "bg-brand/15 text-brand",
    subtitle: "Explore videos",
  };
}

interface DashboardCategoriesSectionProps {
  selectedCategory: string;
  onSelectCategory: (category: string) => void;
}

export function DashboardCategoriesSection({
  selectedCategory,
  onSelectCategory,
}: DashboardCategoriesSectionProps) {
  const [apiCategories, setApiCategories] = useState<ApiCategoryRecord[]>([]);
  const [isLoadingCategories, setIsLoadingCategories] = useState(true);
  const [categoryVideos, setCategoryVideos] = useState<Video[]>([]);
  const [isLoadingVideos, setIsLoadingVideos] = useState(false);

  const loadCategories = useCallback(async () => {
    try {
      const res = await api.categories.list();
      if (res && res.success && Array.isArray(res.categories)) {
        setApiCategories(res.categories);
        return;
      }
    } catch {
      // Fall back to baseline VIDEO_CATEGORIES if API is unreachable
    } finally {
      setIsLoadingCategories(false);
    }

    setApiCategories((prev) =>
      prev.length > 0
        ? prev
        : VIDEO_CATEGORIES.map((name, idx) => ({
            id: idx + 1,
            name,
            slug: toCategorySlug(name),
            created_by: "SYSTEM",
          })),
    );
  }, []);

  useEffect(() => {
    loadCategories();

    const handleRefresh = () => {
      loadCategories();
    };
    window.addEventListener("facetube:categories-updated", handleRefresh);
    window.addEventListener("focus", handleRefresh);
    return () => {
      window.removeEventListener("facetube:categories-updated", handleRefresh);
      window.removeEventListener("focus", handleRefresh);
    };
  }, [loadCategories]);

  const catalog = useMemo(() => buildDashboardCategoryCatalog(apiCategories), [apiCategories]);

  // Load real videos belonging to the selected category
  useEffect(() => {
    const trimmed = selectedCategory.trim();
    if (!trimmed) {
      setCategoryVideos([]);
      setIsLoadingVideos(false);
      return;
    }

    let cancelled = false;
    setIsLoadingVideos(true);

    async function loadVideosForCategory() {
      try {
        const uploaded = await fetchUploadedVideos({ category: trimmed });
        if (cancelled) return;

        const normTarget = trimmed.toLowerCase();
        const fromDb = uploaded
          .filter(
            (v) =>
              isPubliclyCacheableVideo(v) &&
              (v.category || "General").trim().toLowerCase() === normTarget,
          )
          .map(convertUploadedToCatalogVideo);

        const seen = new Set<string>();
        const merged: Video[] = [];
        for (const vid of fromDb) {
          if (!seen.has(vid.id)) {
            seen.add(vid.id);
            merged.push(vid);
          }
        }

        setCategoryVideos(merged);
      } catch {
        if (cancelled) return;
        setCategoryVideos([]);
      } finally {
        if (!cancelled) setIsLoadingVideos(false);
      }
    }

    loadVideosForCategory();
    return () => {
      cancelled = true;
    };
  }, [selectedCategory]);

  const normalizedSelected = selectedCategory.trim().toLowerCase();

  return (
    <section
      aria-labelledby="dashboard-categories-heading"
      className="rounded-3xl border border-border bg-card p-6 sm:p-7 shadow-card space-y-5"
    >
      {/* Section Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-border/60 pb-4">
        <div>
          <div className="inline-flex items-center gap-1.5 rounded-md bg-brand/10 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider text-brand">
            <LayoutGrid className="h-3.5 w-3.5" />
            Category Explorer
          </div>
          <h2
            id="dashboard-categories-heading"
            className="mt-1 text-lg sm:text-xl font-black text-foreground"
          >
            Video Categories
          </h2>
          <p className="text-xs text-muted-foreground">
            Browse Health, Sports, Drama and all FaceTube categories.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-semibold text-muted-foreground">
            Available:{" "}
            <strong className="text-foreground">{catalog.allUniqueNames.length} Categories</strong>
          </span>
          {selectedCategory && (
            <>
              <button
                type="button"
                onClick={() => onSelectCategory("")}
                className="inline-flex items-center gap-1 rounded-xl border border-border bg-secondary px-3 py-1.5 font-bold text-foreground hover:bg-secondary/80 transition"
              >
                <X className="h-3.5 w-3.5" />
                <span>Clear</span>
              </button>
              <Link
                to="/"
                search={{ category: selectedCategory }}
                className="inline-flex items-center gap-1 rounded-xl bg-brand px-3 py-1.5 font-bold text-white shadow-sm hover:bg-brand-dark transition"
              >
                <span>Open in Feed</span>
                <ArrowUpRight className="h-3.5 w-3.5" />
              </Link>
            </>
          )}
        </div>
      </div>

      {/* Featured Categories Row: Health, Sports, Drama */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {catalog.featured.map((cat) => {
          const isSelected = normalizedSelected === cat.name.toLowerCase();
          const meta = getFeaturedCategoryMeta(cat.name);
          const Icon = meta.icon;

          return (
            <button
              key={cat.name.toLowerCase()}
              type="button"
              aria-pressed={isSelected}
              onClick={() => onSelectCategory(isSelected ? "" : cat.name)}
              className={`group flex items-center justify-between gap-3 rounded-2xl border p-4 text-left transition-all ${
                isSelected
                  ? "border-brand bg-brand/10 ring-1 ring-brand/40 shadow-sm"
                  : "border-border bg-secondary/25 hover:border-brand/40 hover:bg-secondary/50"
              }`}
            >
              <div className="flex items-center gap-3 min-w-0">
                <span
                  className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl transition-transform group-hover:scale-105 ${
                    isSelected ? "bg-brand text-white" : meta.iconBg
                  }`}
                >
                  <Icon className="h-5 w-5" />
                </span>
                <div className="min-w-0">
                  <div
                    className={`text-sm font-bold truncate ${
                      isSelected ? "text-brand" : "text-foreground"
                    }`}
                  >
                    {cat.name}
                  </div>
                  <div className="text-[11px] text-muted-foreground truncate">
                    {isSelected ? "Showing category videos" : meta.subtitle}
                  </div>
                </div>
              </div>
              <ArrowUpRight
                className={`h-4 w-4 shrink-0 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5 ${
                  isSelected ? "text-brand" : "text-muted-foreground"
                }`}
              />
            </button>
          );
        })}
      </div>

      {/* Existing Categories from Production Database / API */}
      <div className="space-y-2.5 pt-1">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
            All Categories
          </span>
          {isLoadingCategories && (
            <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin text-brand" />
              Loading...
            </span>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          {catalog.existing.map((cat) => {
            const isSelected = normalizedSelected === cat.name.toLowerCase();
            return (
              <button
                key={String(cat.id || cat.slug || cat.name.toLowerCase())}
                type="button"
                aria-pressed={isSelected}
                onClick={() => onSelectCategory(isSelected ? "" : cat.name)}
                className={`rounded-full px-3.5 py-1.5 text-xs font-semibold transition-all ${
                  isSelected
                    ? "bg-brand text-white shadow-sm"
                    : "bg-secondary text-foreground/80 hover:bg-brand/10 hover:text-brand"
                }`}
              >
                {cat.name}
              </button>
            );
          })}
        </div>
      </div>

      {/* Filtered Videos for Selected Category */}
      {selectedCategory && (
        <div className="border-t border-border/60 pt-5 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div>
              <h3 className="text-base font-bold text-foreground">{selectedCategory} Videos</h3>
              <p className="text-xs text-muted-foreground">
                {isLoadingVideos
                  ? `Loading ${selectedCategory} videos...`
                  : `${categoryVideos.length} ${
                      categoryVideos.length === 1 ? "video" : "videos"
                    } available in ${selectedCategory}`}
              </p>
            </div>
            <Link
              to="/"
              search={{ category: selectedCategory }}
              className="inline-flex items-center gap-1 text-xs font-bold text-brand hover:underline"
            >
              <span>Browse {selectedCategory} in Home Feed</span>
              <ArrowUpRight className="h-3.5 w-3.5" />
            </Link>
          </div>

          {isLoadingVideos ? (
            <div className="flex items-center justify-center rounded-2xl border border-border/60 bg-secondary/15 py-12 text-xs text-muted-foreground gap-2">
              <Loader2 className="h-4 w-4 animate-spin text-brand" />
              <span>Loading {selectedCategory} videos...</span>
            </div>
          ) : categoryVideos.length > 0 ? (
            <div className="grid grid-cols-1 gap-x-5 gap-y-6 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
              {categoryVideos.map((video) => (
                <VideoCard key={`dash-cat-${video.id}`} video={video} />
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-secondary/10 py-10 px-4 text-center space-y-2.5">
              <VideoIcon className="h-8 w-8 text-muted-foreground/60" />
              <p className="text-sm font-bold text-foreground">
                No videos in {selectedCategory} yet
              </p>
              <p className="text-xs text-muted-foreground max-w-md">
                Videos published in the {selectedCategory} category will appear here automatically.
              </p>
              <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
                <Link
                  to="/"
                  search={{ category: selectedCategory }}
                  className="inline-flex items-center gap-1 rounded-full border border-border bg-secondary px-4 py-1.5 text-xs font-semibold text-foreground hover:bg-secondary/80 transition"
                >
                  <span>View in Home Feed</span>
                  <ArrowUpRight className="h-3.5 w-3.5" />
                </Link>
                <button
                  type="button"
                  onClick={() => onSelectCategory("")}
                  className="rounded-full bg-brand px-4 py-1.5 text-xs font-semibold text-white hover:bg-brand-dark transition"
                >
                  Show All Categories
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
