import { api } from "./api";
import { getStoredVideos } from "./video-service";

export type IncomeType =
  | "referral_income"
  | "direct_commission"
  | "global_income"
  | "admin_allocation"
  | "withdrawal"
  | "ads_promotion_fee"
  | "adsense_income"
  | "admob_income"
  | "ad_boost_income"
  | "affiliate_income"
  | "marketing_income";

export interface LedgerTransaction {
  id: string;
  transactionId: string;
  userId: string;
  sourceUserId?: string | undefined;
  sourceUserName?: string | undefined;
  videoId?: string | undefined;
  incomeType: IncomeType;
  amount: number;
  fee?: number | undefined;
  netAmount?: number | undefined;
  status: "settled" | "pending" | "failed";
  specialTag?: "SPECIAL_GLOBAL_RULE" | "SPECIAL_TRANSACTION" | (string & {}) | undefined;
  description: string;
  batchId?: string | undefined;
  batch_id?: string | undefined;
  payoutMethod?: string | undefined;
  payout_method?: string | undefined;
  beneficiaryDetails?: string | undefined;
  beneficiary_details?: string | undefined;
  createdAt: string;
  isStale?: boolean | undefined;
}

export interface UserWallet {
  userId: string;
  balance: number;
  totalEarned: number;
  totalWithdrawn: number;
  referralIncome: number;
  directReferralIncome?: number;
  adBoostIncome?: number;
  adsPromotionIncome?: number;
  globalIncome: number;
  adsenseIncome: number;
  admobIncome?: number;
  affiliateIncome: number;
  updatedAt: string;
  isStale?: boolean | undefined;
}

export interface TotalAdEarningsBreakdown {
  referralIncome: number;
  globalIncome: number;
  adsenseIncome: number;
  admobIncome: number;
  affiliateIncome: number;
  adPromotionIncome: number;
  totalAdEarnings: number;
}

export type AdEarningsBreakdown = TotalAdEarningsBreakdown;
export type UploadOptionsEarningsBreakdown = TotalAdEarningsBreakdown;

export type TotalAdEarningsWalletInput = {
  directReferralIncome?: unknown;
  direct_referral_income?: unknown;
  referralIncome?: unknown;
  referral_income?: unknown;
  globalIncome?: unknown;
  global_income?: unknown;
  adsenseIncome?: unknown;
  adsense_income?: unknown;
  admobIncome?: unknown;
  admob_income?: unknown;
  affiliateIncome?: unknown;
  affiliate_income?: unknown;
  adsPromotionIncome?: unknown;
  adPromotionIncome?: unknown;
  ad_promotion_income?: unknown;
  adBoostIncome?: unknown;
  ad_boost_income?: unknown;
} | null;

export type TotalAdEarningsTransactionInput = {
  id?: unknown;
  transactionId?: unknown;
  transaction_id?: unknown;
  incomeType?: unknown;
  income_type?: unknown;
  type?: unknown;
  purpose?: unknown;
  specialTag?: unknown;
  special_tag?: unknown;
  status?: unknown;
  amount?: unknown;
  description?: unknown;
};

function toFiniteMoney(value: unknown): number {
  if (value === null || value === undefined || value === "") return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.round(parsed * 100) / 100;
}

function nonNegativeMoney(value: unknown): number {
  return Math.max(0, toFiniteMoney(value));
}

function roundMoney2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Canonical calculation helper for combined "Total Ad Earnings" across all six
 * settled creator income streams:
 * 1. Referral Income (Direct Referral)
 * 2. Global Income
 * 3. AdSense Income
 * 4. AdMob Income
 * 5. Affiliate Marketing Income
 * 6. Ad Promotion Income (Ad Boost / 7-level Ads Promotion commissions)
 *
 * Safeguards:
 * - Prefers separated `directReferralIncome` / `direct_referral_income` over legacy `referralIncome`
 *   so Ads Promotion (TX_ADS_L*) commissions are never double-counted in both Referral and Ad Promotion.
 * - Resolves `adPromotionIncome` from one canonical alias chain rather than summing duplicate alias keys.
 * - Excludes `balance`, `totalEarned`, `totalWithdrawn`, pending reserves, and uncredited/negative noise.
 * - When optional ledger `transactions` are supplied, deduplicates by transaction ID, filters to
 *   settled-only credits, and reconciles per stream without ever summing wallet + ledger twice.
 */
export function calculateTotalAdEarnings(
  wallet?: TotalAdEarningsWalletInput,
  transactions?: readonly TotalAdEarningsTransactionInput[] | null,
): TotalAdEarningsBreakdown {
  let referralIncome = nonNegativeMoney(
    wallet?.directReferralIncome ??
      wallet?.direct_referral_income ??
      wallet?.referralIncome ??
      wallet?.referral_income,
  );
  let globalIncome = nonNegativeMoney(wallet?.globalIncome ?? wallet?.global_income);
  let adsenseIncome = nonNegativeMoney(wallet?.adsenseIncome ?? wallet?.adsense_income);
  let admobIncome = nonNegativeMoney(wallet?.admobIncome ?? wallet?.admob_income);
  let affiliateIncome = nonNegativeMoney(wallet?.affiliateIncome ?? wallet?.affiliate_income);
  let adPromotionIncome = nonNegativeMoney(
    wallet?.adsPromotionIncome ??
      wallet?.adPromotionIncome ??
      wallet?.ad_promotion_income ??
      wallet?.adBoostIncome ??
      wallet?.ad_boost_income,
  );

  if (Array.isArray(transactions) && transactions.length > 0) {
    const seenTxKeys = new Set<string>();
    const ledgerTotals = {
      referralIncome: 0,
      globalIncome: 0,
      adsenseIncome: 0,
      admobIncome: 0,
      affiliateIncome: 0,
      adPromotionIncome: 0,
    };
    const hasSettledLedger = {
      referralIncome: false,
      globalIncome: false,
      adsenseIncome: false,
      admobIncome: false,
      affiliateIncome: false,
      adPromotionIncome: false,
    };

    for (const tx of transactions) {
      if (!tx) continue;
      const status = String(tx.status ?? "settled")
        .trim()
        .toLowerCase();
      if (status !== "" && status !== "settled") continue;

      const dedupKey = String(tx.transactionId ?? tx.transaction_id ?? tx.id ?? "")
        .trim()
        .toUpperCase();
      if (dedupKey) {
        if (seenTxKeys.has(dedupKey)) continue;
        seenTxKeys.add(dedupKey);
      }

      const incomeType = String(tx.incomeType ?? tx.income_type ?? tx.type ?? tx.purpose ?? "")
        .trim()
        .toLowerCase();
      const txIdUpper = String(tx.transactionId ?? tx.transaction_id ?? "")
        .trim()
        .toUpperCase();
      const tagUpper = String(tx.specialTag ?? tx.special_tag ?? "")
        .trim()
        .toUpperCase();

      if (txIdUpper.startsWith("TX_REF_PENDING_")) continue;

      const amt = nonNegativeMoney(tx.amount);
      if (amt <= 0) continue;

      const isAdsTx =
        incomeType === "ad_boost_income" ||
        incomeType === "marketing_ads" ||
        txIdUpper.startsWith("TX_ADS_L") ||
        tagUpper.startsWith("ADS_REF_L");

      if (isAdsTx) {
        hasSettledLedger.adPromotionIncome = true;
        ledgerTotals.adPromotionIncome += amt;
      } else if (incomeType === "referral_income" || incomeType === "direct_commission") {
        hasSettledLedger.referralIncome = true;
        ledgerTotals.referralIncome += amt;
      } else if (incomeType === "global_income") {
        hasSettledLedger.globalIncome = true;
        ledgerTotals.globalIncome += amt;
      } else if (incomeType === "adsense_income") {
        hasSettledLedger.adsenseIncome = true;
        ledgerTotals.adsenseIncome += amt;
      } else if (incomeType === "admob_income") {
        hasSettledLedger.admobIncome = true;
        ledgerTotals.admobIncome += amt;
      } else if (incomeType === "affiliate_income" || incomeType === "marketing_income") {
        hasSettledLedger.affiliateIncome = true;
        ledgerTotals.affiliateIncome += amt;
      }
    }

    if (hasSettledLedger.referralIncome) {
      referralIncome = roundMoney2(ledgerTotals.referralIncome);
    }
    if (hasSettledLedger.globalIncome) {
      globalIncome = roundMoney2(ledgerTotals.globalIncome);
    }
    if (hasSettledLedger.adsenseIncome) {
      adsenseIncome = roundMoney2(ledgerTotals.adsenseIncome);
    }
    if (hasSettledLedger.admobIncome) {
      admobIncome = roundMoney2(ledgerTotals.admobIncome);
    }
    if (hasSettledLedger.affiliateIncome) {
      affiliateIncome = roundMoney2(ledgerTotals.affiliateIncome);
    }
    if (hasSettledLedger.adPromotionIncome) {
      adPromotionIncome = roundMoney2(ledgerTotals.adPromotionIncome);
    }
  }

  const totalAdEarnings = roundMoney2(
    referralIncome +
      globalIncome +
      adsenseIncome +
      admobIncome +
      affiliateIncome +
      adPromotionIncome,
  );

  return {
    referralIncome,
    globalIncome,
    adsenseIncome,
    admobIncome,
    affiliateIncome,
    adPromotionIncome,
    totalAdEarnings,
  };
}

export const calculateUploadOptionsTotalEarnings = calculateTotalAdEarnings;

/**
 * Identifies multi-level Ads Promotion commission ledger entries across
 * both canonical ('ad_boost_income') and legacy ('referral_income' with TX_ADS_L* / ADS_REF_L*) schemas.
 */
export function isAdsPromotionTransaction(
  tx: Pick<LedgerTransaction, "incomeType" | "transactionId" | "specialTag">,
): boolean {
  const incomeType = String(tx.incomeType || "")
    .trim()
    .toLowerCase();
  const txId = String(tx.transactionId || "")
    .trim()
    .toUpperCase();
  const specialTag = String(tx.specialTag || "")
    .trim()
    .toUpperCase();

  return (
    incomeType === "ad_boost_income" ||
    incomeType === "marketing_ads" ||
    txId.startsWith("TX_ADS_L") ||
    specialTag.startsWith("ADS_REF_L")
  );
}

/**
 * Extracts level 1-7 from an Ads Promotion transaction when encoded in transactionId or specialTag.
 */
export function extractAdsPromotionLevel(
  tx: Pick<LedgerTransaction, "transactionId" | "specialTag">,
): number | null {
  const txId = String(tx.transactionId || "")
    .trim()
    .toUpperCase();
  const specialTag = String(tx.specialTag || "")
    .trim()
    .toUpperCase();
  const match = txId.match(/^TX_ADS_L(\d+)_/) || specialTag.match(/^ADS_REF_L(\d+)/);
  if (!match) return null;
  const lvl = Number(match[1]);
  return Number.isInteger(lvl) && lvl >= 1 && lvl <= 7 ? lvl : null;
}

/**
 * Identifies Direct Premium Upload referral ledger entries, strictly excluding
 * Ads Promotion commissions.
 */
export function isDirectReferralTransaction(
  tx: Pick<LedgerTransaction, "incomeType" | "transactionId" | "specialTag">,
): boolean {
  const incomeType = String(tx.incomeType || "")
    .trim()
    .toLowerCase();
  if (incomeType !== "referral_income" && incomeType !== "direct_commission") {
    return false;
  }
  return !isAdsPromotionTransaction(tx);
}

/**
 * Identifies settled Direct Premium Upload commission transactions with authoritative TX_REF_<payment_id> format.
 */
export function isSettledDirectPremiumCommission(
  tx: Pick<
    LedgerTransaction,
    "incomeType" | "transactionId" | "specialTag" | "status" | "sourceUserId"
  >,
): boolean {
  if (!isDirectReferralTransaction(tx)) return false;
  if (tx.status !== "settled") return false;
  const txId = String(tx.transactionId || "")
    .trim()
    .toUpperCase();
  if (!txId.startsWith("TX_REF_") || txId.startsWith("TX_REF_PENDING_")) {
    return false;
  }
  return Boolean(tx.sourceUserId && String(tx.sourceUserId).trim() !== "");
}

const LOCAL_STORAGE_LEDGER_KEY = "facetube_income_ledger_v3";
const LOCAL_STORAGE_WALLETS_KEY = "facetube_user_wallets_v3";

// Initial empty ledger and wallet storage (real earnings fetched from backend)
const INITIAL_SEED_LEDGER: LedgerTransaction[] = [];

const INITIAL_SEED_WALLETS: Record<string, UserWallet> = {};

export function getStoredLedger(): LedgerTransaction[] {
  if (typeof window === "undefined") return INITIAL_SEED_LEDGER;
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_LEDGER_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
    localStorage.setItem(LOCAL_STORAGE_LEDGER_KEY, JSON.stringify(INITIAL_SEED_LEDGER));
    return INITIAL_SEED_LEDGER;
  } catch {
    return INITIAL_SEED_LEDGER;
  }
}

export function saveStoredLedger(transactions: LedgerTransaction[]): void {
  if (typeof window === "undefined") {
    INITIAL_SEED_LEDGER.length = 0;
    INITIAL_SEED_LEDGER.push(...transactions);
    return;
  }
  try {
    localStorage.setItem(LOCAL_STORAGE_LEDGER_KEY, JSON.stringify(transactions));
  } catch {
    // quota
  }
}

export function getStoredWallets(): Record<string, UserWallet> {
  if (typeof window === "undefined") return INITIAL_SEED_WALLETS;
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_WALLETS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null) return parsed;
    }
    localStorage.setItem(LOCAL_STORAGE_WALLETS_KEY, JSON.stringify(INITIAL_SEED_WALLETS));
    return INITIAL_SEED_WALLETS;
  } catch {
    return INITIAL_SEED_WALLETS;
  }
}

export function saveStoredWallets(wallets: Record<string, UserWallet>): void {
  if (typeof window === "undefined") {
    for (const key of Object.keys(INITIAL_SEED_WALLETS)) {
      delete INITIAL_SEED_WALLETS[key];
    }
    Object.assign(INITIAL_SEED_WALLETS, wallets);
    return;
  }
  try {
    localStorage.setItem(LOCAL_STORAGE_WALLETS_KEY, JSON.stringify(wallets));
  } catch {
    // quota
  }
}

/**
 * Retrieves the wallet for a user
 */
export async function getUserWallet(userId: string): Promise<UserWallet> {
  const norm = typeof userId === "string" ? userId.trim().toUpperCase() : "";
  if (!norm) {
    return {
      userId: "",
      balance: 0,
      totalEarned: 0,
      totalWithdrawn: 0,
      referralIncome: 0,
      globalIncome: 0,
      adsenseIncome: 0,
      admobIncome: 0,
      affiliateIncome: 0,
      updatedAt: new Date().toISOString(),
      isStale: true,
    };
  }

  try {
    const res = await api.wallet.getBalance(norm);
    if (res && res.wallet) {
      const data = res.wallet;
      const directRef = toFiniteMoney(
        data.directReferralIncome ??
          data.direct_referral_income ??
          data.referral_income ??
          data.referralIncome,
      );
      const adBoost = toFiniteMoney(
        data.adBoostIncome ?? data.ad_boost_income ?? data.adsPromotionIncome,
      );
      const wallet: UserWallet = {
        userId: data.user_id || data.userId || norm,
        balance: toFiniteMoney(data.balance),
        totalEarned: toFiniteMoney(data.total_earned ?? data.totalEarned),
        totalWithdrawn: toFiniteMoney(data.total_withdrawn ?? data.totalWithdrawn),
        referralIncome: directRef,
        directReferralIncome: directRef,
        adBoostIncome: adBoost,
        adsPromotionIncome: adBoost,
        globalIncome: toFiniteMoney(data.global_income ?? data.globalIncome),
        adsenseIncome: toFiniteMoney(data.adsense_income ?? data.adsenseIncome),
        admobIncome: toFiniteMoney(data.admob_income ?? data.admobIncome),
        affiliateIncome: toFiniteMoney(data.affiliate_income ?? data.affiliateIncome),
        updatedAt: data.updated_at || data.updatedAt || new Date().toISOString(),
        isStale: false,
      };
      // Keep local cache synced with authoritative server wallet
      const wallets = getStoredWallets();
      wallets[norm] = wallet;
      saveStoredWallets(wallets);
      return wallet;
    }
  } catch (err) {
    console.warn("getUserWallet: failed to fetch live wallet from server:", err);
  }

  const wallets = getStoredWallets();
  if (wallets[norm]) {
    const cached = wallets[norm]!;
    const directRef = toFiniteMoney(cached.directReferralIncome ?? cached.referralIncome);
    const adBoost = toFiniteMoney(cached.adsPromotionIncome ?? cached.adBoostIncome);
    return {
      ...cached,
      referralIncome: directRef,
      directReferralIncome: directRef,
      adBoostIncome: adBoost,
      adsPromotionIncome: adBoost,
      globalIncome: toFiniteMoney(cached.globalIncome),
      adsenseIncome: toFiniteMoney(cached.adsenseIncome),
      admobIncome: toFiniteMoney(cached.admobIncome),
      affiliateIncome: toFiniteMoney(cached.affiliateIncome),
      isStale: true,
    };
  }

  // Create default unconfirmed wallet without overwriting stored storage
  const unconfirmedWallet: UserWallet = {
    userId: norm,
    balance: 0,
    totalEarned: 0,
    totalWithdrawn: 0,
    referralIncome: 0,
    directReferralIncome: 0,
    adBoostIncome: 0,
    adsPromotionIncome: 0,
    globalIncome: 0,
    adsenseIncome: 0,
    admobIncome: 0,
    affiliateIncome: 0,
    updatedAt: new Date().toISOString(),
    isStale: true,
  };
  return unconfirmedWallet;
}

export function sanitizeLedgerMemberText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const lower = trimmed.toLowerCase();
  if (lower === "null" || lower === "undefined") return undefined;
  return trimmed;
}

export function resolveGlobalIncomeSourceMember(
  tx: Pick<LedgerTransaction, "sourceUserName" | "sourceUserId">,
): string {
  return (
    sanitizeLedgerMemberText(tx.sourceUserName) ||
    sanitizeLedgerMemberText(tx.sourceUserId) ||
    "Global System"
  );
}

/**
 * Gets full ledger transactions for a user across all pages so calculations never truncate at 50/100 rows.
 */
export async function getUserLedger(userId?: string): Promise<LedgerTransaction[]> {
  if (userId !== undefined && (typeof userId !== "string" || userId.trim() === "")) {
    return [];
  }

  try {
    const collectedRaw: any[] = [];
    const seenIds = new Set<string>();
    const pageLimit = 500;
    const maxPages = 20;

    for (let page = 1; page <= maxPages; page++) {
      const res = await api.wallet.getTransactions(
        userId,
        page === 1 ? { page, limit: pageLimit, all: true } : { page, limit: pageLimit },
      );
      const batch = Array.isArray(res?.transactions) ? res.transactions : [];
      if (batch.length === 0) break;

      let addedInBatch = 0;
      for (const item of batch) {
        const key = String(item?.transaction_id || item?.transactionId || item?.id || "")
          .trim()
          .toUpperCase();
        if (key) {
          if (seenIds.has(key)) continue;
          seenIds.add(key);
        }
        collectedRaw.push(item);
        addedInBatch++;
      }

      if (res?.hasMore === false) break;
      if (res?.totalPages !== undefined && page >= Number(res.totalPages)) break;
      // Compatibility guard for simple test mocks or endpoints returning the entire set on page 1
      if (res?.hasMore === undefined && res?.totalPages === undefined) break;
      if (addedInBatch === 0) break;
    }

    if (collectedRaw.length > 0) {
      const mapped: LedgerTransaction[] = collectedRaw.map((d: any) => ({
        id: String(d.id),
        transactionId: d.transaction_id || d.transactionId,
        userId: d.user_id || d.userId,
        sourceUserId:
          sanitizeLedgerMemberText(
            typeof (d.source_user_id ?? d.sourceUserId) === "number"
              ? String(d.source_user_id ?? d.sourceUserId)
              : (d.source_user_id ?? d.sourceUserId),
          ) || undefined,
        sourceUserName: sanitizeLedgerMemberText(d.source_user_name ?? d.sourceUserName),
        videoId: d.video_id || d.videoId || undefined,
        incomeType: (d.income_type || d.incomeType || d.type) as IncomeType,
        amount: Number(d.amount) || 0,
        status: String(d.status || "settled").toLowerCase() as LedgerTransaction["status"],
        specialTag: d.special_tag || d.specialTag || undefined,
        description: d.description || "",
        batchId: d.batch_id || d.batchId || undefined,
        batch_id: d.batch_id || d.batchId || undefined,
        payoutMethod: d.payout_method || d.payoutMethod || undefined,
        payout_method: d.payout_method || d.payoutMethod || undefined,
        beneficiaryDetails: d.beneficiary_details || d.beneficiaryDetails || undefined,
        beneficiary_details: d.beneficiary_details || d.beneficiaryDetails || undefined,
        createdAt: d.created_at || d.createdAt,
        isStale: false,
      }));
      if (mapped.length > 0 && !userId) {
        saveStoredLedger(mapped);
      }
      return mapped;
    }
  } catch (err) {
    console.warn("getUserLedger: failed to fetch live transactions from server:", err);
  }

  const all = getStoredLedger();
  const markedStale = all.map((tx) => ({ ...tx, isStale: true }));
  if (userId) {
    const norm = userId.trim().toUpperCase();
    return markedStale.filter((tx) => tx.userId.trim().toUpperCase() === norm);
  }
  return markedStale;
}

export interface GlobalIncomeEntryMeta {
  rewardedVideoId: string | null;
  sourcePaymentId: string | null;
  settlementBatchId: string | null;
  poolVideoNumber: string | null;
}

/**
 * Extracts the rewarded Sponsor video ID, source payment ID, or settlement batch ID
 * from a Global Income ledger entry so legitimate per-video payouts from the same
 * payment are clearly distinguishable from one another.
 */
export function extractGlobalIncomeEntryMeta(
  tx: Pick<LedgerTransaction, "transactionId" | "videoId" | "description" | "batchId">,
): GlobalIncomeEntryMeta {
  const txId = String(tx.transactionId || "").trim();
  const desc = String(tx.description || "");
  const explicitVideoId = String(tx.videoId || "").trim();
  const descVideoMatch = desc.match(/for\s+video\s+#([^\s(,)]+)/i);
  const rewardedVideoId = explicitVideoId || (descVideoMatch?.[1]?.trim() ?? "") || null;

  let sourcePaymentId: string | null = null;
  let settlementBatchId: string | null = String(tx.batchId || "").trim() || null;

  if (txId.startsWith("TX_GLB_SETTLE_")) {
    const rest = txId.slice("TX_GLB_SETTLE_".length);
    if (rewardedVideoId && rest.endsWith(`_${rewardedVideoId}`)) {
      settlementBatchId =
        settlementBatchId || rest.slice(0, rest.length - `_${rewardedVideoId}`.length) || null;
    } else if (!settlementBatchId) {
      const batchMatch = desc.match(/batch\s+([^\s(,)]+)/i);
      if (batchMatch?.[1]) {
        settlementBatchId = batchMatch[1].trim();
      }
    }
  } else if (txId.startsWith("TX_GLB_RESERVE_")) {
    sourcePaymentId = txId.slice("TX_GLB_RESERVE_".length).trim() || null;
  } else if (txId.startsWith("TX_GLB_")) {
    const rest = txId.slice("TX_GLB_".length);
    if (rewardedVideoId && rest.endsWith(`_${rewardedVideoId}`)) {
      sourcePaymentId = rest.slice(0, rest.length - `_${rewardedVideoId}`.length) || null;
    } else {
      const rzpMatch = rest.match(/^(pay_[^_]+)_(.+)$/);
      if (rzpMatch) {
        sourcePaymentId = rzpMatch[1] || null;
      }
    }
  }

  const poolMatch = desc.match(/Premium Video #(\d+)/i);
  const poolVideoNumber = poolMatch?.[1] || null;

  return {
    rewardedVideoId,
    sourcePaymentId,
    settlementBatchId,
    poolVideoNumber,
  };
}

/**
 * Filters live Global Income ledger entries and collapses any exact duplicate
 * transaction IDs (case-insensitive) while preserving distinct per-video payouts
 * (TX_GLB_<paymentId>_<videoId>) from the same pool distribution.
 */
export function deduplicateGlobalIncomeTransactions(
  ledger: readonly LedgerTransaction[],
): LedgerTransaction[] {
  const seenKeys = new Set<string>();
  const result: LedgerTransaction[] = [];

  for (const tx of ledger) {
    if (!tx || tx.isStale) continue;
    if (
      String(tx.incomeType || "")
        .trim()
        .toLowerCase() !== "global_income"
    )
      continue;

    const dedupKey = String(tx.transactionId || tx.id || "")
      .trim()
      .toUpperCase();
    if (dedupKey) {
      if (seenKeys.has(dedupKey)) continue;
      seenKeys.add(dedupKey);
    }
    result.push(tx);
  }

  return result;
}

export type GroupedGlobalIncomeStatus = "settled" | "pending" | "failed" | "mixed";

export interface GroupedGlobalIncomeEntry {
  groupKey: string;
  sourcePaymentId: string | null;
  settlementBatchId: string | null;
  displayTransactionId: string;
  transactionIds: string[];
  videoIds: string[];
  videoAllocationCount: number;
  entryCount: number;
  sourceUserId?: string | undefined;
  sourceUserName?: string | undefined;
  description: string;
  specialTag?: string | undefined;
  createdAt: string;
  amount: number;
  status: GroupedGlobalIncomeStatus;
  statusCounts: {
    settled: number;
    pending: number;
    failed: number;
  };
  entries: readonly LedgerTransaction[];
}

/**
 * Derives a payment-level grouping key strictly from the transaction ID metadata.
 * Only per-video Global Income entries sharing a verified source payment ID
 * (e.g. TX_GLB_<paymentId>_<videoId>) are grouped together; reserve rows, batch
 * rows without a payment ID, and unrelated entries keep unique per-entry keys.
 */
export function getGlobalIncomePaymentGroupKey(
  tx: Pick<LedgerTransaction, "id" | "transactionId" | "videoId" | "description" | "batchId">,
  fallbackIndex = 0,
): { groupKey: string; sourcePaymentId: string | null; meta: GlobalIncomeEntryMeta } {
  const txId = String(tx.transactionId || "").trim();
  const txIdUpper = txId.toUpperCase();
  const meta = extractGlobalIncomeEntryMeta(tx);

  if (txIdUpper.startsWith("TX_GLB_RESERVE_")) {
    const reserveKey = meta.sourcePaymentId
      ? `RESERVE:${meta.sourcePaymentId.trim().toUpperCase()}`
      : `TX:${
          txIdUpper ||
          String(tx.id || "")
            .trim()
            .toUpperCase() ||
          `IDX_${fallbackIndex}`
        }`;
    return {
      groupKey: reserveKey,
      sourcePaymentId: meta.sourcePaymentId,
      meta,
    };
  }

  if (
    txIdUpper.startsWith("TX_GLB_") &&
    !txIdUpper.startsWith("TX_GLB_SETTLE_") &&
    meta.sourcePaymentId
  ) {
    const normPayId = meta.sourcePaymentId.trim().toUpperCase();
    return {
      groupKey: `PAYMENT:${normPayId}`,
      sourcePaymentId: meta.sourcePaymentId.trim(),
      meta,
    };
  }

  const uniqueFallback =
    txIdUpper ||
    String(tx.id || "")
      .trim()
      .toUpperCase() ||
    `IDX_${fallbackIndex}`;
  return {
    groupKey: `TX:${uniqueFallback}`,
    sourcePaymentId: meta.sourcePaymentId,
    meta,
  };
}

export function resolveGroupedGlobalIncomeStatus(
  entries: readonly Pick<LedgerTransaction, "status">[],
): {
  status: GroupedGlobalIncomeStatus;
  statusCounts: { settled: number; pending: number; failed: number };
} {
  let settled = 0;
  let pending = 0;
  let failed = 0;

  for (const entry of entries) {
    const normalized = String(entry.status || "settled")
      .trim()
      .toLowerCase();
    if (normalized === "pending") {
      pending += 1;
    } else if (normalized === "settled" || normalized === "completed" || normalized === "") {
      settled += 1;
    } else {
      failed += 1;
    }
  }

  const total = entries.length;
  let status: GroupedGlobalIncomeStatus = "mixed";
  if (total > 0) {
    if (settled === total) {
      status = "settled";
    } else if (pending === total) {
      status = "pending";
    } else if (failed === total) {
      status = "failed";
    }
  }

  return {
    status,
    statusCounts: { settled, pending, failed },
  };
}

/**
 * UI-only display grouping for Global Income ledger entries.
 * Combines per-video payouts generated by the same Premium Upload payment into
 * one display row while keeping all underlying LedgerTransaction records intact.
 */
export function groupGlobalIncomeTransactions(
  ledger: readonly LedgerTransaction[],
): GroupedGlobalIncomeEntry[] {
  const deduped = deduplicateGlobalIncomeTransactions(ledger);
  const groups = new Map<
    string,
    {
      groupKey: string;
      sourcePaymentId: string | null;
      settlementBatchId: string | null;
      entries: LedgerTransaction[];
      videoIds: string[];
      seenVideoKeys: Set<string>;
    }
  >();
  const orderedKeys: string[] = [];

  deduped.forEach((tx, index) => {
    const { groupKey, sourcePaymentId, meta } = getGlobalIncomePaymentGroupKey(tx, index);
    let bucket = groups.get(groupKey);
    if (!bucket) {
      bucket = {
        groupKey,
        sourcePaymentId,
        settlementBatchId: meta.settlementBatchId,
        entries: [],
        videoIds: [],
        seenVideoKeys: new Set<string>(),
      };
      groups.set(groupKey, bucket);
      orderedKeys.push(groupKey);
    }

    bucket.entries.push(tx);
    if (!bucket.sourcePaymentId && sourcePaymentId) {
      bucket.sourcePaymentId = sourcePaymentId;
    }
    if (!bucket.settlementBatchId && meta.settlementBatchId) {
      bucket.settlementBatchId = meta.settlementBatchId;
    }
    if (meta.rewardedVideoId) {
      const vKey = meta.rewardedVideoId.trim().toUpperCase();
      if (vKey && !bucket.seenVideoKeys.has(vKey)) {
        bucket.seenVideoKeys.add(vKey);
        bucket.videoIds.push(meta.rewardedVideoId.trim());
      }
    }
  });

  return orderedKeys.map((key) => {
    const bucket = groups.get(key)!;
    const entries = bucket.entries;
    const first = entries[0]!;
    const isPaymentGroup = key.startsWith("PAYMENT:");

    // Sum amounts using 4-decimal integer micro-units to avoid IEEE 754 drift (e.g. 0.14 * 3 = 0.42)
    let totalMicroUnits = 0;
    let latestCreatedAt = first.createdAt || "";
    let latestTimeMs = Date.parse(latestCreatedAt) || 0;
    let resolvedSourceUserName: string | undefined;
    let resolvedSourceUserId: string | undefined;
    let resolvedSpecialTag: string | undefined;
    const transactionIds: string[] = [];

    for (const entry of entries) {
      const amt = Number(entry.amount);
      if (Number.isFinite(amt)) {
        totalMicroUnits += Math.round(amt * 10000);
      }
      if (entry.transactionId) {
        transactionIds.push(entry.transactionId);
      }
      if (!resolvedSourceUserName) {
        resolvedSourceUserName = sanitizeLedgerMemberText(entry.sourceUserName);
      }
      if (!resolvedSourceUserId) {
        resolvedSourceUserId = sanitizeLedgerMemberText(entry.sourceUserId);
      }
      if (!resolvedSpecialTag && typeof entry.specialTag === "string" && entry.specialTag.trim()) {
        resolvedSpecialTag = entry.specialTag.trim();
      }
      const entryTimeMs = Date.parse(entry.createdAt || "");
      if (Number.isFinite(entryTimeMs) && entryTimeMs > latestTimeMs) {
        latestTimeMs = entryTimeMs;
        latestCreatedAt = entry.createdAt;
      }
    }

    const { status, statusCounts } = resolveGroupedGlobalIncomeStatus(entries);
    const entryCount = entries.length;
    const videoAllocationCount =
      bucket.videoIds.length > 0
        ? bucket.videoIds.length
        : isPaymentGroup && entryCount > 1
          ? entryCount
          : 0;

    const displayTransactionId =
      entryCount > 1 && bucket.sourcePaymentId
        ? `TX_GLB_${bucket.sourcePaymentId}`
        : first.transactionId || first.id;

    const description =
      entryCount > 1
        ? `Global Pool share across ${videoAllocationCount || entryCount} video allocations${
            bucket.sourcePaymentId ? ` (Payment ${bucket.sourcePaymentId})` : ""
          }`
        : first.description;

    return {
      groupKey: bucket.groupKey,
      sourcePaymentId: bucket.sourcePaymentId,
      settlementBatchId: bucket.settlementBatchId,
      displayTransactionId,
      transactionIds,
      videoIds: bucket.videoIds,
      videoAllocationCount,
      entryCount,
      sourceUserId: resolvedSourceUserId,
      sourceUserName: resolvedSourceUserName,
      description,
      specialTag: resolvedSpecialTag,
      createdAt: latestCreatedAt,
      amount: Math.round(totalMicroUnits) / 10000,
      status,
      statusCounts,
      entries,
    };
  });
}

export function paginateGroupedGlobalIncomeEntries(
  grouped: readonly GroupedGlobalIncomeEntry[],
  page: number,
  pageSize: number,
): {
  items: GroupedGlobalIncomeEntry[];
  page: number;
  totalPages: number;
  totalGroups: number;
} {
  const safeSize = Math.max(1, Math.floor(pageSize) || 25);
  const totalGroups = grouped.length;
  const totalPages = Math.max(1, Math.ceil(totalGroups / safeSize));
  const safePage = Math.min(totalPages, Math.max(1, Math.floor(page) || 1));
  const start = (safePage - 1) * safeSize;
  return {
    items: grouped.slice(start, start + safeSize),
    page: safePage,
    totalPages,
    totalGroups,
  };
}

/**
 * Requirement 8: Finds eligible users for Global Income distribution.
 * Only users who have uploaded at least one PREMIUM video are eligible.
 * Users who have uploaded only Free Videos are NOT eligible.
 */
export async function getEligibleGlobalIncomeUsers(): Promise<string[]> {
  const videos = getStoredVideos();
  const eligibleSet = new Set<string>();

  for (const v of videos) {
    if (
      v.videoType === "premium" &&
      (v.paymentStatus === "paid" || v.paymentStatus === "not_required")
    ) {
      eligibleSet.add(v.userId.trim().toUpperCase());
    }
  }

  return Array.from(eligibleSet);
}

export interface GlobalIncomePersonalSummary {
  userId: string;
  hasWalletRow: boolean;
  totalIncome: number;
  globalIncome: number;
  balance: number;
  totalWithdrawn: number;
  walletTotalEarned: number;
  walletGlobalIncome: number;
  ledgerTotalEarned: number;
  ledgerGlobalIncome: number;
  walletVsLedgerDiff: number;
  globalTxCount: number;
  source: "wallet_balances" | "income_ledger_fallback";
}

export interface GlobalIncomePlatformSummary {
  totalPremiumTransactions: number;
  totalTransactionAmount: number;
  referralAllocationTotal: number;
  adminAllocationTotal: number;
  gstTotal: number;
  pgFeeTotal: number;
  globalPoolAllocationTotal: number;
  immediateGlobalPoolDistributedTotal: number;
  settlementBatchCount: number;
  settlementDistributedTotal: number;
  globalPoolDistributedTotal: number;
  pendingReserveCount: number;
  pendingReserveTotal: number;
  settledReserveCount: number;
  settledReserveTotal: number;
  cancelledReserveCount: number;
  cancelledReserveTotal: number;
  eligibleCreatorCount: number;
  eligibleVideoCount: number;
}

export interface GlobalIncomeSummary {
  personal: GlobalIncomePersonalSummary;
  platform: GlobalIncomePlatformSummary;
}

/**
 * Fetches authoritative personal + platform Global Income accounting metrics
 * directly from the backend endpoint (zero localStorage calculations or fabricated fallbacks).
 */
export async function getGlobalIncomeSummary(userId?: string): Promise<GlobalIncomeSummary | null> {
  if (userId !== undefined && (typeof userId !== "string" || userId.trim() === "")) {
    return null;
  }
  const norm = typeof userId === "string" ? userId.trim().toUpperCase() : "";
  try {
    const res = await api.wallet.getGlobalIncomeSummary(norm || undefined);
    if (!res?.success || !res.personal || !res.platform) {
      return null;
    }
    return {
      personal: {
        userId: String(res.personal.userId || norm),
        hasWalletRow: Boolean(res.personal.hasWalletRow),
        totalIncome: toFiniteMoney(res.personal.totalIncome),
        globalIncome: toFiniteMoney(res.personal.globalIncome),
        balance: toFiniteMoney(res.personal.balance),
        totalWithdrawn: toFiniteMoney(res.personal.totalWithdrawn),
        walletTotalEarned: toFiniteMoney(res.personal.walletTotalEarned),
        walletGlobalIncome: toFiniteMoney(res.personal.walletGlobalIncome),
        ledgerTotalEarned: toFiniteMoney(res.personal.ledgerTotalEarned),
        ledgerGlobalIncome: toFiniteMoney(res.personal.ledgerGlobalIncome),
        walletVsLedgerDiff: toFiniteMoney(res.personal.walletVsLedgerDiff),
        globalTxCount: Number(res.personal.globalTxCount) || 0,
        source:
          res.personal.source === "income_ledger_fallback"
            ? "income_ledger_fallback"
            : "wallet_balances",
      },
      platform: {
        totalPremiumTransactions: Number(res.platform.totalPremiumTransactions) || 0,
        totalTransactionAmount: toFiniteMoney(res.platform.totalTransactionAmount),
        referralAllocationTotal: toFiniteMoney(res.platform.referralAllocationTotal),
        adminAllocationTotal: toFiniteMoney(res.platform.adminAllocationTotal),
        gstTotal: toFiniteMoney(res.platform.gstTotal),
        pgFeeTotal: toFiniteMoney(res.platform.pgFeeTotal),
        globalPoolAllocationTotal: toFiniteMoney(res.platform.globalPoolAllocationTotal),
        immediateGlobalPoolDistributedTotal: toFiniteMoney(
          res.platform.immediateGlobalPoolDistributedTotal,
        ),
        settlementBatchCount: Number(res.platform.settlementBatchCount) || 0,
        settlementDistributedTotal: toFiniteMoney(res.platform.settlementDistributedTotal),
        globalPoolDistributedTotal: toFiniteMoney(res.platform.globalPoolDistributedTotal),
        pendingReserveCount: Number(res.platform.pendingReserveCount) || 0,
        pendingReserveTotal: toFiniteMoney(res.platform.pendingReserveTotal),
        settledReserveCount: Number(res.platform.settledReserveCount) || 0,
        settledReserveTotal: toFiniteMoney(res.platform.settledReserveTotal),
        cancelledReserveCount: Number(res.platform.cancelledReserveCount) || 0,
        cancelledReserveTotal: toFiniteMoney(res.platform.cancelledReserveTotal),
        eligibleCreatorCount: Number(res.platform.eligibleCreatorCount) || 0,
        eligibleVideoCount: Number(res.platform.eligibleVideoCount) || 0,
      },
    };
  } catch (err) {
    console.warn("getGlobalIncomeSummary: failed to fetch global income summary from server:", err);
    return null;
  }
}

/**
 * Legacy helper preserved for backwards compatibility.
 * Every ₹6 premium transaction now follows the uniform ₹6 distribution.
 */
export function isSpecialGlobalTransaction(_txNumber: number): boolean {
  return false;
}

export interface PremiumDistributionParams {
  uploaderUserId: string;
  uploaderName: string;
  videoId: string;
  paymentId: string;
  txNumber?: number | undefined;
  directReferrerId?: string | null | undefined;
  isSpecialTransaction?: boolean | undefined;
  specialTag?: "SPECIAL_GLOBAL_RULE" | "NORMAL_PREMIUM" | string | undefined;
  adminAmount?: number | undefined;
}

export interface PremiumDistributionResult {
  referralTransaction?: LedgerTransaction | undefined;
  adminTransaction?: LedgerTransaction | undefined;
  specialAuditTransaction?: LedgerTransaction | undefined;
  globalTransactions: LedgerTransaction[];
  isSpecial: boolean;
  txNumber?: number | undefined;
}

/**
 * Client-side premium income distribution is intentionally disabled.
 * All ₹6 financial splits (Referral ₹1.00, Admin ₹1.00, GST ₹0.90 + PG ₹0.10,
 * and Global Pool ₹3.00 weighted by ad_earnings) are executed atomically on the server.
 */
export async function distributePremiumVideoIncome(
  params: PremiumDistributionParams,
): Promise<PremiumDistributionResult> {
  const result: PremiumDistributionResult = {
    globalTransactions: [],
    isSpecial: false,
  };
  if (params.txNumber !== undefined) {
    result.txNumber = params.txNumber;
  }
  return result;
}

/**
 * WITHDRAWAL LIMITS & RULES
 * - Minimum withdrawal amount: ₹100
 * - Maximum withdrawal amount: ₹10,000 per day
 * - Deductions: 18% GST + 2% PG fee = 20% Total Deduction
 * - Net Payout: 80%
 * - If daily withdrawal total reaches ₹10,000, further withdrawals are blocked until next day
 */
export const WITHDRAWAL_RULES = {
  MIN_AMOUNT: 100, // ₹100 minimum
  MAX_DAILY_LIMIT: 10000, // ₹10,000 per day maximum
} as const;

export const WITHDRAWAL_CHARGES = {
  GST_RATE: 0.18, // 18% GST on full withdrawal amount
  PG_FEE_RATE: 0.02, // 2% PG fee on full withdrawal amount
  TOTAL_DEDUCTION_RATE: 0.2, // 20% total deduction
  NET_PAYOUT_RATE: 0.8, // 80% net payout
} as const;

export interface WithdrawalChargesBreakdown {
  grossAmount: number;
  gstRatePercent: number;
  gstAmount: number;
  pgFeePercent: number;
  pgFeeAmount: number;
  totalDeductionPercent: number;
  totalCharge: number;
  netPayable: number;
  baseProcessing?: number;
  adminAllocation?: number;
}

export function calculateWithdrawalBreakdown(amount: number): WithdrawalChargesBreakdown {
  const grossAmount = Math.max(0, Number(amount) || 0);
  const gstAmount = Math.round(grossAmount * WITHDRAWAL_CHARGES.GST_RATE * 100) / 100;
  const pgFeeAmount = Math.round(grossAmount * WITHDRAWAL_CHARGES.PG_FEE_RATE * 100) / 100;
  const totalCharge = Math.round((gstAmount + pgFeeAmount) * 100) / 100;
  const netPayable = Math.max(0, Math.round((grossAmount - totalCharge) * 100) / 100);
  return {
    grossAmount,
    gstRatePercent: 18,
    gstAmount,
    pgFeePercent: 2,
    pgFeeAmount,
    totalDeductionPercent: 20,
    totalCharge,
    netPayable,
    baseProcessing: 0,
    adminAllocation: 0,
  };
}

export async function getDailyWithdrawnAmount(userId: string, dateStr?: string): Promise<number> {
  const norm = typeof userId === "string" ? userId.trim().toUpperCase() : "";
  if (!norm) return 0;
  const targetDate = dateStr || new Date().toISOString().split("T")[0];
  const allTxs = await getUserLedger(norm);
  const dailyWithdrawals = allTxs.filter((tx) => {
    if (tx.incomeType !== "withdrawal") return false;
    const txDate = tx.createdAt.split("T")[0];
    return txDate === targetDate && tx.status !== "failed";
  });
  return dailyWithdrawals.reduce((sum, tx) => sum + Math.abs(tx.amount), 0);
}

export interface WithdrawalValidationResult {
  valid: boolean;
  error?: string | undefined;
  alreadyWithdrawnToday: number;
  remainingDailyLimit: number;
  currentBalance: number;
  breakdown?: WithdrawalChargesBreakdown | undefined;
}

export async function validateWithdrawalRequest(
  userId: string,
  amount: number,
): Promise<WithdrawalValidationResult> {
  const norm = userId.trim().toUpperCase();
  const wallet = await getUserWallet(norm);
  const alreadyWithdrawnToday = await getDailyWithdrawnAmount(norm);
  const remainingDailyLimit = Math.max(0, WITHDRAWAL_RULES.MAX_DAILY_LIMIT - alreadyWithdrawnToday);
  const breakdown = calculateWithdrawalBreakdown(amount);

  if (isNaN(amount) || amount <= 0) {
    return {
      valid: false,
      error: "Please enter a valid withdrawal amount.",
      alreadyWithdrawnToday,
      remainingDailyLimit,
      currentBalance: wallet.balance,
      breakdown,
    };
  }

  // Minimum withdrawal amount check: ₹100
  if (amount < WITHDRAWAL_RULES.MIN_AMOUNT) {
    return {
      valid: false,
      error: `Minimum withdrawal amount is ₹${WITHDRAWAL_RULES.MIN_AMOUNT.toLocaleString("en-IN")}. You cannot withdraw less than ₹100.`,
      alreadyWithdrawnToday,
      remainingDailyLimit,
      currentBalance: wallet.balance,
      breakdown,
    };
  }

  // Check if daily total already reached ₹10,000
  if (alreadyWithdrawnToday >= WITHDRAWAL_RULES.MAX_DAILY_LIMIT) {
    return {
      valid: false,
      error: `Daily withdrawal limit of ₹${WITHDRAWAL_RULES.MAX_DAILY_LIMIT.toLocaleString("en-IN")} reached. Further withdrawals are blocked until tomorrow.`,
      alreadyWithdrawnToday,
      remainingDailyLimit: 0,
      currentBalance: wallet.balance,
    };
  }

  // Check if adding this amount exceeds daily ₹10,000 limit
  if (alreadyWithdrawnToday + amount > WITHDRAWAL_RULES.MAX_DAILY_LIMIT) {
    return {
      valid: false,
      error: `Daily limit exceeded. You have already withdrawn ₹${alreadyWithdrawnToday.toLocaleString("en-IN")} today. You can withdraw at most ₹${remainingDailyLimit.toLocaleString("en-IN")} more today.`,
      alreadyWithdrawnToday,
      remainingDailyLimit,
      currentBalance: wallet.balance,
    };
  }

  // Check insufficient balance
  if (wallet.balance < amount) {
    return {
      valid: false,
      error: `Insufficient wallet balance. Your available balance is ₹${wallet.balance.toFixed(2)}, which is less than requested ₹${amount.toLocaleString("en-IN")}.`,
      alreadyWithdrawnToday,
      remainingDailyLimit,
      currentBalance: wallet.balance,
    };
  }

  return {
    valid: true,
    alreadyWithdrawnToday,
    remainingDailyLimit: remainingDailyLimit - amount,
    currentBalance: wallet.balance,
  };
}

export interface ProcessWithdrawalResult {
  success: boolean;
  error?: string | undefined;
  transaction?: LedgerTransaction | undefined;
  updatedWallet?: UserWallet | undefined;
}

export async function processWithdrawal(
  userId: string,
  amount: number,
  bankDetails?: {
    accountHolder?: string;
    accountNumber?: string;
    ifscCode?: string;
    upiId?: string;
    bankName?: string;
  },
  options?: { signal?: AbortSignal },
): Promise<ProcessWithdrawalResult> {
  const norm = userId.trim().toUpperCase();
  const validation = await validateWithdrawalRequest(norm, amount);
  if (!validation.valid) {
    return {
      success: false,
      error: validation.error || "Withdrawal validation failed",
    };
  }

  // 1. Prepare bank payload
  let withdrawBankPayload:
    | {
        accountHolder?: string;
        accountNumber?: string;
        ifscCode?: string;
        upiId?: string;
        bankName?: string;
      }
    | undefined = undefined;

  if (bankDetails) {
    const payload: {
      accountHolder?: string;
      accountNumber?: string;
      ifscCode?: string;
      upiId?: string;
      bankName?: string;
    } = {};
    if (bankDetails.accountHolder !== undefined && bankDetails.accountHolder !== "") {
      payload.accountHolder = bankDetails.accountHolder;
    }
    if (bankDetails.accountNumber !== undefined && bankDetails.accountNumber !== "") {
      payload.accountNumber = bankDetails.accountNumber;
    }
    if (bankDetails.ifscCode !== undefined && bankDetails.ifscCode !== "") {
      payload.ifscCode = bankDetails.ifscCode;
    }
    if (bankDetails.upiId !== undefined && bankDetails.upiId !== "") {
      payload.upiId = bankDetails.upiId;
    }
    if (bankDetails.bankName !== undefined && bankDetails.bankName !== "") {
      payload.bankName = bankDetails.bankName;
    }
    if (Object.keys(payload).length > 0) {
      withdrawBankPayload = payload;
    }
  }

  // 2. Authoritative Server Call: Submit withdrawal to the Hostinger / MySQL backend
  let res: {
    success: boolean;
    error?: string;
    message?: string;
    transaction?: any;
    updatedWallet?: any;
  };

  try {
    res = await api.wallet.withdraw(
      {
        userId: norm,
        amount,
        ...(withdrawBankPayload !== undefined ? { bankDetails: withdrawBankPayload } : {}),
      },
      options?.signal ? { signal: options.signal } : undefined,
    );
  } catch (err: unknown) {
    const errorMsg =
      err instanceof Error ? err.message : "Server connection failed or response was invalid.";
    const isAbortOrTimeout =
      err instanceof Error &&
      (err.name === "AbortError" ||
        err.name === "TimeoutError" ||
        err.message.toLowerCase().includes("aborted") ||
        err.message.toLowerCase().includes("timeout") ||
        err.message.toLowerCase().includes("timed out"));

    const isNetworkError =
      err instanceof Error &&
      (err.name === "TypeError" ||
        err.message.toLowerCase().includes("fetch") ||
        err.message.toLowerCase().includes("network") ||
        err.message.toLowerCase().includes("econnrefused") ||
        err.message.toLowerCase().includes("enotfound"));

    console.error("[Withdrawal Service Error] API withdrawal failed:", err);

    let specificError: string;
    if (isAbortOrTimeout) {
      specificError =
        "Withdrawal request timed out or was aborted before confirmation. The server might have processed the withdrawal. Please check your transaction history before trying again to avoid duplicate withdrawals.";
    } else if (isNetworkError) {
      specificError = `Withdrawal status could not be confirmed due to a network connection failure (${errorMsg}). The server might have processed the withdrawal. Please check your transaction history before trying again.`;
    } else {
      specificError = `Withdrawal status could not be verified by server: ${errorMsg}. The server might have processed the withdrawal. Please check your transaction history before trying again.`;
    }

    return {
      success: false,
      error: specificError,
    };
  }

  // 3. Strict verification: Never treat unconfirmed or failed responses as successful
  if (!res || !res.success) {
    const errorMsg =
      res?.error ||
      res?.message ||
      "Withdrawal was declined by server. No funds were deducted from your wallet.";
    return {
      success: false,
      error: errorMsg,
    };
  }

  // 4. Server confirmed: apply confirmed deductions and ledger record
  const breakdown = calculateWithdrawalBreakdown(amount);
  const destinationDesc = bankDetails?.upiId
    ? `UPI: ${bankDetails.upiId}`
    : bankDetails?.accountNumber
      ? `Bank: ${bankDetails.bankName || "Account"} (****${bankDetails.accountNumber.slice(-4)})`
      : "Direct Bank Settlement";

  const confirmedTxId =
    res.transaction?.transaction_id ||
    res.transaction?.id ||
    `TX_WD_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

  const tx: LedgerTransaction = {
    id: `wd-tx-${Date.now()}`,
    transactionId: confirmedTxId,
    userId: norm,
    incomeType: "withdrawal",
    amount: -amount,
    fee: breakdown.totalCharge,
    netAmount: breakdown.netPayable,
    status: "settled",
    description: `Withdrawal payout to ${destinationDesc} - Requested: ₹${amount.toLocaleString("en-IN")}, Admin/GST Charges: ₹${breakdown.totalCharge}, Net Payable: ₹${breakdown.netPayable.toLocaleString("en-IN")}`,
    createdAt: new Date().toISOString(),
    isStale: false,
  };

  const ledger = getStoredLedger();
  ledger.unshift(tx);
  saveStoredLedger(ledger);

  const wallets = getStoredWallets();
  const currentWallet = wallets[norm] || (await getUserWallet(norm));

  let updatedWallet: UserWallet;
  if (res.updatedWallet) {
    const rawUpdatedAdmob =
      res.updatedWallet.admob_income !== undefined && res.updatedWallet.admob_income !== null
        ? res.updatedWallet.admob_income
        : res.updatedWallet.admobIncome;
    const parsedUpdatedAdmob =
      rawUpdatedAdmob !== undefined && rawUpdatedAdmob !== null && rawUpdatedAdmob !== ""
        ? Number(rawUpdatedAdmob)
        : NaN;
    const resolvedAdmobIncome = Number.isFinite(parsedUpdatedAdmob)
      ? parsedUpdatedAdmob
      : (currentWallet.admobIncome ?? 0);

    updatedWallet = {
      userId: norm,
      balance: Number(res.updatedWallet.balance) || 0,
      totalEarned:
        Number(res.updatedWallet.total_earned || res.updatedWallet.totalEarned) ||
        currentWallet.totalEarned,
      totalWithdrawn:
        Number(res.updatedWallet.total_withdrawn || res.updatedWallet.totalWithdrawn) ||
        currentWallet.totalWithdrawn + amount,
      referralIncome:
        Number(res.updatedWallet.referral_income || res.updatedWallet.referralIncome) ||
        currentWallet.referralIncome,
      globalIncome:
        Number(res.updatedWallet.global_income || res.updatedWallet.globalIncome) ||
        currentWallet.globalIncome,
      adsenseIncome:
        Number(res.updatedWallet.adsense_income || res.updatedWallet.adsenseIncome) ||
        currentWallet.adsenseIncome,
      admobIncome: resolvedAdmobIncome,
      affiliateIncome:
        Number(res.updatedWallet.affiliate_income || res.updatedWallet.affiliateIncome) ||
        currentWallet.affiliateIncome,
      updatedAt:
        res.updatedWallet.updated_at || res.updatedWallet.updatedAt || new Date().toISOString(),
      isStale: false,
    };
  } else {
    updatedWallet = {
      ...currentWallet,
      balance: Math.max(0, currentWallet.balance - amount),
      totalWithdrawn: currentWallet.totalWithdrawn + amount,
      updatedAt: new Date().toISOString(),
      isStale: false,
    };
  }

  wallets[norm] = updatedWallet;
  saveStoredWallets(wallets);

  return { success: true, transaction: tx, updatedWallet };
}
