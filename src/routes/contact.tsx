import { useState, type FormEvent } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { VideoHubLayout } from "@/components/videohub/VideoHubLayout";
import { Footer } from "@/components/videohub/Footer";
import { Mail, MessageSquare, ShieldAlert, CheckCircle2, CircleHelp } from "lucide-react";

export const Route = createFileRoute("/contact")({
  head: () => ({
    meta: [
      { title: "Contact & Support — FaceTube" },
      {
        name: "description",
        content:
          "Contact the FaceTube team for creator support, copyright notices, privacy requests, or general inquiries.",
      },
      { property: "og:title", content: "Contact & Support — FaceTube" },
      {
        property: "og:description",
        content: "Reach FaceTube support, legal compliance, and creator partnerships.",
      },
    ],
  }),
  component: ContactPage,
});

function ContactPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [topic, setTopic] = useState("General Support");
  const [message, setMessage] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !email.trim() || !message.trim()) {
      setError("Please fill out your name, email address, and message.");
      return;
    }
    setError("");
    setSubmitted(true);
  };

  return (
    <VideoHubLayout>
      <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8 space-y-8">
        <header className="space-y-3 border-b border-border pb-6">
          <div className="inline-flex items-center gap-2 rounded-full bg-brand/10 px-3 py-1 text-xs font-bold text-brand">
            <Mail className="h-3.5 w-3.5" />
            <span>Contact Us</span>
          </div>
          <h1 className="text-3xl font-black tracking-tight text-foreground sm:text-4xl">
            Get in touch with FaceTube
          </h1>
          <p className="text-sm text-muted-foreground max-w-2xl">
            Have a question about creator uploads, content policies, privacy requests, or technical
            playback? Reach our team directly using the channels below.
          </p>
        </header>

        <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
          <div className="space-y-4">
            <div className="rounded-2xl border border-border bg-card p-5 shadow-card space-y-2">
              <div className="flex items-center gap-2 text-sm font-bold text-foreground">
                <Mail className="h-4 w-4 text-brand" />
                <span>Creator & User Support</span>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                For account help, playback feedback, or payouts:
              </p>
              <a
                href="mailto:support@facetube.online"
                className="block text-xs font-bold text-brand hover:underline"
              >
                support@facetube.online
              </a>
            </div>

            <div className="rounded-2xl border border-border bg-card p-5 shadow-card space-y-2">
              <div className="flex items-center gap-2 text-sm font-bold text-foreground">
                <ShieldAlert className="h-4 w-4 text-amber-500" />
                <span>Legal, Privacy & Copyright</span>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                For DMCA takedown requests, trademark reports, or privacy inquiries:
              </p>
              <a
                href="mailto:legal@facetube.online"
                className="block text-xs font-bold text-brand hover:underline"
              >
                legal@facetube.online
              </a>
            </div>

            <div className="rounded-2xl border border-border bg-secondary/40 p-5 space-y-2.5">
              <div className="flex items-center gap-2 text-sm font-bold text-foreground">
                <CircleHelp className="h-4 w-4 text-brand" />
                <span>Quick Resources</span>
              </div>
              <ul className="space-y-1.5 text-xs">
                <li>
                  <Link to="/help" className="text-muted-foreground hover:text-brand">
                    Help & Frequently Asked Questions
                  </Link>
                </li>
                <li>
                  <Link to="/privacy" className="text-muted-foreground hover:text-brand">
                    Privacy Policy & Cookie Choices
                  </Link>
                </li>
                <li>
                  <Link to="/terms" className="text-muted-foreground hover:text-brand">
                    Terms of Service
                  </Link>
                </li>
                <li>
                  <Link to="/about" className="text-muted-foreground hover:text-brand">
                    About FaceTube
                  </Link>
                </li>
              </ul>
            </div>
          </div>

          <div className="md:col-span-2 rounded-2xl border border-border bg-card p-6 shadow-card">
            <div className="flex items-center gap-2 border-b border-border pb-3 mb-5">
              <MessageSquare className="h-4 w-4 text-brand" />
              <h2 className="text-base font-bold text-foreground">Send a Support Message</h2>
            </div>

            {submitted ? (
              <div className="py-10 text-center space-y-3">
                <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-emerald-500/15 text-emerald-500">
                  <CheckCircle2 className="h-6 w-6" />
                </div>
                <h3 className="text-base font-bold text-foreground">Inquiry Prepared</h3>
                <p className="text-xs text-muted-foreground max-w-md mx-auto leading-relaxed">
                  Thank you, {name}. You can also email{" "}
                  <a
                    href={`mailto:support@facetube.online?subject=${encodeURIComponent(`[${topic}] Support Inquiry from ${name}`)}&body=${encodeURIComponent(message)}`}
                    className="font-semibold text-brand hover:underline"
                  >
                    support@facetube.online
                  </a>{" "}
                  directly with your mail client for immediate dispatch.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setSubmitted(false);
                    setMessage("");
                  }}
                  className="rounded-full border border-border px-4 py-1.5 text-xs font-semibold text-foreground hover:bg-secondary cursor-pointer"
                >
                  Send Another Message
                </button>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label htmlFor="contact-name" className="text-xs font-semibold text-foreground">
                      Full Name
                    </label>
                    <input
                      id="contact-name"
                      type="text"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Your name"
                      className="w-full rounded-xl border border-border bg-background px-3.5 py-2.5 text-sm outline-none focus:border-brand"
                      required
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label
                      htmlFor="contact-email"
                      className="text-xs font-semibold text-foreground"
                    >
                      Email Address
                    </label>
                    <input
                      id="contact-email"
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="you@example.com"
                      className="w-full rounded-xl border border-border bg-background px-3.5 py-2.5 text-sm outline-none focus:border-brand"
                      required
                    />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="contact-topic" className="text-xs font-semibold text-foreground">
                    Inquiry Topic
                  </label>
                  <select
                    id="contact-topic"
                    value={topic}
                    onChange={(e) => setTopic(e.target.value)}
                    className="w-full rounded-xl border border-border bg-background px-3.5 py-2.5 text-sm outline-none focus:border-brand"
                  >
                    <option value="General Support">General Support</option>
                    <option value="Creator & Uploads">Creator & Uploads</option>
                    <option value="Monetization & Wallet">Monetization & Wallet</option>
                    <option value="Privacy Request">Privacy Request</option>
                    <option value="Copyright / Content Report">Copyright / Content Report</option>
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label
                    htmlFor="contact-message"
                    className="text-xs font-semibold text-foreground"
                  >
                    Message
                  </label>
                  <textarea
                    id="contact-message"
                    rows={4}
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    placeholder="Describe your question or feedback..."
                    className="w-full rounded-xl border border-border bg-background px-3.5 py-2.5 text-sm outline-none focus:border-brand"
                    required
                  />
                </div>

                {error && <p className="text-xs font-semibold text-red-500">{error}</p>}

                <button
                  type="submit"
                  className="rounded-full bg-brand px-6 py-2.5 text-xs font-bold text-white shadow-lift transition hover:bg-brand-dark cursor-pointer"
                >
                  Submit Inquiry
                </button>
              </form>
            )}
          </div>
        </div>

        <Footer />
      </div>
    </VideoHubLayout>
  );
}
