import { createFileRoute, Link } from "@tanstack/react-router";
import { VideoHubLayout } from "@/components/videohub/VideoHubLayout";
import { Footer } from "@/components/videohub/Footer";
import { Film, ShieldCheck, Users, Globe2, Sparkles, CircleHelp } from "lucide-react";

export const Route = createFileRoute("/about")({
  head: () => ({
    meta: [
      { title: "About FaceTube — Creator Video Streaming Platform" },
      {
        name: "description",
        content:
          "Learn about FaceTube's mission, creator ecosystem, content moderation standards, and community-first video streaming platform.",
      },
      { property: "og:title", content: "About FaceTube — Creator Video Streaming Platform" },
      {
        property: "og:description",
        content:
          "Discover how FaceTube empowers independent creators, short-form storytellers, educators, and live streamers.",
      },
    ],
  }),
  component: AboutPage,
});

function AboutPage() {
  return (
    <VideoHubLayout>
      <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8 space-y-10">
        <header className="space-y-4 border-b border-border pb-6">
          <div className="inline-flex items-center gap-2 rounded-full bg-brand/10 px-3 py-1 text-xs font-bold text-brand">
            <Sparkles className="h-3.5 w-3.5" />
            <span>About FaceTube</span>
          </div>
          <h1 className="text-3xl font-black tracking-tight text-foreground sm:text-4xl">
            Built for independent creators and curious viewers
          </h1>
          <p className="text-base leading-relaxed text-muted-foreground">
            FaceTube is a modern video publishing and streaming platform where creators share
            long-form tutorials, documentaries, short-form vertical reels, live streams, and curated
            visual galleries with audiences around the world.
          </p>
        </header>

        <section className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <article className="rounded-2xl border border-border bg-card p-6 shadow-card space-y-2.5">
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-brand/10 text-brand">
              <Film className="h-5 w-5" />
            </div>
            <h2 className="text-lg font-bold text-foreground">Original Creator Publishing</h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Creators can publish HD long-form videos, 9:16 vertical Shorts, and live broadcasts
              with adaptive aspect-ratio playback across desktop, mobile web, and native Android.
            </p>
          </article>

          <article className="rounded-2xl border border-border bg-card p-6 shadow-card space-y-2.5">
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-emerald-500/10 text-emerald-500">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <h2 className="text-lg font-bold text-foreground">Trust, Privacy & Policy Integrity</h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              We uphold clear community standards, respect intellectual property rights, verify
              creator payouts through KYC and ledger audits, and enforce strict anti-spam and
              ad-integrity protections.
            </p>
          </article>

          <article className="rounded-2xl border border-border bg-card p-6 shadow-card space-y-2.5">
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-blue-500/10 text-blue-500">
              <Users className="h-5 w-5" />
            </div>
            <h2 className="text-lg font-bold text-foreground">Transparent Creator Economy</h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Eligible creators can review verified income statements, track referral and affiliate
              performance, and request withdrawals only after ledger settlement and verification.
            </p>
          </article>

          <article className="rounded-2xl border border-border bg-card p-6 shadow-card space-y-2.5">
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-amber-500/10 text-amber-500">
              <Globe2 className="h-5 w-5" />
            </div>
            <h2 className="text-lg font-bold text-foreground">Accessible Across Devices</h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              FaceTube is engineered for fast loading, clean keyboard and touch navigation, light
              and dark themes, and clear categorization so viewers find original educational and
              entertainment content effortlessly.
            </p>
          </article>
        </section>

        <section className="rounded-2xl border border-border bg-secondary/40 p-6 space-y-4">
          <h2 className="text-xl font-bold text-foreground">Editorial & Community Commitment</h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Every public video, Shorts clip, and channel page on FaceTube is subject to our{" "}
            <Link to="/terms" className="font-semibold text-brand hover:underline">
              Terms of Service
            </Link>{" "}
            and{" "}
            <Link to="/privacy" className="font-semibold text-brand hover:underline">
              Privacy Policy
            </Link>
            . We prohibit misleading metadata, unauthorized copyrighted uploads, automated click
            manipulation, and harmful or deceptive content.
          </p>
          <div className="flex flex-wrap gap-3 pt-1">
            <Link
              to="/explore"
              className="rounded-full bg-brand px-5 py-2 text-xs font-bold text-white shadow-lift transition hover:bg-brand-dark"
            >
              Explore Videos
            </Link>
            <Link
              to="/contact"
              className="rounded-full border border-border bg-card px-5 py-2 text-xs font-bold text-foreground transition hover:bg-secondary"
            >
              Contact Team
            </Link>
            <Link
              to="/help"
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-5 py-2 text-xs font-bold text-foreground transition hover:bg-secondary"
            >
              <CircleHelp className="h-3.5 w-3.5 text-brand" />
              Help Center
            </Link>
          </div>
        </section>

        <Footer />
      </div>
    </VideoHubLayout>
  );
}
