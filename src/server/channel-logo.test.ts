import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { handleApiRequest, resetStoreForTests } from "./api-handler.ts";
import { setMysqlPoolForTesting } from "./mysql.ts";
import { calculateSquareCrop, calculate9to16Crop } from "../lib/image-effects.ts";
import { resolveMediaUrl, PRODUCTION_API_DOMAIN } from "../lib/media-url.ts";
import {
  computeUpdatedChannelSession,
  LOCAL_STORAGE_SESSION_KEY,
} from "../lib/channel-branding.ts";

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
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
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
      formData.append(
        "image",
        new File([validPngBytes], "channel-logo.png", { type: "image/png" }),
      );

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
        new Request(
          `http://localhost:3000/api/videos/get?id=${encodeURIComponent(createdVideoId)}`,
          {
            method: "GET",
          },
        ),
      );
      assert.ok(getRes);
      const getData = (await getRes.json()) as any;
      assert.equal(
        getData.video.channelLogoUrl,
        uploadedLogoUrl || "/uploads/logos/logo_saved.png",
      );
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
      assert.equal(
        firstComment.channel_logo_url,
        uploadedLogoUrl || "/uploads/logos/logo_saved.png",
      );
    });
  });

  describe("5. Task 5C: Critical Security Regression Tests", () => {
    const otherUserId = "FT900431";

    it("1. Rejects unauthenticated POST /api/users/profile with 401 even when body.userId is supplied", async () => {
      const hijackReq = new Request("http://localhost:3000/api/users/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: "FT102857",
          name: "Hijacked Admin",
          channel_name: "Evil Channel",
          channel_logo_url: "https://evil.example/logo.png",
        }),
      });
      const hijackRes = await handleApiRequest(hijackReq);
      assert.ok(hijackRes);
      assert.equal(hijackRes.status, 401);

      // Verify admin record was NOT modified
      const listRes = await handleApiRequest(
        new Request("http://localhost:3000/api/users/list", {
          method: "GET",
          headers: { Authorization: `Bearer ${adminToken}` },
        }),
      );
      assert.ok(listRes);
      assert.equal(listRes.status, 200);
      const listData = (await listRes.json()) as any;
      const adminRecord = (listData.users || []).find((u: any) => u.user_id === "FT102857");
      assert.ok(adminRecord);
      assert.notEqual(adminRecord.name, "Hijacked Admin");
      assert.notEqual(adminRecord.channel_name, "Evil Channel");
    });

    it("2. Prevents User A from updating User B's profile via POST /api/users/profile (403)", async () => {
      const req = new Request("http://localhost:3000/api/users/profile", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({
          userId: otherUserId,
          name: "Tampered Maya",
          channel_name: "Tampered Channel",
        }),
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 403);

      // Verify User B's name remains intact
      const profileRes = await handleApiRequest(
        new Request(
          `http://localhost:3000/api/users/profile?user_id=${encodeURIComponent(otherUserId)}`,
          { method: "GET" },
        ),
      );
      assert.ok(profileRes);
      const profileData = (await profileRes.json()) as any;
      assert.notEqual(profileData.profile.name, "Tampered Maya");
    });

    it("3. Allows authenticated admin permitted cross-user & role updates while blocking non-admin and invalid admin updates", async () => {
      // Non-admin attempting role escalation via profile update cannot change role
      const escalationReq = new Request("http://localhost:3000/api/users/profile", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({
          name: "Alex Mercer",
          role: "admin",
        }),
      });
      const escalationRes = await handleApiRequest(escalationReq);
      assert.ok(escalationRes);
      assert.equal(escalationRes.status, 200);
      const escalationData = (await escalationRes.json()) as any;
      assert.equal(escalationData.profile.role, "user");

      // Non-admin attempting admin/role update is blocked with 403
      const nonAdminRoleReq = new Request("http://localhost:3000/api/admin/role", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({ targetUserId: otherUserId, role: "admin" }),
      });
      const nonAdminRoleRes = await handleApiRequest(nonAdminRoleReq);
      assert.ok(nonAdminRoleRes);
      assert.equal(nonAdminRoleRes.status, 403);

      // Admin cannot bypass URL validation with unsafe scheme
      const adminBadUrlReq = new Request("http://localhost:3000/api/users/profile", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          userId: otherUserId,
          channel_logo_url: "javascript:alert(1)",
        }),
      });
      const adminBadUrlRes = await handleApiRequest(adminBadUrlReq);
      assert.ok(adminBadUrlRes);
      assert.equal(adminBadUrlRes.status, 400);

      // Admin CAN perform permitted cross-user profile update
      const adminUpdateReq = new Request("http://localhost:3000/api/users/profile", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          userId: otherUserId,
          channel_name: "Maya Studio Verified",
          channel_logo_url: "/uploads/logos/maya_verified.png",
        }),
      });
      const adminUpdateRes = await handleApiRequest(adminUpdateReq);
      assert.ok(adminUpdateRes);
      assert.equal(adminUpdateRes.status, 200);
      const adminUpdateData = (await adminUpdateRes.json()) as any;
      assert.equal(adminUpdateData.profile.user_id, otherUserId);
      assert.equal(adminUpdateData.profile.channel_name, "Maya Studio Verified");
      assert.equal(adminUpdateData.profile.channel_logo_url, "/uploads/logos/maya_verified.png");
    });

    it("4. Blocks unauthenticated and non-admin callers from retrieving private user PII via users/list and users/profile", async () => {
      // Unauthenticated GET /api/users/list -> 401
      const unauthListRes = await handleApiRequest(
        new Request("http://localhost:3000/api/users/list", { method: "GET" }),
      );
      assert.ok(unauthListRes);
      assert.equal(unauthListRes.status, 401);
      const unauthListBody = (await unauthListRes.json()) as any;
      assert.equal(unauthListBody.users, undefined);

      // Standard non-admin user GET /api/users/list -> 403
      const userListRes = await handleApiRequest(
        new Request("http://localhost:3000/api/users/list", {
          method: "GET",
          headers: { Authorization: `Bearer ${userToken}` },
        }),
      );
      assert.ok(userListRes);
      assert.equal(userListRes.status, 403);
      const userListBody = (await userListRes.json()) as any;
      assert.equal(userListBody.users, undefined);

      // Unauthenticated GET /api/users/profile?user_id=... exposes only public channel fields (no email/mobile/referral_code)
      const publicProfileRes = await handleApiRequest(
        new Request(
          `http://localhost:3000/api/users/profile?user_id=${encodeURIComponent(userUserId)}`,
          { method: "GET" },
        ),
      );
      assert.ok(publicProfileRes);
      assert.equal(publicProfileRes.status, 200);
      const publicProfileData = (await publicProfileRes.json()) as any;
      assert.equal(publicProfileData.profile.user_id, userUserId);
      assert.equal(publicProfileData.profile.channel_name, "Alex Tech Studio");
      assert.equal(publicProfileData.profile.email, undefined);
      assert.equal(publicProfileData.profile.mobile, undefined);
      assert.equal(publicProfileData.profile.referral_code, undefined);
      assert.equal(publicProfileData.profile.role, undefined);

      // Ordinary authenticated user fetching another user's profile also does not see private fields
      const crossProfileRes = await handleApiRequest(
        new Request(
          `http://localhost:3000/api/users/profile?user_id=${encodeURIComponent(otherUserId)}`,
          {
            method: "GET",
            headers: { Authorization: `Bearer ${userToken}` },
          },
        ),
      );
      assert.ok(crossProfileRes);
      assert.equal(crossProfileRes.status, 200);
      const crossProfileData = (await crossProfileRes.json()) as any;
      assert.equal(crossProfileData.profile.email, undefined);
      assert.equal(crossProfileData.profile.mobile, undefined);
      assert.equal(crossProfileData.profile.referral_code, undefined);

      // Self GET /api/users/profile returns full own profile including private fields
      const selfProfileRes = await handleApiRequest(
        new Request(
          `http://localhost:3000/api/users/profile?user_id=${encodeURIComponent(userUserId)}`,
          {
            method: "GET",
            headers: { Authorization: `Bearer ${userToken}` },
          },
        ),
      );
      assert.ok(selfProfileRes);
      assert.equal(selfProfileRes.status, 200);
      const selfProfileData = (await selfProfileRes.json()) as any;
      assert.equal(selfProfileData.profile.email, "alex@facetube.com");
    });

    it("5. Accepts safe HTTP/HTTPS and /uploads/ URLs for channel_logo_url and avatar_url", async () => {
      const safeUrls = [
        "/uploads/logos/logo_safe_123.png",
        "/uploads/images/avatar_safe_123.webp",
        "https://api.facetube.online/uploads/logos/logo_cdn.png",
        "http://localhost:3000/uploads/logos/logo_local.jpg",
        `https://cdn.example.com/${"a".repeat(472)}.png`,
      ];

      for (const safeUrl of safeUrls) {
        assert.ok(safeUrl.length <= 500);
        const res = await handleApiRequest(
          new Request("http://localhost:3000/api/users/profile", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${userToken}`,
            },
            body: JSON.stringify({
              channel_logo_url: safeUrl,
              avatar_url: safeUrl,
            }),
          }),
        );
        assert.ok(res);
        assert.equal(res.status, 200, `Expected 200 for safe URL: ${safeUrl}`);
        const data = (await res.json()) as any;
        assert.equal(data.profile.channel_logo_url, safeUrl);
        assert.equal(data.profile.avatar_url, safeUrl);
      }
    });

    it("6. Rejects unsafe URL schemes, path traversal, and >500-char values on channel_logo_url and avatar_url", async () => {
      const oversizedUrl = `https://example.com/${"a".repeat(490)}.png`;
      assert.ok(oversizedUrl.length > 500);

      const badInputs = [
        "javascript:alert(1)",
        "JAVASCRIPT:alert(document.cookie)",
        "data:image/png;base64,iVBORw0KGgo=",
        "vbscript:msgbox(1)",
        "file:///etc/passwd",
        "//evil.example.com/logo.png",
        "/uploads/../etc/passwd",
        "/uploads/logo.png\nInjected",
        oversizedUrl,
      ];

      for (const badUrl of badInputs) {
        const resLogo = await handleApiRequest(
          new Request("http://localhost:3000/api/users/profile", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${userToken}`,
            },
            body: JSON.stringify({ channel_logo_url: badUrl }),
          }),
        );
        assert.ok(resLogo);
        assert.equal(resLogo.status, 400, `Expected 400 for unsafe channel_logo_url: ${badUrl}`);

        const resAvatar = await handleApiRequest(
          new Request("http://localhost:3000/api/users/profile", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${userToken}`,
            },
            body: JSON.stringify({ avatar_url: badUrl }),
          }),
        );
        assert.ok(resAvatar);
        assert.equal(resAvatar.status, 400, `Expected 400 for unsafe avatar_url: ${badUrl}`);
      }
    });

    it("7. Preserves legitimate profile updates, admin user directory, public channel displays, and PHP endpoint parity", async () => {
      // Legitimate self profile update (name, mobile, channel_name, channel_logo_url)
      const selfUpdateRes = await handleApiRequest(
        new Request("http://localhost:3000/api/users/profile", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${userToken}`,
          },
          body: JSON.stringify({
            name: "Alex Mercer Updated",
            mobile: "+1 555-999-1234",
            channel_name: "Alex Tech Studio",
            channel_logo_url: uploadedLogoUrl || "/uploads/logos/logo_saved.png",
          }),
        }),
      );
      assert.ok(selfUpdateRes);
      assert.equal(selfUpdateRes.status, 200);
      const selfUpdateData = (await selfUpdateRes.json()) as any;
      assert.equal(selfUpdateData.success, true);
      assert.equal(selfUpdateData.profile.name, "Alex Mercer Updated");
      assert.equal(selfUpdateData.profile.mobile, "+1 555-999-1234");

      // Authenticated admin can retrieve full user management list including private fields
      const adminListRes = await handleApiRequest(
        new Request("http://localhost:3000/api/users/list", {
          method: "GET",
          headers: { Authorization: `Bearer ${adminToken}` },
        }),
      );
      assert.ok(adminListRes);
      assert.equal(adminListRes.status, 200);
      const adminListData = (await adminListRes.json()) as any;
      assert.equal(adminListData.success, true);
      const alexRow = (adminListData.users || []).find((u: any) => u.user_id === userUserId);
      assert.ok(alexRow);
      assert.equal(alexRow.email, "alex@facetube.com");
      assert.equal(alexRow.mobile, "+1 555-999-1234");

      // Public creator/channel display via videos/list continues working without auth
      const publicVideosRes = await handleApiRequest(
        new Request("http://localhost:3000/api/videos/list", { method: "GET" }),
      );
      assert.ok(publicVideosRes);
      assert.equal(publicVideosRes.status, 200);
      const publicVideosData = (await publicVideosRes.json()) as any;
      const alexVideo = (publicVideosData.videos || []).find((v: any) => v.user_id === userUserId);
      assert.ok(alexVideo);
      assert.equal(alexVideo.channelLogoUrl, uploadedLogoUrl || "/uploads/logos/logo_saved.png");
      assert.equal(alexVideo.channelName, "Alex Tech Studio");

      // PHP parity verification for api/users/list.php and api/users/profile.php
      const listPhp = fs.readFileSync(path.resolve(process.cwd(), "api/users/list.php"), "utf-8");
      assert.match(listPhp, /getAuthUser\s*\(\$pdo\)/);
      assert.match(listPhp, /'admin'/);
      assert.match(listPhp, /401/);
      assert.match(listPhp, /403/);

      const profilePhp = fs.readFileSync(
        path.resolve(process.cwd(), "api/users/profile.php"),
        "utf-8",
      );
      assert.match(profilePhp, /requireAuthUser\s*\(\$pdo/);
      assert.match(profilePhp, /validateProfileMediaUrl/);
      assert.match(profilePhp, /sanitizePublicProfile/);
      assert.match(profilePhp, /500/);
    });
  });

  describe("6. Task 5D: Data Integrity, Admin UUID, AuthContext Persistence & Media URL Parity", () => {
    const mayaUuid = "a0000000-0000-0000-0000-000000000003";
    const mayaUserId = "FT900431";
    const alexUuid = "a0000000-0000-0000-0000-000000000002";

    it("1. Fails with HTTP 500 when MySQL UPDATE fails and never swallows errors or falls back to JSON store", async () => {
      let storeUpdated = false;
      const failingPool = {
        query: async (sql: string) => {
          if (/FROM\s+sessions/i.test(sql)) {
            return [[], []];
          }
          if (/SELECT\s+id,\s*user_id,\s*channel_logo_url/i.test(sql)) {
            return [
              [
                {
                  id: alexUuid,
                  user_id: userUserId,
                  channel_logo_url: "/uploads/logos/old_logo.png",
                  channel_name: "Alex Tech Studio",
                },
              ],
              [],
            ];
          }
          if (/UPDATE\s+users\s+SET\s+channel_logo_url/i.test(sql)) {
            throw new Error("Simulated MySQL UPDATE connection failure");
          }
          return [[], []];
        },
      } as any;

      const prevDbHost = process.env["DB_HOST"];
      const prevDbName = process.env["DB_NAME"];
      const prevDbUser = process.env["DB_USER"];
      process.env["DB_HOST"] = "127.0.0.1";
      process.env["DB_NAME"] = "facetube_test";
      process.env["DB_USER"] = "test_user";
      setMysqlPoolForTesting(failingPool);
      try {
        const res = await handleApiRequest(
          new Request("http://localhost:3000/api/users/channel-logo", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${userToken}`,
            },
            body: JSON.stringify({
              channelLogoUrl: "/uploads/logos/should_not_persist.png",
              channelName: "Should Not Persist",
            }),
          }),
        );
        assert.ok(res);
        assert.equal(res.status, 500);
        const data = (await res.json()) as any;
        assert.equal(data.success, false);
        assert.match(data.error, /Database error/i);

        // Confirm local JSON store was not modified by the failed DB request
        const storeSnapshot = JSON.parse(fs.readFileSync(storePath, "utf-8"));
        const alexStoreRow = (storeSnapshot.users || []).find((u: any) => u.user_id === userUserId);
        assert.ok(alexStoreRow);
        storeUpdated = alexStoreRow.channel_logo_url === "/uploads/logos/should_not_persist.png";
        assert.equal(storeUpdated, false);
      } finally {
        if (prevDbHost !== undefined) process.env["DB_HOST"] = prevDbHost;
        else delete process.env["DB_HOST"];
        if (prevDbName !== undefined) process.env["DB_NAME"] = prevDbName;
        else delete process.env["DB_NAME"];
        if (prevDbUser !== undefined) process.env["DB_USER"] = prevDbUser;
        else delete process.env["DB_USER"];
        setMysqlPoolForTesting(null);
      }
    });

    it("2. Fails closed with HTTP 503 in production when MySQL pool is unavailable", async () => {
      const prevNodeEnv = process.env["NODE_ENV"];
      const prevAppEnv = process.env["APP_ENV"];
      process.env["NODE_ENV"] = "production";
      delete process.env["APP_ENV"];
      setMysqlPoolForTesting(null);

      try {
        const res = await handleApiRequest(
          new Request("http://localhost:3000/api/users/channel-logo", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${userToken}`,
            },
            body: JSON.stringify({
              channelLogoUrl: "/uploads/logos/prod_blocked.png",
              channelName: "Blocked In Prod Without DB",
            }),
          }),
        );
        assert.ok(res);
        assert.equal(res.status, 503);
        const data = (await res.json()) as any;
        assert.equal(data.success, false);
        assert.match(data.error, /Database connection unavailable/i);
      } finally {
        if (prevNodeEnv !== undefined) process.env["NODE_ENV"] = prevNodeEnv;
        else delete process.env["NODE_ENV"];
        if (prevAppEnv !== undefined) process.env["APP_ENV"] = prevAppEnv;
        else delete process.env["APP_ENV"];
      }
    });

    it("3. Resolves admin UUID id and user_id consistently to the same user across Node, MySQL, and PHP", async () => {
      // 3a. Non-admin cannot pass another user's UUID id (403)
      const crossUuidRes = await handleApiRequest(
        new Request("http://localhost:3000/api/users/channel-logo", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${userToken}`,
          },
          body: JSON.stringify({
            userId: mayaUuid,
            channelLogoUrl: "/uploads/logos/unauthorized_uuid.png",
          }),
        }),
      );
      assert.ok(crossUuidRes);
      assert.equal(crossUuidRes.status, 403);

      // 3b. Non-admin passing own UUID id succeeds as self-update (200)
      const selfUuidRes = await handleApiRequest(
        new Request("http://localhost:3000/api/users/channel-logo", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${userToken}`,
          },
          body: JSON.stringify({
            userId: alexUuid.toUpperCase(),
            channelName: "Alex Self UUID Update",
          }),
        }),
      );
      assert.ok(selfUuidRes);
      assert.equal(selfUuidRes.status, 200);

      // 3c. Admin updating Maya via UUID id updates the exact same user record as FT900431
      const adminUuidRes = await handleApiRequest(
        new Request("http://localhost:3000/api/users/channel-logo", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${adminToken}`,
          },
          body: JSON.stringify({
            userId: mayaUuid,
            channelLogoUrl: "/uploads/logos/maya_via_uuid.png",
            channelName: "Maya Via UUID",
          }),
        }),
      );
      assert.ok(adminUuidRes);
      assert.equal(adminUuidRes.status, 200);
      const adminUuidData = (await adminUuidRes.json()) as any;
      assert.equal(adminUuidData.channel_logo_url, "/uploads/logos/maya_via_uuid.png");
      assert.equal(adminUuidData.channel_name, "Maya Via UUID");

      const mayaProfileRes = await handleApiRequest(
        new Request(
          `http://localhost:3000/api/users/profile?user_id=${encodeURIComponent(mayaUserId)}`,
          { method: "GET" },
        ),
      );
      assert.ok(mayaProfileRes);
      const mayaProfileData = (await mayaProfileRes.json()) as any;
      assert.equal(mayaProfileData.profile.channel_logo_url, "/uploads/logos/maya_via_uuid.png");
      assert.equal(mayaProfileData.profile.channel_name, "Maya Via UUID");

      // 3d. MySQL mock pool check: UUID lookup resolves canonical id + user_id before UPDATE
      const capturedQueries: Array<{ sql: string; params: any[] }> = [];
      const mockUuidPool = {
        query: async (sql: string, params: any[] = []) => {
          capturedQueries.push({ sql, params });
          if (/FROM\s+sessions/i.test(sql)) {
            return [[], []];
          }
          if (/SELECT\s+id,\s*user_id,\s*channel_logo_url/i.test(sql)) {
            return [
              [
                {
                  id: mayaUuid,
                  user_id: mayaUserId,
                  channel_logo_url: "/uploads/logos/maya_via_uuid.png",
                  channel_name: "Maya Via UUID",
                },
              ],
              [],
            ];
          }
          if (/UPDATE\s+users/i.test(sql)) {
            return [{ affectedRows: 1 }, []];
          }
          if (/SELECT\s+channel_logo_url,\s*channel_name/i.test(sql)) {
            return [
              [
                {
                  channel_logo_url: "/uploads/logos/maya_mysql_uuid.png",
                  channel_name: "Maya MySQL UUID",
                },
              ],
              [],
            ];
          }
          return [[], []];
        },
      } as any;

      const prevDbHost = process.env["DB_HOST"];
      const prevDbName = process.env["DB_NAME"];
      const prevDbUser = process.env["DB_USER"];
      process.env["DB_HOST"] = "127.0.0.1";
      process.env["DB_NAME"] = "facetube_test";
      process.env["DB_USER"] = "test_user";
      setMysqlPoolForTesting(mockUuidPool);
      try {
        const dbUuidRes = await handleApiRequest(
          new Request("http://localhost:3000/api/users/channel-logo", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${adminToken}`,
            },
            body: JSON.stringify({
              userId: mayaUuid,
              channelLogoUrl: "/uploads/logos/maya_mysql_uuid.png",
              channelName: "Maya MySQL UUID",
            }),
          }),
        );
        assert.ok(dbUuidRes);
        assert.equal(dbUuidRes.status, 200);
        const updateQuery = capturedQueries.find((q) => /UPDATE\s+users/i.test(q.sql));
        assert.ok(updateQuery, "MySQL UPDATE query must have executed");
        assert.match(
          updateQuery.sql,
          /WHERE\s+id\s*=\s*\?\s+OR\s+UPPER\(user_id\)\s*=\s*UPPER\(\?\)/i,
        );
        assert.deepEqual(updateQuery.params.slice(-2), [mayaUuid, mayaUserId]);
      } finally {
        if (prevDbHost !== undefined) process.env["DB_HOST"] = prevDbHost;
        else delete process.env["DB_HOST"];
        if (prevDbName !== undefined) process.env["DB_NAME"] = prevDbName;
        else delete process.env["DB_NAME"];
        if (prevDbUser !== undefined) process.env["DB_USER"] = prevDbUser;
        else delete process.env["DB_USER"];
        setMysqlPoolForTesting(null);
      }

      // 3e. Unknown UUID returns 404 instead of silent success
      const missingRes = await handleApiRequest(
        new Request("http://localhost:3000/api/users/channel-logo", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${adminToken}`,
          },
          body: JSON.stringify({
            userId: "00000000-0000-0000-0000-999999999999",
            channelName: "Nonexistent",
          }),
        }),
      );
      assert.ok(missingRes);
      assert.equal(missingRes.status, 404);

      // 3f. PHP parity checks for UUID resolution and 404 handling
      const responsePhp = fs.readFileSync(path.resolve(process.cwd(), "api/response.php"), "utf-8");
      assert.match(responsePhp, /\$matchesUuid/);
      const logoPhp = fs.readFileSync(
        path.resolve(process.cwd(), "api/users/channel-logo.php"),
        "utf-8",
      );
      assert.match(logoPhp, /WHERE id = \? OR UPPER\(user_id\) = UPPER\(\?\)/);
      assert.match(logoPhp, /404/);
    });

    it("4. Persists AuthContext channel logo & name synchronously without React 19 deferred updater race", () => {
      const storageMap = new Map<string, string>();
      const prevWindow = (globalThis as any).window;
      const prevEnvApi = process.env["VITE_API_BASE_URL"];
      const prevEnvMedia = process.env["VITE_MEDIA_BASE_URL"];
      delete process.env["VITE_API_BASE_URL"];
      delete process.env["VITE_MEDIA_BASE_URL"];

      try {
        (globalThis as any).window = {
          location: { hostname: "facetube.online" },
        };

        const initialUser = {
          id: alexUuid,
          user_id: userUserId,
          email: "alex@facetube.com",
          user_metadata: {
            user_id: userUserId,
            name: "Alex Mercer",
            channel_logo_url: null,
            channel_name: "Old Channel",
          },
        };
        const initialProfile = {
          id: alexUuid,
          user_id: userUserId,
          username: userUserId,
          name: "Alex Mercer",
          full_name: "Alex Mercer",
          mobile: "+1 555-014-8392",
          email: "alex@facetube.com",
          channel_logo_url: null,
          channel_name: "Old Channel",
          referral_code: "CREATOR50",
          created_at: new Date().toISOString(),
        };
        const initialDbUser = {
          id: alexUuid,
          user_id: userUserId,
          name: "Alex Mercer",
          mobile: "+1 555-014-8392",
          email: "alex@facetube.com",
          password_hash: "SECURED_BY_PHP_BCRYPT",
          channel_logo_url: null,
          channel_name: "Old Channel",
          referral_code: "CREATOR50",
          created_at: initialProfile.created_at,
          role: "user" as const,
        };

        const cachedSession = {
          user: initialUser,
          profile: initialProfile,
          dbUser: initialDbUser,
          role: "user" as const,
          token: "tok_sync_123",
        };
        storageMap.set(LOCAL_STORAGE_SESSION_KEY, JSON.stringify(cachedSession));

        // Simulate deferred React 19 state setters (callbacks do NOT execute synchronously)
        const deferredQueue: Array<() => void> = [];
        const scheduleDeferredSetter = (fn: () => void) => {
          deferredQueue.push(fn);
        };

        const { updatedProfile, updatedDbUser, updatedAuthUser, sessionToPersist } =
          computeUpdatedChannelSession({
            user: initialUser,
            profile: initialProfile,
            dbUser: initialDbUser,
            role: "user",
            cachedSession,
            token: "tok_sync_123",
            updates: {
              channel_logo_url: "/uploads/logos/logo_sync_fixed.png",
              channel_name: "Synced Studio",
            },
          });

        assert.ok(sessionToPersist);
        storageMap.set(LOCAL_STORAGE_SESSION_KEY, JSON.stringify(sessionToPersist));
        scheduleDeferredSetter(() => {
          void updatedProfile;
          void updatedDbUser;
          void updatedAuthUser;
        });

        // BEFORE deferred setters run (simulating immediate refresh/navigation), localStorage already has updated values
        const restoredAfterRefresh = JSON.parse(storageMap.get(LOCAL_STORAGE_SESSION_KEY) || "{}");
        assert.equal(
          restoredAfterRefresh.profile.channel_logo_url,
          "https://api.facetube.online/uploads/logos/logo_sync_fixed.png",
        );
        assert.equal(restoredAfterRefresh.profile.channel_name, "Synced Studio");
        assert.equal(
          restoredAfterRefresh.dbUser.channel_logo_url,
          "https://api.facetube.online/uploads/logos/logo_sync_fixed.png",
        );
        assert.equal(restoredAfterRefresh.dbUser.channel_name, "Synced Studio");
        assert.equal(
          restoredAfterRefresh.user.user_metadata.channel_logo_url,
          "https://api.facetube.online/uploads/logos/logo_sync_fixed.png",
        );
        assert.equal(restoredAfterRefresh.user.user_metadata.channel_name, "Synced Studio");
        assert.equal(restoredAfterRefresh.token, "tok_sync_123");
        assert.equal(deferredQueue.length, 1);

        // Verify auth-context.tsx uses computeUpdatedChannelSession synchronously before setters
        const authContextSrc = fs.readFileSync(
          path.resolve(process.cwd(), "src/lib/auth-context.tsx"),
          "utf-8",
        );
        const fnStartIdx = authContextSrc.indexOf("const updateChannelBranding = useCallback(");
        assert.ok(fnStartIdx > 0, "updateChannelBranding must exist in auth-context.tsx");
        const fnBodySrc = authContextSrc.slice(fnStartIdx);
        assert.match(fnBodySrc, /computeUpdatedChannelSession/);
        const setItemIdx = fnBodySrc.indexOf("localStorage.setItem(LOCAL_STORAGE_SESSION_KEY");
        const setProfileIdx = fnBodySrc.indexOf("setProfile(updatedProfile)");
        assert.ok(setItemIdx > 0 && setProfileIdx > 0);
        assert.ok(
          setItemIdx < setProfileIdx,
          "localStorage persistence must occur synchronously from calculated objects before state updates",
        );
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

    it("5. Maintains PHP and Node media URL parity in production while preserving local dev and 9:16 uploads", async () => {
      // Production request origin or FACETUBE_API_BASE_URL resolves relative /uploads/logos/* to canonical host
      const prodRequestRes = await handleApiRequest(
        new Request("https://facetube.online/api/users/channel-logo", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${userToken}`,
          },
          body: JSON.stringify({
            channelLogoUrl:
              "https://api.facetube.onlinehttps://api.facetube.online/uploads/logos/logo_parity.png",
            channelName: "Parity Studio",
          }),
        }),
      );
      assert.ok(prodRequestRes);
      assert.equal(prodRequestRes.status, 200);
      const prodData = (await prodRequestRes.json()) as any;
      assert.equal(
        prodData.channel_logo_url,
        "https://api.facetube.online/uploads/logos/logo_parity.png",
      );
      assert.equal(
        prodData.channelLogoUrl,
        "https://api.facetube.online/uploads/logos/logo_parity.png",
      );

      // Relative /uploads/logos/* passed on https://facetube.online resolves to https://api.facetube.online/uploads/logos/*
      const prodRelRes = await handleApiRequest(
        new Request("https://facetube.online/api/users/channel-logo", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${userToken}`,
          },
          body: JSON.stringify({
            channelLogoUrl: "/uploads/logos/logo_rel_prod.png",
          }),
        }),
      );
      assert.ok(prodRelRes);
      assert.equal(prodRelRes.status, 200);
      const prodRelData = (await prodRelRes.json()) as any;
      assert.equal(
        prodRelData.channel_logo_url,
        "https://api.facetube.online/uploads/logos/logo_rel_prod.png",
      );

      // Existing 9:16 default image upload path remains untouched (/uploads/images/img_*)
      const formData = new FormData();
      formData.append("image", new File([validPngBytes], "poster_916.png", { type: "image/png" }));
      const upload916Res = await handleApiRequest(
        new Request("http://localhost:3000/api/uploads/image", {
          method: "POST",
          body: formData,
        }),
      );
      assert.ok(upload916Res);
      assert.equal(upload916Res.status, 201);
      const upload916Data = (await upload916Res.json()) as any;
      assert.match(upload916Data.url, /^\/uploads\/images\/img_.*\.png$/);
      createdFiles.push(upload916Data.url);
    });
  });

  describe("7. Task 5F: Node Profile API Production Fail-Closed & UUID Consistency Tests", () => {
    const alexUuid = "a0000000-0000-0000-0000-000000000002";
    const mayaUuid = "a0000000-0000-0000-0000-000000000003";

    it("1. Returns HTTP 503 for GET/POST users/profile and GET users/list when APP_ENV=production and MySQL pool is unavailable", async () => {
      const prevNodeEnv = process.env["NODE_ENV"];
      const prevAppEnv = process.env["APP_ENV"];
      process.env["APP_ENV"] = "production";
      process.env["NODE_ENV"] = "test";
      setMysqlPoolForTesting(null);

      try {
        // Check JSON store snapshot before requests
        const beforeStore = fs.readFileSync(storePath, "utf-8");

        // GET /api/users/profile -> 503
        const getProfileRes = await handleApiRequest(
          new Request(
            `http://localhost:3000/api/users/profile?user_id=${encodeURIComponent(userUserId)}`,
            { method: "GET" },
          ),
        );
        assert.ok(getProfileRes);
        assert.equal(getProfileRes.status, 503);
        const getProfileData = (await getProfileRes.json()) as any;
        assert.equal(getProfileData.success, false);
        assert.equal(getProfileData.profile, undefined);

        // POST /api/users/profile -> 503 (for authenticated user)
        const postProfileRes = await handleApiRequest(
          new Request("http://localhost:3000/api/users/profile", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${userToken}`,
            },
            body: JSON.stringify({
              name: "Should Not Write In Prod",
              channel_name: "Should Not Persist",
            }),
          }),
        );
        assert.ok(postProfileRes);
        assert.equal(postProfileRes.status, 503);
        const postProfileData = (await postProfileRes.json()) as any;
        assert.equal(postProfileData.success, false);

        // GET /api/users/list -> 503 (for authenticated admin)
        const getListRes = await handleApiRequest(
          new Request("http://localhost:3000/api/users/list", {
            method: "GET",
            headers: { Authorization: `Bearer ${adminToken}` },
          }),
        );
        assert.ok(getListRes);
        assert.equal(getListRes.status, 503);
        const getListData = (await getListRes.json()) as any;
        assert.equal(getListData.success, false);
        assert.equal(getListData.users, undefined);

        // Admin-only & auth protections remain intact even with APP_ENV=production and !pool
        const unauthListRes = await handleApiRequest(
          new Request("http://localhost:3000/api/users/list", { method: "GET" }),
        );
        assert.ok(unauthListRes);
        assert.equal(unauthListRes.status, 401);

        const nonAdminListRes = await handleApiRequest(
          new Request("http://localhost:3000/api/users/list", {
            method: "GET",
            headers: { Authorization: `Bearer ${userToken}` },
          }),
        );
        assert.ok(nonAdminListRes);
        assert.equal(nonAdminListRes.status, 403);

        // Confirm JSON store was never mutated
        const afterStore = fs.readFileSync(storePath, "utf-8");
        assert.equal(afterStore, beforeStore);
      } finally {
        if (prevNodeEnv !== undefined) process.env["NODE_ENV"] = prevNodeEnv;
        else delete process.env["NODE_ENV"];
        if (prevAppEnv !== undefined) process.env["APP_ENV"] = prevAppEnv;
        else delete process.env["APP_ENV"];
      }
    });

    it("2. Returns HTTP 500 without JSON fallback when MySQL query fails on GET/POST users/profile and GET users/list", async () => {
      const failingPool = {
        query: async (sql: string) => {
          if (/FROM\s+sessions/i.test(sql)) {
            return [[], []];
          }
          throw new Error("Simulated MySQL query failure");
        },
      } as any;

      const prevNodeEnv = process.env["NODE_ENV"];
      const prevDbHost = process.env["DB_HOST"];
      const prevDbName = process.env["DB_NAME"];
      const prevDbUser = process.env["DB_USER"];
      process.env["NODE_ENV"] = "test";
      process.env["DB_HOST"] = "127.0.0.1";
      process.env["DB_NAME"] = "facetube_test";
      process.env["DB_USER"] = "test_user";
      setMysqlPoolForTesting(failingPool);

      try {
        const beforeStore = fs.readFileSync(storePath, "utf-8");

        // GET /api/users/profile -> 500
        const getProfileRes = await handleApiRequest(
          new Request(
            `http://localhost:3000/api/users/profile?user_id=${encodeURIComponent(userUserId)}`,
            { method: "GET" },
          ),
        );
        assert.ok(getProfileRes);
        assert.equal(getProfileRes.status, 500);
        const getProfileData = (await getProfileRes.json()) as any;
        assert.equal(getProfileData.success, false);
        assert.equal(getProfileData.profile, undefined);

        // POST /api/users/profile -> 500
        const postProfileRes = await handleApiRequest(
          new Request("http://localhost:3000/api/users/profile", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${userToken}`,
            },
            body: JSON.stringify({
              name: "Should Not Fallback To JSON",
              channel_name: "Failed DB Write",
            }),
          }),
        );
        assert.ok(postProfileRes);
        assert.equal(postProfileRes.status, 500);
        const postProfileData = (await postProfileRes.json()) as any;
        assert.equal(postProfileData.success, false);

        // GET /api/users/list -> 500
        const getListRes = await handleApiRequest(
          new Request("http://localhost:3000/api/users/list", {
            method: "GET",
            headers: { Authorization: `Bearer ${adminToken}` },
          }),
        );
        assert.ok(getListRes);
        assert.equal(getListRes.status, 500);
        const getListData = (await getListRes.json()) as any;
        assert.equal(getListData.success, false);
        assert.equal(getListData.users, undefined);

        // Confirm store remained untouched
        const afterStore = fs.readFileSync(storePath, "utf-8");
        assert.equal(afterStore, beforeStore);
      } finally {
        if (prevNodeEnv !== undefined) process.env["NODE_ENV"] = prevNodeEnv;
        else delete process.env["NODE_ENV"];
        if (prevDbHost !== undefined) process.env["DB_HOST"] = prevDbHost;
        else delete process.env["DB_HOST"];
        if (prevDbName !== undefined) process.env["DB_NAME"] = prevDbName;
        else delete process.env["DB_NAME"];
        if (prevDbUser !== undefined) process.env["DB_USER"] = prevDbUser;
        else delete process.env["DB_USER"];
        setMysqlPoolForTesting(null);
      }
    });

    it("3. Supports case-insensitive self UUID matching while enforcing cross-user 403 and public PII stripping", async () => {
      // Self update with uppercase UUID succeeds (200)
      const selfUuidPostRes = await handleApiRequest(
        new Request("http://localhost:3000/api/users/profile", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${userToken}`,
          },
          body: JSON.stringify({
            userId: alexUuid.toUpperCase(),
            name: "Alex Self Uppercase UUID",
            channel_name: "Alex Tech Studio",
          }),
        }),
      );
      assert.ok(selfUuidPostRes);
      assert.equal(selfUuidPostRes.status, 200);
      const selfUuidPostData = (await selfUuidPostRes.json()) as any;
      assert.equal(selfUuidPostData.profile.user_id, userUserId);
      assert.equal(selfUuidPostData.profile.name, "Alex Self Uppercase UUID");

      // Self GET with uppercase UUID returns full own profile (including email/mobile)
      const selfUuidGetRes = await handleApiRequest(
        new Request(
          `http://localhost:3000/api/users/profile?user_id=${encodeURIComponent(alexUuid.toUpperCase())}`,
          {
            method: "GET",
            headers: { Authorization: `Bearer ${userToken}` },
          },
        ),
      );
      assert.ok(selfUuidGetRes);
      assert.equal(selfUuidGetRes.status, 200);
      const selfUuidGetData = (await selfUuidGetRes.json()) as any;
      assert.equal(selfUuidGetData.profile.email, "alex@facetube.com");

      // Public GET with uppercase UUID returns 200 but strips private fields
      const publicUuidGetRes = await handleApiRequest(
        new Request(
          `http://localhost:3000/api/users/profile?user_id=${encodeURIComponent(alexUuid.toUpperCase())}`,
          { method: "GET" },
        ),
      );
      assert.ok(publicUuidGetRes);
      assert.equal(publicUuidGetRes.status, 200);
      const publicUuidGetData = (await publicUuidGetRes.json()) as any;
      assert.equal(publicUuidGetData.profile.user_id, userUserId);
      assert.equal(publicUuidGetData.profile.email, undefined);
      assert.equal(publicUuidGetData.profile.mobile, undefined);
      assert.equal(publicUuidGetData.profile.referral_code, undefined);
      assert.equal(publicUuidGetData.profile.role, undefined);

      // Cross-user POST using another user's uppercase UUID still returns 403 for non-admin
      const crossUuidPostRes = await handleApiRequest(
        new Request("http://localhost:3000/api/users/profile", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${userToken}`,
          },
          body: JSON.stringify({
            userId: mayaUuid.toUpperCase(),
            name: "Unauthorized Cross UUID Update",
          }),
        }),
      );
      assert.ok(crossUuidPostRes);
      assert.equal(crossUuidPostRes.status, 403);
    });

    it("4. Strips PII in MySQL mode for public GET users/profile and preserves admin users/list", async () => {
      const mockPool = {
        query: async (sql: string) => {
          if (/FROM\s+sessions/i.test(sql)) {
            return [[], []];
          }
          if (/ORDER BY created_at DESC LIMIT 100/i.test(sql)) {
            return [
              [
                {
                  id: alexUuid,
                  user_id: userUserId,
                  name: "Alex MySQL",
                  mobile: "+1 555-000-0001",
                  email: "alex@facetube.com",
                  role: "user",
                  referral_code: "CREATOR50",
                  avatar_url: null,
                  channel_logo_url: "/uploads/logos/alex.png",
                  channel_name: "Alex Studio",
                  created_at: new Date().toISOString(),
                },
              ],
              [],
            ];
          }
          if (/FROM\s+users/i.test(sql)) {
            return [
              [
                {
                  id: alexUuid,
                  user_id: userUserId,
                  name: "Alex MySQL",
                  mobile: "+1 555-000-0001",
                  email: "alex@facetube.com",
                  role: "user",
                  referral_code: "CREATOR50",
                  avatar_url: null,
                  channel_logo_url: "/uploads/logos/alex.png",
                  channel_name: "Alex Studio",
                  created_at: new Date().toISOString(),
                },
              ],
              [],
            ];
          }
          return [[], []];
        },
      } as any;

      const prevDbHost = process.env["DB_HOST"];
      const prevDbName = process.env["DB_NAME"];
      const prevDbUser = process.env["DB_USER"];
      process.env["DB_HOST"] = "127.0.0.1";
      process.env["DB_NAME"] = "facetube_test";
      process.env["DB_USER"] = "test_user";
      setMysqlPoolForTesting(mockPool);

      try {
        // Public MySQL GET users/profile strips private fields
        const pubRes = await handleApiRequest(
          new Request(
            `http://localhost:3000/api/users/profile?user_id=${encodeURIComponent(alexUuid.toUpperCase())}`,
            { method: "GET" },
          ),
        );
        assert.ok(pubRes);
        assert.equal(pubRes.status, 200);
        const pubData = (await pubRes.json()) as any;
        assert.equal(pubData.profile.channel_name, "Alex Studio");
        assert.equal(pubData.profile.email, undefined);
        assert.equal(pubData.profile.mobile, undefined);
        assert.equal(pubData.profile.referral_code, undefined);
        assert.equal(pubData.profile.role, undefined);

        // Self MySQL GET users/profile with uppercase UUID exposes full profile
        const selfRes = await handleApiRequest(
          new Request(
            `http://localhost:3000/api/users/profile?user_id=${encodeURIComponent(alexUuid.toUpperCase())}`,
            {
              method: "GET",
              headers: { Authorization: `Bearer ${userToken}` },
            },
          ),
        );
        assert.ok(selfRes);
        assert.equal(selfRes.status, 200);
        const selfData = (await selfRes.json()) as any;
        assert.equal(selfData.profile.email, "alex@facetube.com");

        // Admin MySQL GET users/list succeeds and non-admin is blocked with 403
        const adminListRes = await handleApiRequest(
          new Request("http://localhost:3000/api/users/list", {
            method: "GET",
            headers: { Authorization: `Bearer ${adminToken}` },
          }),
        );
        assert.ok(adminListRes);
        assert.equal(adminListRes.status, 200);
        const adminListData = (await adminListRes.json()) as any;
        assert.equal(adminListData.users.length, 1);
        assert.equal(adminListData.users[0].email, "alex@facetube.com");

        const userListRes = await handleApiRequest(
          new Request("http://localhost:3000/api/users/list", {
            method: "GET",
            headers: { Authorization: `Bearer ${userToken}` },
          }),
        );
        assert.ok(userListRes);
        assert.equal(userListRes.status, 403);
      } finally {
        if (prevDbHost !== undefined) process.env["DB_HOST"] = prevDbHost;
        else delete process.env["DB_HOST"];
        if (prevDbName !== undefined) process.env["DB_NAME"] = prevDbName;
        else delete process.env["DB_NAME"];
        if (prevDbUser !== undefined) process.env["DB_USER"] = prevDbUser;
        else delete process.env["DB_USER"];
        setMysqlPoolForTesting(null);
      }
    });
  });

  describe("8. Task 5G: Safe Channel Logo Removal / Reset Regression Tests", () => {
    const alexUuid = "a0000000-0000-0000-0000-000000000002";
    const mayaUuid = "a0000000-0000-0000-0000-000000000003";

    it("1. Rejects unauthenticated removal with 401 and cross-user non-admin removal with 403", async () => {
      const unauthRes = await handleApiRequest(
        new Request("http://localhost:3000/api/users/channel-logo", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ channelLogoUrl: null, removeLogo: true }),
        }),
      );
      assert.ok(unauthRes);
      assert.equal(unauthRes.status, 401);

      const crossRes = await handleApiRequest(
        new Request("http://localhost:3000/api/users/channel-logo", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${userToken}`,
          },
          body: JSON.stringify({
            userId: mayaUuid,
            channel_logo_url: null,
            removeLogo: true,
          }),
        }),
      );
      assert.ok(crossRes);
      assert.equal(crossRes.status, 403);
    });

    it("2. Preserves existing logo when omitted, and clears logo to null while preserving channel_name on explicit removal", async () => {
      // Seed user with logo + channel name
      const seedRes = await handleApiRequest(
        new Request("http://localhost:3000/api/users/channel-logo", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${userToken}`,
          },
          body: JSON.stringify({
            channelLogoUrl: "/uploads/logos/logo_before_remove.png",
            channelName: "Preserved Studio Name",
          }),
        }),
      );
      assert.ok(seedRes);
      assert.equal(seedRes.status, 200);

      // Updating channelName ONLY (omitting channel_logo_url) must NOT clear existing logo
      const nameOnlyRes = await handleApiRequest(
        new Request("http://localhost:3000/api/users/channel-logo", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${userToken}`,
          },
          body: JSON.stringify({
            channelName: "Preserved Studio Name v2",
          }),
        }),
      );
      assert.ok(nameOnlyRes);
      assert.equal(nameOnlyRes.status, 200);
      const nameOnlyData = (await nameOnlyRes.json()) as any;
      assert.equal(nameOnlyData.channel_logo_url, "/uploads/logos/logo_before_remove.png");
      assert.equal(nameOnlyData.channel_name, "Preserved Studio Name v2");

      // Explicit removal clears channel_logo_url to null and preserves channel_name
      const removeRes = await handleApiRequest(
        new Request("http://localhost:3000/api/users/channel-logo", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${userToken}`,
          },
          body: JSON.stringify({
            channel_logo_url: null,
            removeLogo: true,
          }),
        }),
      );
      assert.ok(removeRes);
      assert.equal(removeRes.status, 200);
      const removeData = (await removeRes.json()) as any;
      assert.equal(removeData.success, true);
      assert.equal(removeData.channel_logo_url, null);
      assert.equal(removeData.channelLogoUrl, null);
      assert.equal(removeData.channel_name, "Preserved Studio Name v2");
      assert.equal(removeData.channelName, "Preserved Studio Name v2");

      // Verify JSON store persisted channel_logo_url: null and preserved channel_name
      const storeSnapshot = JSON.parse(fs.readFileSync(storePath, "utf-8"));
      const alexRow = (storeSnapshot.users || []).find((u: any) => u.user_id === userUserId);
      assert.ok(alexRow);
      assert.equal(alexRow.channel_logo_url, null);
      assert.equal(alexRow.channel_name, "Preserved Studio Name v2");

      // Verify auth/me reflects null logo & preserved channel_name
      const meRes = await handleApiRequest(
        new Request("http://localhost:3000/api/auth/me", {
          method: "GET",
          headers: { Authorization: `Bearer ${userToken}` },
        }),
      );
      assert.ok(meRes);
      const meData = (await meRes.json()) as any;
      assert.equal(meData.user.channel_logo_url, null);
      assert.equal(meData.user.channel_name, "Preserved Studio Name v2");
    });

    it("3. Allows authorized admin removal for another user and stores SQL NULL in MySQL without modifying omitted fields", async () => {
      // Seed Maya in store with a logo & name first
      const seedMayaRes = await handleApiRequest(
        new Request("http://localhost:3000/api/users/channel-logo", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${adminToken}`,
          },
          body: JSON.stringify({
            userId: mayaUuid,
            channelLogoUrl: "/uploads/logos/maya_before_remove.png",
            channelName: "Maya Kept Channel",
          }),
        }),
      );
      assert.ok(seedMayaRes);
      assert.equal(seedMayaRes.status, 200);

      // Admin removes Maya's logo in JSON store
      const adminRemoveRes = await handleApiRequest(
        new Request("http://localhost:3000/api/users/channel-logo", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${adminToken}`,
          },
          body: JSON.stringify({
            userId: mayaUuid.toUpperCase(),
            channelLogoUrl: null,
            removeLogo: true,
          }),
        }),
      );
      assert.ok(adminRemoveRes);
      assert.equal(adminRemoveRes.status, 200);
      const adminRemoveData = (await adminRemoveRes.json()) as any;
      assert.equal(adminRemoveData.channel_logo_url, null);
      assert.equal(adminRemoveData.channel_name, "Maya Kept Channel");

      // MySQL mock pool: verify explicit removal executes `channel_logo_url = ?` with SQL NULL and does not touch channel_name,
      // and omitted logo field updates ONLY channel_name without touching channel_logo_url.
      const capturedQueries: Array<{ sql: string; params: any[] }> = [];
      let currentDbLogo: string | null = "/uploads/logos/maya_mysql.png";
      const currentDbName = "Maya MySQL Kept";

      const mockPool = {
        query: async (sql: string, params: any[] = []) => {
          capturedQueries.push({ sql, params });
          if (/FROM\s+sessions/i.test(sql)) {
            return [[], []];
          }
          if (/SELECT\s+id,\s*user_id,\s*channel_logo_url/i.test(sql)) {
            return [
              [
                {
                  id: mayaUuid,
                  user_id: "FT900431",
                  channel_logo_url: currentDbLogo,
                  channel_name: currentDbName,
                },
              ],
              [],
            ];
          }
          if (/UPDATE\s+users/i.test(sql)) {
            if (/channel_logo_url\s*=\s*\?/i.test(sql)) {
              currentDbLogo = params[0] ?? null;
            }
            return [{ affectedRows: 1 }, []];
          }
          if (/SELECT\s+channel_logo_url,\s*channel_name/i.test(sql)) {
            return [[{ channel_logo_url: currentDbLogo, channel_name: currentDbName }], []];
          }
          return [[], []];
        },
      } as any;

      const prevDbHost = process.env["DB_HOST"];
      const prevDbName = process.env["DB_NAME"];
      const prevDbUser = process.env["DB_USER"];
      process.env["DB_HOST"] = "127.0.0.1";
      process.env["DB_NAME"] = "facetube_test";
      process.env["DB_USER"] = "test_user";
      setMysqlPoolForTesting(mockPool);

      try {
        // 3a. Omitted logo field must NOT include channel_logo_url in UPDATE SQL
        const omitRes = await handleApiRequest(
          new Request("http://localhost:3000/api/users/channel-logo", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${adminToken}`,
            },
            body: JSON.stringify({
              userId: mayaUuid,
              channelName: "Maya MySQL Kept",
            }),
          }),
        );
        assert.ok(omitRes);
        assert.equal(omitRes.status, 200);
        const omitUpdate = capturedQueries.find((q) => /UPDATE\s+users/i.test(q.sql));
        assert.ok(omitUpdate);
        assert.doesNotMatch(omitUpdate.sql, /channel_logo_url/i);
        assert.equal(currentDbLogo, "/uploads/logos/maya_mysql.png");

        // 3b. Explicit removal sets SQL NULL for channel_logo_url and omits channel_name
        capturedQueries.length = 0;
        const sqlRemoveRes = await handleApiRequest(
          new Request("http://localhost:3000/api/users/channel-logo", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${adminToken}`,
            },
            body: JSON.stringify({
              userId: mayaUuid.toUpperCase(),
              channel_logo_url: null,
              removeLogo: true,
            }),
          }),
        );
        assert.ok(sqlRemoveRes);
        assert.equal(sqlRemoveRes.status, 200);
        const sqlRemoveData = (await sqlRemoveRes.json()) as any;
        assert.equal(sqlRemoveData.channel_logo_url, null);
        assert.equal(sqlRemoveData.channel_name, "Maya MySQL Kept");

        const removeUpdate = capturedQueries.find((q) => /UPDATE\s+users/i.test(q.sql));
        assert.ok(removeUpdate);
        assert.match(removeUpdate.sql, /SET\s+channel_logo_url\s*=\s*\?/i);
        assert.doesNotMatch(removeUpdate.sql, /channel_name\s*=/i);
        assert.equal(removeUpdate.params[0], null);
        assert.equal(currentDbLogo, null);
      } finally {
        if (prevDbHost !== undefined) process.env["DB_HOST"] = prevDbHost;
        else delete process.env["DB_HOST"];
        if (prevDbName !== undefined) process.env["DB_NAME"] = prevDbName;
        else delete process.env["DB_NAME"];
        if (prevDbUser !== undefined) process.env["DB_USER"] = prevDbUser;
        else delete process.env["DB_USER"];
        setMysqlPoolForTesting(null);
      }
    });

    it("4. Fails closed with 500 on MySQL error (no JSON fallback) and 503 in production without MySQL", async () => {
      // Seed a logo in JSON store first to prove failed MySQL removal does NOT mutate store
      await handleApiRequest(
        new Request("http://localhost:3000/api/users/channel-logo", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${userToken}`,
          },
          body: JSON.stringify({
            channelLogoUrl: "/uploads/logos/keep_on_fail.png",
            channelName: "Keep On Fail",
          }),
        }),
      );
      const beforeStore = fs.readFileSync(storePath, "utf-8");

      const failingPool = {
        query: async (sql: string) => {
          if (/FROM\s+sessions/i.test(sql)) return [[], []];
          if (/SELECT\s+id,\s*user_id,\s*channel_logo_url/i.test(sql)) {
            return [
              [
                {
                  id: alexUuid,
                  user_id: userUserId,
                  channel_logo_url: "/uploads/logos/keep_on_fail.png",
                  channel_name: "Keep On Fail",
                },
              ],
              [],
            ];
          }
          if (/UPDATE\s+users/i.test(sql)) {
            throw new Error("Simulated MySQL failure on logo removal");
          }
          return [[], []];
        },
      } as any;

      const prevDbHost = process.env["DB_HOST"];
      const prevDbName = process.env["DB_NAME"];
      const prevDbUser = process.env["DB_USER"];
      const prevAppEnv = process.env["APP_ENV"];
      const prevNodeEnv = process.env["NODE_ENV"];
      process.env["DB_HOST"] = "127.0.0.1";
      process.env["DB_NAME"] = "facetube_test";
      process.env["DB_USER"] = "test_user";
      setMysqlPoolForTesting(failingPool);

      try {
        const failRes = await handleApiRequest(
          new Request("http://localhost:3000/api/users/channel-logo", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${userToken}`,
            },
            body: JSON.stringify({ channelLogoUrl: null, removeLogo: true }),
          }),
        );
        assert.ok(failRes);
        assert.equal(failRes.status, 500);
        assert.equal(fs.readFileSync(storePath, "utf-8"), beforeStore);
      } finally {
        setMysqlPoolForTesting(null);
        if (prevDbHost !== undefined) process.env["DB_HOST"] = prevDbHost;
        else delete process.env["DB_HOST"];
        if (prevDbName !== undefined) process.env["DB_NAME"] = prevDbName;
        else delete process.env["DB_NAME"];
        if (prevDbUser !== undefined) process.env["DB_USER"] = prevDbUser;
        else delete process.env["DB_USER"];
      }

      // Production without MySQL -> 503
      process.env["APP_ENV"] = "production";
      process.env["NODE_ENV"] = "test";
      try {
        const prodRes = await handleApiRequest(
          new Request("http://localhost:3000/api/users/channel-logo", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${userToken}`,
            },
            body: JSON.stringify({ channelLogoUrl: null, removeLogo: true }),
          }),
        );
        assert.ok(prodRes);
        assert.equal(prodRes.status, 503);
        assert.equal(fs.readFileSync(storePath, "utf-8"), beforeStore);
      } finally {
        if (prevAppEnv !== undefined) process.env["APP_ENV"] = prevAppEnv;
        else delete process.env["APP_ENV"];
        if (prevNodeEnv !== undefined) process.env["NODE_ENV"] = prevNodeEnv;
        else delete process.env["NODE_ENV"];
      }
    });

    it("5. Synchronously clears channel_logo_url in AuthContext/localStorage while preserving channel_name, and verifies PHP parity", () => {
      const initialProfile = {
        id: alexUuid,
        user_id: userUserId,
        username: userUserId,
        name: "Alex Mercer",
        full_name: "Alex Mercer",
        mobile: "+1 555-014-8392",
        email: "alex@facetube.com",
        channel_logo_url: "https://api.facetube.online/uploads/logos/logo_existing.png",
        channel_name: "Keep My Studio Name",
        referral_code: "CREATOR50",
        created_at: new Date().toISOString(),
      };
      const initialDbUser = {
        id: alexUuid,
        user_id: userUserId,
        name: "Alex Mercer",
        mobile: "+1 555-014-8392",
        email: "alex@facetube.com",
        password_hash: "SECURED_BY_PHP_BCRYPT",
        channel_logo_url: "https://api.facetube.online/uploads/logos/logo_existing.png",
        channel_name: "Keep My Studio Name",
        referral_code: "CREATOR50",
        created_at: initialProfile.created_at,
        role: "user" as const,
      };
      const initialAuthUser = {
        id: alexUuid,
        user_id: userUserId,
        email: "alex@facetube.com",
        user_metadata: {
          user_id: userUserId,
          name: "Alex Mercer",
          channel_logo_url: "https://api.facetube.online/uploads/logos/logo_existing.png",
          channel_name: "Keep My Studio Name",
        },
      };

      const { sessionToPersist } = computeUpdatedChannelSession({
        user: initialAuthUser,
        profile: initialProfile,
        dbUser: initialDbUser,
        role: "user",
        token: "tok_remove_123",
        updates: {
          channel_logo_url: null,
        },
      });

      assert.ok(sessionToPersist);
      const serialized = JSON.stringify(sessionToPersist);
      const restored = JSON.parse(serialized);
      assert.equal(restored.profile.channel_logo_url, null);
      assert.equal(restored.profile.channel_name, "Keep My Studio Name");
      assert.equal(restored.dbUser.channel_logo_url, null);
      assert.equal(restored.dbUser.channel_name, "Keep My Studio Name");
      assert.equal(restored.user.user_metadata.channel_logo_url, null);
      assert.equal(restored.user.user_metadata.channel_name, "Keep My Studio Name");
      assert.equal(restored.token, "tok_remove_123");

      // PHP parity check: api/users/channel-logo.php distinguishes omitted vs explicit removal and binds null
      const logoPhp = fs.readFileSync(
        path.resolve(process.cwd(), "api/users/channel-logo.php"),
        "utf-8",
      );
      assert.match(logoPhp, /\$hasLogoKey/);
      assert.match(logoPhp, /\$shouldRemoveLogo/);
      assert.match(logoPhp, /removeLogo/);
      assert.match(logoPhp, /\$shouldRemoveLogo\s*\?\s*null\s*:/);
      assert.match(logoPhp, /WHERE UPPER\(id\) = UPPER\(\?\) OR UPPER\(user_id\) = UPPER\(\?\)/);
    });
  });

  describe("9. Task 5H: Channel Description Database Persistence & Security Tests", () => {
    const alexUuid = "a0000000-0000-0000-0000-000000000002";
    const mayaUuid = "a0000000-0000-0000-0000-000000000003";

    it("1. Defines channel_description TEXT NULL in schema.sql and idempotent INFORMATION_SCHEMA migration SQL", () => {
      const schemaSql = fs.readFileSync(
        path.resolve(process.cwd(), "database/schema.sql"),
        "utf-8",
      );
      assert.match(schemaSql, /`channel_description`\s+TEXT\s+DEFAULT\s+NULL/i);

      const migrationSql = fs.readFileSync(
        path.resolve(process.cwd(), "database/migrations/20261120_users_channel_description.sql"),
        "utf-8",
      );
      assert.match(migrationSql, /INFORMATION_SCHEMA\.COLUMNS/i);
      assert.match(migrationSql, /COLUMN_NAME\s*=\s*'channel_description'/i);
      assert.match(migrationSql, /ADD COLUMN `channel_description` TEXT NULL DEFAULT NULL/i);
      assert.match(migrationSql, /PREPARE\s+stmt_add_channel_description/i);
      assert.match(migrationSql, /EXECUTE\s+stmt_add_channel_description/i);
      assert.match(migrationSql, /DEALLOCATE PREPARE\s+stmt_add_channel_description/i);
    });

    it("2. Enforces 1000-char max length, plain-text/no-HTML/script rules, and self/admin authorization", async () => {
      // Unauthenticated POST rejected (401)
      const unauthProfileRes = await handleApiRequest(
        new Request("http://localhost:3000/api/users/profile", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ channel_description: "Unauthorized bio" }),
        }),
      );
      assert.ok(unauthProfileRes);
      assert.equal(unauthProfileRes.status, 401);

      const unauthLogoRes = await handleApiRequest(
        new Request("http://localhost:3000/api/users/channel-logo", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ channelDescription: "Unauthorized bio" }),
        }),
      );
      assert.ok(unauthLogoRes);
      assert.equal(unauthLogoRes.status, 401);

      // Non-admin cross-user rejected (403)
      const crossRes = await handleApiRequest(
        new Request("http://localhost:3000/api/users/channel-logo", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${userToken}`,
          },
          body: JSON.stringify({
            userId: mayaUuid,
            channel_description: "Trying to overwrite Maya",
          }),
        }),
      );
      assert.ok(crossRes);
      assert.equal(crossRes.status, 403);

      // > 1000 characters rejected on both endpoints (400)
      const tooLong = "a".repeat(1001);
      for (const endpoint of ["/api/users/profile", "/api/users/channel-logo"]) {
        const lenRes = await handleApiRequest(
          new Request(`http://localhost:3000${endpoint}`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${userToken}`,
            },
            body: JSON.stringify({ channel_description: tooLong }),
          }),
        );
        assert.ok(lenRes);
        assert.equal(lenRes.status, 400);
      }

      // HTML / script payloads rejected on both endpoints (400)
      const dangerousInputs = [
        "<script>alert('xss')</script>",
        "Hello <img src=x onerror=alert(1)>",
        "Visit javascript:alert(1)",
        "<b>Bold HTML</b>",
      ];
      for (const badText of dangerousInputs) {
        for (const endpoint of ["/api/users/profile", "/api/users/channel-logo"]) {
          const xssRes = await handleApiRequest(
            new Request(`http://localhost:3000${endpoint}`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${userToken}`,
              },
              body: JSON.stringify({ channel_description: badText }),
            }),
          );
          assert.ok(xssRes);
          assert.equal(xssRes.status, 400);
        }
      }

      // Non-string non-null type rejected (400)
      const nonStringRes = await handleApiRequest(
        new Request("http://localhost:3000/api/users/profile", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${userToken}`,
          },
          body: JSON.stringify({ channel_description: { nested: true } }),
        }),
      );
      assert.ok(nonStringRes);
      assert.equal(nonStringRes.status, 400);

      // Exactly 1000 chars plain text (including harmless math `< 10` & newlines) succeeds (200)
      const valid1000 = `${"Creator line 1\r\n5 < 10 & Studio updates. ".padEnd(1000, "x")}`;
      const okRes = await handleApiRequest(
        new Request("http://localhost:3000/api/users/channel-logo", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${userToken}`,
          },
          body: JSON.stringify({ channelDescription: valid1000 }),
        }),
      );
      assert.ok(okRes);
      assert.equal(okRes.status, 200);
      const okData = (await okRes.json()) as any;
      assert.ok(typeof okData.channel_description === "string");
      assert.ok(okData.channel_description.length <= 1000);
      assert.ok(!okData.channel_description.includes("\r"));
    });

    it("3. Persists channel_description across auth/me, auth/login, public-safe users/profile, admin users/list, and preserves branding fields", async () => {
      // Set initial logo & channel name
      const seedRes = await handleApiRequest(
        new Request("http://localhost:3000/api/users/channel-logo", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${userToken}`,
          },
          body: JSON.stringify({
            channelLogoUrl: "/uploads/logos/desc_keep_logo.png",
            channelName: "Keep Name Studio",
            channelDescription: "Weekly UI architecture and full-stack coding streams.",
          }),
        }),
      );
      assert.ok(seedRes);
      assert.equal(seedRes.status, 200);
      const seedData = (await seedRes.json()) as any;
      assert.equal(
        seedData.channel_description,
        "Weekly UI architecture and full-stack coding streams.",
      );
      assert.equal(seedData.channel_logo_url, "/uploads/logos/desc_keep_logo.png");
      assert.equal(seedData.channel_name, "Keep Name Studio");

      // Removing logo later MUST preserve channel_description and channel_name
      const removeLogoRes = await handleApiRequest(
        new Request("http://localhost:3000/api/users/channel-logo", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${userToken}`,
          },
          body: JSON.stringify({ channelLogoUrl: null, removeLogo: true }),
        }),
      );
      assert.ok(removeLogoRes);
      assert.equal(removeLogoRes.status, 200);
      const removeLogoData = (await removeLogoRes.json()) as any;
      assert.equal(removeLogoData.channel_logo_url, null);
      assert.equal(removeLogoData.channel_name, "Keep Name Studio");
      assert.equal(
        removeLogoData.channel_description,
        "Weekly UI architecture and full-stack coding streams.",
      );

      // Update channel_description via POST /api/users/profile
      const updateDescRes = await handleApiRequest(
        new Request("http://localhost:3000/api/users/profile", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${userToken}`,
          },
          body: JSON.stringify({
            channel_description: "  Updated creator bio for React 19 & TypeScript.  ",
          }),
        }),
      );
      assert.ok(updateDescRes);
      assert.equal(updateDescRes.status, 200);
      const updateDescData = (await updateDescRes.json()) as any;
      assert.equal(
        updateDescData.profile.channel_description,
        "Updated creator bio for React 19 & TypeScript.",
      );

      // Refresh check: GET /api/auth/me returns persisted channel_description
      const meRes = await handleApiRequest(
        new Request("http://localhost:3000/api/auth/me", {
          method: "GET",
          headers: { Authorization: `Bearer ${userToken}` },
        }),
      );
      assert.ok(meRes);
      assert.equal(meRes.status, 200);
      const meData = (await meRes.json()) as any;
      assert.equal(
        meData.user.channel_description,
        "Updated creator bio for React 19 & TypeScript.",
      );

      // Login check: POST /api/auth/login returns persisted channel_description
      const loginRes = await handleApiRequest(
        new Request("http://localhost:3000/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ identifier: userUserId, password: "password" }),
        }),
      );
      assert.ok(loginRes);
      assert.equal(loginRes.status, 200);
      const loginData = (await loginRes.json()) as any;
      assert.equal(
        loginData.user.channel_description,
        "Updated creator bio for React 19 & TypeScript.",
      );

      // Public-safe GET /api/users/profile includes channel_description while stripping PII
      const pubRes = await handleApiRequest(
        new Request(
          `http://localhost:3000/api/users/profile?user_id=${encodeURIComponent(userUserId)}`,
          { method: "GET" },
        ),
      );
      assert.ok(pubRes);
      assert.equal(pubRes.status, 200);
      const pubData = (await pubRes.json()) as any;
      assert.equal(
        pubData.profile.channel_description,
        "Updated creator bio for React 19 & TypeScript.",
      );
      assert.equal(pubData.profile.email, undefined);
      assert.equal(pubData.profile.mobile, undefined);
      assert.equal(pubData.profile.referral_code, undefined);

      // Admin GET /api/users/list includes channel_description
      const listRes = await handleApiRequest(
        new Request("http://localhost:3000/api/users/list", {
          method: "GET",
          headers: { Authorization: `Bearer ${adminToken}` },
        }),
      );
      assert.ok(listRes);
      assert.equal(listRes.status, 200);
      const listData = (await listRes.json()) as any;
      const alexEntry = (listData.users || []).find((u: any) => u.user_id === userUserId);
      assert.ok(alexEntry);
      assert.equal(alexEntry.channel_description, "Updated creator bio for React 19 & TypeScript.");

      // Clearing channel_description with "" saves null cleanly
      const clearRes = await handleApiRequest(
        new Request("http://localhost:3000/api/users/channel-logo", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${userToken}`,
          },
          body: JSON.stringify({ channelDescription: "   " }),
        }),
      );
      assert.ok(clearRes);
      assert.equal(clearRes.status, 200);
      const clearData = (await clearRes.json()) as any;
      assert.equal(clearData.channel_description, null);
      assert.equal(clearData.channel_name, "Keep Name Studio");
    });

    it("4. Saves channel_description in MySQL mode and fails closed with 500/503 without JSON fallback", async () => {
      const capturedQueries: Array<{ sql: string; params: any[] }> = [];
      let currentDbDescription: string | null = "Initial MySQL bio";

      const mockPool = {
        query: async (sql: string, params: any[] = []) => {
          capturedQueries.push({ sql, params });
          if (/FROM\s+sessions/i.test(sql)) {
            return [[], []];
          }
          if (/SELECT\s+id,\s*user_id,\s*channel_logo_url/i.test(sql)) {
            return [
              [
                {
                  id: alexUuid,
                  user_id: userUserId,
                  channel_logo_url: "/uploads/logos/alex_mysql.png",
                  channel_name: "Alex MySQL",
                  channel_description: currentDbDescription,
                },
              ],
              [],
            ];
          }
          if (/UPDATE\s+users/i.test(sql)) {
            if (/channel_description\s*=\s*\?/i.test(sql)) {
              currentDbDescription = params[0] ?? null;
            }
            return [{ affectedRows: 1 }, []];
          }
          if (/SELECT\s+channel_logo_url,\s*channel_name,\s*channel_description/i.test(sql)) {
            return [
              [
                {
                  channel_logo_url: "/uploads/logos/alex_mysql.png",
                  channel_name: "Alex MySQL",
                  channel_description: currentDbDescription,
                },
              ],
              [],
            ];
          }
          return [[], []];
        },
      } as any;

      const prevDbHost = process.env["DB_HOST"];
      const prevDbName = process.env["DB_NAME"];
      const prevDbUser = process.env["DB_USER"];
      const prevAppEnv = process.env["APP_ENV"];
      const prevNodeEnv = process.env["NODE_ENV"];
      process.env["DB_HOST"] = "127.0.0.1";
      process.env["DB_NAME"] = "facetube_test";
      process.env["DB_USER"] = "test_user";
      setMysqlPoolForTesting(mockPool);

      try {
        const res = await handleApiRequest(
          new Request("http://localhost:3000/api/users/channel-logo", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${userToken}`,
            },
            body: JSON.stringify({
              channelDescription: "New MySQL persisted description",
            }),
          }),
        );
        assert.ok(res);
        assert.equal(res.status, 200);
        const data = (await res.json()) as any;
        assert.equal(data.channel_description, "New MySQL persisted description");
        assert.equal(currentDbDescription, "New MySQL persisted description");
        const updateQ = capturedQueries.find((q) => /UPDATE\s+users/i.test(q.sql));
        assert.ok(updateQ);
        assert.match(updateQ.sql, /channel_description\s*=\s*\?/i);

        // Failing MySQL pool returns 500 without mutating store
        const beforeStore = fs.readFileSync(storePath, "utf-8");
        setMysqlPoolForTesting({
          query: async (sql: string) => {
            if (/FROM\s+sessions/i.test(sql)) return [[], []];
            throw new Error("Simulated MySQL failure");
          },
        } as any);
        const failRes = await handleApiRequest(
          new Request("http://localhost:3000/api/users/profile", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${userToken}`,
            },
            body: JSON.stringify({ channel_description: "Should fail closed" }),
          }),
        );
        assert.ok(failRes);
        assert.equal(failRes.status, 500);
        assert.equal(fs.readFileSync(storePath, "utf-8"), beforeStore);
      } finally {
        setMysqlPoolForTesting(null);
        if (prevDbHost !== undefined) process.env["DB_HOST"] = prevDbHost;
        else delete process.env["DB_HOST"];
        if (prevDbName !== undefined) process.env["DB_NAME"] = prevDbName;
        else delete process.env["DB_NAME"];
        if (prevDbUser !== undefined) process.env["DB_USER"] = prevDbUser;
        else delete process.env["DB_USER"];
      }

      // Production without MySQL returns 503
      process.env["APP_ENV"] = "production";
      process.env["NODE_ENV"] = "test";
      try {
        const prodRes = await handleApiRequest(
          new Request("http://localhost:3000/api/users/profile", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${userToken}`,
            },
            body: JSON.stringify({ channel_description: "Should fail 503" }),
          }),
        );
        assert.ok(prodRes);
        assert.equal(prodRes.status, 503);
      } finally {
        if (prevAppEnv !== undefined) process.env["APP_ENV"] = prevAppEnv;
        else delete process.env["APP_ENV"];
        if (prevNodeEnv !== undefined) process.env["NODE_ENV"] = prevNodeEnv;
        else delete process.env["NODE_ENV"];
      }
    });

    it("5. Persists channel_description synchronously in AuthContext/localStorage and matches UI + PHP parity", () => {
      const initialProfile = {
        id: alexUuid,
        user_id: userUserId,
        username: userUserId,
        name: "Alex Mercer",
        full_name: "Alex Mercer",
        mobile: "+1 555-014-8392",
        email: "alex@facetube.com",
        channel_logo_url: "https://api.facetube.online/uploads/logos/logo_existing.png",
        channel_name: "Studio Name",
        channel_description: "Old bio",
        referral_code: "CREATOR50",
        created_at: new Date().toISOString(),
      };
      const initialDbUser = {
        id: alexUuid,
        user_id: userUserId,
        name: "Alex Mercer",
        mobile: "+1 555-014-8392",
        email: "alex@facetube.com",
        password_hash: "SECURED_BY_PHP_BCRYPT",
        channel_logo_url: "https://api.facetube.online/uploads/logos/logo_existing.png",
        channel_name: "Studio Name",
        channel_description: "Old bio",
        referral_code: "CREATOR50",
        created_at: initialProfile.created_at,
        role: "user" as const,
      };
      const initialAuthUser = {
        id: alexUuid,
        user_id: userUserId,
        email: "alex@facetube.com",
        user_metadata: {
          user_id: userUserId,
          name: "Alex Mercer",
          channel_logo_url: "https://api.facetube.online/uploads/logos/logo_existing.png",
          channel_name: "Studio Name",
          channel_description: "Old bio",
        },
      };

      const { sessionToPersist } = computeUpdatedChannelSession({
        user: initialAuthUser,
        profile: initialProfile,
        dbUser: initialDbUser,
        role: "user",
        token: "tok_desc_123",
        updates: {
          channel_description: "Updated persistent bio after refresh",
        },
      });

      assert.ok(sessionToPersist);
      const restored = JSON.parse(JSON.stringify(sessionToPersist));
      assert.equal(restored.profile.channel_description, "Updated persistent bio after refresh");
      assert.equal(restored.dbUser.channel_description, "Updated persistent bio after refresh");
      assert.equal(
        restored.user.user_metadata.channel_description,
        "Updated persistent bio after refresh",
      );
      assert.equal(
        restored.profile.channel_logo_url,
        "https://api.facetube.online/uploads/logos/logo_existing.png",
      );
      assert.equal(restored.profile.channel_name, "Studio Name");

      // UI checks on profile.tsx: loads hydratedChannelDescription, enforces 1000 chars, plain text JSX only
      const profileSrc = fs.readFileSync(
        path.resolve(process.cwd(), "src/routes/profile.tsx"),
        "utf-8",
      );
      assert.match(profileSrc, /hydratedChannelDescription/);
      assert.match(profileSrc, /channelDescription:\s*normalizedBio\s*\|\|\s*null/);
      assert.match(profileSrc, /maxLength=\{1000\}/);
      assert.doesNotMatch(profileSrc, /dangerouslySetInnerHTML/);

      // PHP parity across response.php, login.php, list.php, profile.php, channel-logo.php
      for (const phpRel of [
        "api/response.php",
        "api/auth/login.php",
        "api/users/list.php",
        "api/users/profile.php",
        "api/users/channel-logo.php",
      ]) {
        const phpSrc = fs.readFileSync(path.resolve(process.cwd(), phpRel), "utf-8");
        assert.match(phpSrc, /channel_description/, `${phpRel} must handle channel_description`);
      }
      const profilePhp = fs.readFileSync(
        path.resolve(process.cwd(), "api/users/profile.php"),
        "utf-8",
      );
      assert.match(profilePhp, /validateChannelDescription/);
      assert.match(profilePhp, /sanitizePublicProfile[\s\S]*channel_description/);
    });
  });

  describe("10. Task 5J-L: Empty channel_logo_url Normalization to NULL", () => {
    it("1. Normalizes empty and whitespace-only channel_logo_url to null/SQL NULL while preserving omitted updates and channel_name behavior", async () => {
      // Seed logo + channel_name in JSON store
      const seedRes = await handleApiRequest(
        new Request("http://localhost:3000/api/users/profile", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${userToken}`,
          },
          body: JSON.stringify({
            channel_logo_url: "/uploads/logos/profile_empty_clear.png",
            channel_name: "Kept Channel Name",
          }),
        }),
      );
      assert.ok(seedRes);
      assert.equal(seedRes.status, 200);
      const seedData = (await seedRes.json()) as any;
      assert.equal(seedData.profile.channel_logo_url, "/uploads/logos/profile_empty_clear.png");

      // Omitting channel_logo_url while updating channel_name preserves existing logo
      const omitRes = await handleApiRequest(
        new Request("http://localhost:3000/api/users/profile", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${userToken}`,
          },
          body: JSON.stringify({
            channel_name: "Updated Kept Channel",
          }),
        }),
      );
      assert.ok(omitRes);
      assert.equal(omitRes.status, 200);
      const omitData = (await omitRes.json()) as any;
      assert.equal(omitData.profile.channel_logo_url, "/uploads/logos/profile_empty_clear.png");
      assert.equal(omitData.profile.channel_name, "Updated Kept Channel");

      // Empty string clears channel_logo_url to null in JSON store
      const emptyRes = await handleApiRequest(
        new Request("http://localhost:3000/api/users/profile", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${userToken}`,
          },
          body: JSON.stringify({
            channel_logo_url: "",
          }),
        }),
      );
      assert.ok(emptyRes);
      assert.equal(emptyRes.status, 200);
      const emptyData = (await emptyRes.json()) as any;
      assert.equal(emptyData.profile.channel_logo_url, null);
      assert.equal(emptyData.profile.channel_name, "Updated Kept Channel");

      const storeSnapshot = JSON.parse(fs.readFileSync(storePath, "utf-8"));
      const alexStoreRow = (storeSnapshot.users || []).find((u: any) => u.user_id === userUserId);
      assert.ok(alexStoreRow);
      assert.equal(alexStoreRow.channel_logo_url, null);

      // Re-seed and test whitespace-only channelLogoUrl in MySQL mode -> binds SQL NULL
      let currentDbLogo: string | null = "/uploads/logos/mysql_before_empty.png";
      let currentDbName: string | null = "MySQL Studio";
      const capturedUpdates: Array<{ sql: string; params: any[] }> = [];

      const mockPool = {
        query: async (sql: string, params: any[] = []) => {
          if (/FROM\s+sessions/i.test(sql)) {
            return [[], []];
          }
          if (/UPDATE\s+users/i.test(sql)) {
            capturedUpdates.push({ sql, params });
            if (/channel_logo_url\s*=\s*\?/i.test(sql)) {
              currentDbLogo = params[0] ?? null;
            }
            if (/channel_name\s*=\s*\?/i.test(sql)) {
              const idx = /channel_logo_url\s*=\s*\?/i.test(sql) ? 1 : 0;
              currentDbName = params[idx] ?? null;
            }
            return [{ affectedRows: 1 }, []];
          }
          if (/FROM\s+users/i.test(sql)) {
            return [
              [
                {
                  id: "a0000000-0000-0000-0000-000000000002",
                  user_id: userUserId,
                  name: "Alex Rivera",
                  mobile: "+1 555-014-8392",
                  email: "alex@facetube.com",
                  role: "user",
                  referral_code: "CREATOR50",
                  avatar_url: null,
                  channel_logo_url: currentDbLogo,
                  channel_name: currentDbName,
                  channel_description: null,
                  created_at: new Date().toISOString(),
                },
              ],
              [],
            ];
          }
          return [[], []];
        },
      } as any;

      const prevDbHost = process.env["DB_HOST"];
      const prevDbName = process.env["DB_NAME"];
      const prevDbUser = process.env["DB_USER"];
      process.env["DB_HOST"] = "127.0.0.1";
      process.env["DB_NAME"] = "facetube_test";
      process.env["DB_USER"] = "test_user";
      setMysqlPoolForTesting(mockPool);

      try {
        const wsRes = await handleApiRequest(
          new Request("http://localhost:3000/api/users/profile", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${userToken}`,
            },
            body: JSON.stringify({
              channelLogoUrl: "   ",
            }),
          }),
        );
        assert.ok(wsRes);
        assert.equal(wsRes.status, 200);
        const wsData = (await wsRes.json()) as any;
        assert.equal(wsData.profile.channel_logo_url, null);
        assert.equal(wsData.profile.channel_name, "MySQL Studio");
        assert.equal(capturedUpdates.length, 1);
        const firstUpdate = capturedUpdates[0]!;
        assert.match(firstUpdate.sql, /channel_logo_url\s*=\s*\?/i);
        assert.equal(firstUpdate.params[0], null);

        // Existing channel_name empty-string behavior remains unchanged
        const emptyNameRes = await handleApiRequest(
          new Request("http://localhost:3000/api/users/profile", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${userToken}`,
            },
            body: JSON.stringify({
              channel_name: "",
            }),
          }),
        );
        assert.ok(emptyNameRes);
        assert.equal(emptyNameRes.status, 200);
        const emptyNameData = (await emptyNameRes.json()) as any;
        assert.equal(emptyNameData.profile.channel_name, "");
      } finally {
        setMysqlPoolForTesting(null);
        if (prevDbHost !== undefined) process.env["DB_HOST"] = prevDbHost;
        else delete process.env["DB_HOST"];
        if (prevDbName !== undefined) process.env["DB_NAME"] = prevDbName;
        else delete process.env["DB_NAME"];
        if (prevDbUser !== undefined) process.env["DB_USER"] = prevDbUser;
        else delete process.env["DB_USER"];
      }

      // PHP profile.php also normalizes empty/whitespace channel_logo_url to null
      const profilePhp = fs.readFileSync(
        path.resolve(process.cwd(), "api/users/profile.php"),
        "utf-8",
      );
      assert.match(profilePhp, /\$fieldName\s*===\s*'channel_logo_url'\s*\?\s*null\s*:\s*''/);
    });
  });

  describe("11. Task 5J-N: Public users/profile GET channel_logo_url Normalization", () => {
    it("1. Normalizes relative /uploads/... logos in public MySQL and non-prod JSON profile GET while preserving absolute, null, and empty values without PII", async () => {
      const envKeys = [
        "NODE_ENV",
        "APP_ENV",
        "DB_HOST",
        "DB_NAME",
        "DB_USER",
        "FACETUBE_API_BASE_URL",
        "API_BASE_URL",
        "VITE_MEDIA_BASE_URL",
      ] as const;
      const envSnapshot: Record<string, string | undefined> = {};
      for (const k of envKeys) {
        envSnapshot[k] = process.env[k];
      }
      const storeSnapshot = fs.existsSync(storePath) ? fs.readFileSync(storePath, "utf-8") : null;

      try {
        // A. Production MySQL mode: relative -> https://api.facetube.online/uploads/..., absolute/null/"" preserved, no PII
        process.env["APP_ENV"] = "production";
        delete process.env["NODE_ENV"];
        delete process.env["FACETUBE_API_BASE_URL"];
        delete process.env["API_BASE_URL"];
        delete process.env["VITE_MEDIA_BASE_URL"];
        process.env["DB_HOST"] = "127.0.0.1";
        process.env["DB_NAME"] = "facetube_test";
        process.env["DB_USER"] = "test_user";

        const cases: Array<{ label: string; input: string | null; expected: string | null }> = [
          {
            label: "relative /uploads/ logo",
            input: "/uploads/logos/public_rel.png",
            expected: "https://api.facetube.online/uploads/logos/public_rel.png",
          },
          {
            label: "already absolute https URL",
            input: "https://cdn.example.com/logos/public_abs.png",
            expected: "https://cdn.example.com/logos/public_abs.png",
          },
          {
            label: "null logo",
            input: null,
            expected: null,
          },
          {
            label: "empty string logo",
            input: "",
            expected: "",
          },
        ];

        for (const tc of cases) {
          setMysqlPoolForTesting({
            query: async () => [
              [
                {
                  id: "u-pub-test",
                  user_id: "FT483921",
                  name: "Alex Rivera",
                  mobile: "+1 555-000-0001",
                  email: "alex@facetube.com",
                  role: "user",
                  referral_code: "CREATOR50",
                  avatar_url: null,
                  channel_logo_url: tc.input,
                  channel_name: "Alex Public Studio",
                  channel_description: "Public bio",
                  created_at: "2026-11-01T00:00:00.000Z",
                },
              ],
              [],
            ],
          } as any);

          const res = await handleApiRequest(
            new Request("http://localhost:3000/api/users/profile?user_id=FT483921", {
              method: "GET",
            }),
          );
          assert.ok(res);
          assert.equal(res.status, 200, tc.label);
          const data = (await res.json()) as any;
          assert.equal(data.profile.channel_logo_url, tc.expected, tc.label);
          assert.equal(data.profile.email, undefined);
          assert.equal(data.profile.mobile, undefined);
          assert.equal(data.profile.referral_code, undefined);
          assert.equal(data.profile.role, undefined);
        }

        // B. Non-production JSON store fallback on https://facetube.online host normalizes relative logo and preserves no PII
        process.env["NODE_ENV"] = "test";
        delete process.env["APP_ENV"];
        delete process.env["DB_HOST"];
        setMysqlPoolForTesting(null);
        resetStoreForTests();

        await handleApiRequest(
          new Request("http://localhost:3000/api/users/profile", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${userToken}`,
            },
            body: JSON.stringify({
              channel_logo_url: "/uploads/logos/json_public.png",
            }),
          }),
        );

        const jsonPubRes = await handleApiRequest(
          new Request(
            `https://facetube.online/api/users/profile?user_id=${encodeURIComponent(userUserId)}`,
            { method: "GET" },
          ),
        );
        assert.ok(jsonPubRes);
        assert.equal(jsonPubRes.status, 200);
        const jsonPubData = (await jsonPubRes.json()) as any;
        assert.equal(
          jsonPubData.profile.channel_logo_url,
          "https://api.facetube.online/uploads/logos/json_public.png",
        );
        assert.equal(jsonPubData.profile.email, undefined);
        assert.equal(jsonPubData.profile.mobile, undefined);
        assert.equal(jsonPubData.profile.referral_code, undefined);
      } finally {
        setMysqlPoolForTesting(null);
        for (const k of envKeys) {
          if (envSnapshot[k] !== undefined) {
            process.env[k] = envSnapshot[k];
          } else {
            delete process.env[k];
          }
        }
        if (storeSnapshot !== null) {
          fs.writeFileSync(storePath, storeSnapshot, "utf-8");
        }
        resetInMemoryStore();
      }
    });
  });
});
