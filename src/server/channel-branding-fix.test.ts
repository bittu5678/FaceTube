import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  CHANNEL_BRANDING_UPDATED_EVENT,
  computeChannelInitials,
  resolveChannelAvatarUrl,
  resolveChannelDisplayName,
  syncCachedVideosChannelBranding,
} from "../lib/channel-branding.ts";
import { findPublicCachedVideo } from "../lib/watch-video.ts";

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) ?? null) : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
}

describe("FaceTube Channel Branding Final Fix Verification", () => {
  it("1. Resolves channel display name in exact order: channel_name -> full_name -> name -> username -> email -> fallback", () => {
    assert.equal(
      resolveChannelDisplayName({
        profile: {
          id: "u1",
          user_id: "FT1001",
          channel_name: "Studio Alpha",
          full_name: "Priya Sharma",
          name: "Priya",
          username: "priya1001",
          email: "priya@example.com",
        } as any,
      }),
      "Studio Alpha",
    );

    assert.equal(
      resolveChannelDisplayName({
        profile: {
          id: "u1",
          user_id: "FT1001",
          channel_name: "   ",
          full_name: "Priya Sharma",
          name: "Priya",
          username: "priya1001",
          email: "priya@example.com",
        } as any,
      }),
      "Priya Sharma",
    );

    assert.equal(
      resolveChannelDisplayName({
        profile: {
          id: "u1",
          user_id: "FT1001",
          name: "Priya",
          username: "priya1001",
          email: "priya@example.com",
        } as any,
      }),
      "Priya",
    );

    assert.equal(
      resolveChannelDisplayName({
        profile: {
          id: "u1",
          user_id: "FT1001",
          username: "priya1001",
          email: "priya@example.com",
        } as any,
      }),
      "priya1001",
    );

    assert.equal(
      resolveChannelDisplayName({
        user: {
          id: "u1",
          email: "creator.handle@example.com",
          user_metadata: {},
        },
      }),
      "creator.handle",
    );

    assert.equal(resolveChannelDisplayName({}, "Creator"), "Creator");
  });

  it("2. Resolves channel_logo_url first and falls back to avatar_url when requested", () => {
    assert.equal(
      resolveChannelAvatarUrl({
        profile: {
          id: "u1",
          channel_logo_url: "/uploads/logos/ch_1.png",
          avatar_url: "/uploads/logos/av_1.png",
        } as any,
      }),
      "/uploads/logos/ch_1.png",
    );

    assert.equal(
      resolveChannelAvatarUrl(
        {
          profile: {
            id: "u1",
            channel_logo_url: null,
            avatar_url: "/uploads/logos/av_1.png",
          } as any,
        },
        { includeAvatarFallback: true },
      ),
      "/uploads/logos/av_1.png",
    );

    assert.equal(
      resolveChannelAvatarUrl(
        {
          profile: {
            id: "u1",
            channel_logo_url: null,
            avatar_url: "/uploads/logos/av_1.png",
          } as any,
        },
        { includeAvatarFallback: false },
      ),
      undefined,
    );
  });

  it("3. Computes clean 2-letter initials without single-letter overrides", () => {
    assert.equal(computeChannelInitials("Maya Lin"), "ML");
    assert.equal(computeChannelInitials("TechNova"), "TE");
    assert.equal(computeChannelInitials(""), "FT");
  });

  it("4. Synchronizes cached video branding in public and owner caches without corrupting video metadata or unrelated creators", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      "facetube_uploaded_videos_v3",
      JSON.stringify([
        {
          id: "vid-owner-1",
          userId: "FT9001",
          creatorName: "Old Studio",
          channelName: "Old Studio",
          channelLogoUrl: "/uploads/logos/old.png",
          title: "Owner Public Video",
          videoUrl: "/uploads/videos/owner.mp4",
          videoType: "premium",
          paymentStatus: "paid",
          visibility: "public",
          views: 420,
        },
        {
          id: "vid-other-1",
          userId: "FT9999",
          creatorName: "Other Creator",
          channelName: "Other Creator",
          channelLogoUrl: "/uploads/logos/other.png",
          title: "Other Public Video",
          videoUrl: "/uploads/videos/other.mp4",
          videoType: "free",
          paymentStatus: "not_required",
          visibility: "public",
          views: 15,
        },
      ]),
    );
    storage.setItem(
      "facetube_owner_videos_v1:FT9001",
      JSON.stringify([
        {
          id: "vid-owner-priv",
          userId: "FT9001",
          creatorName: "Old Studio",
          channelName: "Old Studio",
          channelLogoUrl: "/uploads/logos/old.png",
          title: "Owner Private Video",
          videoUrl: "/uploads/videos/priv.mp4",
          videoType: "free",
          paymentStatus: "not_required",
          visibility: "private",
          views: 7,
        },
      ]),
    );

    const syncRes = syncCachedVideosChannelBranding({
      userId: "ft9001",
      channelName: "Fresh Branding Studio",
      channelLogoUrl: "/uploads/logos/new.png",
      storage,
    });

    assert.equal(syncRes.publicUpdated, 1);
    assert.equal(syncRes.ownerUpdated, 1);

    const updatedPublic = JSON.parse(storage.getItem("facetube_uploaded_videos_v3") || "[]");
    const ownerPublic = updatedPublic.find((v: any) => v.id === "vid-owner-1");
    const otherPublic = updatedPublic.find((v: any) => v.id === "vid-other-1");

    assert.equal(ownerPublic.channelName, "Fresh Branding Studio");
    assert.equal(ownerPublic.creatorName, "Fresh Branding Studio");
    assert.equal(ownerPublic.channelLogoUrl, "/uploads/logos/new.png");
    assert.equal(ownerPublic.title, "Owner Public Video");
    assert.equal(ownerPublic.paymentStatus, "paid");
    assert.equal(ownerPublic.visibility, "public");
    assert.equal(ownerPublic.views, 420);

    // Other creator untouched
    assert.equal(otherPublic.channelName, "Other Creator");
    assert.equal(otherPublic.channelLogoUrl, "/uploads/logos/other.png");

    // Owner partition updated
    const updatedOwner = JSON.parse(storage.getItem("facetube_owner_videos_v1:FT9001") || "[]");
    assert.equal(updatedOwner[0].channelName, "Fresh Branding Studio");
    assert.equal(updatedOwner[0].channelLogoUrl, "/uploads/logos/new.png");
    assert.equal(updatedOwner[0].visibility, "private");

    // Verify findPublicCachedVideo returns updated branding
    const prevWindow = (globalThis as any).window;
    const prevLocalStorage = (globalThis as any).localStorage;
    try {
      (globalThis as any).window = {};
      (globalThis as any).localStorage = storage;

      const resolved = findPublicCachedVideo("vid-owner-1");
      assert.ok(resolved);
      assert.equal(resolved.channel, "Fresh Branding Studio");
      assert.equal((resolved as any).channelName, "Fresh Branding Studio");
      assert.equal((resolved as any).channelLogoUrl, "/uploads/logos/new.png");
      assert.equal(resolved.initials, "FB");
      assert.equal((resolved as any).userId, "FT9001");

      // Logo removal clears cached channelLogoUrl cleanly so initials take over
      syncCachedVideosChannelBranding({
        userId: "FT9001",
        channelLogoUrl: null,
        storage,
      });
      const afterRemove = findPublicCachedVideo("vid-owner-1");
      assert.ok(afterRemove);
      assert.equal((afterRemove as any).channelLogoUrl, undefined);
      assert.equal(afterRemove.channel, "Fresh Branding Studio");
    } finally {
      if (prevWindow !== undefined) (globalThis as any).window = prevWindow;
      else delete (globalThis as any).window;
      if (prevLocalStorage !== undefined) (globalThis as any).localStorage = prevLocalStorage;
      else delete (globalThis as any).localStorage;
    }
  });

  it("5. Removes hardcoded fake identities, stats, and fake video lists from profile, studio, navbar, dashboard, upload, and certificate UIs", () => {
    const readSrc = (rel: string) => fs.readFileSync(path.resolve(process.cwd(), rel), "utf-8");

    const profileSrc = readSrc("src/routes/profile.tsx");
    assert.doesNotMatch(profileSrc, /Alex Rivera/);
    assert.doesNotMatch(profileSrc, /FT483921/);
    assert.doesNotMatch(profileSrc, /uv-1|uv-2|uv-3|uv-4/);
    assert.doesNotMatch(profileSrc, /12\.4K|84\.2K hrs|4,280\.50|\+₹520\.20/);
    assert.doesNotMatch(profileSrc, /creator@facetube\.app/);
    assert.doesNotMatch(profileSrc, /recent\.slice/);
    assert.doesNotMatch(profileSrc, /initials=\{/);
    assert.match(profileSrc, /fetchUploadedVideos/);
    assert.match(profileSrc, /api\.channel\.getSubscriberCount/);
    assert.match(profileSrc, /getUserWallet/);
    assert.match(profileSrc, /readOnly/);

    const yourVideosSrc = readSrc("src/routes/your-videos.tsx");
    assert.match(yourVideosSrc, /resolveChannelDisplayName/);
    assert.match(yourVideosSrc, /resolveChannelAvatarUrl/);
    assert.doesNotMatch(yourVideosSrc, /FT483921/);

    const uploadSrc = readSrc("src/routes/upload.tsx");
    assert.doesNotMatch(uploadSrc, /creator@facetube\.app/);
    assert.match(uploadSrc, /resolveChannelDisplayName/);

    const navbarSrc = readSrc("src/components/videohub/Navbar.tsx");
    assert.doesNotMatch(navbarSrc, /"AK"/);
    assert.doesNotMatch(navbarSrc, /initials=\{initials\}/);
    assert.match(navbarSrc, /resolveChannelDisplayName/);
    assert.match(navbarSrc, /resolveChannelAvatarUrl/);

    const dashboardSrc = readSrc("src/routes/dashboard.tsx");
    assert.match(dashboardSrc, /ChannelAvatar/);
    assert.match(dashboardSrc, /resolveChannelDisplayName/);
    assert.match(dashboardSrc, /resolveChannelAvatarUrl/);

    const certSrc = readSrc("src/routes/my-certificate.tsx");
    assert.doesNotMatch(certSrc, /Alex Rivera/);
    assert.doesNotMatch(certSrc, /FT483921/);
    assert.doesNotMatch(certSrc, /alex\.rivera@facetube\.app/);
    assert.doesNotMatch(certSrc, /128400|128,400/);
    assert.match(certSrc, /api\.channel\s*\.getSubscriberCount/);

    const certCardSrc = readSrc("src/components/certificate/DigitalCertificateCard.tsx");
    assert.doesNotMatch(certCardSrc, /Alex Rivera/);
    assert.doesNotMatch(certCardSrc, /FT483921/);
    assert.doesNotMatch(certCardSrc, /100,000/);

    assert.equal(CHANNEL_BRANDING_UPDATED_EVENT, "facetube:channel-branding-updated");
    const authSrc = readSrc("src/lib/auth-context.tsx");
    assert.match(authSrc, /syncCachedVideosChannelBranding/);
    assert.match(authSrc, /CHANNEL_BRANDING_UPDATED_EVENT/);
  });
});
