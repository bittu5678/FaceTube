import { createFileRoute, Link } from "@tanstack/react-router";
import { VideoHubLayout } from "@/components/videohub/VideoHubLayout";
import { Footer } from "@/components/videohub/Footer";
import { Lock } from "lucide-react";

export const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: [
      { title: "Privacy Policy — FaceTube" },
      {
        name: "description",
        content:
          "Read the FaceTube Privacy Policy covering account data, cookies, Google AdSense advertising disclosures, user choices, and data protection.",
      },
      { property: "og:title", content: "Privacy Policy — FaceTube" },
      {
        property: "og:description",
        content:
          "How FaceTube collects, uses, and protects your information, including third-party advertising cookie disclosures.",
      },
    ],
  }),
  component: PrivacyPolicyPage,
});

function PrivacyPolicyPage() {
  return (
    <VideoHubLayout>
      <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8 space-y-8">
        <header className="space-y-3 border-b border-border pb-6">
          <div className="inline-flex items-center gap-2 rounded-full bg-emerald-500/10 px-3 py-1 text-xs font-bold text-emerald-500">
            <Lock className="h-3.5 w-3.5" />
            <span>Legal & Privacy</span>
          </div>
          <h1 className="text-3xl font-black tracking-tight text-foreground sm:text-4xl">
            Privacy Policy
          </h1>
          <p className="text-xs font-medium text-muted-foreground">
            Effective Date: January 1, 2026 · Last Updated: November 2026
          </p>
        </header>

        <div className="space-y-7 text-sm leading-relaxed text-muted-foreground">
          <section className="space-y-2">
            <h2 className="text-lg font-bold text-foreground">1. Information We Collect</h2>
            <p>
              When you browse, register, or publish content on FaceTube, we collect information
              necessary to operate the platform securely:
            </p>
            <ul className="list-disc pl-5 space-y-1.5">
              <li>
                <strong className="text-foreground">Account Information:</strong> Name, username,
                email address, channel metadata, and authentication session credentials.
              </li>
              <li>
                <strong className="text-foreground">Creator & Payout Details:</strong> Uploaded
                videos, thumbnails, comments, and (for creators requesting payouts) identity and
                bank verification records submitted via our KYC workflow.
              </li>
              <li>
                <strong className="text-foreground">Usage & Device Data:</strong> Browser type,
                IP-derived region, playback interactions, watch history preferences, and diagnostic
                logs used to keep video streaming reliable and prevent fraud.
              </li>
            </ul>
          </section>

          <section className="space-y-2">
            <h2 className="text-lg font-bold text-foreground">
              2. Cookies, Analytics & Google AdSense Advertising
            </h2>
            <p>
              FaceTube uses essential cookies and browser storage for authentication sessions, theme
              preferences (Light/Dark mode), and playback settings.
            </p>
            <p>
              We also partner with third-party advertising providers, including{" "}
              <strong className="text-foreground">Google AdSense</strong> and{" "}
              <strong className="text-foreground">Google AdMob</strong>, to serve ads on eligible
              pages and within the FaceTube Android application:
            </p>
            <ul className="list-disc pl-5 space-y-1.5">
              <li>
                Third-party vendors, including Google, use cookies to serve ads based on a
                user&apos;s prior visits to FaceTube or other websites on the Internet.
              </li>
              <li>
                Google&apos;s use of advertising cookies enables it and its partners to serve ads to
                users based on their visit to this site and/or other sites on the Internet.
              </li>
              <li>
                Users may opt out of personalized advertising by visiting{" "}
                <a
                  href="https://www.google.com/settings/ads"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-semibold text-brand hover:underline"
                >
                  Google Ads Settings
                </a>{" "}
                or visiting{" "}
                <a
                  href="https://www.aboutads.info/choices/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-semibold text-brand hover:underline"
                >
                  aboutads.info
                </a>
                .
              </li>
            </ul>
          </section>

          <section className="space-y-2">
            <h2 className="text-lg font-bold text-foreground">3. How We Use Your Information</h2>
            <p>
              We use collected information solely to deliver and improve FaceTube services,
              authenticate users, process creator payouts and subscriptions, enforce community
              safety, prevent invalid ad clicks or automated abuse, and comply with legal
              obligations. We do not sell user personal data to third parties.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-lg font-bold text-foreground">4. Data Security & Retention</h2>
            <p>
              Account passwords are protected using cryptographic hashing, sensitive payment and KYC
              flows require authenticated server-side verification, and data is retained only as
              long as required for active accounts, legal compliance, and financial ledger
              integrity.
            </p>
          </section>

          <section className="space-y-2">
            <h2 className="text-lg font-bold text-foreground">5. Your Rights & Contact</h2>
            <p>
              You may access, update, or request deletion of your account information at any time.
              For privacy inquiries, data access requests, or advertising cookie questions, please{" "}
              <Link to="/contact" className="font-semibold text-brand hover:underline">
                contact our support team
              </Link>{" "}
              or email{" "}
              <a
                href="mailto:support@facetube.online"
                className="font-semibold text-brand hover:underline"
              >
                support@facetube.online
              </a>
              .
            </p>
          </section>
        </div>

        <Footer />
      </div>
    </VideoHubLayout>
  );
}
