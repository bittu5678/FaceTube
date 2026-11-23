import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type ComponentType } from "react";
import {
  Compass,
  Flame,
  Music,
  Gamepad2,
  Newspaper,
  Clapperboard,
  Sparkles,
  Podcast,
  GraduationCap,
  HeartPulse,
  Trophy,
  Theater,
  Tag,
} from "lucide-react";
import { VideoHubLayout } from "@/components/videohub/VideoHubLayout";
import { ChannelAvatar } from "@/components/videohub/ChannelAvatar";
import { VideoCard } from "@/components/videohub/VideoCard";
import { AdMobBanner } from "@/components/admob/AdMobBanner";
import {
  buildExploreCategoryList,
  buildPublicFeedVideos,
  deriveCreatorsFromVideos,
  fetchUploadedVideos,
  filterExploreVideos,
  getAvailableCategories,
  isPubliclyCacheableVideo,
  parseCatalogViews,
  type UploadedVideo,
  VIDEO_CATEGORIES,
} from "@/lib/video-service";

export const Route = createFileRoute("/explore")({
  head: () => ({
    meta: [
      { title: "Explore — FaceTube" },
      {
        name: "description",
        content: "Discover trending videos, rising creators, music, gaming, and news on FaceTube.",
      },
    ],
  }),
  component: ExplorePage,
});

interface ExploreCategoryMeta {
  icon: ComponentType<{ className?: string }>;
  color: string;
}

const EXPLORE_CATEGORY_META: Record<string, ExploreCategoryMeta> = {
  trending: { icon: Flame, color: "text-amber-500 bg-amber-500/10 border-amber-500/20" },
  music: { icon: Music, color: "text-red-500 bg-red-500/10 border-red-500/20" },
  gaming: { icon: Gamepad2, color: "text-purple-500 bg-purple-500/10 border-purple-500/20" },
  movie: { icon: Clapperboard, color: "text-blue-500 bg-blue-500/10 border-blue-500/20" },
  entertainment: { icon: Clapperboard, color: "text-blue-500 bg-blue-500/10 border-blue-500/20" },
  blog: { icon: Newspaper, color: "text-emerald-500 bg-emerald-500/10 border-emerald-500/20" },
  news: { icon: Newspaper, color: "text-emerald-500 bg-emerald-500/10 border-emerald-500/20" },
  podcasts: { icon: Podcast, color: "text-indigo-500 bg-indigo-500/10 border-indigo-500/20" },
  education: { icon: GraduationCap, color: "text-cyan-500 bg-cyan-500/10 border-cyan-500/20" },
  coding: { icon: GraduationCap, color: "text-cyan-500 bg-cyan-500/10 border-cyan-500/20" },
  ai: { icon: Sparkles, color: "text-cyan-500 bg-cyan-500/10 border-cyan-500/20" },
  health: { icon: HeartPulse, color: "text-rose-500 bg-rose-500/10 border-rose-500/20" },
  sports: { icon: Trophy, color: "text-orange-500 bg-orange-500/10 border-orange-500/20" },
  drama: { icon: Theater, color: "text-violet-500 bg-violet-500/10 border-violet-500/20" },
};

function getExploreCategoryMeta(label: string): ExploreCategoryMeta {
  const key = label.trim().toLowerCase();
  return (
    EXPLORE_CATEGORY_META[key] ?? {
      icon: Tag,
      color: "text-brand bg-brand/10 border-brand/20",
    }
  );
}

function ExplorePage() {
  const [selectedTag, setSelectedTag] = useState<string>("Trending");
  const [searchQuery, setSearchQuery] = useState("");
  const [uploadedVideos, setUploadedVideos] = useState<UploadedVideo[]>([]);
  const [availableCategories, setAvailableCategories] = useState<string[]>(() => [
    ...VIDEO_CATEGORIES,
  ]);

  useEffect(() => {
    let isMounted = true;
    fetchUploadedVideos()
      .then((vids) => {
        if (isMounted) {
          setUploadedVideos(Array.isArray(vids) ? vids : []);
        }
      })
      .catch((err) => {
        if (isMounted) {
          console.error("Error loading explore creators:", err);
          setUploadedVideos([]);
        }
      });
    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    let isMounted = true;
    const loadCategories = () => {
      getAvailableCategories()
        .then((cats) => {
          if (isMounted && Array.isArray(cats) && cats.length > 0) {
            setAvailableCategories(cats);
          }
        })
        .catch(() => {});
    };
    loadCategories();
    window.addEventListener("facetube:categories-updated", loadCategories);
    return () => {
      isMounted = false;
      window.removeEventListener("facetube:categories-updated", loadCategories);
    };
  }, []);

  const exploreCategories = useMemo(
    () =>
      buildExploreCategoryList(availableCategories).map((label) => ({
        label,
        ...getExploreCategoryMeta(label),
      })),
    [availableCategories],
  );

  const eligibleVideos = useMemo(() => buildPublicFeedVideos(uploadedVideos), [uploadedVideos]);

  const trendingExploreVideos = useMemo(
    () =>
      [...eligibleVideos]
        .sort((a, b) => parseCatalogViews(b.views) - parseCatalogViews(a.views))
        .slice(0, 8),
    [eligibleVideos],
  );

  const featuredCreators = useMemo(() => {
    const liveCreators = deriveCreatorsFromVideos(
      uploadedVideos.filter(isPubliclyCacheableVideo),
    ).slice(0, 6);
    return liveCreators.map((c) => ({
      key: c.key,
      name: c.name,
      initials: c.initials,
      channelLogoUrl: c.channelLogoUrl,
      subtitle: `${c.uploadCount} ${c.uploadCount === 1 ? "video" : "videos"}`,
      tag: c.category || "Creator",
    }));
  }, [uploadedVideos]);

  const filteredVideos = useMemo(
    () =>
      filterExploreVideos(eligibleVideos, {
        selectedTag,
        searchQuery,
      }),
    [eligibleVideos, searchQuery, selectedTag],
  );

  return (
    <VideoHubLayout query={searchQuery} onQueryChange={setSearchQuery}>
      <div className="px-4 py-6 sm:px-6 lg:px-8 space-y-8">
        {/* Page Header */}
        <div className="flex items-center gap-3 border-b border-border pb-4">
          <div className="grid h-12 w-12 place-items-center rounded-2xl bg-brand/10 text-brand">
            <Compass className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight text-foreground sm:text-3xl">
              Explore
            </h1>
            <p className="text-sm text-muted-foreground">
              Discover what's trending across FaceTube right now
            </p>
          </div>
        </div>

        {/* Explore Hub Category Pills */}
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
          {exploreCategories.map((cat) => {
            const Icon = cat.icon;
            const isSelected = selectedTag.trim().toLowerCase() === cat.label.trim().toLowerCase();
            return (
              <button
                key={cat.label}
                type="button"
                onClick={() => setSelectedTag(cat.label)}
                className={`flex items-center gap-2.5 rounded-2xl border p-3 text-left transition-all ${
                  isSelected
                    ? "bg-brand text-white border-brand shadow-sm"
                    : `${cat.color} hover:scale-102 hover:shadow-sm`
                }`}
              >
                <Icon className={`h-5 w-5 shrink-0 ${isSelected ? "text-white" : ""}`} />
                <span
                  className={`text-xs font-bold truncate ${isSelected ? "text-white" : "text-foreground"}`}
                >
                  {cat.label}
                </span>
              </button>
            );
          })}
        </div>

        {/* Trending Spotlight Shelf */}
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Flame className="h-5 w-5 text-brand" />
              <h2 className="text-lg font-bold text-foreground sm:text-xl">Trending Videos</h2>
            </div>
            <span className="text-xs text-muted-foreground">Updated in real-time</span>
          </div>

          {trendingExploreVideos.length > 0 ? (
            <div className="grid grid-cols-1 gap-x-4 gap-y-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {trendingExploreVideos.map((v) => (
                <VideoCard key={`explore-trending-${v.id}`} video={v} />
              ))}
            </div>
          ) : (
            <p className="rounded-2xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
              No public trending videos available yet.
            </p>
          )}
        </section>

        {/* Popular Creators Shelf */}
        <section className="space-y-4 rounded-3xl border border-border bg-card p-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-brand" />
              <h2 className="text-base font-bold text-foreground sm:text-lg">
                Featured FaceTube Creators
              </h2>
            </div>
          </div>

          {featuredCreators.length > 0 ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
              {featuredCreators.map((c) => (
                <div
                  key={c.key}
                  className="flex flex-col items-center justify-center p-3 rounded-2xl border border-border bg-background text-center transition hover:border-brand/40"
                >
                  <div className="mb-2">
                    <ChannelAvatar
                      src={c.channelLogoUrl}
                      name={c.name}
                      initials={c.initials}
                      sizeClassName="h-12 w-12"
                      imageRingClassName="ring-1 ring-border shadow-sm"
                      fallbackClassName="bg-gradient-to-br from-brand to-brand-dark text-sm font-bold text-white shadow-sm"
                    />
                  </div>
                  <p className="text-xs font-bold text-foreground truncate w-full">{c.name}</p>
                  <p className="text-[10px] text-muted-foreground mt-0.5 truncate w-full">
                    {c.subtitle}
                  </p>
                  <span className="mt-2 rounded-full bg-secondary px-2 py-0.5 text-[9px] font-semibold text-muted-foreground">
                    {c.tag}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="py-4 text-center text-xs text-muted-foreground">
              No creators available yet.
            </p>
          )}
        </section>

        {/* Filtered & Discovered Feed */}
        <section className="space-y-4">
          <h2 className="text-lg font-bold text-foreground sm:text-xl">
            {selectedTag === "Trending" ? "Fresh Discoveries" : `${selectedTag} Videos`}
          </h2>

          {filteredVideos.length > 0 ? (
            <div className="grid grid-cols-1 gap-x-4 gap-y-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {filteredVideos.map((v) => (
                <VideoCard key={`explore-feed-${v.id}`} video={v} />
              ))}
            </div>
          ) : (
            <p className="rounded-2xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
              No public videos match the selected topic yet.
            </p>
          )}
        </section>

        <AdMobBanner margin={64} />
      </div>
    </VideoHubLayout>
  );
}
