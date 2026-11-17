import { useState, useEffect, useMemo, useCallback } from "react";
import {
  ShieldCheck,
  CheckCircle2,
  XCircle,
  Clock,
  AlertCircle,
  Eye,
  Building2,
  User,
  History,
  RefreshCw,
  Search,
  ExternalLink,
  ChevronLeft,
  ChevronRight,
  FileText,
  AlertTriangle,
} from "lucide-react";
import { api } from "@/lib/api";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

interface KycSubmission {
  id: string;
  type: "personal" | "bank";
  userId: string;
  fullName?: string | undefined;
  accountHolderName?: string | undefined;
  mobile?: string | undefined;
  dob?: string | undefined;
  address?: string | undefined;
  city?: string | undefined;
  state?: string | undefined;
  pincode?: string | undefined;
  nomineeName?: string | undefined;
  nomineeRelation?: string | undefined;
  nomineeMobile?: string | undefined;
  bankName?: string | undefined;
  accountNumber?: string | undefined;
  ifscCode?: string | undefined;
  branchName?: string | undefined;
  accountType?: string | undefined;
  upiId?: string | undefined;
  upiQrCodeUrl?: string | undefined;
  status: string;
  reviewedBy?: string | null | undefined;
  reviewedAt?: string | null | undefined;
  adminNote?: string | null | undefined;
  rejectionReason?: string | null | undefined;
  submittedAt: string;
  updatedAt: string;
}

interface KycStats {
  totalPending: number;
  pendingPersonal: number;
  pendingBank: number;
  totalVerified: number;
  totalRejected: number;
  totalSubmissions: number;
}

interface KycAuditLog {
  id: string;
  kycType: string;
  kycId: string;
  userId: string;
  action: string;
  previousStatus: string;
  newStatus: string;
  adminNote: string | null;
  rejectionReason: string | null;
  reviewedBy: string;
  reviewedAt: string;
  createdAt: string;
}

interface AdminKycReviewTabProps {
  onStatsUpdate?: ((stats: KycStats) => void) | undefined;
}

export function AdminKycReviewTab({ onStatsUpdate }: AdminKycReviewTabProps) {
  // Navigation sub-view: submissions vs audit trail
  const [currentView, setCurrentView] = useState<"submissions" | "audit">("submissions");

  // Filters
  const [typeFilter, setTypeFilter] = useState<"all" | "personal" | "bank">("all");
  const [statusFilter, setStatusFilter] = useState<string>("submitted");
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(1);
  const limit = 15;

  // Data states
  const [submissions, setSubmissions] = useState<KycSubmission[]>([]);
  const [stats, setStats] = useState<KycStats>({
    totalPending: 0,
    pendingPersonal: 0,
    pendingBank: 0,
    totalVerified: 0,
    totalRejected: 0,
    totalSubmissions: 0,
  });
  const [pagination, setPagination] = useState({
    page: 1,
    limit: 15,
    totalItems: 0,
    totalPages: 1,
  });
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Review & Dialog states
  const [inspectingItem, setInspectingItem] = useState<KycSubmission | null>(null);
  const [rejectingItem, setRejectingItem] = useState<KycSubmission | null>(null);
  const [approvingItem, setApprovingItem] = useState<KycSubmission | null>(null);
  const [rejectionReason, setRejectionReason] = useState("");
  const [adminNote, setAdminNote] = useState("");
  const [isSubmittingReview, setIsSubmittingReview] = useState(false);

  // Audit History states
  const [auditLogs, setAuditLogs] = useState<KycAuditLog[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditFilterAction, setAuditFilterAction] = useState<"all" | "approved" | "rejected">(
    "all",
  );
  const [auditPage, setAuditPage] = useState(1);
  const [auditPagination, setAuditPagination] = useState({
    page: 1,
    limit: 20,
    totalItems: 0,
    totalPages: 1,
  });

  // Load Submissions
  const fetchSubmissions = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await api.admin.listKycSubmissions({
        type: typeFilter,
        status: statusFilter,
        search: searchQuery.trim(),
        page,
        limit,
      });

      if (res && res.success) {
        setSubmissions(res.submissions || []);
        if (res.stats) {
          setStats(res.stats);
          onStatsUpdate?.(res.stats);
        }
        if (res.pagination) {
          setPagination(res.pagination);
        }
      } else {
        throw new Error((res as any)?.error || "Failed to retrieve KYC submissions.");
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Error loading KYC submissions.";
      setError(msg);
      toast.error(msg);
    } finally {
      setIsLoading(false);
    }
  }, [typeFilter, statusFilter, searchQuery, page, limit, onStatsUpdate]);

  // Load Audit Trail
  const fetchAuditHistory = useCallback(async () => {
    setAuditLoading(true);
    try {
      const res = await api.admin.getKycAuditHistory({
        action: auditFilterAction,
        page: auditPage,
        limit: 20,
      });

      if (res && res.success) {
        setAuditLogs(res.auditLogs || []);
        if (res.pagination) {
          setAuditPagination(res.pagination);
        }
      } else {
        toast.error("Failed to load KYC audit history.");
      }
    } catch (err) {
      console.error("Failed to fetch KYC audit history:", err);
    } finally {
      setAuditLoading(false);
    }
  }, [auditFilterAction, auditPage]);

  // Initial & Dependency Fetch
  useEffect(() => {
    if (currentView === "submissions") {
      fetchSubmissions();
    } else {
      fetchAuditHistory();
    }
  }, [currentView, fetchSubmissions, fetchAuditHistory]);

  // Reset page when filters change
  const handleTypeChange = (t: "all" | "personal" | "bank") => {
    setTypeFilter(t);
    setPage(1);
  };

  const handleStatusChange = (st: string) => {
    setStatusFilter(st);
    setPage(1);
  };

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
    fetchSubmissions();
  };

  // Approve action handler
  const handleConfirmApproval = async () => {
    if (!approvingItem) return;
    setIsSubmittingReview(true);
    try {
      const reviewPayload: {
        type: "personal" | "bank";
        userId: string;
        decision: "approved";
        adminNote?: string;
      } = {
        type: approvingItem.type,
        userId: approvingItem.userId,
        decision: "approved",
      };
      if (adminNote.trim()) {
        reviewPayload.adminNote = adminNote.trim();
      }
      const res = await api.admin.reviewKycSubmission(reviewPayload);

      if (res && res.success) {
        toast.success(
          `KYC ${approvingItem.type.toUpperCase()} for ${approvingItem.userId} approved successfully!`,
        );
        setApprovingItem(null);
        setAdminNote("");
        fetchSubmissions();
      } else {
        toast.error(res?.error || "Failed to approve KYC submission.");
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Error approving KYC submission.";
      toast.error(msg);
    } finally {
      setIsSubmittingReview(false);
    }
  };

  // Reject action handler
  const handleConfirmRejection = async () => {
    if (!rejectingItem) return;
    if (!rejectionReason.trim()) {
      toast.error("A mandatory rejection reason is required.");
      return;
    }

    setIsSubmittingReview(true);
    try {
      const reviewPayload: {
        type: "personal" | "bank";
        userId: string;
        decision: "rejected";
        rejectionReason: string;
        adminNote?: string;
      } = {
        type: rejectingItem.type,
        userId: rejectingItem.userId,
        decision: "rejected",
        rejectionReason: rejectionReason.trim(),
      };
      if (adminNote.trim()) {
        reviewPayload.adminNote = adminNote.trim();
      }
      const res = await api.admin.reviewKycSubmission(reviewPayload);

      if (res && res.success) {
        toast.success(
          `KYC ${rejectingItem.type.toUpperCase()} for ${rejectingItem.userId} rejected. Creator has been notified.`,
        );
        setRejectingItem(null);
        setRejectionReason("");
        setAdminNote("");
        fetchSubmissions();
      } else {
        toast.error(res?.error || "Failed to reject KYC submission.");
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Error rejecting KYC submission.";
      toast.error(msg);
    } finally {
      setIsSubmittingReview(false);
    }
  };

  return (
    <section className="mt-6 space-y-6">
      {/* 1. KPI COUNTER CARDS */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <div className="rounded-2xl border border-amber-500/20 bg-amber-500/5 p-4 shadow-sm transition hover:border-amber-500/40">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-amber-500">
              Total Pending
            </span>
            <Clock className="h-4 w-4 text-amber-500" />
          </div>
          <div className="mt-2 text-2xl font-bold tracking-tight text-foreground">
            {stats.totalPending.toLocaleString("en-IN")}
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">Requires admin review</p>
        </div>

        <div className="rounded-2xl border border-blue-500/20 bg-blue-500/5 p-4 shadow-sm transition hover:border-blue-500/40">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-blue-500">
              Pending Personal
            </span>
            <User className="h-4 w-4 text-blue-500" />
          </div>
          <div className="mt-2 text-2xl font-bold tracking-tight text-foreground">
            {stats.pendingPersonal.toLocaleString("en-IN")}
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">ID & Address proofs</p>
        </div>

        <div className="rounded-2xl border border-indigo-500/20 bg-indigo-500/5 p-4 shadow-sm transition hover:border-indigo-500/40">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-indigo-500">
              Pending Bank
            </span>
            <Building2 className="h-4 w-4 text-indigo-500" />
          </div>
          <div className="mt-2 text-2xl font-bold tracking-tight text-foreground">
            {stats.pendingBank.toLocaleString("en-IN")}
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">Bank & UPI verification</p>
        </div>

        <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-4 shadow-sm transition hover:border-emerald-500/40">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-emerald-500">
              Total Verified
            </span>
            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
          </div>
          <div className="mt-2 text-2xl font-bold tracking-tight text-foreground">
            {stats.totalVerified.toLocaleString("en-IN")}
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">Eligible for payouts</p>
        </div>

        <div className="rounded-2xl border border-rose-500/20 bg-rose-500/5 p-4 shadow-sm transition hover:border-rose-500/40">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-rose-500">
              Total Rejected
            </span>
            <XCircle className="h-4 w-4 text-rose-500" />
          </div>
          <div className="mt-2 text-2xl font-bold tracking-tight text-foreground">
            {stats.totalRejected.toLocaleString("en-IN")}
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">Resubmission required</p>
        </div>
      </div>

      {/* 2. SUB-VIEW SELECTOR & CONTROLS */}
      <div className="rounded-2xl border border-border bg-card p-4 shadow-card">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setCurrentView("submissions")}
              className={`flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-bold transition ${
                currentView === "submissions"
                  ? "bg-brand text-brand-foreground shadow-sm"
                  : "bg-secondary/60 text-muted-foreground hover:bg-secondary hover:text-foreground"
              }`}
            >
              <ShieldCheck className="h-4 w-4" />
              <span>KYC Submissions ({stats.totalPending} Pending)</span>
            </button>

            <button
              type="button"
              onClick={() => setCurrentView("audit")}
              className={`flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-bold transition ${
                currentView === "audit"
                  ? "bg-brand text-brand-foreground shadow-sm"
                  : "bg-secondary/60 text-muted-foreground hover:bg-secondary hover:text-foreground"
              }`}
            >
              <History className="h-4 w-4" />
              <span>Immutable Audit Ledger</span>
            </button>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                if (currentView === "submissions") fetchSubmissions();
                else fetchAuditHistory();
              }}
              disabled={isLoading || auditLoading}
              className="inline-flex items-center gap-1.5 rounded-xl border border-input bg-background px-3 py-2 text-xs font-medium text-foreground transition hover:bg-accent disabled:opacity-50"
              title="Refresh Records"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${isLoading || auditLoading ? "animate-spin" : ""}`}
              />
              <span>Refresh</span>
            </button>
          </div>
        </div>

        {/* 3. FILTERS FOR SUBMISSIONS VIEW */}
        {currentView === "submissions" && (
          <div className="mt-4 border-t border-border pt-4">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              {/* Type & Status pills */}
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold text-muted-foreground">Type:</span>
                <div className="inline-flex rounded-lg border border-border bg-muted/40 p-0.5">
                  {(["all", "personal", "bank"] as const).map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => handleTypeChange(t)}
                      className={`rounded-md px-2.5 py-1 text-xs font-medium capitalize transition ${
                        typeFilter === t
                          ? "bg-background text-foreground shadow-xs"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {t === "all" ? "All Types" : t}
                    </button>
                  ))}
                </div>

                <span className="ml-2 text-xs font-semibold text-muted-foreground">Status:</span>
                <div className="inline-flex rounded-lg border border-border bg-muted/40 p-0.5">
                  {[
                    { id: "submitted", label: "Pending Review" },
                    { id: "verified", label: "Verified" },
                    { id: "rejected", label: "Rejected" },
                    { id: "all", label: "All" },
                  ].map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => handleStatusChange(s.id)}
                      className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
                        statusFilter === s.id
                          ? "bg-background text-foreground shadow-xs"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Search Bar */}
              <form onSubmit={handleSearchSubmit} className="relative w-full md:w-64">
                <Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search user, name, bank, UPI..."
                  className="w-full rounded-xl border border-input bg-background pl-9 pr-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                />
              </form>
            </div>
          </div>
        )}

        {/* 3B. FILTERS FOR AUDIT HISTORY VIEW */}
        {currentView === "audit" && (
          <div className="mt-4 border-t border-border pt-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold text-muted-foreground">Action:</span>
              <div className="inline-flex rounded-lg border border-border bg-muted/40 p-0.5">
                {(["all", "approved", "rejected"] as const).map((a) => (
                  <button
                    key={a}
                    type="button"
                    onClick={() => {
                      setAuditFilterAction(a);
                      setAuditPage(1);
                    }}
                    className={`rounded-md px-2.5 py-1 text-xs font-medium capitalize transition ${
                      auditFilterAction === a
                        ? "bg-background text-foreground shadow-xs"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {a === "all" ? "All Decisions" : a}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 4. SUBMISSIONS TABLE VIEW */}
      {currentView === "submissions" && (
        <div className="rounded-2xl border border-border bg-card shadow-card overflow-hidden">
          {/* Error Banner */}
          {error && (
            <div className="flex items-center justify-between border-b border-destructive/20 bg-destructive/10 px-6 py-3 text-xs text-destructive">
              <div className="flex items-center gap-2">
                <AlertCircle className="h-4 w-4" />
                <span>{error}</span>
              </div>
              <button
                type="button"
                onClick={fetchSubmissions}
                className="font-bold underline hover:opacity-80"
              >
                Retry
              </button>
            </div>
          )}

          {/* Loading Skeleton */}
          {isLoading && (
            <div className="p-8 space-y-4">
              <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground py-10">
                <RefreshCw className="h-5 w-5 animate-spin text-brand" />
                <span>Loading creator KYC submissions...</span>
              </div>
            </div>
          )}

          {/* Empty State */}
          {!isLoading && !error && submissions.length === 0 && (
            <div className="p-12 text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted/50 text-muted-foreground">
                <ShieldCheck className="h-6 w-6" />
              </div>
              <h3 className="mt-3 text-sm font-bold text-foreground">No KYC Submissions Found</h3>
              <p className="mt-1 text-xs text-muted-foreground max-w-sm mx-auto">
                No submissions matched the selected type (
                <span className="capitalize">{typeFilter}</span>) and status filter (
                <span className="capitalize">{statusFilter}</span>).
              </p>
              <div className="mt-4">
                <button
                  type="button"
                  onClick={() => {
                    setTypeFilter("all");
                    setStatusFilter("all");
                    setSearchQuery("");
                  }}
                  className="rounded-xl border border-input bg-background px-4 py-2 text-xs font-semibold hover:bg-accent"
                >
                  Clear Filters
                </button>
              </div>
            </div>
          )}

          {/* Populated Table */}
          {!isLoading && !error && submissions.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-border bg-muted/30 text-muted-foreground font-semibold">
                    <th className="px-5 py-3">Creator / User ID</th>
                    <th className="px-4 py-3">Type</th>
                    <th className="px-4 py-3">Details Summary</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Submitted At</th>
                    <th className="px-5 py-3 text-right">Review Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {submissions.map((sub) => {
                    const isPending =
                      sub.status.toLowerCase() === "submitted" ||
                      sub.status.toLowerCase() === "pending";
                    const isVerified = sub.status.toLowerCase() === "verified";
                    const isRejected = sub.status.toLowerCase() === "rejected";

                    return (
                      <tr key={sub.id} className="hover:bg-muted/20 transition">
                        {/* Creator */}
                        <td className="px-5 py-3.5">
                          <div className="font-mono font-bold text-foreground flex items-center gap-1.5">
                            <span className="rounded bg-secondary px-1.5 py-0.5 text-[11px]">
                              {sub.userId}
                            </span>
                          </div>
                          <div className="mt-0.5 text-xs text-muted-foreground">
                            {sub.type === "personal"
                              ? sub.fullName || "Name not specified"
                              : sub.accountHolderName || "Holder not specified"}
                          </div>
                        </td>

                        {/* Type */}
                        <td className="px-4 py-3.5">
                          {sub.type === "personal" ? (
                            <span className="inline-flex items-center gap-1 rounded-md bg-blue-500/10 px-2 py-0.5 text-[11px] font-semibold text-blue-400">
                              <User className="h-3 w-3" />
                              <span>Personal</span>
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 rounded-md bg-indigo-500/10 px-2 py-0.5 text-[11px] font-semibold text-indigo-400">
                              <Building2 className="h-3 w-3" />
                              <span>Bank KYC</span>
                            </span>
                          )}
                        </td>

                        {/* Details Summary */}
                        <td className="px-4 py-3.5 max-w-xs">
                          {sub.type === "personal" ? (
                            <div className="space-y-0.5 text-muted-foreground">
                              {sub.mobile && (
                                <div className="text-[11px]">Mobile: {sub.mobile}</div>
                              )}
                              {sub.city && sub.state && (
                                <div className="text-[11px] truncate">
                                  {sub.city}, {sub.state}
                                </div>
                              )}
                              {sub.nomineeName && (
                                <div className="text-[10px] text-muted-foreground/75 truncate">
                                  Nominee: {sub.nomineeName} ({sub.nomineeRelation || "Relative"})
                                </div>
                              )}
                            </div>
                          ) : (
                            <div className="space-y-0.5 text-muted-foreground">
                              {sub.bankName && (
                                <div className="text-[11px] font-medium text-foreground">
                                  {sub.bankName}
                                </div>
                              )}
                              {sub.accountNumber && (
                                <div className="text-[11px] font-mono">
                                  A/C: {sub.accountNumber}
                                </div>
                              )}
                              {sub.ifscCode && (
                                <div className="text-[10px] font-mono">IFSC: {sub.ifscCode}</div>
                              )}
                              {sub.upiId && (
                                <div className="text-[10px] text-emerald-400/90 font-mono truncate">
                                  UPI: {sub.upiId}
                                </div>
                              )}
                            </div>
                          )}
                        </td>

                        {/* Status */}
                        <td className="px-4 py-3.5">
                          {isVerified && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-[11px] font-bold text-emerald-400">
                              <CheckCircle2 className="h-3 w-3" />
                              <span>Verified</span>
                            </span>
                          )}
                          {isPending && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2.5 py-0.5 text-[11px] font-bold text-amber-400">
                              <Clock className="h-3 w-3" />
                              <span>Submitted</span>
                            </span>
                          )}
                          {isRejected && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-rose-500/10 px-2.5 py-0.5 text-[11px] font-bold text-rose-400">
                              <XCircle className="h-3 w-3" />
                              <span>Rejected</span>
                            </span>
                          )}
                        </td>

                        {/* Submitted / Updated At */}
                        <td className="px-4 py-3.5 text-muted-foreground text-[11px]">
                          <div>
                            {new Date(sub.submittedAt).toLocaleDateString("en-IN", {
                              month: "short",
                              day: "numeric",
                              year: "numeric",
                            })}
                          </div>
                          <div className="text-[10px] text-muted-foreground/75">
                            {new Date(sub.submittedAt).toLocaleTimeString("en-IN", {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </div>
                        </td>

                        {/* Actions */}
                        <td className="px-5 py-3.5 text-right space-x-1.5 whitespace-nowrap">
                          {/* Inspect Full Details Button */}
                          <button
                            type="button"
                            onClick={() => setInspectingItem(sub)}
                            className="inline-flex items-center gap-1 rounded-lg border border-input bg-background px-2.5 py-1.5 text-xs font-semibold text-foreground hover:bg-accent transition"
                            title="Inspect creator KYC details and documents"
                          >
                            <Eye className="h-3 w-3" />
                            <span>Inspect</span>
                          </button>

                          {/* Action Buttons for Pending Submissions */}
                          {isPending && (
                            <>
                              <button
                                type="button"
                                onClick={() => setApprovingItem(sub)}
                                className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-emerald-500 transition shadow-xs"
                              >
                                <CheckCircle2 className="h-3 w-3" />
                                <span>Approve</span>
                              </button>

                              <button
                                type="button"
                                onClick={() => setRejectingItem(sub)}
                                className="inline-flex items-center gap-1 rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-rose-500 transition shadow-xs"
                              >
                                <XCircle className="h-3 w-3" />
                                <span>Reject</span>
                              </button>
                            </>
                          )}

                          {/* Reviewed Info Pill */}
                          {!isPending && sub.reviewedBy && (
                            <span
                              className="text-[10px] text-muted-foreground/80 italic ml-1"
                              title={`Reviewed by ${sub.reviewedBy}`}
                            >
                              Reviewed
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Pagination Controls */}
          {!isLoading && pagination.totalPages > 1 && (
            <div className="flex items-center justify-between border-t border-border px-5 py-3 text-xs text-muted-foreground">
              <div>
                Showing {(page - 1) * limit + 1} to {Math.min(page * limit, pagination.totalItems)}{" "}
                of {pagination.totalItems} submissions
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1}
                  className="rounded-lg border border-input bg-background p-1.5 hover:bg-accent disabled:opacity-40"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </button>
                <span className="px-2 font-medium text-foreground">
                  Page {page} of {pagination.totalPages}
                </span>
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.min(pagination.totalPages, p + 1))}
                  disabled={page >= pagination.totalPages}
                  className="rounded-lg border border-input bg-background p-1.5 hover:bg-accent disabled:opacity-40"
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 5. AUDIT HISTORY VIEW */}
      {currentView === "audit" && (
        <div className="rounded-2xl border border-border bg-card shadow-card overflow-hidden">
          {auditLoading && (
            <div className="p-8 text-center text-xs text-muted-foreground flex items-center justify-center gap-2">
              <RefreshCw className="h-4 w-4 animate-spin text-brand" />
              <span>Loading audit ledger...</span>
            </div>
          )}

          {!auditLoading && auditLogs.length === 0 && (
            <div className="p-12 text-center text-muted-foreground">
              <History className="h-8 w-8 mx-auto text-muted-foreground/60" />
              <p className="mt-2 text-xs font-semibold">No audit entries found.</p>
              <p className="text-[11px] text-muted-foreground/75">
                Administrative review decisions will automatically appear here.
              </p>
            </div>
          )}

          {!auditLoading && auditLogs.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-border bg-muted/30 text-muted-foreground font-semibold">
                    <th className="px-5 py-3">Timestamp</th>
                    <th className="px-4 py-3">Decision</th>
                    <th className="px-4 py-3">Creator / User ID</th>
                    <th className="px-4 py-3">Type</th>
                    <th className="px-4 py-3">Status Transition</th>
                    <th className="px-4 py-3">Reviewer Admin</th>
                    <th className="px-5 py-3">Notes & Reason</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {auditLogs.map((log) => {
                    const isApprove = log.action.toLowerCase() === "approved";
                    return (
                      <tr key={log.id} className="hover:bg-muted/20 transition">
                        <td className="px-5 py-3 text-muted-foreground font-mono text-[11px]">
                          {new Date(log.createdAt).toLocaleString("en-IN", {
                            dateStyle: "short",
                            timeStyle: "short",
                          })}
                        </td>
                        <td className="px-4 py-3">
                          {isApprove ? (
                            <span className="inline-flex items-center gap-1 rounded bg-emerald-500/10 px-2 py-0.5 text-[11px] font-bold text-emerald-400">
                              <CheckCircle2 className="h-3 w-3" />
                              <span>Approved</span>
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 rounded bg-rose-500/10 px-2 py-0.5 text-[11px] font-bold text-rose-400">
                              <XCircle className="h-3 w-3" />
                              <span>Rejected</span>
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 font-mono font-bold text-foreground">
                          {log.userId}
                        </td>
                        <td className="px-4 py-3 capitalize text-muted-foreground font-medium">
                          {log.kycType}
                        </td>
                        <td className="px-4 py-3 font-mono text-[11px]">
                          <span className="text-muted-foreground">{log.previousStatus}</span>
                          <span className="mx-1 text-muted-foreground/60">→</span>
                          <span
                            className={
                              isApprove ? "text-emerald-400 font-bold" : "text-rose-400 font-bold"
                            }
                          >
                            {log.newStatus}
                          </span>
                        </td>
                        <td className="px-4 py-3 font-mono text-muted-foreground text-[11px]">
                          {log.reviewedBy}
                        </td>
                        <td className="px-5 py-3 max-w-xs text-muted-foreground">
                          {log.rejectionReason && (
                            <div className="text-rose-400 font-medium text-[11px]">
                              Reason: {log.rejectionReason}
                            </div>
                          )}
                          {log.adminNote && (
                            <div className="text-[10px] text-muted-foreground italic">
                              Note: {log.adminNote}
                            </div>
                          )}
                          {!log.rejectionReason && !log.adminNote && (
                            <span className="text-muted-foreground/50 text-[10px]">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* 6. INSPECTION MODAL (SECURE DETAILS & DOCUMENT VIEW) */}
      <Dialog open={Boolean(inspectingItem)} onOpenChange={() => setInspectingItem(null)}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <div className="flex items-center gap-2">
              <span className="rounded bg-secondary p-1.5 text-foreground">
                {inspectingItem?.type === "personal" ? (
                  <User className="h-4 w-4" />
                ) : (
                  <Building2 className="h-4 w-4" />
                )}
              </span>
              <div>
                <DialogTitle className="text-base font-bold">
                  {inspectingItem?.type === "personal" ? "Personal KYC Review" : "Bank KYC Review"}
                  {" — "}
                  <span className="font-mono text-brand">{inspectingItem?.userId}</span>
                </DialogTitle>
                <DialogDescription className="text-xs">
                  Inspect creator submitted identity and banking credentials.
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          {inspectingItem && (
            <div className="space-y-4 py-2 text-xs">
              {/* Personal KYC Details */}
              {inspectingItem.type === "personal" && (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-3 rounded-xl border border-border bg-muted/20 p-3.5">
                    <div>
                      <span className="text-[11px] text-muted-foreground block">
                        Full Legal Name
                      </span>
                      <span className="font-semibold text-foreground">
                        {inspectingItem.fullName || "Not provided"}
                      </span>
                    </div>
                    <div>
                      <span className="text-[11px] text-muted-foreground block">Mobile Number</span>
                      <span className="font-semibold font-mono text-foreground">
                        {inspectingItem.mobile || "Not provided"}
                      </span>
                    </div>
                    <div>
                      <span className="text-[11px] text-muted-foreground block">Date of Birth</span>
                      <span className="font-semibold text-foreground">
                        {inspectingItem.dob || "Not provided"}
                      </span>
                    </div>
                    <div>
                      <span className="text-[11px] text-muted-foreground block">
                        Submission Status
                      </span>
                      <span className="font-bold text-amber-400 capitalize">
                        {inspectingItem.status}
                      </span>
                    </div>
                  </div>

                  <div className="rounded-xl border border-border bg-muted/20 p-3.5 space-y-2">
                    <span className="text-[11px] font-semibold text-muted-foreground block uppercase tracking-wider">
                      Residential Address
                    </span>
                    <div className="text-foreground font-medium">
                      {inspectingItem.address || "Street address not provided"}
                    </div>
                    <div className="text-muted-foreground">
                      {[inspectingItem.city, inspectingItem.state, inspectingItem.pincode]
                        .filter(Boolean)
                        .join(", ") || "City/State not provided"}
                    </div>
                  </div>

                  <div className="rounded-xl border border-border bg-muted/20 p-3.5">
                    <span className="text-[11px] font-semibold text-muted-foreground block uppercase tracking-wider mb-2">
                      Nominee Information
                    </span>
                    <div className="grid grid-cols-3 gap-2">
                      <div>
                        <span className="text-[10px] text-muted-foreground block">
                          Nominee Name
                        </span>
                        <span className="font-medium text-foreground">
                          {inspectingItem.nomineeName || "None"}
                        </span>
                      </div>
                      <div>
                        <span className="text-[10px] text-muted-foreground block">
                          Relationship
                        </span>
                        <span className="font-medium text-foreground">
                          {inspectingItem.nomineeRelation || "None"}
                        </span>
                      </div>
                      <div>
                        <span className="text-[10px] text-muted-foreground block">
                          Nominee Contact
                        </span>
                        <span className="font-mono text-foreground">
                          {inspectingItem.nomineeMobile || "None"}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Bank KYC Details */}
              {inspectingItem.type === "bank" && (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-3 rounded-xl border border-border bg-muted/20 p-3.5">
                    <div>
                      <span className="text-[11px] text-muted-foreground block">
                        Account Holder Name
                      </span>
                      <span className="font-semibold text-foreground">
                        {inspectingItem.accountHolderName || "Not provided"}
                      </span>
                    </div>
                    <div>
                      <span className="text-[11px] text-muted-foreground block">Bank Name</span>
                      <span className="font-semibold text-foreground">
                        {inspectingItem.bankName || "Not provided"}
                      </span>
                    </div>
                    <div>
                      <span className="text-[11px] text-muted-foreground block">
                        Account Number
                      </span>
                      <span className="font-mono font-semibold text-foreground">
                        {inspectingItem.accountNumber || "Not provided"}
                      </span>
                    </div>
                    <div>
                      <span className="text-[11px] text-muted-foreground block">IFSC Code</span>
                      <span className="font-mono font-semibold text-foreground">
                        {inspectingItem.ifscCode || "Not provided"}
                      </span>
                    </div>
                    <div>
                      <span className="text-[11px] text-muted-foreground block">Branch Name</span>
                      <span className="text-foreground">
                        {inspectingItem.branchName || "Not provided"}
                      </span>
                    </div>
                    <div>
                      <span className="text-[11px] text-muted-foreground block">Account Type</span>
                      <span className="text-foreground">
                        {inspectingItem.accountType || "Saving"}
                      </span>
                    </div>
                  </div>

                  <div className="rounded-xl border border-border bg-muted/20 p-3.5">
                    <span className="text-[11px] font-semibold text-muted-foreground block uppercase tracking-wider mb-1">
                      UPI Payout ID & QR
                    </span>
                    <div className="font-mono text-emerald-400 font-bold">
                      {inspectingItem.upiId || "No UPI ID provided"}
                    </div>

                    {/* QR Code / Document Preview */}
                    <div className="mt-3">
                      <span className="text-[11px] text-muted-foreground block mb-1.5">
                        Uploaded Payout QR / Document
                      </span>
                      {inspectingItem.upiQrCodeUrl ? (
                        <div className="rounded-lg border border-border bg-background p-2 max-w-xs">
                          <img
                            src={inspectingItem.upiQrCodeUrl}
                            alt="Creator UPI QR Document"
                            className="h-44 w-44 object-contain rounded mx-auto"
                            onError={(e) => {
                              // Safe fallback on load error
                              (e.target as HTMLElement).style.display = "none";
                            }}
                          />
                          <div className="mt-2 text-center">
                            <a
                              href={inspectingItem.upiQrCodeUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 text-[11px] text-brand hover:underline font-medium"
                            >
                              <span>View Full Document</span>
                              <ExternalLink className="h-3 w-3" />
                            </a>
                          </div>
                        </div>
                      ) : (
                        <div className="rounded-lg border border-dashed border-border p-3 text-muted-foreground text-center text-[11px]">
                          No document or QR attachment uploaded. Creator relies on direct bank
                          details.
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Review History / Meta */}
              {inspectingItem.reviewedBy && (
                <div className="rounded-xl border border-border bg-secondary/30 p-3 text-xs">
                  <span className="font-semibold text-foreground block mb-1">
                    Previous Review Record
                  </span>
                  <div className="text-muted-foreground">
                    Reviewed by{" "}
                    <span className="font-mono font-bold">{inspectingItem.reviewedBy}</span> on{" "}
                    {inspectingItem.reviewedAt
                      ? new Date(inspectingItem.reviewedAt).toLocaleString("en-IN")
                      : "N/A"}
                    .
                  </div>
                  {inspectingItem.rejectionReason && (
                    <div className="mt-1 text-rose-400 font-medium">
                      Rejection Reason: {inspectingItem.rejectionReason}
                    </div>
                  )}
                  {inspectingItem.adminNote && (
                    <div className="mt-1 text-muted-foreground italic">
                      Admin Note: {inspectingItem.adminNote}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          <DialogFooter className="gap-2 sm:gap-0">
            <button
              type="button"
              onClick={() => setInspectingItem(null)}
              className="rounded-xl border border-input bg-background px-4 py-2 text-xs font-semibold hover:bg-accent"
            >
              Close
            </button>
            {inspectingItem &&
              (inspectingItem.status.toLowerCase() === "submitted" ||
                inspectingItem.status.toLowerCase() === "pending") && (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      const item = inspectingItem;
                      setInspectingItem(null);
                      setRejectingItem(item);
                    }}
                    className="rounded-xl bg-rose-600 px-3.5 py-2 text-xs font-bold text-white hover:bg-rose-500 transition shadow-xs"
                  >
                    Reject
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const item = inspectingItem;
                      setInspectingItem(null);
                      setApprovingItem(item);
                    }}
                    className="rounded-xl bg-emerald-600 px-3.5 py-2 text-xs font-bold text-white hover:bg-emerald-500 transition shadow-xs"
                  >
                    Approve
                  </button>
                </div>
              )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 7. REJECT CONFIRMATION MODAL (MANDATORY REASON) */}
      <Dialog
        open={Boolean(rejectingItem)}
        onOpenChange={(open) => {
          if (!open) {
            setRejectingItem(null);
            setRejectionReason("");
            setAdminNote("");
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <div className="flex items-center gap-2 text-rose-500">
              <AlertTriangle className="h-5 w-5" />
              <DialogTitle className="text-base font-bold text-foreground">
                Reject KYC Submission
              </DialogTitle>
            </div>
            <DialogDescription className="text-xs">
              Rejecting will mark the submission as{" "}
              <span className="font-bold text-rose-500">Rejected</span> and notify creator{" "}
              <span className="font-mono font-bold text-foreground">{rejectingItem?.userId}</span>.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-2 text-xs">
            <div>
              <label className="block text-xs font-semibold text-foreground mb-1">
                Rejection Reason <span className="text-rose-500">*</span>
              </label>
              <textarea
                value={rejectionReason}
                onChange={(e) => setRejectionReason(e.target.value)}
                placeholder="e.g. Document image is blurry, account holder name mismatch, or expired government ID."
                rows={3}
                required
                className="w-full rounded-xl border border-input bg-background p-2.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              />
              <p className="mt-1 text-[11px] text-muted-foreground">
                This explanation is visible to the creator so they can correct and resubmit.
              </p>
            </div>

            <div>
              <label className="block text-xs font-semibold text-foreground mb-1">
                Internal Administrative Note (Optional)
              </label>
              <input
                type="text"
                value={adminNote}
                onChange={(e) => setAdminNote(e.target.value)}
                placeholder="e.g. Verified via SVB portal; phone call verified."
                className="w-full rounded-xl border border-input bg-background px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <button
              type="button"
              onClick={() => {
                setRejectingItem(null);
                setRejectionReason("");
                setAdminNote("");
              }}
              disabled={isSubmittingReview}
              className="rounded-xl border border-input bg-background px-4 py-2 text-xs font-semibold hover:bg-accent disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleConfirmRejection}
              disabled={!rejectionReason.trim() || isSubmittingReview}
              className="rounded-xl bg-rose-600 px-4 py-2 text-xs font-bold text-white hover:bg-rose-500 disabled:opacity-50 transition shadow-xs flex items-center gap-1.5"
            >
              {isSubmittingReview ? (
                <>
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                  <span>Rejecting...</span>
                </>
              ) : (
                <>
                  <XCircle className="h-3.5 w-3.5" />
                  <span>Confirm Rejection</span>
                </>
              )}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 8. APPROVE CONFIRMATION MODAL */}
      <Dialog
        open={Boolean(approvingItem)}
        onOpenChange={(open) => {
          if (!open) {
            setApprovingItem(null);
            setAdminNote("");
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <div className="flex items-center gap-2 text-emerald-500">
              <CheckCircle2 className="h-5 w-5" />
              <DialogTitle className="text-base font-bold text-foreground">
                Approve KYC Submission
              </DialogTitle>
            </div>
            <DialogDescription className="text-xs">
              Mark {approvingItem?.type.toUpperCase()} KYC for creator{" "}
              <span className="font-mono font-bold text-foreground">{approvingItem?.userId}</span>{" "}
              as <span className="font-bold text-emerald-500">Verified</span>.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-2 text-xs">
            <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3 text-muted-foreground">
              Once verified, this submission becomes official and unlocks creator withdrawal
              eligibility.
            </div>

            <div>
              <label className="block text-xs font-semibold text-foreground mb-1">
                Internal Administrative Note (Optional)
              </label>
              <input
                type="text"
                value={adminNote}
                onChange={(e) => setAdminNote(e.target.value)}
                placeholder="e.g. Identity matched government records; verified."
                className="w-full rounded-xl border border-input bg-background px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <button
              type="button"
              onClick={() => {
                setApprovingItem(null);
                setAdminNote("");
              }}
              disabled={isSubmittingReview}
              className="rounded-xl border border-input bg-background px-4 py-2 text-xs font-semibold hover:bg-accent disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleConfirmApproval}
              disabled={isSubmittingReview}
              className="rounded-xl bg-emerald-600 px-4 py-2 text-xs font-bold text-white hover:bg-emerald-500 disabled:opacity-50 transition shadow-xs flex items-center gap-1.5"
            >
              {isSubmittingReview ? (
                <>
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                  <span>Approving...</span>
                </>
              ) : (
                <>
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  <span>Confirm Approval</span>
                </>
              )}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
