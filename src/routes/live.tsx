import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, useEffect, useCallback } from "react";
import {
  Radio,
  Users,
  Send,
  Sparkles,
  Share2,
  Heart,
  Search,
  Video,
  DollarSign,
  Plus,
  X,
  MessageSquare,
  Gift,
} from "lucide-react";
import { toast } from "sonner";
import { Logo } from "@/components/videohub/Logo";
import { ThemeToggle } from "@/components/videohub/ThemeToggle";
import { BottomNav } from "@/components/videohub/BottomNav";
import { ChannelAvatar } from "@/components/videohub/ChannelAvatar";
import { LIVE_SUBJECTS, LIVE_CATEGORIES, matchStreamCategory, type LiveStream } from "@/data/live";
import { useAuth } from "@/lib/auth-context";
import { api } from "@/lib/api";
import { LiveKitViewerPlayer } from "@/components/live/LiveKitViewerPlayer";
import { LiveKitBroadcasterStudio } from "@/components/live/LiveKitBroadcasterStudio";

export const Route = createFileRoute("/live")({
  head: () => ({
    meta: [
      { title: "Live Streams — FaceTube" },
      {
        name: "description",
        content:
          "Watch live streams, gaming tournaments, coding sessions, and global events on FaceTube Live.",
      },
    ],
  }),
  component: LivePage,
});

function isMockStreamId(id: string | undefined | null): boolean {
  if (!id) return true;
  const normalized = String(id).trim().toLowerCase();
  return (
    normalized === "" ||
    normalized === "live-default" ||
    normalized === "live_seed_001" ||
    /^live-\d+$/.test(normalized)
  );
}

export function LivePage() {
  const { user, profile } = useAuth();
  const [selectedCategory, setSelectedCategory] = useState("All");
  const [streams, setStreams] = useState<LiveStream[]>([]);
  const [activeStream, setActiveStream] = useState<LiveStream | null>(null);
  const [streamsLoading, setStreamsLoading] = useState(true);
  const [streamsError, setStreamsError] = useState<string | null>(null);
  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState<any[]>([]);
  const [liked, setLiked] = useState(false);
  const [superchatOpen, setSuperchatOpen] = useState(false);
  const [superchatAmount, setSuperchatAmount] = useState(100);
  const [superchatMsg, setSuperchatMsg] = useState("");
  const [createStreamOpen, setCreateStreamOpen] = useState(false);
  const [studioOpen, setStudioOpen] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newCategory, setNewCategory] = useState<string>(LIVE_SUBJECTS[0]);

  // Load real streams from backend
  const loadStreams = useCallback(async () => {
    setStreamsLoading(true);
    setStreamsError(null);
    try {
      const res = await api.live.listStreams();
      const rawStreams = Array.isArray(res?.streams) ? res.streams : [];
      const mapped: LiveStream[] = rawStreams
        .filter(
          (s: any) => s && s.id !== undefined && s.id !== null && !isMockStreamId(String(s.id)),
        )
        .map((s: any) => {
          const pickName = (...values: unknown[]): string => {
            for (const val of values) {
              if (typeof val === "string") {
                const trimmed = val.trim();
                if (
                  trimmed &&
                  trimmed.toLowerCase() !== "null" &&
                  trimmed.toLowerCase() !== "undefined"
                ) {
                  return trimmed;
                }
              }
            }
            return "";
          };
          const primaryCreatorName = pickName(
            s.streamer_name,
            s.creator_name,
            s.channel_name,
            s.channelName,
          );
          return {
            id: String(s.id),
            userId: s.user_id,
            title: s.title,
            streamer: primaryCreatorName || pickName(s.streamer) || "FaceTube Creator",
            streamerHandle: `@${(primaryCreatorName || "creator").toLowerCase().replace(/\s+/g, "")}`,
            initials: (primaryCreatorName || "FT").substring(0, 2).toUpperCase(),
            viewers: `${s.viewers_count || 1} viewers`,
            viewersCount: Number(s.viewers_count) || 1,
            category: s.category || "Coding & Tech",
            tags: ["live", "stream"],
            thumb:
              s.thumbnail_url ||
              "https://images.unsplash.com/photo-1517694712202-14dd9538aa97?w=800",
            isLive: s.status === "live",
            startedTime: s.status === "live" ? "Live now" : "Upcoming",
            channelLogoUrl: s.channel_logo_url || s.channelLogoUrl || s.avatar_url || undefined,
            chatMessages: [],
          };
        });

      setStreams(mapped);
      setActiveStream((prev) => {
        if (mapped.length === 0) {
          return null;
        }
        if (prev && !isMockStreamId(prev.id)) {
          const matching = mapped.find((s) => s.id === prev.id);
          if (matching) return matching;
        }
        return mapped[0] ?? null;
      });
    } catch (err: any) {
      setStreams([]);
      setActiveStream(null);
      setStreamsError(err?.message || "Unable to reach live streams service.");
    } finally {
      setStreamsLoading(false);
    }
  }, []);

  // Load chat messages for active stream
  const loadChat = useCallback(async (streamId: string) => {
    if (!streamId || isMockStreamId(streamId)) {
      setChatMessages([]);
      return;
    }
    try {
      const res = await api.live.getChatMessages(streamId);
      if (res && Array.isArray(res.messages)) {
        setChatMessages(
          res.messages.map((m: any) => ({
            user: m.user_name || m.user,
            text: m.message || m.text,
            isSuperchat: Boolean(m.is_superchat),
            superchatAmount: m.superchat_amount,
            color: m.is_superchat ? "text-amber-400 font-bold" : "text-brand font-bold",
          })),
        );
      }
    } catch {
      // Use existing messages
    }
  }, []);

  useEffect(() => {
    loadStreams();
  }, [loadStreams]);

  useEffect(() => {
    if (activeStream?.id && !isMockStreamId(activeStream.id)) {
      setChatMessages([]);
      loadChat(activeStream.id);
    } else {
      setChatMessages([]);
    }
  }, [activeStream?.id, loadChat]);

  const filteredStreams =
    selectedCategory === "All" || selectedCategory === "All Live"
      ? streams
      : streams.filter((s) => matchStreamCategory(s.category, selectedCategory));

  const handleSelectCategory = (cat: string) => {
    setSelectedCategory(cat);
    const matched =
      cat === "All" || cat === "All Live"
        ? streams
        : streams.filter((s) => matchStreamCategory(s.category, cat));
    if (matched.length > 0 && !matched.some((s) => s.id === activeStream?.id)) {
      if (matched[0]) {
        setActiveStream(matched[0]);
        setChatMessages(matched[0].chatMessages || []);
      }
    }
  };

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeStream || isMockStreamId(activeStream.id) || !chatInput.trim()) return;
    const authorName =
      profile?.channel_name ||
      profile?.full_name ||
      profile?.name ||
      profile?.username ||
      user?.email?.split("@")[0] ||
      "You";

    const newMsg = {
      user: authorName,
      text: chatInput.trim(),
      color: "text-brand font-bold",
    };

    setChatMessages((prev) => [...prev, newMsg]);
    setChatInput("");

    try {
      await api.live.sendChatMessage({
        streamId: activeStream.id,
        message: newMsg.text,
        userName: authorName,
      });
    } catch {
      // Succeeded locally
    }
  };

  const handleSendSuperChat = async () => {
    if (!activeStream || isMockStreamId(activeStream.id)) return;
    const authorName =
      profile?.channel_name ||
      profile?.full_name ||
      profile?.name ||
      user?.email?.split("@")[0] ||
      "SuperFan";

    const text = superchatMsg.trim() || `Sent a ₹${superchatAmount} SuperChat! 🚀`;
    const superMsg = {
      user: authorName,
      text,
      isSuperchat: true,
      superchatAmount,
      color: "text-amber-400 font-bold",
    };

    setChatMessages((prev) => [...prev, superMsg]);
    setSuperchatOpen(false);
    setSuperchatMsg("");
    toast.success(`🎉 SuperChat of ₹${superchatAmount} sent to ${activeStream.streamer}!`);

    try {
      await api.live.sendChatMessage({
        streamId: activeStream.id,
        message: text,
        isSuperchat: true,
        superchatAmount,
        userName: authorName,
      });
    } catch {
      // Done locally
    }
  };

  const currentUserId = user?.id || (user as any)?.user_id;
  const isOwner = Boolean(
    currentUserId &&
    activeStream?.userId &&
    String(currentUserId).toUpperCase() === String(activeStream.userId).toUpperCase(),
  );

  const handleEndActiveStream = async () => {
    if (!activeStream?.id) return;
    try {
      await api.live.endStream({ streamId: activeStream.id });
      toast.success("Broadcast ended successfully.");
      await loadStreams();
    } catch (err: any) {
      toast.error(err?.message || "Failed to end broadcast.");
    }
  };

  const handleCreateStream = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim()) {
      toast.error("Please enter a stream title.");
      return;
    }

    try {
      const res = await api.live.createStream({
        title: newTitle.trim(),
        category: newCategory,
        description: "Official FaceTube Creator Live Broadcast",
      });

      if (res && res.stream) {
        toast.success(`🔴 Broadcast "${newTitle.slice(0, 24)}" created! Launching studio...`);
        setCreateStreamOpen(false);
        setNewTitle("");
        await loadStreams();

        const authorName =
          profile?.channel_name ||
          profile?.full_name ||
          profile?.name ||
          user?.email?.split("@")[0] ||
          "You";

        const newStreamObj: LiveStream = {
          id: String(res.stream.id),
          userId: res.stream.user_id || currentUserId,
          title: res.stream.title,
          streamer: authorName,
          streamerHandle: `@${authorName.toLowerCase().replace(/\s+/g, "")}`,
          initials: authorName.substring(0, 2).toUpperCase(),
          viewers: "1 viewer",
          viewersCount: 1,
          category: res.stream.category || newCategory,
          tags: ["live"],
          thumb:
            res.stream.thumbnail_url ||
            "https://images.unsplash.com/photo-1517694712202-14dd9538aa97?w=800",
          isLive: true,
          startedTime: "Live now",
          chatMessages: [],
        };
        setActiveStream(newStreamObj);
        setStudioOpen(true);
      } else {
        toast.error("Failed to start broadcast.");
      }
    } catch (err: any) {
      toast.error(err?.message || "Failed to start broadcast.");
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground antialiased selection:bg-brand selection:text-white pb-24 md:pb-28">
      {/* Top Navbar */}
      <header className="sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <Logo size={30} />
            <div className="flex items-center gap-1.5 rounded-full bg-red-500/10 px-2.5 py-0.5 text-[11px] font-extrabold uppercase tracking-wider text-red-500">
              <span className="h-2 w-2 rounded-full bg-red-500 animate-pulse" />
              Live
            </div>
          </div>

          <div className="flex items-center gap-2 sm:gap-3">
            <button
              type="button"
              onClick={() => setCreateStreamOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-full bg-red-600 px-3.5 py-1.5 text-xs font-bold text-white shadow-sm transition hover:bg-red-700 active:scale-95"
            >
              <Radio className="h-3.5 w-3.5" />
              <span>Go Live</span>
            </button>
            <ThemeToggle showLabelsOnWide={false} />
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="mx-auto max-w-7xl px-4 sm:px-6 pt-4 space-y-6">
        {/* Category / Subject Filter Pills */}
        <div className="flex items-center gap-2 overflow-x-auto pb-1.5 scrollbar-none">
          {LIVE_CATEGORIES.map((cat) => (
            <button
              key={cat}
              type="button"
              onClick={() => handleSelectCategory(cat)}
              className={`rounded-full px-4 py-1.5 text-xs font-medium transition shrink-0 ${
                selectedCategory === cat
                  ? "bg-brand text-white font-semibold shadow-sm"
                  : "bg-secondary text-muted-foreground hover:text-foreground hover:bg-secondary/80"
              }`}
            >
              {cat}
            </button>
          ))}
        </div>

        {/* Featured Live Stream & Live Chat Split Layout */}
        {activeStream && !isMockStreamId(activeStream.id) ? (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Main Video Stream Container (2 cols) */}
            <div className="lg:col-span-2 space-y-4">
              <LiveKitViewerPlayer
                streamId={activeStream.id}
                streamTitle={activeStream.title}
                isOwner={isOwner}
                disabled={studioOpen}
                thumbnailUrl={activeStream.thumb}
                initialViewers={activeStream.viewersCount || 1}
                onOpenStudio={() => setStudioOpen(true)}
                onEndBroadcast={handleEndActiveStream}
              />

              {/* Stream Information & Actions */}
              <div className="rounded-2xl border border-border bg-card p-5 space-y-4 shadow-sm">
                <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
                  <div className="space-y-1">
                    <h1 className="text-lg sm:text-xl font-black text-foreground leading-snug">
                      {activeStream.title}
                    </h1>
                    <p className="text-xs text-muted-foreground">
                      {activeStream.category} · {activeStream.startedTime}
                    </p>
                  </div>

                  <div className="flex items-center gap-2">
                    {isOwner && (
                      <button
                        type="button"
                        onClick={() => setStudioOpen(true)}
                        className="inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-bold transition border border-brand/40 bg-brand/10 text-brand hover:bg-brand hover:text-white"
                      >
                        <Radio className="h-3.5 w-3.5 animate-pulse" />
                        <span>Studio</span>
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setLiked((l) => !l)}
                      className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-semibold transition border ${
                        liked
                          ? "border-red-500 bg-red-500/10 text-red-500"
                          : "border-border bg-secondary/60 text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <Heart className={`h-3.5 w-3.5 ${liked ? "fill-red-500" : ""}`} />
                      <span>{liked ? "Liked" : "Like"}</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        navigator.clipboard.writeText(window.location.href);
                        toast.success("Stream link copied!");
                      }}
                      className="inline-flex items-center gap-1.5 rounded-full border border-border bg-secondary/60 px-3.5 py-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground transition"
                    >
                      <Share2 className="h-3.5 w-3.5" />
                      <span>Share</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => setSuperchatOpen(true)}
                      className="inline-flex items-center gap-1.5 rounded-full bg-amber-500 hover:bg-amber-400 text-black px-3.5 py-1.5 text-xs font-bold shadow-sm transition active:scale-95"
                    >
                      <Gift className="h-3.5 w-3.5" />
                      <span>SuperChat</span>
                    </button>
                  </div>
                </div>

                {/* Streamer Profile Snippet */}
                <div className="flex items-center justify-between pt-3 border-t border-border">
                  <div className="flex items-center gap-3">
                    <ChannelAvatar
                      src={activeStream.channelLogoUrl}
                      name={activeStream.streamer}
                      initials={activeStream.initials}
                      sizeClassName="h-10 w-10"
                      imageRingClassName="ring-1 ring-border shadow-md"
                      fallbackClassName="bg-brand text-white font-bold text-sm shadow-md"
                    />
                    <div>
                      <h3 className="text-sm font-bold text-foreground">{activeStream.streamer}</h3>
                      <p className="text-xs text-muted-foreground">{activeStream.streamerHandle}</p>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => toast.success(`Subscribed to ${activeStream.streamer}!`)}
                    className="rounded-full bg-foreground text-background px-4 py-1.5 text-xs font-bold hover:opacity-90 transition active:scale-95"
                  >
                    Subscribe
                  </button>
                </div>
              </div>
            </div>

            {/* Live Chat Panel (1 col) */}
            <div className="flex flex-col h-[520px] rounded-2xl border border-border bg-card shadow-sm overflow-hidden">
              <div className="flex items-center justify-between border-b border-border/70 px-4 py-3 bg-secondary/30">
                <div className="flex items-center gap-2">
                  <Radio className="h-4 w-4 text-red-500 animate-pulse" />
                  <span className="text-xs font-bold uppercase tracking-wider text-foreground">
                    Live Chat Stream
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setSuperchatOpen(true)}
                  className="text-[11px] font-bold text-amber-400 bg-amber-400/10 px-2 py-0.5 rounded-md hover:bg-amber-400/20 transition flex items-center gap-1"
                >
                  <DollarSign className="h-3 w-3" /> SuperChat
                </button>
              </div>

              {/* Chat message stream */}
              <div className="flex-1 overflow-y-auto p-4 space-y-3">
                {chatMessages.map((msg, i) => (
                  <div
                    key={i}
                    className={`text-xs leading-relaxed p-2 rounded-xl transition ${
                      msg.isSuperchat
                        ? "bg-gradient-to-r from-amber-500/20 via-card to-card border border-amber-500/40"
                        : "hover:bg-secondary/20"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className={`font-semibold shrink-0 ${msg.color}`}>{msg.user}</span>
                      {msg.isSuperchat && (
                        <span className="rounded-md bg-amber-500 text-black px-1.5 py-0.2 text-[10px] font-black">
                          ₹{msg.superchatAmount}
                        </span>
                      )}
                    </div>
                    <p className="text-foreground/90 break-words mt-0.5">{msg.text}</p>
                  </div>
                ))}
              </div>

              {/* Chat message input */}
              <form
                onSubmit={handleSendMessage}
                className="border-t border-border/70 p-3 bg-background/50 flex gap-2"
              >
                <input
                  type="text"
                  placeholder="Chat as viewer..."
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  className="flex-1 rounded-xl border border-border bg-secondary/40 px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-brand"
                />
                <button
                  type="submit"
                  aria-label="Send message"
                  className="grid h-8 w-8 place-items-center rounded-xl bg-brand text-white transition hover:bg-brand-dark active:scale-95"
                >
                  <Send className="h-3.5 w-3.5" />
                </button>
              </form>
            </div>
          </div>
        ) : (
          <div className="rounded-2xl border border-dashed border-border bg-card/70 p-8 sm:p-12 text-center space-y-4">
            <div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-secondary text-muted-foreground">
              <Radio className={`h-7 w-7 text-red-500 ${streamsLoading ? "animate-pulse" : ""}`} />
            </div>
            <div className="space-y-1.5">
              <h1 className="text-lg sm:text-xl font-black text-foreground">
                {streamsLoading
                  ? "Loading live broadcasts..."
                  : streamsError
                    ? "Live Broadcasts Currently Unavailable"
                    : "No Live Broadcasts Active Right Now"}
              </h1>
              <p className="text-xs sm:text-sm text-muted-foreground max-w-md mx-auto">
                {streamsLoading
                  ? "Checking FaceTube Live for active creator streams."
                  : streamsError
                    ? "Unable to connect to the live streams directory right now. Please try refreshing or start a new broadcast."
                    : "There are no active live streams at the moment. Start your own live broadcast or refresh to check again."}
              </p>
            </div>
            {!streamsLoading && (
              <div className="flex flex-wrap items-center justify-center gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => setCreateStreamOpen(true)}
                  className="inline-flex items-center gap-1.5 rounded-full bg-red-600 px-5 py-2 text-xs font-bold text-white shadow-sm hover:bg-red-700 transition active:scale-95"
                >
                  <Radio className="h-3.5 w-3.5" />
                  <span>Go Live</span>
                </button>
                <button
                  type="button"
                  onClick={loadStreams}
                  className="rounded-full border border-border bg-secondary px-5 py-2 text-xs font-semibold text-foreground hover:bg-secondary/80 transition"
                >
                  Refresh Streams
                </button>
              </div>
            )}
          </div>
        )}

        {/* Other Active Streams Grid */}
        {streams.length > 0 && (
          <section className="pt-4">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-lg font-bold text-foreground">
                  {selectedCategory === "All" || selectedCategory === "All Live"
                    ? "More Live Broadcasts"
                    : `${selectedCategory} Streams`}
                </h2>
                {selectedCategory !== "All" && selectedCategory !== "All Live" && (
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Filtered by subject:{" "}
                    <span className="text-brand font-medium">{selectedCategory}</span>
                  </p>
                )}
              </div>
              <span className="text-xs text-muted-foreground">
                {filteredStreams.length} {filteredStreams.length === 1 ? "broadcast" : "broadcasts"}
              </span>
            </div>

            {filteredStreams.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-border bg-card/60 p-8 text-center space-y-3">
                <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-secondary text-muted-foreground">
                  <Radio className="h-6 w-6 text-brand" />
                </div>
                <div className="space-y-1">
                  <h3 className="text-sm font-bold text-foreground">
                    No active broadcasts in {selectedCategory}
                  </h3>
                  <p className="text-xs text-muted-foreground max-w-sm mx-auto">
                    Be the first creator to go live in this subject, or browse all currently active
                    live streams.
                  </p>
                </div>
                <div className="flex flex-wrap items-center justify-center gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => {
                      setNewCategory(selectedCategory);
                      setCreateStreamOpen(true);
                    }}
                    className="inline-flex items-center gap-1.5 rounded-full bg-red-600 px-4 py-1.5 text-xs font-bold text-white shadow-sm hover:bg-red-700 transition"
                  >
                    <Radio className="h-3.5 w-3.5" />
                    <span>Go Live in {selectedCategory}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSelectCategory("All")}
                    className="rounded-full border border-border bg-secondary px-4 py-1.5 text-xs font-semibold text-foreground hover:bg-secondary/80 transition"
                  >
                    View All Streams
                  </button>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
                {filteredStreams.map((stream) => (
                  <div
                    key={stream.id}
                    onClick={() => {
                      setActiveStream(stream);
                      setChatMessages(stream.chatMessages || []);
                      window.scrollTo({ top: 0, behavior: "smooth" });
                    }}
                    className={`group cursor-pointer rounded-2xl border p-2 transition-all hover:shadow-md ${
                      activeStream?.id === stream.id
                        ? "border-brand bg-brand/5 ring-2 ring-brand/30"
                        : "border-border bg-card hover:border-brand/40"
                    }`}
                  >
                    <div className="relative aspect-video rounded-xl overflow-hidden bg-black mb-2.5">
                      <img
                        src={stream.thumb}
                        alt={stream.title}
                        className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105 opacity-85"
                      />
                      <span className="absolute top-2 left-2 inline-flex items-center gap-1 rounded-md bg-red-600 px-2 py-0.5 text-[10px] font-bold uppercase text-white shadow">
                        Live
                      </span>
                      <span className="absolute bottom-2 right-2 rounded-md bg-black/70 px-2 py-0.5 text-[10px] font-semibold text-white">
                        {stream.viewers}
                      </span>
                    </div>

                    <div className="flex items-start gap-2.5">
                      <ChannelAvatar
                        src={stream.channelLogoUrl}
                        name={stream.streamer}
                        initials={stream.initials}
                        sizeClassName="h-8 w-8"
                        imageRingClassName="ring-1 ring-border"
                        fallbackClassName="bg-brand text-white font-bold text-xs"
                      />
                      <div className="min-w-0 flex-1">
                        <h4 className="text-xs font-bold text-foreground line-clamp-2 group-hover:text-brand transition-colors">
                          {stream.title}
                        </h4>
                        <div className="flex items-center justify-between text-[11px] text-muted-foreground mt-0.5">
                          <span>{stream.streamer}</span>
                          {stream.category && (
                            <span className="text-[10px] rounded-full bg-secondary px-2 py-0.5 text-muted-foreground">
                              {stream.category}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}
      </main>

      {/* SuperChat Modal */}
      {superchatOpen && activeStream && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm animate-in fade-in">
          <div className="w-full max-w-sm rounded-3xl border border-amber-500/40 bg-card p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-border pb-3">
              <div className="flex items-center gap-2">
                <Gift className="h-5 w-5 text-amber-400" />
                <h3 className="text-base font-bold text-foreground">Send SuperChat</h3>
              </div>
              <button
                type="button"
                onClick={() => setSuperchatOpen(false)}
                className="rounded-full p-1 text-muted-foreground hover:bg-secondary"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <p className="text-xs text-muted-foreground">
              Highlight your message in live chat and directly support{" "}
              <strong>{activeStream.streamer}</strong>.
            </p>

            {/* Quick Amount Selector */}
            <div className="grid grid-cols-4 gap-2">
              {[50, 100, 200, 500].map((amt) => (
                <button
                  key={amt}
                  type="button"
                  onClick={() => setSuperchatAmount(amt)}
                  className={`rounded-xl py-2 text-xs font-bold transition ${
                    superchatAmount === amt
                      ? "bg-amber-500 text-black shadow-md ring-2 ring-amber-400/50"
                      : "bg-secondary text-foreground hover:bg-secondary/80"
                  }`}
                >
                  ₹{amt}
                </button>
              ))}
            </div>

            <div>
              <label className="text-xs font-semibold text-muted-foreground">
                Message (Optional)
              </label>
              <input
                type="text"
                placeholder="Awesome live stream! Keep it up! 🚀"
                value={superchatMsg}
                onChange={(e) => setSuperchatMsg(e.target.value)}
                className="mt-1.5 w-full rounded-xl border border-border bg-secondary/50 px-3 py-2 text-xs text-foreground outline-none focus:border-amber-500"
              />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setSuperchatOpen(false)}
                className="rounded-full px-4 py-2 text-xs font-semibold text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSendSuperChat}
                className="rounded-full bg-amber-500 px-5 py-2 text-xs font-bold text-black shadow-lift hover:bg-amber-400 transition"
              >
                Send ₹{superchatAmount} SuperChat
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Go Live Stream Creation Modal */}
      {createStreamOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm animate-in fade-in">
          <div className="w-full max-w-md rounded-3xl border border-red-500/40 bg-card p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-border pb-3">
              <div className="flex items-center gap-2">
                <Radio className="h-5 w-5 text-red-500 animate-pulse" />
                <h3 className="text-base font-bold text-foreground">Launch Live Broadcast</h3>
              </div>
              <button
                type="button"
                onClick={() => setCreateStreamOpen(false)}
                className="rounded-full p-1 text-muted-foreground hover:bg-secondary"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={handleCreateStream} className="space-y-4">
              <div>
                <label className="text-xs font-semibold text-foreground">Broadcast Title *</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Building Next-Gen React Apps Live!"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  className="mt-1.5 w-full rounded-xl border border-border bg-secondary/50 px-3 py-2 text-xs text-foreground outline-none focus:border-brand"
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-foreground">Subject / Category</label>
                <select
                  value={newCategory}
                  onChange={(e) => setNewCategory(e.target.value)}
                  className="mt-1.5 w-full rounded-xl border border-border bg-secondary/50 px-3 py-2 text-xs text-foreground outline-none focus:border-brand"
                >
                  {LIVE_SUBJECTS.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>

              <div className="rounded-xl border border-border bg-secondary/20 p-3 text-xs text-muted-foreground space-y-1">
                <div className="font-semibold text-foreground flex items-center gap-1.5">
                  <Sparkles className="h-3.5 w-3.5 text-brand" />
                  RTMP Stream Key Configured
                </div>
                <p className="font-mono text-[11px] text-muted-foreground">
                  rtmp://live.facetube.app/live/key-ft-{user?.id?.substring(0, 8) || "stream"}
                </p>
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-border">
                <button
                  type="button"
                  onClick={() => setCreateStreamOpen(false)}
                  className="rounded-full px-4 py-2 text-xs font-semibold text-muted-foreground hover:text-foreground"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="rounded-full bg-red-600 px-5 py-2 text-xs font-bold text-white shadow-lift hover:bg-red-500 transition"
                >
                  Start Live Broadcast
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* LiveKit Broadcaster Studio */}
      {activeStream && !isMockStreamId(activeStream.id) && (
        <LiveKitBroadcasterStudio
          streamId={activeStream.id}
          streamTitle={activeStream.title}
          isOpen={studioOpen}
          onClose={() => setStudioOpen(false)}
          onStreamEnded={() => {
            loadStreams();
          }}
        />
      )}

      {/* Mobile Bottom Navigation */}
      <BottomNav />
    </div>
  );
}
