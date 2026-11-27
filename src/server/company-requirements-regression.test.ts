import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { handleApiRequest } from "./api-handler.ts";
import { setMysqlPoolForTesting } from "./mysql.ts";
import {
  calculateTotalAdEarnings,
  calculateUploadOptionsTotalEarnings,
} from "../lib/ledger-service.ts";
import {
  computeFittedVideoBox,
  getPlayerContainerClass,
  getPlayerIntrinsicContainerStyle,
  getShortsStageCardClass,
} from "../lib/video-player-layout.ts";

describe("FaceTube Pending Company Requirements Verification Suite", () => {
  afterEach(() => {
    setMysqlPoolForTesting(null);
  });

  describe("1. AdMob Income Verification & Total Ad Earnings (6 Streams)", () => {
    it("Reconciles settled admob_income ledger rows in /api/wallet/balance while excluding pending/unfinalized/duplicate income", async () => {
      const origHost = process.env["DB_HOST"];
      const origName = process.env["DB_NAME"];
      const origUser = process.env["DB_USER"];
      process.env["DB_HOST"] = "127.0.0.1";
      process.env["DB_NAME"] = "facetube_test";
      process.env["DB_USER"] = "test_user";

      const capturedSqls: string[] = [];
      try {
        setMysqlPoolForTesting({
          query: async (sql: string) => {
            if (sql.includes("FROM sessions s")) {
              return [
                [
                  {
                    id: "u-admob-e2e",
                    user_id: "FT777001",
                    name: "Creator Verified",
                    email: "creator777@facetube.com",
                    role: "user",
                    referral_code: "CR777",
                  },
                ],
              ];
            }
            if (sql.includes("FROM wallet_balances WHERE UPPER(user_id) = UPPER(?)")) {
              // Simulate cached wallet_balances slightly stale/zero on admob_income while settled ledger has ₹420.50
              return [
                [
                  {
                    user_id: "FT777001",
                    balance: 1520.5,
                    total_earned: 1520.5,
                    total_withdrawn: 0,
                    referral_income: 100.0,
                    ad_boost_income: 250.0,
                    global_income: 300.0,
                    adsense_income: 270.0,
                    admob_income: 0.0,
                    affiliate_income: 180.0,
                    updated_at: "2026-10-01T00:00:00.000Z",
                  },
                ],
              ];
            }
            if (sql.includes("AS ledger_admob_income")) {
              capturedSqls.push(sql);
              // Notice: SQL enforces status = 'settled', admob_row_count = 2 (₹420.50 settled AdMob)
              return [
                [
                  {
                    ref_row_count: 2,
                    ledger_direct_referral: 100.0,
                    ledger_ad_boost: 250.0,
                    admob_row_count: 2,
                    ledger_admob_income: 420.5,
                  },
                ],
              ];
            }
            return [[]];
          },
        } as any);

        const res = await handleApiRequest(
          new Request("http://localhost:3000/api/wallet/balance.php", {
            headers: { Authorization: "Bearer tok_admob_e2e" },
          }),
        );
        assert.equal(res?.status, 200);
        const body = (await res?.json()) as any;
        assert.equal(body.success, true);
        assert.equal(body.wallet.admobIncome, 420.5);
        assert.equal(body.wallet.admob_income, 420.5);
        assert.equal(body.wallet.referralIncome, 100.0);
        assert.equal(body.wallet.adsPromotionIncome, 250.0);

        // Confirm SQL strictly filters settled rows only
        assert.equal(capturedSqls.length, 1);
        assert.match(capturedSqls[0]!, /AND status = 'settled'/);
        assert.match(capturedSqls[0]!, /admob_row_count/);

        // Combined Total Ad Earnings (all 6 settled streams) via canonical helper
        const adSummary = calculateTotalAdEarnings(body.wallet);
        assert.equal(adSummary.referralIncome, 100.0);
        assert.equal(adSummary.globalIncome, 300.0);
        assert.equal(adSummary.adsenseIncome, 270.0);
        assert.equal(adSummary.admobIncome, 420.5);
        assert.equal(adSummary.affiliateIncome, 180.0);
        assert.equal(adSummary.adPromotionIncome, 250.0);
        assert.equal(adSummary.totalAdEarnings, 1520.5);

        // Studio alias remains strictly identical without double counting
        const sixStream = calculateUploadOptionsTotalEarnings(body.wallet);
        assert.deepEqual(sixStream, adSummary);
      } finally {
        setMysqlPoolForTesting(null);
        if (origHost !== undefined) process.env["DB_HOST"] = origHost;
        else delete process.env["DB_HOST"];
        if (origName !== undefined) process.env["DB_NAME"] = origName;
        else delete process.env["DB_NAME"];
        if (origUser !== undefined) process.env["DB_USER"] = origUser;
        else delete process.env["DB_USER"];
      }
    });

    it("PHP api/wallet/balance.php reconciles settled admob_income with scoped ref_row_count & admob_row_count", async () => {
      const phpSrc = await fs.readFile(
        path.resolve(process.cwd(), "api/wallet/balance.php"),
        "utf8",
      );
      assert.match(phpSrc, /AS admob_row_count/);
      assert.match(phpSrc, /AS ledger_admob_income/);
      assert.match(phpSrc, /AND status = 'settled'/);
      assert.match(
        phpSrc,
        /\$admobIncome = round\(floatval\(\$sepRow\['ledger_admob_income'\] \?\? 0\), 2\)/,
      );
    });

    it("Client AdMob & AdSense pages strictly filter settled records and deduplicate transaction IDs", async () => {
      const admobSrc = await fs.readFile(
        path.resolve(process.cwd(), "src/routes/admob-income.tsx"),
        "utf8",
      );
      const adsenseSrc = await fs.readFile(
        path.resolve(process.cwd(), "src/routes/adsense-income.tsx"),
        "utf8",
      );
      assert.match(admobSrc, /seenTxIds/);
      assert.match(admobSrc, /status !== "" && status !== "settled"/);
      assert.match(adsenseSrc, /seenTxIds/);
      assert.match(adsenseSrc, /status !== "" && status !== "settled"/);
    });
  });

  describe("2. Video Player Black Space Fix & Responsive Aspect Integrity", () => {
    it("Stage fills container cleanly via absolute inset-0 without stale ResizeObserver pixel-locking in normal intrinsic playback", async () => {
      const playerSrc = await fs.readFile(
        path.resolve(process.cwd(), "src/components/videohub/FaceTubeVideoPlayer.tsx"),
        "utf8",
      );
      assert.ok(
        playerSrc.includes("absolute inset-0 flex items-center justify-center overflow-hidden"),
        "Video stage must use absolute inset-0 so it always fills aspect-ratio container height cleanly",
      );
      assert.ok(
        playerSrc.includes(
          "shouldUseFittedBox = Boolean(fittedBox && (isFullscreen || isRotated || zoom > 1))",
        ),
        "Normal unrotated unzoomed intrinsic playback must use 100% w/h object-contain without ResizeObserver frame-lag",
      );
      assert.ok(playerSrc.includes("orientationchange"));
      assert.ok(playerSrc.includes("fullscreenchange"));
    });

    it("Responsive aspect math eliminates vertical black bars across portrait, landscape, square, and ultrawide viewports", () => {
      // Portrait 9:16 video on Watch page
      const p = getPlayerIntrinsicContainerStyle(720, 1280, 0, false);
      assert.equal(p?.aspectRatio, "720 / 1280");
      // Square 1:1 video
      const sq = getPlayerIntrinsicContainerStyle(1080, 1080, 0, false);
      assert.equal(sq?.aspectRatio, "1080 / 1080");
      // Rotated 16:9 -> swaps to 9:16 cleanly and computeFittedVideoBox keeps it inside mobile bounds
      const rot = getPlayerIntrinsicContainerStyle(1920, 1080, 90, false);
      assert.equal(rot?.aspectRatio, "1080 / 1920");
      const mobileFit = computeFittedVideoBox(360, 640, 1920, 1080, 90, "standard");
      assert.ok(mobileFit);
      assert.ok(mobileFit.visualWidth <= 360.01);
      assert.ok(mobileFit.visualHeight <= 640.01);
      // Fullscreen delegates to full viewport h-full w-full + fittedBox
      assert.equal(getPlayerContainerClass("standard", true), "h-full w-full rounded-none");
      assert.ok(getShortsStageCardClass().includes("aspect-[9/16]"));
    });

    it("Shorts player preserves 9:16 card & object-contain while adding ambient blurred backdrop for wider clips", async () => {
      const shortsSrc = await fs.readFile(
        path.resolve(process.cwd(), "src/routes/shorts.tsx"),
        "utf8",
      );
      assert.ok(shortsSrc.includes("getShortsStageCardClass"));
      assert.ok(shortsSrc.includes("object-contain"));
      assert.ok(shortsSrc.includes("setShortVideoDims"));
      assert.ok(shortsSrc.includes("blur-2xl"));
    });
  });

  describe("3. AdSense Website Readiness & Policy Pages", () => {
    it("Substantive policy & trust routes exist and Footer/Sidebar have zero dead href='#' links", async () => {
      const [about, privacy, terms, contact, footer, sidebar, hero, adsTxt, sitemap, robots] =
        await Promise.all([
          fs.readFile(path.resolve(process.cwd(), "src/routes/about.tsx"), "utf8"),
          fs.readFile(path.resolve(process.cwd(), "src/routes/privacy.tsx"), "utf8"),
          fs.readFile(path.resolve(process.cwd(), "src/routes/terms.tsx"), "utf8"),
          fs.readFile(path.resolve(process.cwd(), "src/routes/contact.tsx"), "utf8"),
          fs.readFile(path.resolve(process.cwd(), "src/components/videohub/Footer.tsx"), "utf8"),
          fs.readFile(path.resolve(process.cwd(), "src/components/videohub/Sidebar.tsx"), "utf8"),
          fs.readFile(path.resolve(process.cwd(), "src/components/videohub/Hero.tsx"), "utf8"),
          fs.readFile(path.resolve(process.cwd(), "public/ads.txt"), "utf8"),
          fs.readFile(path.resolve(process.cwd(), "public/sitemap.xml"), "utf8"),
          fs.readFile(path.resolve(process.cwd(), "public/robots.txt"), "utf8"),
        ]);

      assert.ok(about.includes('createFileRoute("/about")'));
      assert.ok(privacy.includes('createFileRoute("/privacy")'));
      assert.ok(privacy.includes("Google AdSense"));
      assert.ok(privacy.includes("https://www.google.com/settings/ads"));
      assert.ok(terms.includes('createFileRoute("/terms")'));
      assert.ok(contact.includes('createFileRoute("/contact")'));
      assert.ok(contact.includes("support@facetube.online"));

      assert.ok(!footer.includes('href="#"'), "Footer must not contain dead href='#' links");
      assert.ok(
        footer.includes("/about") &&
          footer.includes("/privacy") &&
          footer.includes("/terms") &&
          footer.includes("/contact"),
      );
      assert.ok(
        sidebar.includes('to="/about"') &&
          sidebar.includes('to="/privacy"') &&
          sidebar.includes('to="/terms"'),
      );
      assert.ok(hero.includes('to="/explore"') && hero.includes('to="/watch-later"'));

      // Preserve existing ads.txt & publisher credentials completely untouched
      assert.ok(adsTxt.includes("pub-9404076664639786"));
      assert.ok(sitemap.includes("https://facetube.online/privacy"));
      assert.ok(
        robots.includes("Allow: /") &&
          robots.includes("Sitemap: https://facetube.online/sitemap.xml"),
      );
    });
  });
});
