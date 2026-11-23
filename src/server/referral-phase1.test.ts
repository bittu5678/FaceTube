import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  KNOWN_PROMOTIONAL_ALIASES,
  resolveSponsorFromUsers,
  resolveDirectSponsorFromUsers,
  resolveUplineSponsors,
} from "./payments";
import {
  handleApiRequest,
  resolveDirectSponsorMysql,
  resolveUplineSponsorsMysql,
  resetInMemoryStore,
  resetStoreForTests,
} from "./api-handler";
import { setMysqlPoolForTesting } from "./mysql";
import { api } from "../lib/api";
import {
  isAdsPromotionTransaction,
  isDirectReferralTransaction,
  isSettledDirectPremiumCommission,
  extractAdsPromotionLevel,
  saveStoredLedger,
} from "../lib/ledger-service";
import { saveLocalDbUsers } from "../lib/user-service";
import { saveStoredVideos } from "../lib/video-service";
import { getReferralDashboardData } from "../lib/referral-service";

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("FaceTube — Referral Commission Phase 1 Regression Suite", () => {
  const envKeys = [
    "FACETUBE_DATA_DIR",
    "RAZORPAY_KEY_ID",
    "RAZORPAY_KEY_SECRET",
    "RAZORPAY_SKIP_REMOTE_CHECK",
    "NODE_ENV",
    "APP_ENV",
    "DB_HOST",
    "DB_NAME",
    "DB_USER",
  ] as const;
  let envSnapshot: Record<string, string | undefined> = {};
  let tmpDataDir = "";

  beforeEach(() => {
    envSnapshot = {};
    for (const k of envKeys) {
      envSnapshot[k] = process.env[k];
    }
    tmpDataDir = makeTempDir("ft-ref-phase1-");
    process.env["FACETUBE_DATA_DIR"] = tmpDataDir;
    process.env["NODE_ENV"] = "test";
    delete process.env["APP_ENV"];
    delete process.env["DB_HOST"];
    delete process.env["DB_NAME"];
    delete process.env["DB_USER"];
    setMysqlPoolForTesting(null);
    resetInMemoryStore();
    resetStoreForTests();
  });

  afterEach(() => {
    setMysqlPoolForTesting(null);
    for (const k of envKeys) {
      if (envSnapshot[k] !== undefined) {
        process.env[k] = envSnapshot[k];
      } else {
        delete process.env[k];
      }
    }
    resetInMemoryStore();
    if (tmpDataDir && fs.existsSync(tmpDataDir)) {
      fs.rmSync(tmpDataDir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // 1. CRITICAL: Sponsor Resolution (No Sibling Leakage)
  // =========================================================================
  describe("1. Sponsor Resolution & Sibling Isolation", () => {
    it("resolves exact user_id and KNOWN_PROMOTIONAL_ALIASES, and strictly prevents sibling leakage", () => {
      const users = [
        { user_id: "FT102857", name: "Admin", referral_code: "FTVIP" },
        { user_id: "FT483921", name: "Alex", referral_code: "CREATOR50" },
        { user_id: "FT_ALICE", name: "Alice", referral_code: "FTVIP" },
        { user_id: "FT_BOB", name: "Bob", referral_code: "FTVIP" },
        { user_id: "FT_ORPHAN_1", name: "Orphan 1", referral_code: "SHARED_MISSING_CODE" },
        { user_id: "FT_ORPHAN_2", name: "Orphan 2", referral_code: "SHARED_MISSING_CODE" },
        { user_id: "FT_CHARLIE", name: "Charlie", referral_code: "ft_alice" },
        { user_id: "FT_SELF", name: "Self Ref", referral_code: "FT_SELF" },
      ];

      assert.ok(KNOWN_PROMOTIONAL_ALIASES["FT102857"]?.includes("FTVIP"));
      assert.ok(KNOWN_PROMOTIONAL_ALIASES["FT483921"]?.includes("CREATOR50"));

      // Promotional alias FTVIP resolves strictly to FT102857 (never sibling Bob)
      const aliceSponsor = resolveDirectSponsorFromUsers("FT_ALICE", users);
      assert.equal(aliceSponsor?.user_id, "FT102857");

      // Promotional alias CREATOR50 resolves strictly to FT483921
      const creator50Owner = resolveSponsorFromUsers("creator50", "FT_NEW", users);
      assert.equal(creator50Owner?.user_id, "FT483921");

      // Direct user_id match works case-insensitively
      const charlieSponsor = resolveDirectSponsorFromUsers("FT_CHARLIE", users);
      assert.equal(charlieSponsor?.user_id, "FT_ALICE");

      // Missing/unowned code shared by another sibling MUST NOT match the sibling!
      const orphanSponsor = resolveDirectSponsorFromUsers("FT_ORPHAN_1", users);
      assert.equal(
        orphanSponsor,
        null,
        "Sibling FT_ORPHAN_2 sharing referral_code must never be matched as sponsor",
      );

      // Self-referral (direct or via own alias) must return null
      assert.equal(resolveDirectSponsorFromUsers("FT_SELF", users), null);
      assert.equal(resolveDirectSponsorFromUsers("FT102857", users), null);
    });

    it("resolves multi-level Ads Promotion chain cleanly without sibling leakage or cycles", () => {
      const users = [
        { user_id: "FT102857", name: "Admin", referral_code: "FTVIP" },
        { user_id: "FT_L1", name: "L1", referral_code: "FTVIP" },
        { user_id: "FT_SIBLING", name: "Sibling", referral_code: "FTVIP" },
        { user_id: "FT_L2", name: "L2", referral_code: "FT_L1" },
        { user_id: "FT_UPLOADER", name: "Uploader", referral_code: "FT_L2" },
      ];

      const uplines = resolveUplineSponsors("FT_UPLOADER", users);
      assert.deepEqual(
        uplines.map((u) => [u.level, u.userId]),
        [
          [1, "FT_L2"],
          [2, "FT_L1"],
          [3, "FT102857"],
        ],
      );
      assert.equal(
        uplines.some((u) => u.userId === "FT_SIBLING"),
        false,
        "Sibling user must never enter Ads Promotion upline chain",
      );
    });

    it("resolveDirectSponsorMysql queries ONLY by UPPER(user_id) and handles missing/sibling/alias cases", async () => {
      const queries: Array<{ sql: string; params: any[] }> = [];
      const mockUsers: Record<
        string,
        { user_id: string; referral_code: string | null; name: string }
      > = {
        FT102857: { user_id: "FT102857", referral_code: "FTVIP", name: "Admin" },
        FT_ALICE: { user_id: "FT_ALICE", referral_code: "FTVIP", name: "Alice" },
        FT_BOB: { user_id: "FT_BOB", referral_code: "SHARED_UNKNOWN", name: "Bob" },
        FT_EVE: { user_id: "FT_EVE", referral_code: "SHARED_UNKNOWN", name: "Eve" },
        FT_DAN: { user_id: "FT_DAN", referral_code: "FT_ALICE", name: "Dan" },
      };

      const mockConn: any = {
        query: async (sql: string, params: any[] = []) => {
          const normalized = sql.replace(/\s+/g, " ").trim();
          queries.push({ sql: normalized, params });

          assert.equal(
            /OR\s+UPPER\(referral_code\)/i.test(normalized),
            false,
            "SQL must NEVER match another user's referral_code field",
          );

          if (
            normalized.includes(
              "SELECT id, user_id, referral_code FROM users WHERE UPPER(user_id) = UPPER(?)",
            )
          ) {
            const uid = String(params[0] || "").toUpperCase();
            return [mockUsers[uid] ? [{ id: `id-${uid}`, ...mockUsers[uid] }] : []];
          }
          if (
            normalized.includes(
              "SELECT user_id, referral_code, name FROM users WHERE UPPER(user_id) = UPPER(?)",
            )
          ) {
            const target = String(params[0] || "").toUpperCase();
            const excl = String(params[1] || "").toUpperCase();
            const found = mockUsers[target];
            return [found && found.user_id.toUpperCase() !== excl ? [found] : []];
          }
          return [[]];
        },
      };

      // Promotional alias FTVIP -> Admin
      const aliceSponsor = await resolveDirectSponsorMysql("FT_ALICE", mockConn);
      assert.equal(aliceSponsor?.user_id, "FT102857");

      // Missing sponsor shared by sibling FT_EVE -> null (never Bob or Eve)
      const bobSponsor = await resolveDirectSponsorMysql("FT_BOB", mockConn);
      assert.equal(bobSponsor, null);

      // 2-level upline for Dan: L1=Alice -> L2=Admin
      const uplines = await resolveUplineSponsorsMysql("FT_DAN", mockConn);
      assert.deepEqual(
        uplines.map((u) => [u.level, u.userId]),
        [
          [1, "FT_ALICE"],
          [2, "FT102857"],
        ],
      );
      assert.ok(queries.length >= 4);
    });

    it("Store /api/payments/verify uses UNASSIGNED_REFERRAL when sponsor is unresolvable sibling code and never leaks to sibling", async () => {
      const secret = "rzp_test_secret_phase1";
      process.env["RAZORPAY_KEY_ID"] = "rzp_test_id_phase1";
      process.env["RAZORPAY_KEY_SECRET"] = secret;
      process.env["RAZORPAY_SKIP_REMOTE_CHECK"] = "true";

      // Seed store with two siblings sharing an unowned referral_code
      const seedStore = {
        users: [
          {
            id: "u-admin",
            user_id: "FT102857",
            name: "Admin",
            email: "admin@facetube.com",
            mobile: "9999999999",
            role: "admin",
            referral_code: "FTVIP",
            created_at: "2026-01-01T00:00:00.000Z",
          },
          {
            id: "u-orphan-a",
            user_id: "FT_ORPHAN_A",
            name: "Orphan A",
            email: "orphana@facetube.com",
            mobile: "9999999991",
            role: "user",
            password_hash: "$2b$10$hash",
            referral_code: "UNOWNED_TEAM_CODE",
            created_at: "2026-01-01T00:00:00.000Z",
          },
          {
            id: "u-orphan-b",
            user_id: "FT_ORPHAN_B",
            name: "Orphan B",
            email: "orphanb@facetube.com",
            mobile: "9999999992",
            role: "user",
            referral_code: "UNOWNED_TEAM_CODE",
            created_at: "2026-01-01T00:00:00.000Z",
          },
        ],
        sessions: {
          tok_orphan_a: "FT_ORPHAN_A",
        },
        paymentOrders: [
          {
            order_id: "order_orphan_001",
            user_id: "FT_ORPHAN_A",
            video_id: "vid_orphan_001",
            purpose: "premium_video_upload",
            amount: 6,
            currency: "INR",
            status: "created",
            created_at: "2026-01-02T00:00:00.000Z",
          },
        ],
        videos: [
          {
            id: "vid_orphan_001",
            user_id: "FT_ORPHAN_A",
            title: "Orphan Video",
            video_type: "premium",
            payment_status: "pending",
            ad_earnings: 0,
          },
        ],
        wallets: {},
        walletTransactions: [],
      };
      fs.writeFileSync(
        path.join(tmpDataDir, "facetube_store.json"),
        JSON.stringify(seedStore, null, 2),
        "utf-8",
      );
      resetInMemoryStore();

      const payId = "pay_orphan_001";
      const sig = crypto
        .createHmac("sha256", secret)
        .update(`order_orphan_001|${payId}`)
        .digest("hex");

      const verifyRes = await handleApiRequest(
        new Request("http://localhost:3000/api/payments/verify.php", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer tok_orphan_a",
          },
          body: JSON.stringify({
            orderId: "order_orphan_001",
            paymentId: payId,
            signature: sig,
            userId: "FT_ORPHAN_A",
            videoId: "vid_orphan_001",
            purpose: "premium_video_upload",
            referrerUserId: "FT_ORPHAN_B", // spoofed client referrer must be ignored
          }),
        }),
      );
      assert.equal(verifyRes?.status, 200);
      const body = (await verifyRes?.json()) as any;
      assert.equal(body.verified, true);
      assert.equal(body.distribution.referralStatus, "unassigned_pending");
      assert.equal(body.distribution.referrerId, null);

      const updatedStore = JSON.parse(
        fs.readFileSync(path.join(tmpDataDir, "facetube_store.json"), "utf-8"),
      );
      assert.equal(
        updatedStore.wallets["FT_ORPHAN_B"]?.referral_income ?? 0,
        0,
        "Sibling FT_ORPHAN_B must NEVER receive referral commission",
      );
      const pendingTx = updatedStore.walletTransactions.find(
        (t: any) => t.transaction_id === `TX_REF_PENDING_${payId}`,
      );
      assert.ok(pendingTx, "UNASSIGNED_REFERRAL pending transaction must be recorded");
      assert.equal(pendingTx.user_id, "UNASSIGNED_REFERRAL");
      assert.equal(pendingTx.status, "pending");
    });

    it("PHP downline.php and verify.php enforce sibling-free sponsor resolution", () => {
      const downlinePhp = fs.readFileSync(
        path.resolve(process.cwd(), "api/referrals/downline.php"),
        "utf-8",
      );
      const verifyPhp = fs.readFileSync(
        path.resolve(process.cwd(), "api/payments/verify.php"),
        "utf-8",
      );
      assert.match(downlinePhp, /function resolveSponsorTargetUserIdPhp/);
      assert.match(downlinePhp, /function resolveDirectSponsorUserPhp/);
      assert.match(downlinePhp, /function resolveUplineSponsorsPhp/);
      assert.match(verifyPhp, /resolveDirectSponsorUserPhp\(/);
      assert.match(verifyPhp, /resolveUplineSponsorsPhp\(/);
      assert.doesNotMatch(
        verifyPhp,
        /OR\s+UPPER\(referral_code\)\s*=\s*UPPER\(/i,
        "verify.php must never contain sibling-leaking OR UPPER(referral_code) sponsor SQL",
      );
    });
  });

  // =========================================================================
  // 2. Referral Commission Reporting (No premiumCount × ₹1, No not_required)
  // =========================================================================
  describe("2. Authoritative Referral Commission Reporting", () => {
    it("Node Store referrals/dashboard counts only verified paid TX_REF_ settled entries, excludes not_required & Ads Promotion, and reconciles totals", async () => {
      const seedStore = {
        users: [
          {
            id: "u-sponsor",
            user_id: "FT_SPONSOR",
            name: "Sponsor User",
            email: "sponsor@facetube.com",
            mobile: "9000000001",
            role: "user",
            referral_code: null,
            created_at: "2026-01-01T00:00:00.000Z",
          },
          {
            id: "u-mem1",
            user_id: "FT_MEM_1",
            name: "Member One",
            email: "m1@facetube.com",
            mobile: "9000000002",
            role: "user",
            referral_code: "FT_SPONSOR",
            created_at: "2026-01-02T00:00:00.000Z",
          },
          {
            id: "u-mem2",
            user_id: "FT_MEM_2",
            name: "Member Two",
            email: "m2@facetube.com",
            mobile: "9000000003",
            role: "user",
            referral_code: "FT_SPONSOR",
            created_at: "2026-01-03T00:00:00.000Z",
          },
        ],
        sessions: {
          tok_sponsor: "FT_SPONSOR",
        },
        paymentOrders: [
          {
            order_id: "ord_paid_1",
            payment_id: "pay_paid_1",
            user_id: "FT_MEM_1",
            video_id: "vid_m1_paid",
            purpose: "premium_video_upload",
            amount: 6,
            currency: "INR",
            status: "paid",
            created_at: "2026-01-04T00:00:00.000Z",
          },
        ],
        videos: [
          {
            id: "vid_m1_paid",
            user_id: "FT_MEM_1",
            title: "Paid Prem",
            video_type: "premium",
            payment_status: "paid",
          },
          {
            id: "vid_m1_notreq",
            user_id: "FT_MEM_1",
            title: "Migrated Not Required",
            video_type: "premium",
            payment_status: "not_required",
          },
          {
            id: "vid_m2_notreq",
            user_id: "FT_MEM_2",
            title: "Another Not Required",
            video_type: "premium",
            payment_status: "not_required",
          },
          {
            id: "vid_m2_pending",
            user_id: "FT_MEM_2",
            title: "Unpaid Pending",
            video_type: "premium",
            payment_status: "pending",
          },
        ],
        wallets: {
          FT_SPONSOR: {
            user_id: "FT_SPONSOR",
            balance: 11,
            total_earned: 11,
            referral_income: 11,
          },
        },
        walletTransactions: [
          {
            id: "l1",
            transaction_id: "TX_REF_pay_paid_1",
            user_id: "FT_SPONSOR",
            source_user_id: "FT_MEM_1",
            income_type: "referral_income",
            amount: 1.0,
            status: "settled",
            created_at: "2026-01-05T00:00:00.000Z",
          },
          {
            id: "l2",
            transaction_id: "TX_ADS_L1_pay_ads_1",
            user_id: "FT_SPONSOR",
            source_user_id: "FT_MEM_1",
            income_type: "referral_income",
            special_tag: "ADS_REF_L1",
            amount: 10.0,
            status: "settled",
            created_at: "2026-01-06T00:00:00.000Z",
          },
          {
            id: "l3",
            transaction_id: "TX_REF_PENDING_pay_pending_1",
            user_id: "FT_SPONSOR",
            source_user_id: "FT_MEM_2",
            income_type: "referral_income",
            amount: 1.0,
            status: "pending",
            created_at: "2026-01-07T00:00:00.000Z",
          },
          {
            id: "l4_fake_orphan_payment",
            transaction_id: "TX_REF_pay_unverified_999",
            user_id: "FT_SPONSOR",
            source_user_id: "FT_MEM_2",
            income_type: "referral_income",
            amount: 1.0,
            status: "settled",
            created_at: "2026-01-08T00:00:00.000Z",
          },
        ],
      };
      fs.writeFileSync(
        path.join(tmpDataDir, "facetube_store.json"),
        JSON.stringify(seedStore, null, 2),
        "utf-8",
      );
      resetInMemoryStore();

      const res = await handleApiRequest(
        new Request("http://localhost:3000/api/referrals/dashboard", {
          method: "GET",
          headers: { Authorization: "Bearer tok_sponsor" },
        }),
      );
      assert.equal(res?.status, 200);
      const data = (await res?.json()) as any;
      assert.equal(data.success, true);

      const d = data.dashboard;
      assert.equal(d.directReferralIncome, 1.0, "Only verified paid settled TX_REF_ counts");
      assert.equal(d.referralIncome, 1.0);
      assert.equal(d.adsPromotionIncome, 10.0, "Ads promotion tracked separately");
      assert.equal(d.pendingReferralIncome, 1.0, "Pending tracked separately");
      assert.equal(d.totalReferralIncome, 11.0);

      const m1 = d.members.find((m: any) => m.userId === "FT_MEM_1");
      const m2 = d.members.find((m: any) => m.userId === "FT_MEM_2");
      assert.equal(m1.premiumVideosCount, 1, "not_required must be excluded from premium count");
      assert.equal(m1.directCommissionEarned, 1.0);
      assert.equal(m2.premiumVideosCount, 0, "not_required and pending must be 0");
      assert.equal(m2.directCommissionEarned, 0);

      const memberSum = d.members.reduce(
        (acc: number, m: any) => acc + m.directCommissionEarned,
        0,
      );
      assert.equal(
        memberSum,
        d.directReferralIncome,
        "Top-level total must reconcile with members",
      );
    });

    it("Node MySQL referrals/dashboard joins payment_transactions + income_ledger and separates Ads Promotion", async () => {
      process.env["DB_HOST"] = "127.0.0.1";
      process.env["DB_NAME"] = "facetube_test";
      process.env["DB_USER"] = "test_user";

      const capturedSql: string[] = [];
      setMysqlPoolForTesting({
        query: async (sql: string, params: any[] = []) => {
          const normalized = sql.replace(/\s+/g, " ").trim();
          capturedSql.push(normalized);

          if (/FROM\s+sessions/i.test(normalized) && params[0] === "tok_mysql_dash") {
            return [
              [
                {
                  id: "u1",
                  user_id: "FT102857",
                  name: "Admin",
                  mobile: "99999",
                  email: "a@b.com",
                  role: "admin",
                  referral_code: "FTVIP",
                  created_at: "2026-01-01T00:00:00Z",
                },
              ],
            ];
          }
          if (normalized.startsWith("SELECT user_id, referral_code, mobile, name FROM users")) {
            return [
              [{ user_id: "FT102857", referral_code: "FTVIP", mobile: "99999", name: "Admin" }],
            ];
          }
          if (normalized.startsWith("SELECT id, user_id, name, email, mobile, created_at")) {
            return [
              [
                { user_id: "FT102857", name: "Admin", referral_code: "FTVIP", role: "admin" },
                {
                  id: "m1",
                  user_id: "FT_ALICE",
                  name: "Alice",
                  email: "a@x.com",
                  mobile: "111",
                  referral_code: "FTVIP",
                  role: "user",
                  created_at: "2026-01-02",
                },
              ],
            ];
          }
          if (normalized.includes("INNER JOIN payment_transactions pt")) {
            return [[{ member_user_id: "FT_ALICE", direct_commission: 2.0 }]];
          }
          if (normalized.includes("AS ads_income FROM income_ledger")) {
            return [[{ ads_income: 25.0 }]];
          }
          if (normalized.includes("AS pending_income FROM income_ledger")) {
            return [[{ pending_income: 1.0 }]];
          }
          if (normalized.includes("FROM uploaded_videos")) {
            return [
              [
                { video_type: "premium", payment_status: "paid", cnt: 2 },
                { video_type: "premium", payment_status: "not_required", cnt: 5 },
              ],
            ];
          }
          return [[]];
        },
      } as any);

      const res = await handleApiRequest(
        new Request("http://localhost:3000/api/referrals/dashboard", {
          method: "GET",
          headers: { Authorization: "Bearer tok_mysql_dash" },
        }),
      );
      assert.equal(res?.status, 200);
      const body = (await res?.json()) as any;
      assert.equal(body.dashboard.directReferralIncome, 2.0);
      assert.equal(body.dashboard.referralIncome, 2.0);
      assert.equal(body.dashboard.adsPromotionIncome, 25.0);
      assert.equal(body.dashboard.pendingReferralIncome, 1.0);
      assert.equal(body.dashboard.totalReferralIncome, 27.0);
      assert.equal(body.dashboard.members[0].premiumVideosCount, 2);
      assert.equal(body.dashboard.members[0].directCommissionEarned, 2.0);
      assert.equal(body.dashboard.referralLink, "https://facetube.online/auth?ref=FTVIP");

      const joinQuery = capturedSql.find((s) => s.includes("INNER JOIN payment_transactions pt"));
      assert.ok(joinQuery, "Must join income_ledger with payment_transactions");
      assert.match(joinQuery, /pt\.purpose = 'premium_video_upload'/);
      assert.match(joinQuery, /ESCAPE '\|'/);
    });

    it("client getReferralDashboardData fallback never computes premiumCount * 1 for not_required or ledger-less videos", async () => {
      const origDashboard = api.referrals.getDashboard;
      const origTx = api.wallet.getTransactions;
      const hadLocalStorage = typeof (globalThis as any).localStorage !== "undefined";
      const prevLocalStorage = (globalThis as any).localStorage;
      const memStorage = new Map<string, string>();
      if (!hadLocalStorage) {
        (globalThis as any).localStorage = {
          getItem: (k: string) => memStorage.get(k) ?? null,
          setItem: (k: string, v: string) => {
            memStorage.set(k, String(v));
          },
          removeItem: (k: string) => {
            memStorage.delete(k);
          },
          clear: () => memStorage.clear(),
        };
      }
      try {
        api.referrals.getDashboard = async () => {
          throw new Error("Offline");
        };
        api.wallet.getTransactions = async () => {
          throw new Error("Offline");
        };

        saveLocalDbUsers([
          {
            id: "u1",
            user_id: "FT_OFF_SPONSOR",
            name: "Off Sponsor",
            email: "s@ft.com",
            mobile: "111",
            password_hash: "hash",
            referral_code: null,
            created_at: "2026-01-01T00:00:00Z",
            role: "user",
          },
          {
            id: "u2",
            user_id: "FT_OFF_MEM",
            name: "Off Mem",
            email: "m@ft.com",
            mobile: "222",
            password_hash: "hash",
            referral_code: "FT_OFF_SPONSOR",
            created_at: "2026-01-01T00:00:00Z",
            role: "user",
          },
        ]);
        saveStoredVideos([
          {
            id: "v1",
            userId: "FT_OFF_MEM",
            creatorName: "Off Mem",
            title: "Not Req Video",
            description: "",
            videoUrl: "https://example.com/v1.mp4",
            thumbnailUrl: "",
            category: "Drama",
            duration: "01:00",
            contentType: "long",
            videoType: "premium",
            paymentStatus: "not_required",
            paymentAmount: 0,
            isPromoted: false,
            views: 0,
            likes: 0,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
          },
        ]);
        // Only a pending ledger row and an Ads Promotion row — ZERO settled TX_REF_ entries
        saveStoredLedger([
          {
            id: "l_ads",
            transactionId: "TX_ADS_L1_999",
            userId: "FT_OFF_SPONSOR",
            sourceUserId: "FT_OFF_MEM",
            incomeType: "referral_income",
            specialTag: "ADS_REF_L1",
            amount: 10,
            status: "settled",
            description: "Ads L1",
            createdAt: "2026-01-01T00:00:00Z",
          },
          {
            id: "l_pend",
            transactionId: "TX_REF_pay_pend",
            userId: "FT_OFF_SPONSOR",
            sourceUserId: "FT_OFF_MEM",
            incomeType: "referral_income",
            amount: 1,
            status: "pending",
            description: "Pending",
            createdAt: "2026-01-01T00:00:00Z",
          },
        ]);

        const dash = await getReferralDashboardData("FT_OFF_SPONSOR");
        assert.equal(dash.isStale, true);
        assert.equal(dash.referralIncome, 0);
        assert.equal(dash.directReferralIncome, 0);
        assert.equal(dash.adsPromotionIncome, 10);
        assert.equal(dash.pendingReferralIncome, 1);
        assert.equal(dash.members[0]?.premiumVideosCount, 0);
        assert.equal(dash.members[0]?.directCommissionEarned, 0);
        assert.equal(dash.referralLink, "https://facetube.online/auth?ref=FT_OFF_SPONSOR");
      } finally {
        api.referrals.getDashboard = origDashboard;
        api.wallet.getTransactions = origTx;
        saveLocalDbUsers([]);
        saveStoredVideos([]);
        saveStoredLedger([]);
        if (!hadLocalStorage) {
          delete (globalThis as any).localStorage;
        } else {
          (globalThis as any).localStorage = prevLocalStorage;
        }
      }
    });

    it("PHP api/referrals/dashboard.php removes premiumCount * 1 and uses payment_transactions + settled income_ledger", () => {
      const dashPhp = fs.readFileSync(
        path.resolve(process.cwd(), "api/referrals/dashboard.php"),
        "utf-8",
      );
      assert.match(dashPhp, /INNER JOIN payment_transactions pt/);
      assert.match(dashPhp, /pt\.purpose = 'premium_video_upload'/);
      assert.match(dashPhp, /'adsPromotionIncome'\s*=>\s*\$adsPromotionIncome/);
      assert.match(dashPhp, /'pendingReferralIncome'\s*=>\s*\$pendingReferralIncome/);
      assert.doesNotMatch(dashPhp, /\$premiumCount\s*\*\s*1(\.0)?\b/);
      assert.doesNotMatch(dashPhp, /\$ps === 'not_required'.*\$premiumCount/s);
    });
  });

  // =========================================================================
  // 3 & 4. Team Income, Earnings Categorization & History UI Verification
  // =========================================================================
  describe("3 & 4. Team Income, Ledger Categorization & Income History", () => {
    it("ledger-service helpers separate Direct Referral vs Ads Promotion and enforce settled TX_REF_ status", () => {
      const adsLegacy = {
        incomeType: "referral_income" as const,
        transactionId: "TX_ADS_L3_order123",
        specialTag: "ADS_REF_L3",
        status: "settled" as const,
        sourceUserId: "FT999",
      };
      assert.equal(isAdsPromotionTransaction(adsLegacy), true);
      assert.equal(extractAdsPromotionLevel(adsLegacy), 3);
      assert.equal(isDirectReferralTransaction(adsLegacy), false);
      assert.equal(isSettledDirectPremiumCommission(adsLegacy), false);

      const pendingDirect = {
        incomeType: "referral_income" as const,
        transactionId: "TX_REF_pay_abc",
        status: "pending" as const,
        sourceUserId: "FT999",
      };
      assert.equal(isDirectReferralTransaction(pendingDirect), true);
      assert.equal(isSettledDirectPremiumCommission(pendingDirect), false);

      const settledDirect = {
        incomeType: "referral_income" as const,
        transactionId: "TX_REF_pay_abc",
        status: "settled" as const,
        sourceUserId: "FT999",
      };
      assert.equal(isDirectReferralTransaction(settledDirect), true);
      assert.equal(isSettledDirectPremiumCommission(settledDirect), true);
    });

    it("wallet/earnings-history separates legacy TX_ADS_L* referral rows into ad_boost instead of referral", async () => {
      const today = new Date().toISOString().split("T")[0]!;
      const seedStore = {
        users: [
          { id: "u1", user_id: "FT_CAT_USER", name: "Cat User", email: "c@ft.com", role: "user" },
        ],
        sessions: {
          tok_cat_user: "FT_CAT_USER",
        },
        walletTransactions: [
          {
            id: "c1",
            transaction_id: "TX_REF_pay_1",
            user_id: "FT_CAT_USER",
            income_type: "referral_income",
            amount: 1.0,
            status: "settled",
            created_at: `${today}T10:00:00.000Z`,
          },
          {
            id: "c2",
            transaction_id: "TX_ADS_L1_pay_2",
            user_id: "FT_CAT_USER",
            income_type: "referral_income",
            special_tag: "ADS_REF_L1",
            amount: 10.0,
            status: "settled",
            created_at: `${today}T11:00:00.000Z`,
          },
          {
            id: "c3",
            transaction_id: "TX_REF_PENDING_pay_3",
            user_id: "FT_CAT_USER",
            income_type: "referral_income",
            amount: 1.0,
            status: "pending",
            created_at: `${today}T12:00:00.000Z`,
          },
        ],
      };
      fs.writeFileSync(
        path.join(tmpDataDir, "facetube_store.json"),
        JSON.stringify(seedStore, null, 2),
        "utf-8",
      );
      resetInMemoryStore();

      const res = await handleApiRequest(
        new Request("http://localhost:3000/api/wallet/earnings-history.php?period=7D", {
          method: "GET",
          headers: { Authorization: "Bearer tok_cat_user" },
        }),
      );
      assert.equal(res?.status, 200);
      const body = (await res?.json()) as any;
      assert.equal(body.summary.referral, 1.0);
      assert.equal(body.summary.ad_boost, 10.0);
      assert.equal(body.summary.total_revenue, 11.0);
    });

    it("team-income.tsx removes all hardcoded mock income/volume/awards and renders honest unavailable states", () => {
      const teamIncomeTsx = fs.readFileSync(
        path.resolve(process.cwd(), "src/routes/team-income.tsx"),
        "utf-8",
      );
      for (const forbidden of [
        "2,045.40",
        "34,490",
        "₹50,000",
        "Gold Creator Award",
        "Active Diamond Status",
        "68.9%",
        "+16.8%",
        "10.0%",
        "5.0%",
        "2% Global Creator Bonus Pool",
        "const tierStats",
      ]) {
        assert.equal(
          teamIncomeTsx.includes(forbidden),
          false,
          `team-income.tsx must not contain hardcoded mock data: ${forbidden}`,
        );
      }
      assert.match(teamIncomeTsx, /getTeamMembers/);
      assert.match(teamIncomeTsx, /getReferralDashboardData/);
      assert.match(teamIncomeTsx, /getUserLedger/);
      assert.match(teamIncomeTsx, /Unavailable/);
    });

    it("direct-referral-income.tsx and referral-income.tsx render dynamic tx.status and exclude hardcoded Settled / FT483921 fallback", () => {
      const directTsx = fs.readFileSync(
        path.resolve(process.cwd(), "src/routes/direct-referral-income.tsx"),
        "utf-8",
      );
      const referralTsx = fs.readFileSync(
        path.resolve(process.cwd(), "src/routes/referral-income.tsx"),
        "utf-8",
      );

      assert.doesNotMatch(directTsx, /"FT483921"/);
      assert.doesNotMatch(referralTsx, /"FT483921"/);
      assert.match(directTsx, /tx\.status === "pending"/);
      assert.match(directTsx, /isDirectReferralTransaction/);
      assert.match(referralTsx, /tx\.status === "pending"/);
      assert.match(referralTsx, /isAdsPromotionTransaction/);
      assert.match(referralTsx, /Ads Promotion/);
    });
  });

  // =========================================================================
  // 5. Canonical Referral Link Consistency
  // =========================================================================
  describe("5. Canonical Referral Link Consistency (/auth?ref=)", () => {
    it("uses canonical /auth?ref= across PHP, Node, client services, and UI routes with zero /register?ref=", () => {
      const filesToCheck = [
        "api/referrals/dashboard.php",
        "src/server/api-handler.ts",
        "src/lib/referral-service.ts",
        "src/routes/referral-members.tsx",
        "src/components/profile/ReferralLinkTab.tsx",
      ];

      for (const relPath of filesToCheck) {
        const content = fs.readFileSync(path.resolve(process.cwd(), relPath), "utf-8");
        assert.equal(
          content.includes("/register?ref="),
          false,
          `${relPath} must not contain non-existent /register?ref= route`,
        );
        assert.equal(
          content.includes("/auth?ref="),
          true,
          `${relPath} must use canonical /auth?ref= route`,
        );
      }
    });
  });
});
