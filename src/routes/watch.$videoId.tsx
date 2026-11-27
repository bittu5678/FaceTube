import { createFileRoute, Link, notFound, useRouter } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import {
  ArrowLeft,
  Play,
  ThumbsUp,
  ThumbsDown,
  Share2,
  Download,
  Bookmark,
  Volume2,
  Maximize2,
  Settings,
  Send,
} from "lucide-react";
import { toast } from "sonner";

import { Navbar } from "@/components/videohub/Navbar";
import { BottomNav } from "@/components/videohub/BottomNav";
import { VideoCard } from "@/components/videohub/VideoCard";
import { ImageCard } from "@/components/videohub/ImageCard";
import { ChannelAvatar } from "@/components/videohub/ChannelAvatar";
import { FaceTubeVideoPlayer } from "@/components/videohub/FaceTubeVideoPlayer";
import { findVideoAsync, resolveWatchVideo, type Video } from "@/data/videos";
import { useAuth } from "@/lib/auth-context";
import { buildVideoSharePayload, persistPendingReferral } from "@/lib/referral-service";
import { api, getStoredAuthToken } from "@/lib/api";
import {
  fetchUploadedVideos,
  convertUploadedToCatalogVideo,
  getVideoBadgeLabels,
  isPubliclyCacheableVideo,
  type UploadedVideo,
} from "@/lib/video-service";
import {
  fetchUploadedImages,
  interleaveFeedWithImages,
  IMAGE_FEED_INTERVAL,
  type UploadedImage,
} from "@/lib/image-service";
import { AdSenseAd } from "@/components/adsense/AdSenseAd";
import { AdMobBanner } from "@/components/admob/AdMobBanner";
import { AiVideoSummaryCard } from "@/components/ai/AiVideoSummaryCard";
import { recordWatchedVideoId } from "@/lib/watch-history";

export const Route = createFileRoute("/watch/$videoId")({
  loader: async ({ params }) => {
    const resolution = await resolveWatchVideo(params.videoId);
    if (resolution.status === "ok") {
      return {
        video: resolution.video,
        needsClientAuth: false,
        videoId: params.videoId,
      };
    }
    if (resolution.status === "needs_client_auth") {
      return {
        video: null as Video | null,
        needsClientAuth: true,
        videoId: params.videoId,
      };
    }
    throw notFound();
  },
  head: ({ loaderData }) => {
    if (!loaderData || !loaderData.video) {
      return {
        meta: [{ title: "Video unavailable — FaceTube" }, { name: "robots", content: "noindex" }],
      };
    }
    const { video } = loaderData;
    const title = `${video.title} — FaceTube`;
    return {
      meta: [
        { title },
        { name: "description", content: video.description },
        { property: "og:title", content: title },
        { property: "og:description", content: video.description },
        { property: "og:type", content: "video.other" },
        { name: "twitter:card", content: "summary_large_image" },
      ],
    };
  },
  notFoundComponent: WatchNotFound,
  component: WatchPage,
});

function WatchNotFound() {
  return (
    <div className="grid min-h-screen place-items-center bg-background px-6 text-center font-sans">
      <div>
        <h1 className="text-2xl font-extrabold text-foreground">This video isn’t available</h1>
        <p className="mt-2 text-muted-foreground">It may have been removed or made private.</p>
        <Link
          to="/"
          className="mt-6 inline-block rounded-full bg-brand px-5 py-2.5 text-sm font-semibold text-brand-foreground"
        >
          Back to home
        </Link>
      </div>
    </div>
  );
}

function WatchPage() {
  const { video: initialVideo, needsClientAuth, videoId } = Route.useLoaderData();
  const [video, setVideo] = useState<Video | null>(initialVideo);
  const [verifyingAccess, setVerifyingAccess] = useState<boolean>(() =>
    Boolean(needsClientAuth && !initialVideo),
  );
  const [accessDenied, setAccessDenied] = useState<boolean>(false);

  const router = useRouter();
  const { user, profile } = useAuth();

  useEffect(() => {
    setVideo(initialVideo);
    setAccessDenied(false);

    if (!needsClientAuth || initialVideo) {
      setVerifyingAccess(false);
      return;
    }

    const token = getStoredAuthToken();
    if (!token) {
      setVerifyingAccess(false);
      setAccessDenied(true);
      return;
    }

    let active = true;
    setVerifyingAccess(true);
    findVideoAsync(videoId)
      .then((authorizedVideo) => {
        if (!active) return;
        if (authorizedVideo) {
          setVideo(authorizedVideo);
          setAccessDenied(false);
        } else {
          setVideo(null);
          setAccessDenied(true);
        }
      })
      .catch(() => {
        if (!active) return;
        setVideo(null);
        setAccessDenied(true);
      })
      .finally(() => {
        if (active) setVerifyingAccess(false);
      });

    return () => {
      active = false;
    };
  }, [videoId, initialVideo, needsClientAuth]);

  const handleBack = (e?: React.MouseEvent) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    const hasHistory =
      typeof window !== "undefined" &&
      ((window.history.state &&
        typeof window.history.state.idx === "number" &&
        window.history.state.idx > 0) ||
        (document.referrer && document.referrer.startsWith(window.location.origin)));

    if (hasHistory) {
      window.history.back();
    } else {
      router.navigate({ to: "/" });
    }
  };

  const creatorUserId = video ? String((video as any).userId || (video as any).user_id || "") : "";

  const [subscribed, setSubscribed] = useState(false);
  const [subscriberCount, setSubscriberCount] = useState<number | null>(null);
  const [isSubscribing, setIsSubscribing] = useState(false);
  const [isSelfChannel, setIsSelfChannel] = useState(false);

  useEffect(() => {
    if (!video || !creatorUserId) return;
    let mounted = true;
    api.channel
      .getStatus(creatorUserId)
      .then((res) => {
        if (mounted && res && res.success) {
          setSubscribed(Boolean(res.subscribed));
          setSubscriberCount(Number(res.subscriber_count) || 0);
          setIsSelfChannel(Boolean(res.is_self));
        }
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, [video, creatorUserId]);

  const handleToggleSubscribe = async () => {
    if (!video || !creatorUserId) return;
    if (isSelfChannel) {
      toast.error("You cannot subscribe to your own channel.");
      return;
    }
    if (isSubscribing) return;
    setIsSubscribing(true);
    try {
      if (subscribed) {
        const res = await api.channel.unsubscribe(creatorUserId);
        if (res && res.success) {
          setSubscribed(false);
          setSubscriberCount(res.subscriber_count);
          toast.success(`Unsubscribed from ${video.channel}.`);
        } else {
          toast.error(res?.error || "Could not unsubscribe.");
        }
      } else {
        const res = await api.channel.subscribe(creatorUserId);
        if (res && res.success) {
          setSubscribed(true);
          setSubscriberCount(res.subscriber_count);
          toast.success(`Subscribed to ${video.channel}!`);
        } else {
          if (
            res?.error?.toLowerCase().includes("authentication") ||
            res?.error?.toLowerCase().includes("sign in")
          ) {
            toast.error("Please sign in to subscribe to channels.");
          } else {
            toast.error(res?.error || "Could not subscribe.");
          }
        }
      }
    } catch (err: any) {
      toast.error(err?.message || "Failed to update subscription.");
    } finally {
      setIsSubscribing(false);
    }
  };

  const [liked, setLiked] = useState(false);
  const [disliked, setDisliked] = useState(false);
  const [saved, setSaved] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [commentText, setCommentText] = useState("");
  const [comments, setComments] = useState<
    Array<{ id: string; n: string; i: string; t: string; time: string; avatar?: string | null }>
  >([
    {
      id: "c1",
      n: "Aria Kapoor",
      i: "AK",
      t: "The pacing on this is perfect. Bookmarked the whole middle section.",
      time: "2 days ago",
    },
    {
      id: "c2",
      n: "Marcus Bell",
      i: "MB",
      t: "Been waiting for this one. The part at 08:12 finally made it click for me.",
      time: "2 days ago",
    },
  ]);

  const [uploadedVideos, setUploadedVideos] = useState<UploadedVideo[]>([]);
  const [uploadedImages, setUploadedImages] = useState<UploadedImage[]>([]);

  useEffect(() => {
    if (!video) return;
    recordWatchedVideoId(video.id);
    fetchUploadedVideos()
      .then((vids) => {
        setUploadedVideos(Array.isArray(vids) ? vids : []);
      })
      .catch((err) => {
        console.error("Error loading videos for related feed:", err);
        setUploadedVideos([]);
      });

    fetchUploadedImages()
      .then((imgs) => {
        if (imgs && imgs.length > 0) setUploadedImages(imgs);
      })
      .catch((err) => console.error("Error loading images for related feed:", err));
  }, [video]);

  if (verifyingAccess) {
    return (
      <div className="grid min-h-screen place-items-center bg-background px-6 text-center font-sans">
        <div className="space-y-3">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
          <p className="text-sm font-medium text-muted-foreground">Verifying video access...</p>
        </div>
      </div>
    );
  }

  if (!video || accessDenied) {
    return <WatchNotFound />;
  }

  const watchLabels = getVideoBadgeLabels(video);

  const allAvailableVideos: Video[] = uploadedVideos
    .filter(isPubliclyCacheableVideo)
    .map(convertUploadedToCatalogVideo);
  const seenRelatedIds = new Set<string>([video.id]);
  const related = allAvailableVideos
    .filter((v) => {
      if (seenRelatedIds.has(v.id)) return false;
      seenRelatedIds.add(v.id);
      return true;
    })
    .slice(0, 10);

  const interleavedRelated = interleaveFeedWithImages(related, uploadedImages, IMAGE_FEED_INTERVAL);

  const handleToggleLike = () => {
    setLiked((v) => !v);
    if (!liked && disliked) setDisliked(false);
  };

  const handleToggleDislike = () => {
    setDisliked((v) => !v);
    if (!disliked && liked) setLiked(false);
  };

  const handleShare = () => {
    const myRefCode = profile?.user_id || user?.id || null;
    const payload = buildVideoSharePayload({
      videoTitle: video.title,
      videoUrl: window.location.href,
      referralCode: myRefCode,
    });
    if (navigator.share) {
      navigator
        .share({ title: payload.title, text: payload.text, url: payload.url })
        .catch(() => {});
    } else {
      navigator.clipboard.writeText(payload.text);
      toast.success(
        myRefCode
          ? "Video & personal referral link copied to clipboard!"
          : "Link copied to clipboard!",
      );
    }
  };

  const handleToggleSave = () => {
    setSaved((prev) => {
      const next = !prev;
      toast.success(next ? "Added to Watch Later!" : "Removed from Watch Later.");
      return next;
    });
  };

  const handleAddComment = (e: React.FormEvent) => {
    e.preventDefault();
    if (!commentText.trim()) return;

    const authorName =
      profile?.channel_name || profile?.full_name || user?.email?.split("@")[0] || "You";
    const authorInitials = authorName.slice(0, 2).toUpperCase();
    const authorAvatar = profile?.channel_logo_url || profile?.avatar_url || null;

    setComments((prev) => [
      {
        id: `c-${Date.now()}`,
        n: authorName,
        i: authorInitials,
        t: commentText.trim(),
        time: "Just now",
        avatar: authorAvatar,
      },
      ...prev,
    ]);
    setCommentText("");
    toast.success("Comment posted!");
  };

  return (
    <div className="min-h-screen bg-background font-sans text-foreground">
      <Navbar onToggleSidebar={() => {}} />

      <main className="mx-auto grid max-w-[1600px] gap-8 px-4 pt-0 pb-24 sm:px-6 lg:grid-cols-[minmax(0,1fr)_400px] lg:pb-10">
        <div className="min-w-0">
          <div className="w-full">
            <FaceTubeVideoPlayer
              key={video.id}
              src={video.videoUrl}
              poster={video.thumb || video.thumbnailUrl}
              title={video.title}
              duration={video.duration}
              contentType={(video as any).contentType || (video as any).content_type}
              autoPlay={true}
              onBack={handleBack}
            />
          </div>

          {/* Back Navigation & Category Bar below player */}
          <div className="mt-3 flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={handleBack}
              className="group inline-flex items-center gap-2 rounded-full border border-border/80 bg-secondary/70 hover:bg-secondary px-3.5 py-1.5 text-xs font-semibold text-foreground transition-all active:scale-95 shadow-xs cursor-pointer"
              aria-label="Back to previous page"
              title="Back to previous page"
            >
              <ArrowLeft className="h-4 w-4 transition-transform group-hover:-translate-x-0.5" />
              <span>Back</span>
            </button>
            {video.category && (
              <span className="text-xs font-medium text-muted-foreground">{video.category}</span>
            )}
          </div>

          <h1 className="mt-2.5 text-xl font-extrabold leading-snug tracking-tight sm:text-2xl">
            {video.title}
          </h1>

          {/* YouTube-style small Ads label immediately below video title */}
          {watchLabels.showAdsLabel && (
            <div className="mt-2 flex items-center gap-2">
              <span className="inline-flex items-center rounded px-2 py-0.5 text-xs font-bold tracking-wide bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30">
                Ads
              </span>
            </div>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <ChannelAvatar
              src={(video as any).channelLogoUrl || (video as any).channel_logo_url}
              name={video.channel}
              initials={video.initials}
              tint={video.tint || "#ef4444"}
              sizeClassName="h-11 w-11"
              imageRingClassName="ring-2 ring-brand/30 shadow-sm"
              fallbackClassName="text-sm font-bold text-white shadow-sm"
            />
            <div className="min-w-0 flex-1 sm:flex-initial">
              <div className="flex items-center gap-1.5 min-w-0">
                <p className="truncate text-sm font-semibold">{video.channel}</p>
                {watchLabels.showSponsorLabel && (
                  <span className="inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30">
                    Sponsored
                  </span>
                )}
              </div>
              <p className="truncate text-xs text-muted-foreground">
                {subscriberCount === null
                  ? "..."
                  : subscriberCount > 0
                    ? `${subscriberCount >= 1000 ? `${(subscriberCount / 1000).toFixed(1)}K` : subscriberCount.toLocaleString()} subscribers`
                    : "0 subscribers"}
              </p>
            </div>
            {!isSelfChannel && (
              <button
                type="button"
                disabled={isSubscribing}
                onClick={handleToggleSubscribe}
                className={`ml-1 rounded-full px-5 py-2 text-sm font-semibold transition ${
                  isSubscribing ? "opacity-60 cursor-not-allowed " : ""
                }${
                  subscribed
                    ? "bg-secondary text-foreground hover:bg-muted"
                    : "bg-brand text-brand-foreground shadow-lift hover:bg-brand-dark"
                }`}
              >
                {isSubscribing ? "..." : subscribed ? "Subscribed" : "Subscribe"}
              </button>
            )}

            <div className="ml-auto flex flex-wrap items-center gap-2">
              <div className="flex items-center overflow-hidden rounded-full bg-secondary">
                <button
                  type="button"
                  onClick={handleToggleLike}
                  className={`flex items-center gap-2 px-4 py-2 text-sm font-medium transition hover:bg-muted ${
                    liked ? "text-brand font-bold" : "text-foreground"
                  }`}
                >
                  <ThumbsUp className={`h-4 w-4 ${liked ? "fill-brand" : ""}`} />
                  {liked ? "24K" : "23K"}
                </button>
                <span className="h-6 w-px bg-border" />
                <button
                  type="button"
                  aria-label="Dislike"
                  onClick={handleToggleDislike}
                  className={`px-4 py-2 transition hover:bg-muted ${
                    disliked ? "text-foreground font-bold" : "text-foreground"
                  }`}
                >
                  <ThumbsDown className={`h-4 w-4 ${disliked ? "fill-foreground" : ""}`} />
                </button>
              </div>

              {/* Share */}
              <button
                type="button"
                onClick={handleShare}
                className="flex items-center gap-2 rounded-full bg-secondary px-4 py-2 text-sm font-medium text-foreground transition hover:bg-muted active:scale-95"
              >
                <Share2 className="h-4 w-4" />
                <span className="hidden sm:inline">Share</span>
              </button>

              {/* Download */}
              <button
                type="button"
                onClick={() => toast.info("Download starting...")}
                className="flex items-center gap-2 rounded-full bg-secondary px-4 py-2 text-sm font-medium text-foreground transition hover:bg-muted active:scale-95"
              >
                <Download className="h-4 w-4" />
                <span className="hidden sm:inline">Download</span>
              </button>

              {/* Save / Watch Later */}
              <button
                type="button"
                onClick={handleToggleSave}
                className={`flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition active:scale-95 ${
                  saved ? "bg-brand text-white" : "bg-secondary text-foreground hover:bg-muted"
                }`}
              >
                <Bookmark className={`h-4 w-4 ${saved ? "fill-white" : ""}`} />
                <span className="hidden sm:inline">{saved ? "Saved" : "Save"}</span>
              </button>
            </div>
          </div>

          <div className="mt-5 rounded-2xl bg-secondary/70 p-4">
            <p className="text-sm font-semibold">
              {video.views} · {video.age} ·{" "}
              <span className="text-brand">#{video.category || "General"}</span>
            </p>
            <p
              className={`mt-2 text-sm leading-relaxed text-foreground/85 ${
                expanded ? "" : "line-clamp-2"
              }`}
            >
              {video.description ||
                `Uploaded by ${video.channel} on FaceTube. Leave a comment below to join the conversation.`}
            </p>
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="mt-2 text-sm font-semibold text-muted-foreground hover:text-foreground"
            >
              {expanded ? "Show less" : "Show more"}
            </button>
          </div>

          <AiVideoSummaryCard
            videoId={video.id}
            visibility={(video as any).visibility || "public"}
          />

          {/* Google AdSense Placement: Non-disruptive watch page responsive banner */}
          <AdSenseAd slotType="watch-banner" format="auto" />

          {/* Interactive Comments Section */}
          <section className="mt-8 space-y-6">
            <div className="flex items-center gap-2">
              <h2 className="text-base font-bold">{comments.length + 1282} Comments</h2>
            </div>

            {/* Add Comment Input Form */}
            <form onSubmit={handleAddComment} className="flex items-start gap-3">
              <ChannelAvatar
                src={profile?.channel_logo_url || profile?.avatar_url}
                name={profile?.channel_name || profile?.full_name || user?.email || "You"}
                initials={(profile?.username || user?.email || "U").charAt(0).toUpperCase()}
                sizeClassName="h-9 w-9"
                imageRingClassName="ring-1 ring-border shadow-sm"
                fallbackClassName="bg-gradient-to-br from-brand to-brand-dark text-xs font-bold text-white shadow-sm"
              />
              <div className="flex-1 space-y-2">
                <input
                  type="text"
                  placeholder="Add a comment..."
                  value={commentText}
                  onChange={(e) => setCommentText(e.target.value)}
                  className="w-full border-b border-border bg-transparent pb-1.5 text-sm text-foreground outline-none transition focus:border-brand"
                />
                {commentText.trim() && (
                  <div className="flex justify-end gap-2 animate-in fade-in">
                    <button
                      type="button"
                      onClick={() => setCommentText("")}
                      className="rounded-full px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      className="inline-flex items-center gap-1.5 rounded-full bg-brand px-4 py-1.5 text-xs font-bold text-white shadow-sm transition hover:bg-brand-dark"
                    >
                      <Send className="h-3 w-3" />
                      Comment
                    </button>
                  </div>
                )}
              </div>
            </form>

            <div className="space-y-5">
              {comments.map((c) => (
                <div key={c.id} className="flex gap-3 animate-in fade-in">
                  <ChannelAvatar
                    src={c.avatar}
                    name={c.n}
                    initials={c.i}
                    sizeClassName="h-9 w-9"
                    imageRingClassName="ring-1 ring-border shadow-sm"
                    fallbackClassName="bg-gradient-to-br from-brand to-brand-dark text-xs font-bold text-brand-foreground"
                  />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold">
                      {c.n} <span className="font-normal text-muted-foreground">· {c.time}</span>
                    </p>
                    <p className="text-sm text-foreground/85 mt-0.5">{c.t}</p>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>

        <aside className="min-w-0">
          {/* Google AdSense Placement: Non-disruptive sidebar rectangle unit */}
          <AdSenseAd slotType="sidebar" format="rectangle" />

          <h2 className="mb-4 text-base font-bold">Related content</h2>
          <div className="grid grid-cols-1 gap-x-5 gap-y-7 sm:grid-cols-2 lg:grid-cols-1">
            {interleavedRelated.map((item) =>
              item.type === "video" ? (
                <VideoCard key={item.feedKey} video={item.data} />
              ) : (
                <ImageCard key={item.feedKey} image={item.data} />
              ),
            )}
          </div>
        </aside>
      </main>

      <AdMobBanner margin={64} />
      <BottomNav />
    </div>
  );
}
