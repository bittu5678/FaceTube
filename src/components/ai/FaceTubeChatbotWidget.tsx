import { useState, useRef, useEffect } from "react";
import { Link } from "@tanstack/react-router";
import { MessageSquare, X, Send, Sparkles, Loader2, Lock } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { api } from "@/lib/api";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
}

const QUICK_PROMPTS = [
  "How do I upload a Free or Sponsor video?",
  "How do wallet withdrawals and KYC work?",
  "How do I start a live stream on FaceTube?",
];

export function FaceTubeChatbotWidget() {
  const { user, isLoading: authLoading } = useAuth();
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "welcome",
      role: "assistant",
      text: "Hi! Ask me anything about using FaceTube — uploading videos, live streaming, channel logos, referrals, subscriptions, or KYC & withdrawals.",
    },
  ]);

  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [open, messages, sending]);

  const sendMessage = async (rawText: string) => {
    const trimmed = rawText.trim();
    if (!trimmed || sending || !user) return;

    setErrorMsg(null);
    const userMsg: ChatMessage = {
      id: `u-${Date.now()}`,
      role: "user",
      text: trimmed,
    };

    const historyPayload = messages
      .filter((m) => m.id !== "welcome")
      .slice(-8)
      .map((m) => ({ role: m.role, text: m.text }));

    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setSending(true);

    try {
      const res = await api.ai.chat({
        message: trimmed,
        history: historyPayload,
      });
      if (!res?.success || !res?.reply) {
        throw new Error(res?.error || "Could not get a response right now.");
      }
      setMessages((prev) => [
        ...prev,
        {
          id: `a-${Date.now()}`,
          role: "assistant",
          text: res.reply,
        },
      ]);
    } catch (err: any) {
      setErrorMsg(err?.message || "Assistant is unavailable right now.");
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      {open && (
        <div
          role="dialog"
          aria-label="FaceTube AI Assistant"
          className="fixed bottom-36 right-4 z-50 flex h-[440px] w-[min(360px,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl lg:bottom-20 sm:right-6"
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-border bg-secondary/50 px-4 py-3">
            <div className="flex items-center gap-2">
              <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand/15 text-brand">
                <Sparkles className="h-4 w-4" />
              </span>
              <div>
                <h3 className="text-xs font-bold text-foreground">FaceTube Help AI</h3>
                <p className="text-[10px] text-muted-foreground">
                  Informational guidance · Cannot modify account/payments
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close FaceTube AI Assistant"
              className="rounded-full p-1 text-muted-foreground transition hover:bg-secondary hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {authLoading ? (
            <div className="flex flex-1 items-center justify-center p-6 text-xs text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              <span>Checking session…</span>
            </div>
          ) : !user ? (
            <div className="flex flex-1 flex-col items-center justify-center p-6 text-center space-y-3">
              <div className="grid h-12 w-12 place-items-center rounded-full bg-secondary text-muted-foreground">
                <Lock className="h-5 w-5" />
              </div>
              <p className="text-sm font-bold text-foreground">Sign in required</p>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Sign in to your FaceTube account to ask questions about uploads, monetization, KYC,
                and live streaming.
              </p>
              <Link
                to="/auth"
                onClick={() => setOpen(false)}
                className="rounded-full bg-brand px-5 py-2 text-xs font-semibold text-brand-foreground transition hover:bg-brand-dark"
              >
                Sign in
              </Link>
            </div>
          ) : (
            <>
              {/* Messages */}
              <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-3.5">
                {messages.map((m) => (
                  <div
                    key={m.id}
                    className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
                  >
                    <div
                      className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-xs leading-relaxed whitespace-pre-wrap ${
                        m.role === "user"
                          ? "bg-brand text-brand-foreground"
                          : "bg-secondary text-foreground"
                      }`}
                    >
                      {m.text}
                    </div>
                  </div>
                ))}

                {messages.length <= 1 && (
                  <div className="space-y-1.5 pt-1">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Quick questions
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {QUICK_PROMPTS.map((q) => (
                        <button
                          key={q}
                          type="button"
                          onClick={() => void sendMessage(q)}
                          className="rounded-xl border border-border bg-secondary/40 px-2.5 py-1.5 text-left text-[11px] font-medium text-foreground transition hover:border-brand/50 hover:bg-secondary"
                        >
                          {q}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {sending && (
                  <div className="flex justify-start">
                    <div className="inline-flex items-center gap-1.5 rounded-2xl bg-secondary px-3 py-2 text-xs text-muted-foreground">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      <span>Thinking…</span>
                    </div>
                  </div>
                )}

                {errorMsg && (
                  <p className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] text-red-400">
                    {errorMsg}
                  </p>
                )}
              </div>

              {/* Input */}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void sendMessage(input);
                }}
                className="flex items-center gap-2 border-t border-border p-2.5"
              >
                <input
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  maxLength={1500}
                  placeholder="Ask how FaceTube works…"
                  disabled={sending}
                  className="flex-1 rounded-xl border border-border bg-secondary/40 px-3 py-2 text-xs text-foreground outline-none focus:border-brand"
                />
                <button
                  type="submit"
                  aria-label="Send message"
                  disabled={sending || !input.trim()}
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-brand text-brand-foreground transition hover:bg-brand-dark disabled:opacity-50"
                >
                  <Send className="h-3.5 w-3.5" />
                </button>
              </form>
            </>
          )}
        </div>
      )}

      {/* Floating Toggle Button */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Open FaceTube AI Assistant"
        className="fixed bottom-20 right-4 z-40 inline-flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2.5 text-xs font-bold text-foreground shadow-lg transition hover:border-brand/50 hover:text-brand lg:bottom-6 sm:right-6"
      >
        <MessageSquare className="h-4 w-4 text-brand" />
        <span className="hidden sm:inline">FaceTube AI</span>
      </button>
    </>
  );
}
