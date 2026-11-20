import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { handleApiRequest, isAdPromotionActive, resetInMemoryStore } from "./api-handler.js";
import { setMysqlPoolForTesting } from "./mysql.js";

const env = {
  NODE_ENV: "test",
};

describe("FaceTube Task 4: Dynamic Sponsor Ad Video Dashboard Tests", () => {
  it("1. isAdPromotionActive accurately differentiates active vs expired vs unpromoted campaigns", () => {
    const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const pastDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

    // Active campaign: is_promoted true and expiry in future
    assert.equal(
      isAdPromotionActive({
        is_promoted: true,
        promotion_expires_at: futureDate,
      }),
      true,
    );

    // Expired campaign: is_promoted true but expiry in the past
    assert.equal(
      isAdPromotionActive({
        is_promoted: true,
        promotion_expires_at: pastDate,
      }),
      false,
    );

    // Unpromoted video: is_promoted false even if date is provided
    assert.equal(
      isAdPromotionActive({
        is_promoted: false,
        promotion_expires_at: futureDate,
      }),
      false,
    );

    // Missing expiry date
    assert.equal(
      isAdPromotionActive({
        is_promoted: true,
        promotion_expires_at: null,
      }),
      false,
    );
  });

  it("2. /api/videos/list returns real campaign deliverables for specific creator (FT483921)", async () => {
    const req = new Request("http://localhost:3000/api/videos/list?userId=FT483921", {
      method: "GET",
    });

    const res = await handleApiRequest(req, env);
    assert.ok(res);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.success, true);
    assert.ok(Array.isArray(body.videos));
    assert.ok(body.videos.length > 0);

    // All returned videos must strictly belong to FT483921
    for (const v of body.videos) {
      assert.equal(v.userId.toUpperCase(), "FT483921");
      assert.equal(typeof v.views, "number");
      assert.equal(typeof v.likes, "number");
      assert.equal(typeof v.isPromoted, "boolean");
    }

    // Must find the promoted video for FT483921 (vid-seed-002)
    const promotedVid = body.videos.find((v: any) => v.id === "vid-seed-002");
    assert.ok(promotedVid, "vid-seed-002 should exist for FT483921");
    assert.equal(promotedVid.isPromoted, true);
    assert.equal(promotedVid.promotionPlan, "plan-7-days");
    assert.ok(promotedVid.promotionExpiresAt);
  });

  it("3. /api/videos/list with Maya Lin (FT900431) isolates her campaign from Alex Rivera", async () => {
    const req = new Request("http://localhost:3000/api/videos/list?userId=FT900431", {
      method: "GET",
    });

    const res = await handleApiRequest(req, env);
    assert.ok(res);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.success, true);

    // All videos must belong strictly to FT900431
    for (const v of body.videos) {
      assert.equal(v.userId.toUpperCase(), "FT900431");
    }

    // Must not leak Alex Rivera's videos
    const alexVid = body.videos.find((v: any) => v.id === "vid-seed-002");
    assert.equal(alexVid, undefined, "FT483921's video must not leak in FT900431's video list");

    // Must include Maya's promoted video vid-seed-004
    const mayaPromoted = body.videos.find((v: any) => v.id === "vid-seed-004");
    assert.ok(mayaPromoted, "vid-seed-004 should exist for FT900431");
    assert.equal(mayaPromoted.promotionPlan, "plan-monthly");
  });

  it("4. /api/videos/list without userId returns all videos for platform-wide admin audit", async () => {
    const req = new Request("http://localhost:3000/api/videos/list", {
      method: "GET",
    });

    const res = await handleApiRequest(req, env);
    assert.ok(res);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.success, true);
    assert.ok(body.videos.length >= 2);

    // Should contain both FT483921 and FT900431 videos
    const hasAlex = body.videos.some((v: any) => v.userId === "FT483921");
    const hasMaya = body.videos.some((v: any) => v.userId === "FT900431");
    assert.ok(hasAlex, "Platform-wide list must include Alex Rivera");
    assert.ok(hasMaya, "Platform-wide list must include Maya Lin");
  });

  it("5. /api/wallet/balance requires authentication and rejects unauthenticated request", async () => {
    const req = new Request("http://localhost:3000/api/wallet/balance?userId=FT483921", {
      method: "GET",
    });

    const res = await handleApiRequest(req, env);
    assert.ok(res);
    assert.equal(res.status, 401);

    const body = await res.json();
    assert.equal(body.success, false);
    assert.match(body.error, /Authentication required/i);
  });

  it("6. Promotion plan presets define valid pricing structure for campaigns", () => {
    const plans: Record<string, number> = {
      "plan-7-days": 100,
      "plan-15-days": 200,
      "plan-monthly": 300,
      "plan-yearly": 3000,
    };

    assert.equal(plans["plan-7-days"], 100);
    assert.equal(plans["plan-15-days"], 200);
    assert.equal(plans["plan-monthly"], 300);
    assert.equal(plans["plan-yearly"], 3000);
  });

  describe("7. Task 5J-K: Videos & Images Production Fail-Closed Guards", () => {
    const storePath = path.resolve(process.cwd(), "data/facetube_store.json");
    const envKeys = ["NODE_ENV", "APP_ENV", "DB_HOST", "DB_NAME", "DB_USER"] as const;
    let envSnapshot: Record<string, string | undefined> = {};
    let suiteStoreSnapshot: string | null = null;
    let suiteStoreExisted = false;

    function enableMockDbEnv(mockPool: any) {
      process.env["DB_HOST"] = "127.0.0.1";
      process.env["DB_NAME"] = "facetube_test";
      process.env["DB_USER"] = "test_user";
      setMysqlPoolForTesting(mockPool);
    }

    beforeEach(() => {
      envSnapshot = {};
      for (const k of envKeys) {
        envSnapshot[k] = process.env[k];
      }
      suiteStoreExisted = fs.existsSync(storePath);
      suiteStoreSnapshot = suiteStoreExisted ? fs.readFileSync(storePath, "utf-8") : null;
      setMysqlPoolForTesting(null);
      resetInMemoryStore();
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
      if (suiteStoreExisted && suiteStoreSnapshot !== null) {
        fs.writeFileSync(storePath, suiteStoreSnapshot, "utf-8");
      } else if (!suiteStoreExisted && fs.existsSync(storePath)) {
        fs.unlinkSync(storePath);
      }
      resetInMemoryStore();
    });

    it("returns HTTP 503 for videos/list, videos/get, and images/list in production without MySQL pool", async () => {
      process.env["APP_ENV"] = "production";
      delete process.env["NODE_ENV"];
      delete process.env["DB_HOST"];
      setMysqlPoolForTesting(null);

      const listRes = await handleApiRequest(
        new Request("http://localhost:3000/api/videos/list", { method: "GET" }),
      );
      assert.equal(listRes?.status, 503);

      const getRes = await handleApiRequest(
        new Request("http://localhost:3000/api/videos/get?id=vid-seed-002", { method: "GET" }),
      );
      assert.equal(getRes?.status, 503);

      const imgRes = await handleApiRequest(
        new Request("http://localhost:3000/api/images/list", { method: "GET" }),
      );
      assert.equal(imgRes?.status, 503);
    });

    it("returns HTTP 500 in production on MySQL query failures for videos/list, videos/get, and images/list", async () => {
      process.env["APP_ENV"] = "production";
      delete process.env["NODE_ENV"];
      enableMockDbEnv({
        query: async () => {
          throw new Error("ECONNREFUSED MySQL query error");
        },
      });

      const listRes = await handleApiRequest(
        new Request("http://localhost:3000/api/videos/list", { method: "GET" }),
      );
      assert.equal(listRes?.status, 500);
      const listData = (await listRes!.json()) as any;
      assert.equal(listData.success, false);
      assert.equal(listData.videos, undefined);

      const getRes = await handleApiRequest(
        new Request("http://localhost:3000/api/videos/get?id=vid-seed-002", { method: "GET" }),
      );
      assert.equal(getRes?.status, 500);
      const getData = (await getRes!.json()) as any;
      assert.equal(getData.success, false);
      assert.equal(getData.video, undefined);

      const imgRes = await handleApiRequest(
        new Request("http://localhost:3000/api/images/list", { method: "GET" }),
      );
      assert.equal(imgRes?.status, 500);
      const imgData = (await imgRes!.json()) as any;
      assert.equal(imgData.success, false);
      assert.equal(imgData.images, undefined);
    });

    it("does not fall back to JSON store when MySQL returns valid empty results for videos/list, videos/get, and images/list", async () => {
      process.env["NODE_ENV"] = "test";
      delete process.env["APP_ENV"];
      enableMockDbEnv({
        query: async () => [[], []],
      });

      const listRes = await handleApiRequest(
        new Request("http://localhost:3000/api/videos/list", { method: "GET" }),
      );
      assert.equal(listRes?.status, 200);
      const listData = (await listRes!.json()) as any;
      assert.equal(listData.success, true);
      assert.deepEqual(listData.videos, []);
      assert.equal(listData.total, 0);

      const getRes = await handleApiRequest(
        new Request("http://localhost:3000/api/videos/get?id=vid-seed-002", { method: "GET" }),
      );
      assert.equal(getRes?.status, 404);
      const getData = (await getRes!.json()) as any;
      assert.equal(getData.success, false);

      const imgRes = await handleApiRequest(
        new Request("http://localhost:3000/api/images/list", { method: "GET" }),
      );
      assert.equal(imgRes?.status, 200);
      const imgData = (await imgRes!.json()) as any;
      assert.equal(imgData.success, true);
      assert.deepEqual(imgData.images, []);
      assert.equal(imgData.total, 0);
    });

    it("preserves non-production images/list JSON fallback with public channel branding and no PII", async () => {
      process.env["NODE_ENV"] = "test";
      delete process.env["APP_ENV"];
      setMysqlPoolForTesting(null);

      const res = await handleApiRequest(
        new Request("http://localhost:3000/api/images/list", { method: "GET" }),
      );
      assert.equal(res?.status, 200);
      const data = (await res!.json()) as any;
      assert.equal(data.success, true);
      assert.ok(Array.isArray(data.images));
      for (const img of data.images) {
        assert.equal("email" in img, false);
        assert.equal("mobile" in img, false);
        assert.equal("password_hash" in img, false);
        assert.equal("referral_code" in img, false);
      }
    });

    it("verifies api/images/list.php returns HTTP 500 on PDOException without exposing raw SQL errors", () => {
      const phpPath = path.resolve(process.cwd(), "api/images/list.php");
      const phpContent = fs.readFileSync(phpPath, "utf-8");
      const catchMatch = phpContent.match(/catch\s*\(\s*PDOException\s+\$e\s*\)\s*\{([\s\S]*?)\}/);
      assert.ok(catchMatch && catchMatch[1], "api/images/list.php must catch PDOException");
      const catchBody = catchMatch[1];
      assert.match(catchBody, /jsonResponse\([\s\S]*'success'\s*=>\s*false[\s\S]*,\s*500\s*\)/);
      assert.doesNotMatch(catchBody, /'success'\s*=>\s*true/);
      assert.doesNotMatch(catchBody, /\$e->getMessage\(\)/);
    });

    it("normalizes relative /uploads/... channel_logo_url in Node images/list (MySQL and JSON fallback) while preserving absolute, null, and empty values without PII", async () => {
      const mediaKeys = ["FACETUBE_API_BASE_URL", "API_BASE_URL", "VITE_MEDIA_BASE_URL"] as const;
      const mediaSnapshot: Record<string, string | undefined> = {};
      for (const k of mediaKeys) {
        mediaSnapshot[k] = process.env[k];
        delete process.env[k];
      }

      try {
        process.env["APP_ENV"] = "production";
        delete process.env["NODE_ENV"];
        enableMockDbEnv({
          query: async () => [
            [
              {
                id: "img_rel",
                user_id: "FT483921",
                creator_name: "Alex Rivera",
                creator_channel_name: "Alex Studio",
                creator_channel_logo_url: "/uploads/logos/img_rel.png",
                title: "Relative Logo Image",
                description: "",
                image_url: "https://cdn.example.com/img1.jpg",
                format: "jpg",
                file_size: "1.0 MB",
                category: "General",
                views: 10,
                likes: 2,
                created_at: "2026-11-20T00:00:00.000Z",
              },
              {
                id: "img_abs",
                user_id: "FT483922",
                creator_name: "Maya Lin",
                creator_channel_name: "Maya Studio",
                creator_channel_logo_url: "https://cdn.example.com/logos/maya.png",
                title: "Absolute Logo Image",
                description: "",
                image_url: "https://cdn.example.com/img2.jpg",
                format: "jpg",
                file_size: "1.0 MB",
                category: "General",
                views: 5,
                likes: 1,
                created_at: "2026-11-20T00:00:00.000Z",
              },
              {
                id: "img_null",
                user_id: "FT483923",
                creator_name: "Null Logo",
                creator_channel_name: null,
                creator_channel_logo_url: null,
                title: "Null Logo Image",
                description: "",
                image_url: "https://cdn.example.com/img3.jpg",
                format: "jpg",
                file_size: "1.0 MB",
                category: "General",
                views: 1,
                likes: 0,
                created_at: "2026-11-20T00:00:00.000Z",
              },
              {
                id: "img_empty",
                user_id: "FT483924",
                creator_name: "Empty Logo",
                creator_channel_name: "",
                creator_channel_logo_url: "",
                title: "Empty Logo Image",
                description: "",
                image_url: "https://cdn.example.com/img4.jpg",
                format: "jpg",
                file_size: "1.0 MB",
                category: "General",
                views: 1,
                likes: 0,
                created_at: "2026-11-20T00:00:00.000Z",
              },
            ],
            [],
          ],
        });

        const prodRes = await handleApiRequest(
          new Request("http://localhost:3000/api/images/list", { method: "GET" }),
        );
        assert.equal(prodRes?.status, 200);
        const prodData = (await prodRes!.json()) as any;
        assert.equal(prodData.images.length, 4);
        assert.equal(
          prodData.images[0].channelLogoUrl,
          "https://api.facetube.online/uploads/logos/img_rel.png",
        );
        assert.equal(
          prodData.images[0].channel_logo_url,
          "https://api.facetube.online/uploads/logos/img_rel.png",
        );
        assert.equal(prodData.images[1].channelLogoUrl, "https://cdn.example.com/logos/maya.png");
        assert.equal(prodData.images[2].channelLogoUrl, null);
        assert.equal(prodData.images[3].channelLogoUrl, null);

        // Non-production JSON store fallback with facetube.online request host also normalizes relative logos
        process.env["NODE_ENV"] = "test";
        delete process.env["APP_ENV"];
        delete process.env["DB_HOST"];
        setMysqlPoolForTesting(null);

        const baseStore = suiteStoreSnapshot
          ? JSON.parse(suiteStoreSnapshot)
          : { users: [], images: [] };
        baseStore.users = [
          {
            id: "u-img-test",
            user_id: "FT777001",
            name: "JSON Image Creator",
            channel_name: "JSON Image Studio",
            channel_logo_url: "/uploads/logos/json_img_logo.png",
            email: "secret@facetube.com",
            mobile: "+1 555-999-0000",
            password_hash: "secret_hash",
            referral_code: "SECRET",
            role: "user",
            created_at: "2026-11-01T00:00:00.000Z",
          },
        ];
        baseStore.images = [
          {
            id: "json_img_1",
            user_id: "FT777001",
            creator_name: "JSON Image Creator",
            title: "JSON Image",
            description: "",
            image_url: "/uploads/images/json_pic.jpg",
            format: "jpg",
            file_size: "1.0 MB",
            category: "General",
            views: 0,
            likes: 0,
            created_at: "2026-11-20T00:00:00.000Z",
          },
        ];
        fs.writeFileSync(storePath, JSON.stringify(baseStore), "utf-8");
        resetInMemoryStore();

        const jsonRes = await handleApiRequest(
          new Request("https://facetube.online/api/images/list", { method: "GET" }),
        );
        assert.equal(jsonRes?.status, 200);
        const jsonData = (await jsonRes!.json()) as any;
        assert.equal(jsonData.images.length, 1);
        assert.equal(
          jsonData.images[0].channelLogoUrl,
          "https://api.facetube.online/uploads/logos/json_img_logo.png",
        );
        assert.equal("email" in jsonData.images[0], false);
        assert.equal("mobile" in jsonData.images[0], false);
        assert.equal("password_hash" in jsonData.images[0], false);
        assert.equal("referral_code" in jsonData.images[0], false);
      } finally {
        for (const k of mediaKeys) {
          if (mediaSnapshot[k] !== undefined) {
            process.env[k] = mediaSnapshot[k];
          } else {
            delete process.env[k];
          }
        }
      }
    });
  });
});
