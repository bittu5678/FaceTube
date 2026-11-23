import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleApiRequest, resetInMemoryStore } from "./api-handler.ts";
import { setMysqlPoolForTesting } from "./mysql.ts";
import { buildDashboardCategoryCatalog } from "../lib/dashboard-categories.ts";
import {
  VIDEO_CATEGORIES,
  buildExploreCategoryList,
  filterExploreVideos,
  getAvailableCategories,
} from "../lib/video-service.ts";
import {
  CATEGORY_THUMBNAILS,
  getCategoryFallbackThumbnail,
  resolveVideoThumbnail,
  uploadThumbnailDataUrl,
} from "../lib/thumbnail-service.ts";

describe("Priority 3: Admin Category Management & Verification Tests", () => {
  let adminToken = "";
  let userToken = "";
  let tmpDataDir = "";
  const createdDiskFiles: string[] = [];

  const origDataDir = process.env["FACETUBE_DATA_DIR"];
  const origNodeEnv = process.env["NODE_ENV"];
  const origDbHost = process.env["DB_HOST"];
  const origDbName = process.env["DB_NAME"];
  const origDbUser = process.env["DB_USER"];
  const origDbPassword = process.env["DB_PASSWORD"];
  const origMysqlHost = process.env["MYSQL_HOST"];
  const origMysqlDatabase = process.env["MYSQL_DATABASE"];
  const origMysqlUser = process.env["MYSQL_USER"];
  const origMysqlPassword = process.env["MYSQL_PASSWORD"];

  function clearDbEnvVars(): void {
    delete process.env["DB_HOST"];
    delete process.env["DB_NAME"];
    delete process.env["DB_USER"];
    delete process.env["DB_PASSWORD"];
    delete process.env["MYSQL_HOST"];
    delete process.env["MYSQL_DATABASE"];
    delete process.env["MYSQL_USER"];
    delete process.env["MYSQL_PASSWORD"];
  }

  function restoreEnvVar(key: string, val: string | undefined): void {
    if (val !== undefined) process.env[key] = val;
    else delete process.env[key];
  }

  before(async () => {
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "facetube-categories-test-"));
    process.env["FACETUBE_DATA_DIR"] = tmpDataDir;
    clearDbEnvVars();
    setMysqlPoolForTesting(null);
    resetInMemoryStore();

    // 1. Authenticate as Admin (FT102857 / admin@facetube.com)
    const adminLoginReq = new Request("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "admin@facetube.com", password: "password" }),
    });
    const adminLoginRes = await handleApiRequest(adminLoginReq);
    assert.ok(adminLoginRes, "Admin login request must return a response");
    const adminData = await adminLoginRes.json();
    assert.ok(adminData.token, "Admin login must return a session token");
    adminToken = adminData.token;

    // 2. Authenticate as Standard User (FT483921 / alex@facetube.com)
    const userLoginReq = new Request("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "alex@facetube.com", password: "password123" }),
    });
    const userLoginRes = await handleApiRequest(userLoginReq);
    assert.ok(userLoginRes, "User login request must return a response");
    const userData = await userLoginRes.json();
    assert.ok(userData.token, "User login must return a session token");
    userToken = userData.token;
  });

  afterEach(async () => {
    setMysqlPoolForTesting(null);
    clearDbEnvVars();
    while (createdDiskFiles.length > 0) {
      const target = createdDiskFiles.pop();
      if (target) {
        await fs.promises.rm(target, { force: true }).catch(() => undefined);
      }
    }
  });

  after(() => {
    setMysqlPoolForTesting(null);
    resetInMemoryStore();
    restoreEnvVar("FACETUBE_DATA_DIR", origDataDir);
    restoreEnvVar("NODE_ENV", origNodeEnv);
    restoreEnvVar("DB_HOST", origDbHost);
    restoreEnvVar("DB_NAME", origDbName);
    restoreEnvVar("DB_USER", origDbUser);
    restoreEnvVar("DB_PASSWORD", origDbPassword);
    restoreEnvVar("MYSQL_HOST", origMysqlHost);
    restoreEnvVar("MYSQL_DATABASE", origMysqlDatabase);
    restoreEnvVar("MYSQL_USER", origMysqlUser);
    restoreEnvVar("MYSQL_PASSWORD", origMysqlPassword);
    if (tmpDataDir && fs.existsSync(tmpDataDir)) {
      fs.rmSync(tmpDataDir, { recursive: true, force: true });
    }
  });

  // Test Suite 1: Category Listing
  describe("1. Category Listing Endpoint (/api/categories/list)", () => {
    it("returns 200 with categories list and source indicator", async () => {
      const req = new Request("http://localhost:3000/api/categories/list", {
        method: "GET",
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 200);

      const data = await res.json();
      assert.equal(data.success, true);
      assert.ok(Array.isArray(data.categories), "categories must be an array");
      assert.ok(data.categories.length >= 13, "baseline categories must contain at least 13 items");

      const names = data.categories.map((c: any) => c.name);
      assert.ok(names.includes("Comedy"), "Must include baseline category Comedy");
      assert.ok(names.includes("Coding"), "Must include baseline category Coding");
    });
  });

  // Test Suite 2: Authentication & RBAC Authorization
  describe("2. Authentication and Authorization on Admin Category Creation", () => {
    it("rejects unauthenticated requests with HTTP 401", async () => {
      const req = new Request("http://localhost:3000/api/admin/categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Robotics" }),
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 401);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /authentication required/i);
    });

    it("rejects non-admin authenticated users with HTTP 403 Forbidden", async () => {
      const req = new Request("http://localhost:3000/api/admin/categories", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({ name: "Robotics" }),
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 403);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /admin authorization required/i);
    });
  });

  // Test Suite 3: Input Validation
  describe("3. Input Validation on Category Creation", () => {
    it("rejects empty category name with HTTP 400", async () => {
      const req = new Request("http://localhost:3000/api/admin/categories", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ name: "   " }),
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /category name is required/i);
    });

    it("rejects category names shorter than 2 characters with HTTP 400", async () => {
      const req = new Request("http://localhost:3000/api/admin/categories", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ name: "A" }),
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /at least 2 characters/i);
    });

    it("rejects category names longer than 100 characters with HTTP 400", async () => {
      const longName = "X".repeat(101);
      const req = new Request("http://localhost:3000/api/admin/categories", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ name: longName }),
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /must not exceed 100 characters/i);
    });
  });

  // Test Suite 4: Category Creation & Duplicate Prevention
  describe("4. Category Creation & Case-Insensitive Duplicate Handling", () => {
    const uniqueCategoryName = `Web Dev ${Date.now()}`;

    it("allows verified administrator to create a new category with HTTP 201", async () => {
      const req = new Request("http://localhost:3000/api/admin/categories", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ name: uniqueCategoryName }),
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 201);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.ok(data.category);
      assert.equal(data.category.name, uniqueCategoryName);
      assert.ok(data.category.slug);
    });

    it("rejects exact duplicate category name with HTTP 409 Conflict", async () => {
      const req = new Request("http://localhost:3000/api/admin/categories", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ name: uniqueCategoryName }),
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 409);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /already exists/i);
    });

    it("rejects case-insensitive duplicate category name (lowercase) with HTTP 409", async () => {
      const req = new Request("http://localhost:3000/api/admin/categories", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ name: uniqueCategoryName.toLowerCase() }),
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 409);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /already exists/i);
    });

    it("rejects duplicate matching a baseline category case-insensitively (e.g. 'coding')", async () => {
      const req = new Request("http://localhost:3000/api/admin/categories", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ name: "coding" }),
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 409);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /already exists/i);
    });
  });

  // Test Suite 5: PHP Codebase & Migration Artifact Verification
  describe("5. Hostinger PHP Codebase & Migration File Verification", () => {
    it("verifies database/migrations/20261030_create_categories_table.sql exists and is idempotent", () => {
      const migrationPath = path.resolve(
        process.cwd(),
        "database/migrations/20261030_create_categories_table.sql",
      );
      assert.ok(fs.existsSync(migrationPath), "Migration SQL file must exist");
      const sql = fs.readFileSync(migrationPath, "utf-8");

      assert.match(sql, /CREATE TABLE IF NOT EXISTS `categories`/i);
      assert.match(sql, /UNIQUE KEY `uniq_categories_name`/i);
      assert.match(sql, /UNIQUE KEY `uniq_categories_slug`/i);
      assert.match(sql, /INSERT IGNORE INTO `categories`/i);
      assert.match(sql, /DO NOT EXECUTE ON PRODUCTION WITHOUT SIGN-OFF/i);
    });

    it("verifies api/categories/list.php exists and implements graceful migration-pending fallback", () => {
      const listPhpPath = path.resolve(process.cwd(), "api/categories/list.php");
      assert.ok(fs.existsSync(listPhpPath), "api/categories/list.php must exist");
      const php = fs.readFileSync(listPhpPath, "utf-8");

      assert.match(php, /REQUEST_METHOD.+GET/);
      assert.match(php, /SELECT id, name, slug, created_by, created_at FROM categories/);
      assert.match(php, /baseline_fallback/);
    });

    it("verifies api/admin/categories.php exists with Bearer auth, admin RBAC, and duplicate check", () => {
      const adminPhpPath = path.resolve(process.cwd(), "api/admin/categories.php");
      assert.ok(fs.existsSync(adminPhpPath), "api/admin/categories.php must exist");
      const php = fs.readFileSync(adminPhpPath, "utf-8");

      assert.match(php, /REQUEST_METHOD.+POST/);
      assert.match(php, /getAuthUser\(\$pdo\)/);
      assert.match(php, /'admin'/);
      assert.match(php, /LOWER\(TRIM\(name\)\) = LOWER\(\?\)/);
      assert.match(php, /INSERT INTO categories/);
    });
  });

  // Test Suite 6: Production Safety & Database Fallback Protection Tests
  describe("6. Production Safety & Database Fallback Protection", () => {
    it("fails closed with HTTP 503 on category creation when NODE_ENV=production and MySQL pool is unavailable", async () => {
      const prevEnv = process.env["NODE_ENV"];
      try {
        process.env["NODE_ENV"] = "production";

        const req = new Request("http://localhost:3000/api/admin/categories", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${adminToken}`,
          },
          body: JSON.stringify({ name: "Cloud Architecture" }),
        });

        const res = await handleApiRequest(req);
        assert.ok(res);
        assert.equal(res.status, 503);

        const data = await res.json();
        assert.equal(data.success, false);
        assert.match(data.error, /database connection unavailable/i);
      } finally {
        process.env["NODE_ENV"] = prevEnv;
      }
    });

    it("returns clean baseline categories in production without silently relying on local JSON storage", async () => {
      const prevEnv = process.env["NODE_ENV"];
      try {
        process.env["NODE_ENV"] = "production";

        const req = new Request("http://localhost:3000/api/categories/list", {
          method: "GET",
        });

        const res = await handleApiRequest(req);
        assert.ok(res);
        assert.equal(res.status, 200);

        const data = await res.json();
        assert.equal(data.success, true);
        assert.equal(data.source, "baseline_fallback");
        assert.ok(Array.isArray(data.categories));
        assert.ok(data.categories.length >= 13);

        const names = data.categories.map((c: any) => c.name);
        assert.ok(names.includes("Cartoon"));
        assert.ok(names.includes("Coding"));
      } finally {
        process.env["NODE_ENV"] = prevEnv;
      }
    });
  });

  // Test Suite 7: Dashboard Category Integration (Health, Sports, Drama)
  describe("7. Dashboard Category Integration & Deduplication", () => {
    it("displays Health, Sports, and Drama together while preserving existing categories and avoiding duplicates when missing from DB", () => {
      const apiCats = [
        { id: 1, name: "Cartoon", slug: "cartoon", created_by: "SYSTEM" },
        { id: 2, name: "Coding", slug: "coding", created_by: "SYSTEM" },
        { id: 3, name: "Music", slug: "music", created_by: "SYSTEM" },
      ];

      const catalog = buildDashboardCategoryCatalog(apiCats);

      assert.deepEqual(
        catalog.featured.map((c) => c.name),
        ["Health", "Sports", "Drama"],
      );
      assert.equal(
        catalog.featured.every((c) => c.existsInDb === false),
        true,
      );
      assert.deepEqual(
        catalog.existing.map((c) => c.name),
        ["Cartoon", "Coding", "Music"],
      );
      assert.equal(catalog.allUniqueNames.length, 6);
    });

    it("reuses existing database Health, Sports, and Drama records case-insensitively without duplicates", () => {
      const apiCats = [
        { id: 101, name: "health", slug: "health", created_by: "FT102857" },
        { id: 102, name: "Sports", slug: "sports", created_by: "FT102857" },
        { id: 103, name: "DRAMA", slug: "drama", created_by: "FT102857" },
        { id: 104, name: "drama", slug: "drama", created_by: "FT102857" },
        { id: 105, name: "Coding", slug: "coding", created_by: "SYSTEM" },
        { id: 106, name: "coding", slug: "coding", created_by: "SYSTEM" },
      ];

      const catalog = buildDashboardCategoryCatalog(apiCats);

      assert.equal(catalog.featured.length, 3);
      assert.equal(catalog.featured[0]?.id, 101);
      assert.equal(catalog.featured[0]?.existsInDb, true);
      assert.equal(catalog.featured[1]?.id, 102);
      assert.equal(catalog.featured[1]?.existsInDb, true);
      assert.equal(catalog.featured[2]?.id, 103);
      assert.equal(catalog.featured[2]?.existsInDb, true);

      // Existing list must NOT duplicate Health, Sports, Drama, or Coding
      assert.deepEqual(
        catalog.existing.map((c) => c.name),
        ["Coding"],
      );
      assert.equal(catalog.allUniqueNames.length, 4);
    });

    it("allows both logged-out and logged-in visitors to query categories and category-filtered videos", async () => {
      // Logged-out category listing
      const catRes = await handleApiRequest(
        new Request("http://localhost:3000/api/categories/list", { method: "GET" }),
      );
      assert.ok(catRes);
      assert.equal(catRes.status, 200);
      const catData = await catRes.json();
      assert.equal(catData.success, true);
      assert.ok(Array.isArray(catData.categories));

      // Logged-out category video filtering for Coding (existing videos)
      const codingRes = await handleApiRequest(
        new Request("http://localhost:3000/api/videos/list?category=Coding", { method: "GET" }),
      );
      assert.ok(codingRes);
      assert.equal(codingRes.status, 200);
      const codingData = await codingRes.json();
      assert.equal(codingData.success, true);
      assert.ok(Array.isArray(codingData.videos));
      assert.ok(codingData.videos.every((v: any) => String(v.category).toLowerCase() === "coding"));

      // Logged-in category video filtering for Health/Sports/Drama returns only real matching records (no fake demo videos)
      for (const catName of ["Health", "Sports", "Drama"]) {
        const res = await handleApiRequest(
          new Request(
            `http://localhost:3000/api/videos/list?category=${encodeURIComponent(catName)}`,
            {
              method: "GET",
              headers: { Authorization: `Bearer ${userToken}` },
            },
          ),
        );
        assert.ok(res);
        assert.equal(res.status, 200);
        const data = await res.json();
        assert.equal(data.success, true);
        assert.ok(Array.isArray(data.videos));
        assert.ok(
          data.videos.every((v: any) => String(v.category).toLowerCase() === catName.toLowerCase()),
        );
      }
    });
  });

  // Test Suite 8: Health, Sports & Drama End-to-End Category Coverage
  describe("8. Health, Sports & Drama End-to-End Category Coverage", () => {
    it("includes Health, Sports, and Drama in shared VIDEO_CATEGORIES catalogs without duplicates while preserving existing 18 categories", () => {
      const expectedBaseline = [
        "Cartoon",
        "Agriculture",
        "Motivational",
        "Comedy",
        "Blog",
        "Movie",
        "Entertainment",
        "Cooking",
        "Finance",
        "Share Market",
        "Business",
        "Crypto",
        "Coding",
        "Music",
        "Gaming",
        "Travel",
        "AI",
        "Education",
        "Health",
        "Sports",
        "Drama",
      ];

      assert.deepEqual([...VIDEO_CATEGORIES], expectedBaseline);
      const lowerSet = new Set(VIDEO_CATEGORIES.map((c) => c.toLowerCase()));
      assert.equal(
        lowerSet.size,
        VIDEO_CATEGORIES.length,
        "VIDEO_CATEGORIES must contain no case-insensitive duplicates",
      );

      const dataVideosSrc = fs.readFileSync(
        path.resolve(process.cwd(), "src/data/videos.ts"),
        "utf-8",
      );
      const match = dataVideosSrc.match(/export const VIDEO_CATEGORIES = \[([\s\S]*?)\] as const;/);
      assert.ok(match && match[1], "src/data/videos.ts must define VIDEO_CATEGORIES");
      const parsedDataCategories = [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
      assert.deepEqual(parsedDataCategories, expectedBaseline);
      assert.match(dataVideosSrc, /export const categories = \["All", \.\.\.VIDEO_CATEGORIES\]/);
    });

    it("ensures Node and PHP baseline category APIs return Health, Sports, and Drama in parity without duplicates", async () => {
      // 1. Node default /api/categories/list
      const nodeRes = await handleApiRequest(
        new Request("http://localhost:3000/api/categories/list", { method: "GET" }),
      );
      assert.ok(nodeRes);
      assert.equal(nodeRes.status, 200);
      const nodeData = await nodeRes.json();
      assert.equal(nodeData.success, true);

      const nodeNames: string[] = nodeData.categories.map((c: any) => String(c.name));
      const nodeLower = nodeNames.map((n) => n.toLowerCase());
      assert.equal(
        new Set(nodeLower).size,
        nodeNames.length,
        "Node categories list must have no case-insensitive duplicates",
      );
      for (const reqCat of ["Health", "Sports", "Drama"]) {
        assert.ok(nodeNames.includes(reqCat), `Node categories list must include ${reqCat}`);
      }

      // 2. Node production baseline_fallback
      const prevEnv = process.env["NODE_ENV"];
      try {
        process.env["NODE_ENV"] = "production";
        const prodRes = await handleApiRequest(
          new Request("http://localhost:3000/api/categories/list", { method: "GET" }),
        );
        assert.ok(prodRes);
        assert.equal(prodRes.status, 200);
        const prodData = await prodRes.json();
        assert.equal(prodData.source, "baseline_fallback");
        const prodNames: string[] = prodData.categories.map((c: any) => String(c.name));
        for (const reqCat of VIDEO_CATEGORIES) {
          assert.ok(
            prodNames.includes(reqCat),
            `Production baseline_fallback must include ${reqCat}`,
          );
        }
      } finally {
        process.env["NODE_ENV"] = prevEnv;
      }

      // 3. PHP baseline parity check in api/categories/list.php
      const listPhp = fs.readFileSync(
        path.resolve(process.cwd(), "api/categories/list.php"),
        "utf-8",
      );
      const phpMatch = listPhp.match(/\$baselineCategories = \[([\s\S]*?)\];/);
      assert.ok(phpMatch && phpMatch[1], "api/categories/list.php must define $baselineCategories");
      const phpBaseline = [...phpMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
      assert.deepEqual(phpBaseline, [...VIDEO_CATEGORIES]);
      assert.match(
        listPhp,
        /usort\(\$categories,\s*function\s*\(\$a,\s*\$b\)\s*\{\s*return\s+strcasecmp\(\$a\['name'\],\s*\$b\['name'\]\);/s,
      );
    });

    it("rejects case-insensitive duplicate creation of Health, Sports, and Drama while preserving admin-created categories", async () => {
      for (const variant of ["health", "SPORTS", "drama"]) {
        const res = await handleApiRequest(
          new Request("http://localhost:3000/api/admin/categories", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${adminToken}`,
            },
            body: JSON.stringify({ name: variant }),
          }),
        );
        assert.ok(res);
        assert.equal(res.status, 409, `Duplicate category "${variant}" must return HTTP 409`);
        const data = await res.json();
        assert.equal(data.success, false);
        assert.match(data.error, /already exists/i);
      }

      // Existing custom admin category creation & persistence in listing remains functional
      const customName = `Podcast Tech ${Date.now()}`;
      const createRes = await handleApiRequest(
        new Request("http://localhost:3000/api/admin/categories", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${adminToken}`,
          },
          body: JSON.stringify({ name: customName }),
        }),
      );
      assert.ok(createRes);
      assert.equal(createRes.status, 201);

      const listRes = await handleApiRequest(
        new Request("http://localhost:3000/api/categories/list", { method: "GET" }),
      );
      assert.ok(listRes);
      const listData = await listRes.json();
      assert.ok(
        listData.categories.some((c: any) => c.name === customName),
        "Newly admin-created category must appear alongside baseline categories",
      );
    });

    it("wires getAvailableCategories() to merge API categories with VIDEO_CATEGORIES case-insensitively without duplicates", async () => {
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = (async () =>
          new Response(
            JSON.stringify({
              success: true,
              source: "database",
              categories: [
                { id: 1, name: "Coding", slug: "coding" },
                { id: 2, name: "health", slug: "health" },
                { id: 99, name: "Custom Studio", slug: "custom-studio" },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          )) as typeof fetch;

        const merged = await getAvailableCategories();
        const lowerMerged = merged.map((c) => c.toLowerCase());
        assert.equal(
          new Set(lowerMerged).size,
          merged.length,
          "Merged categories must have zero duplicates",
        );
        assert.ok(merged.includes("Custom Studio"), "Admin API categories must be preserved");
        assert.ok(lowerMerged.includes("health"));
        assert.ok(lowerMerged.includes("sports"));
        assert.ok(lowerMerged.includes("drama"));
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("verifies all four upload selectors in src/routes/upload.tsx use dynamic useUploadCategories and preserve categories-updated events", () => {
      const uploadSrc = fs.readFileSync(
        path.resolve(process.cwd(), "src/routes/upload.tsx"),
        "utf-8",
      );
      const adminSrc = fs.readFileSync(
        path.resolve(process.cwd(), "src/routes/admin.tsx"),
        "utf-8",
      );

      assert.match(uploadSrc, /function useUploadCategories\(\)/);
      assert.match(uploadSrc, /window\.addEventListener\("facetube:categories-updated"/);
      assert.match(
        adminSrc,
        /window\.dispatchEvent\(new CustomEvent\("facetube:categories-updated"\)\)/,
      );

      // Every upload view hook & dropdown uses `categories` instead of unmerged static VIDEO_CATEGORIES.map
      const selectorOccurrences = uploadSrc.match(/categories\.map\(\(cat\)\s*=>/g) || [];
      assert.ok(
        selectorOccurrences.length >= 4 && selectorOccurrences.length === 5,
        "All upload category selectors (Bulk batch + row, Free, Sponsor, Image) must iterate dynamic categories",
      );
      assert.equal(
        /VIDEO_CATEGORIES\.map/.test(uploadSrc),
        false,
        "Upload selectors must not hardcode static VIDEO_CATEGORIES.map",
      );
    });

    it("verifies Free, Premium, and Explore routes expose Health, Sports, and Drama filters cleanly", () => {
      for (const routeFile of ["src/routes/free-videos.tsx", "src/routes/premium-videos.tsx"]) {
        const src = fs.readFileSync(path.resolve(process.cwd(), routeFile), "utf-8");
        assert.match(
          src,
          /getAvailableCategories\(/,
          `${routeFile} must fetch available categories`,
        );
        assert.match(
          src,
          /facetube:categories-updated/,
          `${routeFile} must listen for admin category updates`,
        );
        assert.match(
          src,
          /availableCategories\.map\(\(cat\)/,
          `${routeFile} must render availableCategories`,
        );
      }

      const exploreSrc = fs.readFileSync(
        path.resolve(process.cwd(), "src/routes/explore.tsx"),
        "utf-8",
      );
      assert.match(exploreSrc, /getAvailableCategories\(/);
      assert.match(exploreSrc, /facetube:categories-updated/);
      assert.match(exploreSrc, /buildExploreCategoryList\(/);
      assert.match(exploreSrc, /filterExploreVideos\(/);
    });

    it("provides distinct, offline-safe fallback thumbnails for Health, Sports, and Drama in both TS and PHP", () => {
      const generalThumb = getCategoryFallbackThumbnail("General");

      for (const cat of ["Health", "Sports", "Drama"] as const) {
        const direct = CATEGORY_THUMBNAILS[cat];
        assert.ok(direct, `CATEGORY_THUMBNAILS must define ${cat}`);
        assert.ok(
          direct.startsWith("data:image/svg+xml;base64,"),
          `${cat} fallback must be offline-safe SVG data URI`,
        );
        assert.notEqual(direct, generalThumb, `${cat} fallback must be category-specific`);
        assert.equal(
          getCategoryFallbackThumbnail(cat.toLowerCase()),
          direct,
          "Fallback lookup must be case-insensitive",
        );
        assert.equal(resolveVideoThumbnail({ category: cat, thumbnailUrl: "" }), direct);
      }

      const createPhp = fs.readFileSync(
        path.resolve(process.cwd(), "api/videos/create.php"),
        "utf-8",
      );
      for (const cat of ["Health", "Sports", "Drama"] as const) {
        assert.ok(
          createPhp.includes(`'${cat}' => '${CATEGORY_THUMBNAILS[cat]}'`),
          `api/videos/create.php must match TS fallback thumbnail for ${cat}`,
        );
      }
      assert.match(createPhp, /strcasecmp\(\$catKey,\s*\$trimmedCategory\)\s*===\s*0/);
    });

    it("does not modify Go Live LIVE_SUBJECTS", () => {
      const liveSrc = fs.readFileSync(path.resolve(process.cwd(), "src/data/live.ts"), "utf-8");
      const match = liveSrc.match(/export const LIVE_SUBJECTS = \[([\s\S]*?)\] as const;/);
      assert.ok(match && match[1]);
      const subjects = [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
      assert.deepEqual(subjects, [
        "Education & Learning",
        "News & Politics",
        "Entertainment & Comedy",
        "Finance & Business",
        "Sports & Fitness",
        "Art & Design",
        "Lifestyle & Vlogs",
        "Podcasts & Talk Shows",
        "Medical & Healthcare",
      ]);
    });
  });

  // Test Suite 9: Phase 1 Minimum Safe Fixes Regression Suite
  describe("9. Phase 1 Category Migration, Thumbnail SVG Safety, Dynamic Explore & Test Isolation", () => {
    it("verifies database/migrations/20261127_seed_health_sports_drama_categories.sql is idempotent and non-destructive", () => {
      const migrationPath = path.resolve(
        process.cwd(),
        "database/migrations/20261127_seed_health_sports_drama_categories.sql",
      );
      assert.ok(fs.existsSync(migrationPath), "Health/Sports/Drama migration SQL file must exist");
      const sql = fs.readFileSync(migrationPath, "utf-8");

      assert.match(sql, /DO NOT EXECUTE ON PRODUCTION WITHOUT SIGN-OFF/i);
      assert.match(sql, /utf8mb4_unicode_ci/i);
      assert.match(sql, /INSERT IGNORE INTO `categories` \(`name`, `slug`, `created_by`\) VALUES/i);
      assert.match(sql, /\('Health',\s*'health',\s*'SYSTEM'\)/);
      assert.match(sql, /\('Sports',\s*'sports',\s*'SYSTEM'\)/);
      assert.match(sql, /\('Drama',\s*'drama',\s*'SYSTEM'\)/);
      assert.equal(/ON DUPLICATE KEY UPDATE|DROP TABLE|DELETE FROM|TRUNCATE/i.test(sql), false);

      const valueRows = [...sql.matchAll(/\('([^']+)',\s*'([^']+)',\s*'SYSTEM'\)/g)];
      assert.equal(valueRows.length, 3, "Migration must seed exactly 3 new categories");
      const names = valueRows.map((m) => m[1]?.toLowerCase());
      const slugs = valueRows.map((m) => m[2]?.toLowerCase());
      assert.equal(new Set(names).size, 3);
      assert.equal(new Set(slugs).size, 3);
    });

    it("never saves SVG fallback thumbnails with a .jpg extension in local-store /api/videos/create", async () => {
      for (const cat of ["Health", "Sports", "Drama"] as const) {
        const expectedSvg = CATEGORY_THUMBNAILS[cat];
        assert.ok(expectedSvg && expectedSvg.startsWith("data:image/svg+xml;base64,"));

        // Case A: thumbnail_url omitted
        const vidOmitted = `svg-omitted-${cat.toLowerCase()}-${Date.now()}`;
        const resOmitted = await handleApiRequest(
          new Request("http://localhost:3000/api/videos/create", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${userToken}`,
            },
            body: JSON.stringify({
              id: vidOmitted,
              user_id: "FT483921",
              creator_name: "Alex Rivera",
              title: `${cat} Omitted Thumb`,
              video_url: "/uploads/videos/sample_svg_test.mp4",
              video_type: "free",
              content_type: "long",
              category: cat,
            }),
          }),
        );
        assert.ok(resOmitted);
        assert.equal(resOmitted.status, 201);
        const bodyOmitted = await resOmitted.json();
        assert.equal(bodyOmitted.video.thumbnail_url, expectedSvg);
        assert.equal(
          fs.existsSync(
            path.resolve(process.cwd(), "uploads", "images", `thumb_${vidOmitted}.jpg`),
          ),
          false,
          `SVG fallback for ${cat} must NEVER be saved as .jpg`,
        );

        // Case B: data:image/svg+xml;base64 sent by client fallback
        const vidSupplied = `svg-supplied-${cat.toLowerCase()}-${Date.now()}`;
        const resSupplied = await handleApiRequest(
          new Request("http://localhost:3000/api/videos/create", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${userToken}`,
            },
            body: JSON.stringify({
              id: vidSupplied,
              user_id: "FT483921",
              creator_name: "Alex Rivera",
              title: `${cat} Client SVG Fallback`,
              video_url: "/uploads/videos/sample_svg_test.mp4",
              thumbnail_url: expectedSvg,
              video_type: "free",
              content_type: "long",
              category: cat,
            }),
          }),
        );
        assert.ok(resSupplied);
        assert.equal(resSupplied.status, 201);
        const bodySupplied = await resSupplied.json();
        assert.equal(bodySupplied.video.thumbnail_url, expectedSvg);
        assert.equal(
          fs.existsSync(
            path.resolve(process.cwd(), "uploads", "images", `thumb_${vidSupplied}.jpg`),
          ),
          false,
          `Supplied SVG fallback for ${cat} must NEVER be saved as .jpg`,
        );
      }
    });

    it("saves custom raster data:image/png thumbnails with .png extension and keeps SVG fallback safe in uploadThumbnailDataUrl", async () => {
      const tinyPngBase64 =
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
      const vidId = `png-custom-${Date.now()}`;
      const res = await handleApiRequest(
        new Request("http://localhost:3000/api/videos/create", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${userToken}`,
          },
          body: JSON.stringify({
            id: vidId,
            user_id: "FT483921",
            creator_name: "Alex Rivera",
            title: "Health Custom PNG Cover",
            video_url: "/uploads/videos/sample_png.mp4",
            thumbnail_url: tinyPngBase64,
            video_type: "free",
            content_type: "long",
            category: "Health",
          }),
        }),
      );
      assert.ok(res);
      assert.equal(res.status, 201);
      const data = await res.json();
      assert.equal(data.video.thumbnail_url, `/uploads/images/thumb_${vidId}.png`);
      const pngPath = path.resolve(process.cwd(), "uploads", "images", `thumb_${vidId}.png`);
      createdDiskFiles.push(pngPath);
      assert.equal(fs.existsSync(pngPath), true);

      // uploadThumbnailDataUrl returns SVG data URIs intact instead of wrapping SVG as image/jpeg .jpg
      const healthSvg = CATEGORY_THUMBNAILS["Health"]!;
      const resolvedSvg = await uploadThumbnailDataUrl(healthSvg, "Health");
      assert.equal(resolvedSvg, healthSvg);
    });

    it("applies the same SVG fallback and raster MIME extension rules in the MySQL video creation path", async () => {
      const insertedThumbnails: Array<{ vidId: string; thumbnailUrl: string }> = [];
      const mockConn = {
        beginTransaction: async () => {},
        commit: async () => {},
        rollback: async () => {},
        release: () => {},
        query: async (sql: string, params: any[] = []) => {
          if (/FROM uploaded_videos\s+WHERE id = \?/i.test(sql)) {
            return [[]];
          }
          if (/INSERT INTO uploaded_videos/i.test(sql)) {
            insertedThumbnails.push({
              vidId: String(params[0]),
              thumbnailUrl: String(params[6]),
            });
            return [{ affectedRows: 1 }];
          }
          return [[]];
        },
      };
      const mockPool = {
        query: async (sql: string, _params: any[] = []) => {
          if (/FROM sessions s/i.test(sql)) {
            return [
              [
                {
                  id: "FT483921",
                  user_id: "FT483921",
                  name: "Alex Rivera",
                  mobile: "",
                  email: "alex@facetube.com",
                  role: "user",
                  referral_code: null,
                  avatar_url: null,
                  channel_logo_url: null,
                  channel_name: "Alex Rivera",
                  channel_description: null,
                  created_at: new Date().toISOString(),
                },
              ],
            ];
          }
          if (/INFORMATION_SCHEMA\.COLUMNS/i.test(sql)) {
            return [[{ "1": 1 }]];
          }
          return [[]];
        },
        getConnection: async () => mockConn,
      };

      process.env["DB_HOST"] = "mock-mysql";
      process.env["DB_NAME"] = "mock_db";
      process.env["DB_USER"] = "mock_user";
      setMysqlPoolForTesting(mockPool);

      const vidHealth = `mysql-health-${Date.now()}`;
      const resHealth = await handleApiRequest(
        new Request("http://localhost:3000/api/videos/create", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${userToken}`,
          },
          body: JSON.stringify({
            id: vidHealth,
            user_id: "FT483921",
            creator_name: "Alex Rivera",
            title: "MySQL Health SVG Fallback",
            video_url: "/uploads/videos/mysql_health.mp4",
            video_type: "free",
            content_type: "long",
            category: "Health",
          }),
        }),
      );
      assert.ok(resHealth);
      assert.equal(resHealth.status, 201);
      const healthBody = await resHealth.json();
      assert.equal(healthBody.video.thumbnail_url, CATEGORY_THUMBNAILS["Health"]);
      assert.equal(
        insertedThumbnails.find((r) => r.vidId === vidHealth)?.thumbnailUrl,
        CATEGORY_THUMBNAILS["Health"],
      );
      assert.equal(
        fs.existsSync(path.resolve(process.cwd(), "uploads", "images", `thumb_${vidHealth}.jpg`)),
        false,
        "MySQL path must NEVER write Health SVG fallback to .jpg",
      );

      // Custom PNG on MySQL path
      const tinyPngBase64 =
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
      const vidPng = `mysql-png-${Date.now()}`;
      const resPng = await handleApiRequest(
        new Request("http://localhost:3000/api/videos/create", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${userToken}`,
          },
          body: JSON.stringify({
            id: vidPng,
            user_id: "FT483921",
            creator_name: "Alex Rivera",
            title: "MySQL Custom PNG",
            video_url: "/uploads/videos/mysql_png.mp4",
            thumbnail_url: tinyPngBase64,
            video_type: "free",
            content_type: "long",
            category: "Drama",
          }),
        }),
      );
      assert.ok(resPng);
      assert.equal(resPng.status, 201);
      const pngBody = await resPng.json();
      assert.equal(pngBody.video.thumbnail_url, `/uploads/images/thumb_${vidPng}.png`);
      createdDiskFiles.push(
        path.resolve(process.cwd(), "uploads", "images", `thumb_${vidPng}.png`),
      );
    });

    it("builds dynamic Explore categories including admin-created categories and filters case-insensitively with trimming", () => {
      const exploreList = buildExploreCategoryList([
        "Health",
        "Sports",
        "Drama",
        "Podcast Tech",
        "health",
        "All",
      ]);
      assert.equal(exploreList[0], "Trending");
      assert.ok(exploreList.includes("Health"));
      assert.ok(exploreList.includes("Sports"));
      assert.ok(exploreList.includes("Drama"));
      assert.ok(exploreList.includes("Podcast Tech"));
      assert.equal(exploreList.filter((c) => c.toLowerCase() === "health").length, 1);
      assert.equal(exploreList.includes("All"), false);

      const sampleVideos = [
        { id: "1", title: "Morning Yoga", channel: "FitLab", category: " health " },
        { id: "2", title: "Cup Finals", channel: "GoalTV", category: "SPORTS" },
        { id: "3", title: "Stage Play", channel: "ArtHouse", category: "Drama" },
        { id: "4", title: "Founders Ep 1", channel: "Studio", category: "Podcast Tech" },
      ];

      assert.equal(filterExploreVideos(sampleVideos, { selectedTag: "Trending" }).length, 4);
      assert.deepEqual(
        filterExploreVideos(sampleVideos, { selectedTag: "Health" }).map((v) => v.id),
        ["1"],
      );
      assert.deepEqual(
        filterExploreVideos(sampleVideos, { selectedTag: "  sports  " }).map((v) => v.id),
        ["2"],
      );
      assert.deepEqual(
        filterExploreVideos(sampleVideos, { selectedTag: "DRAMA" }).map((v) => v.id),
        ["3"],
      );
      assert.deepEqual(
        filterExploreVideos(sampleVideos, { selectedTag: "podcast tech" }).map((v) => v.id),
        ["4"],
      );
      assert.deepEqual(
        filterExploreVideos(sampleVideos, { selectedTag: "Health", searchQuery: "yoga" }).map(
          (v) => v.id,
        ),
        ["1"],
      );

      const exploreSrc = fs.readFileSync(
        path.resolve(process.cwd(), "src/routes/explore.tsx"),
        "utf-8",
      );
      assert.match(exploreSrc, /window\.addEventListener\("facetube:categories-updated"/);
      assert.match(exploreSrc, /window\.removeEventListener\("facetube:categories-updated"/);
    });

    it("runs all category tests inside isolated FACETUBE_DATA_DIR storage without mutating data/facetube_store.json", () => {
      assert.ok(tmpDataDir.startsWith(os.tmpdir()));
      assert.equal(process.env["FACETUBE_DATA_DIR"], tmpDataDir);
      assert.equal(
        fs.existsSync(path.join(tmpDataDir, "facetube_store.json")),
        true,
        "Isolated temp directory must hold the test store file",
      );
    });
  });
});
