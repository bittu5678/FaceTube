import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { handleApiRequest, resetStoreForTests } from "./api-handler.ts";
import { setMysqlPoolForTesting } from "./mysql.ts";
import { calculateSquareCrop, calculate9to16Crop } from "../lib/image-effects.ts";
import { resolveMediaUrl, PRODUCTION_API_DOMAIN } from "../lib/media-url.ts";

describe("FaceTube Task 5B: Channel Logo End-to-End Tests", () => {
  const storePath = path.resolve(process.cwd(), "data/facetube_store.json");
  let storeExistedBefore = false;
  let initialStoreContent: string | null = null;
  const originalNodeEnv = process.env["NODE_ENV"];
  const createdFiles: string[] = [];

  let userToken = "";
  let adminToken = "";
  let userUserId = "";
  let uploadedLogoUrl = "";

  // Minimal valid 1x1 PNG magic header + IHDR bytes
  const validPngBytes = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89,
  ]);

  before(async () => {
    if (!process.env["NODE_ENV"] && !process.env["APP_ENV"]) {
      process.env["NODE_ENV"] = "test";
    }
    setMysqlPoolForTesting(null);

    if (fs.existsSync(storePath)) {
      storeExistedBefore = true;
      initialStoreContent = fs.readFileSync(storePath, "utf-8");
    }

    resetStoreForTests();

    const userLoginReq = new Request("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "alex@facetube.com", password: "password123" }),
    });
    const userLoginRes = await handleApiRequest(userLoginReq);
    assert.ok(userLoginRes);
    const userLoginData = (await userLoginRes.json()) as any;
    assert.equal(userLoginRes.status, 200);
    assert.ok(userLoginData.token);
    userToken = userLoginData.token;
    userUserId = userLoginData.user.user_id;

    const adminLoginReq = new Request("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "admin@facetube.com", password: "password123" }),
    });
    const adminLoginRes = await handleApiRequest(adminLoginReq);
    assert.ok(adminLoginRes);
    const adminLoginData = (await adminLoginRes.json()) as any;
    assert.equal(adminLoginRes.status, 200);
    assert.ok(adminLoginData.token);
    adminToken = adminLoginData.token;
  });

  after(() => {
    setMysqlPoolForTesting(null);
    if (originalNodeEnv !== undefined) {
      process.env["NODE_ENV"] = originalNodeEnv;
    } else {
      delete process.env["NODE_ENV"];
    }

    for (const relPath of createdFiles) {
      const fullPath = path.resolve(process.cwd(), relPath.replace(/^\/+/, ""));
      if (fs.existsSync(fullPath)) {
        try {
          fs.unlinkSync(fullPath);
        } catch {
          // ignore cleanup failure
        }
      }
    }

    if (storeExistedBefore && initialStoreContent !== null) {
      fs.writeFileSync(storePath, initialStoreContent, "utf-8");
    } else if (!storeExistedBefore && fs.existsSync(storePath)) {
      try {
        fs.unlinkSync(storePath);
      } catch {
        // ignore
      }
    }
  });

  describe("1. Client Helpers: Square Logo Crop & Production Media URLs", () => {
    it("calculates proportional 1:1 square center-crop for landscape, portrait, and square logos", () => {
      const landscape = calculateSquareCrop(1920, 1080, 512);
      assert.equal(landscape.cropWidth, 1080);
      assert.equal(landscape.cropHeight, 1080);
      assert.equal(landscape.cropX, 420);
      assert.equal(landscape.cropY, 0);
      assert.equal(landscape.targetSize, 512);
      assert.equal(landscape.isAlreadySquare, false);

      const portrait = calculateSquareCrop(600, 1000, 512);
      assert.equal(portrait.cropWidth, 600);
      assert.equal(portrait.cropHeight, 600);
      assert.equal(portrait.cropX, 0);
      assert.equal(portrait.cropY, 200);
      assert.equal(portrait.isAlreadySquare, false);

      const square = calculateSquareCrop(512, 512, 512);
      assert.equal(square.cropWidth, 512);
      assert.equal(square.cropHeight, 512);
      assert.equal(square.isAlreadySquare, true);

      // Existing 9:16 crop helper remains strict 9:16
      const strict916 = calculate9to16Crop(1000, 1000);
      assert.equal(strict916.targetWidth, 1080);
      assert.equal(strict916.targetHeight, 1920);
      assert.equal(strict916.isAlready9to16, false);
    });

    it("resolves /uploads/logos/* to https://api.facetube.online on facetube.online without double-prefixing", () => {
      assert.equal(PRODUCTION_API_DOMAIN, "https://api.facetube.online");

      const prevWindow = (globalThis as any).window;
      const prevEnvApi = process.env["VITE_API_BASE_URL"];
      const prevEnvMedia = process.env["VITE_MEDIA_BASE_URL"];
      delete process.env["VITE_API_BASE_URL"];
      delete process.env["VITE_MEDIA_BASE_URL"];

      try {
        (globalThis as any).window = {
          location: { hostname: "facetube.online" },
        };

        assert.equal(
          resolveMediaUrl("/uploads/logos/logo_test.png"),
          "https://api.facetube.online/uploads/logos/logo_test.png",
        );
        assert.equal(
          resolveMediaUrl("/uploads/images/img_test.jpg"),
          "https://api.facetube.online/uploads/images/img_test.jpg",
        );
        assert.equal(
          resolveMediaUrl("https://api.facetube.online/uploads/logos/logo_test.png"),
          "https://api.facetube.online/uploads/logos/logo_test.png",
        );
        assert.equal(
          resolveMediaUrl(
            "https://api.facetube.onlinehttps://api.facetube.online/uploads/logos/logo_test.png",
          ),
          "https://api.facetube.online/uploads/logos/logo_test.png",
        );
        assert.equal(resolveMediaUrl(null), "");
        assert.equal(resolveMediaUrl("undefined"), "");
      } finally {
        if (prevWindow !== undefined) {
          (globalThis as any).window = prevWindow;
        } else {
          delete (globalThis as any).window;
        }
        if (prevEnvApi !== undefined) process.env["VITE_API_BASE_URL"] = prevEnvApi;
        if (prevEnvMedia !== undefined) process.env["VITE_MEDIA_BASE_URL"] = prevEnvMedia;
      }
    });
  });

  describe("2. Upload Endpoint (POST /api/uploads/image)", () => {
    it("rejects unauthenticated channel_logo upload with 401", async () => {
      const formData = new FormData();
      formData.append("purpose", "channel_logo");
      formData.append("image", new File([validPngBytes], "logo.png", { type: "image/png" }));

      const req = new Request("http://localhost:3000/api/uploads/image", {
        method: "POST",
        body: formData,
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 401);
    });

    it("rejects non-image payload disguised as PNG for channel_logo with 400", async () => {
      const formData = new FormData();
      formData.append("purpose", "channel_logo");
      formData.append(
        "image",
        new File([Buffer.from("not-a-real-image")], "fake.png", { type: "image/png" }),
      );

      const req = new Request("http://localhost:3000/api/uploads/image", {
        method: "POST",
        headers: { Authorization: `Bearer ${userToken}` },
        body: formData,
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 400);
      const data = (await res.json()) as any;
      assert.equal(data.success, false);
    });

    it("uploads valid PNG channel logo to /uploads/logos/ when authenticated", async () => {
      const formData = new FormData();
      formData.append("purpose", "channel_logo");
      formData.append("image", new File([validPngBytes], "channel-logo.png", { type: "image/png" }));

      const req = new Request("http://localhost:3000/api/uploads/image", {
        method: "POST",
        headers: { Authorization: `Bearer ${userToken}` },
        body: formData,
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 201);
      const data = (await res.json()) as any;
      assert.equal(data.success, true);
      assert.match(data.url, /^\/uploads\/logos\/logo_.*\.png$/);

      uploadedLogoUrl = data.url;
      createdFiles.push(data.url);

      const diskPath = path.resolve(process.cwd(), data.url.replace(/^\/+/, ""));
      assert.equal(fs.existsSync(diskPath), true, "Uploaded channel logo must exist on disk");
    });

    it("preserves /uploads/images/ destination for default image uploads", async () => {
      const formData = new FormData();
      formData.append("image", new File([validPngBytes], "community.png", { type: "image/png" }));

      const req = new Request("http://localhost:3000/api/uploads/image", {
        method: "POST",
        body: formData,
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 201);
      const data = (await res.json()) as any;
      assert.equal(data.success, true);
      assert.match(data.url, /^\/uploads\/images\/img_.*\.png$/);
      createdFiles.push(data.url);
    });
  });

  describe("3. Channel Logo Persistence & Authorization (POST /api/users/channel-logo)", () => {
    it("rejects unauthenticated requests with 401", async () => {
      const req = new Request("http://localhost:3000/api/users/channel-logo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channelLogoUrl: "/uploads/logos/test.png" }),
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 401);
    });

    it("blocks non-admin user from modifying another user's channel logo with 403", async () => {
      const req = new Request("http://localhost:3000/api/users/channel-logo", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({
          userId: "FT102857",
          channelLogoUrl: "/uploads/logos/hijack.png",
        }),
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 403);
    });

    it("rejects unsafe URL schemes like javascript: and data:", async () => {
      for (const badUrl of ["javascript:alert(1)", "data:image/png;base64,AAA"]) {
        const req = new Request("http://localhost:3000/api/users/channel-logo", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${userToken}`,
          },
          body: JSON.stringify({ channelLogoUrl: badUrl }),
        });
        const res = await handleApiRequest(req);
        assert.ok(res);
        assert.equal(res.status, 400, `Expected 400 for unsafe URL ${badUrl}`);
      }
    });

    it("persists channel_logo_url and channel_name across auth/me, login, users/profile, and users/list", async () => {
      const logoToSave = uploadedLogoUrl || "/uploads/logos/logo_saved.png";
      const channelName = "Alex Tech Studio";

      const saveReq = new Request("http://localhost:3000/api/users/channel-logo", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({
          userId: userUserId,
          channelLogoUrl: logoToSave,
          channelName,
        }),
      });
      const saveRes = await handleApiRequest(saveReq);
      assert.ok(saveRes);
      assert.equal(saveRes.status, 200);
      const saveData = (await saveRes.json()) as any;
      assert.equal(saveData.success, true);
      assert.equal(saveData.channel_logo_url, logoToSave);
      assert.equal(saveData.channelLogoUrl, logoToSave);
      assert.equal(saveData.channel_name, channelName);

      // auth/me hydration check
      const meReq = new Request("http://localhost:3000/api/auth/me", {
        method: "GET",
        headers: { Authorization: `Bearer ${userToken}` },
      });
      const meRes = await handleApiRequest(meReq);
      assert.ok(meRes);
      const meData = (await meRes.json()) as any;
      assert.equal(meData.authenticated, true);
      assert.equal(meData.user.channel_logo_url, logoToSave);
      assert.equal(meData.user.channel_name, channelName);

      // fresh login hydration check
      const loginReq = new Request("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: "alex@facetube.com", password: "password123" }),
      });
      const loginRes = await handleApiRequest(loginReq);
      assert.ok(loginRes);
      const loginData = (await loginRes.json()) as any;
      assert.equal(loginData.user.channel_logo_url, logoToSave);
      assert.equal(loginData.user.channel_name, channelName);

      // users/profile GET check
      const profileReq = new Request(
        `http://localhost:3000/api/users/profile?user_id=${encodeURIComponent(userUserId)}`,
        { method: "GET" },
      );
      const profileRes = await handleApiRequest(profileReq);
      assert.ok(profileRes);
      const profileData = (await profileRes.json()) as any;
      assert.equal(profileData.profile.channel_logo_url, logoToSave);
      assert.equal(profileData.profile.channel_name, channelName);

      // users/list admin check
      const listReq = new Request("http://localhost:3000/api/users/list", {
        method: "GET",
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const listRes = await handleApiRequest(listReq);
      assert.ok(listRes);
      const listData = (await listRes.json()) as any;
      const updatedUser = (listData.users || []).find((u: any) => u.user_id === userUserId);
      assert.ok(updatedUser);
      assert.equal(updatedUser.channel_logo_url, logoToSave);
      assert.equal(updatedUser.channel_name, channelName);
    });
  });

  describe("4. Channel Logo Display Payloads (Videos & Comments)", () => {
    it("includes channelLogoUrl/channelName on videos/list and videos/get and handles missing logos gracefully", async () => {
      // Create a video uploaded by userUserId (who now has a channel logo)
      const createRes = await handleApiRequest(
        new Request("http://localhost:3000/api/videos/create", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${userToken}`,
          },
          body: JSON.stringify({
            userId: userUserId,
            creatorName: "Alex Mercer",
            title: "Channel Logo Verification Video",
            description: "Testing channel logo propagation",
            videoUrl: "https://example.com/test-video.mp4",
            thumbnailUrl: "https://example.com/test-thumb.jpg",
            videoType: "free",
            contentType: "long",
            category: "Technology",
            duration: "01:20",
          }),
        }),
      );
      assert.ok(createRes);
      assert.equal(createRes.status, 201);
      const createData = (await createRes.json()) as any;
      const createdVideoId = createData.video.id;

      // Also create a video uploaded by admin (who has no channel logo set) to verify fallback behavior
      const adminVidRes = await handleApiRequest(
        new Request("http://localhost:3000/api/videos/create", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${adminToken}`,
          },
          body: JSON.stringify({
            userId: "FT102857",
            creatorName: "FaceTube Admin",
            title: "No Logo Fallback Video",
            description: "Testing null channel logo fallback",
            videoUrl: "https://example.com/admin-video.mp4",
            thumbnailUrl: "https://example.com/admin-thumb.jpg",
            videoType: "free",
            contentType: "long",
            category: "Education",
            duration: "00:45",
          }),
        }),
      );
      assert.ok(adminVidRes);
      assert.equal(adminVidRes.status, 201);
      const adminVidData = (await adminVidRes.json()) as any;

      // Verify videos/list
      const listRes = await handleApiRequest(
        new Request("http://localhost:3000/api/videos/list", { method: "GET" }),
      );
      assert.ok(listRes);
      const listData = (await listRes.json()) as any;
      const userVideo = (listData.videos || []).find((v: any) => v.id === createdVideoId);
      const adminVideo = (listData.videos || []).find((v: any) => v.id === adminVidData.video.id);

      assert.ok(userVideo, "Created user video must appear in videos/list");
      assert.equal(userVideo.channelLogoUrl, uploadedLogoUrl || "/uploads/logos/logo_saved.png");
      assert.equal(userVideo.channel_logo_url, uploadedLogoUrl || "/uploads/logos/logo_saved.png");
      assert.equal(userVideo.channelName, "Alex Tech Studio");

      assert.ok(adminVideo, "Created admin video must appear in videos/list");
      assert.equal(adminVideo.channelLogoUrl, null);
      assert.equal(adminVideo.channel_logo_url, null);

      // Verify videos/get
      const getRes = await handleApiRequest(
        new Request(`http://localhost:3000/api/videos/get?id=${encodeURIComponent(createdVideoId)}`, {
          method: "GET",
        }),
      );
      assert.ok(getRes);
      const getData = (await getRes.json()) as any;
      assert.equal(getData.video.channelLogoUrl, uploadedLogoUrl || "/uploads/logos/logo_saved.png");
      assert.equal(getData.video.channelName, "Alex Tech Studio");

      // Post comment as userUserId and verify comments/list returns channelLogoUrl
      const commentCreateRes = await handleApiRequest(
        new Request("http://localhost:3000/api/comments/create", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${userToken}`,
          },
          body: JSON.stringify({
            videoId: createdVideoId,
            userId: userUserId,
            userName: "Alex Mercer",
            comment: "Great upload with channel logo!",
          }),
        }),
      );
      assert.ok(commentCreateRes);
      assert.equal(commentCreateRes.status, 200);

      const commentListRes = await handleApiRequest(
        new Request(
          `http://localhost:3000/api/comments/list?videoId=${encodeURIComponent(createdVideoId)}`,
          { method: "GET" },
        ),
      );
      assert.ok(commentListRes);
      const commentListData = (await commentListRes.json()) as any;
      assert.ok(Array.isArray(commentListData.comments) && commentListData.comments.length > 0);
      const firstComment = commentListData.comments[0];
      assert.equal(firstComment.channelLogoUrl, uploadedLogoUrl || "/uploads/logos/logo_saved.png");
      assert.equal(firstComment.channel_logo_url, uploadedLogoUrl || "/uploads/logos/logo_saved.png");
    });
  });
});
