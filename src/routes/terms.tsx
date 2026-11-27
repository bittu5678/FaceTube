import { createFileRoute, Link } from "@tanstack/react-router";
import { VideoHubLayout } from "@/components/videohub/VideoHubLayout";
import { Footer } from "@/components/videohub/Footer";
import { ScrollText } from "lucide-react";

export const Route = createFileRoute("/terms")({
  head: () => ({
    meta: [
      { title: "Terms of Service — FaceTube" },
      {
        name: "description",
        content:
          "Read the FaceTube Terms of Service governing platform access, creator content rights, community conduct, copyright, and monetization.",
      },
      { property: "og:title", content: "Terms of Service — FaceTube" },
      {
        property: "og:description",
        content:
          "Platform rules, content ownership, acceptable use, and creator monetization terms on FaceTube.",
      },
    ],
  }),
  component: TermsPage,
});

function TermsPage() {
  return (
    <VideoHubLayout>
      <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8 space-y-8">
        <header className="space-y-3 border-b border-border pb-6">
          <div className="inline-flex items-center gap-2 rounded-full bg-brand/10 px-3 py-1 text-xs font-bold text-brand">
            <ScrollText className="h-3.5 w-3.5" />
            <span>Legal & Terms</span>
          </div>
          <h1 className="text-3xl font-black tracking-tight text-foreground sm:text-4xl">
            Terms of Service
          </h1>
          <p className="text-xs font-medium text-muted-foreground">
            Effective Date: January 1, 2026 · Last Updated: November 2026
          </p>
        </header>

        <div className="space-y-7 text-sm leading-relaxed text-muted-foreground">
          <section className="space-y-2">
            <h2 className="text-lg font-bold text-foreground">1. Acceptance of Terms</h2>
            <p>
              By accessing or using FaceTube, creating a channel, uploading media, or watching
              videos, you agree to be bound by these Terms of Service and our{" "}
              <Link to="/privacy" className="font-semibold text-brand hover:underline">
                Privacy Policy
              </Link>
              . If you do not agree, please discontinue use of the service.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-lg font-bold text-foreground">
              2. Creator Content & Intellectual Property
            </h2>
            <p>
              Creators retain ownership of original videos, audio, and images they upload to
              FaceTube. By publishing public content, you grant FaceTube a non-exclusive, worldwide,
              royalty-free license to host, stream, transcode, and display your content across
              FaceTube services for viewers.
            </p>
            <p>
              You represent and warrant that you hold all necessary rights and permissions for any
              content you upload, and that your uploads do not infringe third-party copyrights,
              trademarks, or privacy rights.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-lg font-bold text-foreground">
              3. Acceptable Use & Prohibited Activity
            </h2>
            <ul className="list-disc pl-5 space-y-1.5">
              <li>
                Do not upload unlawful, abusive, deceptive, sexually explicit, or hateful media.
              </li>
              <li>
                Do not engage in automated view inflation, invalid ad clicks, bot traffic, or
                manipulation of monetization metrics.
              </li>
              <li>
                Do not impersonate other creators, attempt unauthorized account access, or interfere
                with platform security or video delivery infrastructure.
              </li>
            </ul>
          </section>

          <section className="space-y-2">
            <h2 className="text-lg font-bold text-foreground">
              4. Monetization, Finalized Statements & Payouts
            </h2>
            <p>
              Advertising and creator earnings are recorded solely from verified, finalized ledger
              statements after billing cycle settlement and policy review. Pending or disputed
              amounts are never withdrawable. FaceTube reserves the right to withhold or reverse
              payouts tied to policy violations, invalid traffic, or fraudulent transactions.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-lg font-bold text-foreground">5. Moderation & Termination</h2>
            <p>
              We may remove non-compliant videos or suspend accounts that violate these Terms or
              applicable law. To report a copyright issue or appeal a moderation decision, visit our{" "}
              <Link to="/contact" className="font-semibold text-brand hover:underline">
                Contact page
              </Link>
              .
            </p>
          </section>
        </div>

        <Footer />
      </div>
    </VideoHubLayout>
  );
}
