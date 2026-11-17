import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState, useCallback } from "react";
import { Radio, Plus, Play, Calendar, Users, MessageSquare, DollarSign, Tv } from "lucide-react";
import { VideoHubLayout } from "@/components/videohub/VideoHubLayout";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { LiveKitBroadcasterStudio } from "@/components/live/LiveKitBroadcasterStudio";

export const Route = createFileRoute("/live-videos")({
  head: () => ({
    meta: [
      { title: "Live Videos — Your Videos — FaceTube" },
      {
        name: "description",
        content:
          "Manage FaceTube live broadcasts, scheduled streams, RTMP stream keys, and live chat donations.",
      },
    ],
  }),
  component: LiveVideosPage,
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

function LiveVideosPage() {
  const { user } = useAuth();
  const [streamList, setStreamList] = useState<any[]>([]);
  const [studioOpen, setStudioOpen] = useState(false);
  const [activeStudioStream, setActiveStudioStream] = useState<{
    id: string;
    title: string;
  } | null>(null);

  const currentUserId = user?.id || (user as any)?.user_id;

  const loadStreams = useCallback(() => {
    api.live
      .listStreams()
      .then((res) => {
        const rawStreams = Array.isArray(res?.streams) ? res.streams : [];
        const mapped = rawStreams
          .filter(
            (s: any) => s && s.id !== undefined && s.id !== null && !isMockStreamId(String(s.id)),
          )
          .map((s: any) => ({
            id: String(s.id),
            userId: s.user_id,
            title: s.title,
            status: s.status === "live" ? "Live Now" : "Upcoming",
            scheduledFor: s.status === "live" ? "Broadcasting live" : "Scheduled",
            duration: "Live",
            views: `${s.viewers_count || 1} viewers`,
            superchats: "₹655.00",
            thumbnail:
              s.thumbnail_url ||
              "https://images.unsplash.com/photo-1517694712202-14dd9538aa97?w=600",
          }));
        setStreamList(mapped);
      })
      .catch(() => {
        setStreamList([]);
      });
  }, []);

  useEffect(() => {
    loadStreams();
  }, [loadStreams]);
  return (
    <VideoHubLayout>
      <div className="px-4 py-6 sm:px-6 lg:px-8 space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-border pb-4">
          <div className="flex items-center gap-3">
            <div className="grid h-12 w-12 place-items-center rounded-2xl bg-emerald-500/10 text-emerald-400">
              <Radio className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-2xl font-extrabold tracking-tight text-foreground sm:text-3xl">
                Live Videos
              </h1>
              <p className="text-sm text-muted-foreground">
                Live stream control room, RTMP keys, upcoming schedules, and SuperChat donations
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Link
              to="/live"
              className="inline-flex items-center justify-center gap-2 rounded-full border border-border bg-secondary/80 px-4 py-2 text-xs font-bold text-foreground transition hover:bg-secondary active:scale-95"
            >
              <Tv className="h-3.5 w-3.5" />
              Watch Live Feed
            </Link>
            <Link
              to="/live"
              className="inline-flex items-center justify-center gap-2 rounded-full bg-brand px-4 py-2 text-xs font-bold text-white shadow-lift transition hover:bg-brand-dark active:scale-95"
            >
              <Radio className="h-3.5 w-3.5" />
              Go Live Now
            </Link>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div className="rounded-2xl border border-border bg-card p-4 space-y-1 shadow-card">
            <span className="text-xs text-muted-foreground font-medium">Total Live Streams</span>
            <p className="text-2xl font-black text-emerald-400">3</p>
            <p className="text-[11px] text-muted-foreground">1 Upcoming, 2 Past</p>
          </div>
          <div className="rounded-2xl border border-border bg-card p-4 space-y-1 shadow-card">
            <span className="text-xs text-muted-foreground font-medium">SuperChat Earnings</span>
            <p className="text-2xl font-black text-foreground">₹655.00</p>
            <p className="text-[11px] text-emerald-400 font-semibold">Live audience tips</p>
          </div>
          <div className="rounded-2xl border border-border bg-card p-4 space-y-1 shadow-card">
            <span className="text-xs text-muted-foreground font-medium">Total Live Viewers</span>
            <p className="text-2xl font-black text-foreground">37.0K</p>
            <p className="text-[11px] text-muted-foreground">Peak concurrent 1,840</p>
          </div>
          <div className="rounded-2xl border border-border bg-card p-4 space-y-1 shadow-card">
            <span className="text-xs text-muted-foreground font-medium">Stream Health</span>
            <p className="text-2xl font-black text-emerald-400">Excellent</p>
            <p className="text-[11px] text-muted-foreground">1080p60 RTMP ready</p>
          </div>
        </div>

        {/* Streams List */}
        <div className="space-y-4">
          <h2 className="text-base font-extrabold text-foreground">Live Broadcasts & Schedule</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            {streamList.map((stream) => (
              <div
                key={stream.id}
                className="group overflow-hidden rounded-2xl border border-border bg-card shadow-card transition duration-200 hover:-translate-y-1 hover:shadow-lift"
              >
                <div className="relative aspect-video w-full overflow-hidden bg-secondary">
                  <img
                    src={stream.thumbnail}
                    alt={stream.title}
                    className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                    referrerPolicy="no-referrer"
                  />
                  <span
                    className={`absolute top-2 left-2 rounded-md px-2 py-0.5 text-[10px] font-bold shadow-sm flex items-center gap-1 ${
                      stream.status === "Upcoming"
                        ? "bg-amber-500 text-black"
                        : "bg-secondary/90 text-foreground"
                    }`}
                  >
                    <Radio className="h-2.5 w-2.5" /> {stream.status}
                  </span>
                  {stream.duration && (
                    <span className="absolute bottom-2 right-2 rounded-md bg-black/80 px-1.5 py-0.5 text-[10px] font-mono font-bold text-white">
                      {stream.duration}
                    </span>
                  )}
                </div>

                <div className="p-4 space-y-2">
                  <h3 className="line-clamp-2 text-xs font-bold text-foreground leading-snug group-hover:text-brand transition-colors">
                    {stream.title}
                  </h3>
                  <div className="flex items-center justify-between text-[11px] text-muted-foreground pt-2 border-t border-border/60">
                    <span>{stream.scheduledFor}</span>
                    {stream.superchats && (
                      <span className="font-bold text-emerald-400">Tips: {stream.superchats}</span>
                    )}
                  </div>

                  {stream.userId &&
                    currentUserId &&
                    String(stream.userId).toUpperCase() === String(currentUserId).toUpperCase() && (
                      <div className="pt-2">
                        <button
                          type="button"
                          onClick={() => {
                            setActiveStudioStream({ id: stream.id, title: stream.title });
                            setStudioOpen(true);
                          }}
                          className="w-full inline-flex items-center justify-center gap-1.5 rounded-xl bg-brand/10 hover:bg-brand hover:text-white text-brand px-3 py-1.5 text-xs font-bold transition border border-brand/20 active:scale-95"
                        >
                          <Radio className="h-3.5 w-3.5 animate-pulse" />
                          <span>Open Broadcaster Studio</span>
                        </button>
                      </div>
                    )}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* LiveKit Broadcaster Studio */}
        {activeStudioStream && (
          <LiveKitBroadcasterStudio
            streamId={activeStudioStream.id}
            streamTitle={activeStudioStream.title}
            isOpen={studioOpen}
            onClose={() => setStudioOpen(false)}
            onStreamEnded={() => {
              loadStreams();
            }}
          />
        )}
      </div>
    </VideoHubLayout>
  );
}
