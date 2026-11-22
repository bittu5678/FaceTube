import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  convertVideoToShortItem,
  getVideoBadgeLabels,
  type UploadedVideo,
} from "../lib/video-service";

function readSource(relPath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relPath), "utf-8");
}

describe("FaceTube Task 8: Sponsored Label Next to Channel Name", () => {
  it("1. Shows 'Sponsored' only when videoType or video_type is 'premium' and never for 'free'", () => {
    const premiumCamel = getVideoBadgeLabels({ videoType: "premium", isPromoted: false });
    assert.equal(premiumCamel.showSponsorLabel, true);
    assert.equal(premiumCamel.showAdsLabel, false);
    assert.deepEqual(premiumCamel.badges, [{ type: "sponsor", label: "Sponsored" }]);

    const premiumSnake = getVideoBadgeLabels({ video_type: "premium", is_promoted: 0 });
    assert.equal(premiumSnake.showSponsorLabel, true);
    assert.equal(premiumSnake.showAdsLabel, false);
    assert.deepEqual(premiumSnake.badges, [{ type: "sponsor", label: "Sponsored" }]);

    const freeVideo = getVideoBadgeLabels({ videoType: "free", isPromoted: false });
    assert.equal(freeVideo.showSponsorLabel, false);
    assert.equal(freeVideo.showAdsLabel, false);
    assert.equal(freeVideo.badges.length, 0);

    const omittedType = getVideoBadgeLabels({});
    assert.equal(omittedType.showSponsorLabel, false);
    assert.equal(omittedType.badges.length, 0);
  });

  it("2. Never infers 'Sponsored' from isPromoted and keeps Ads status separate", () => {
    const futureExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const promotedFreeOnly = getVideoBadgeLabels({
      videoType: "free",
      isPromoted: true,
      promotionExpiresAt: futureExpiry,
    });
    assert.equal(promotedFreeOnly.showSponsorLabel, false);
    assert.equal(promotedFreeOnly.showAdsLabel, true);
    assert.deepEqual(promotedFreeOnly.badges, [{ type: "ads", label: "Ads" }]);

    const promotedSnakeOnly = getVideoBadgeLabels({
      video_type: "free",
      is_promoted: 1,
      promotion_expires_at: futureExpiry,
    });
    assert.equal(promotedSnakeOnly.showSponsorLabel, false);
    assert.equal(promotedSnakeOnly.showAdsLabel, true);

    const premiumAndPromoted = getVideoBadgeLabels({
      videoType: "premium",
      isPromoted: true,
      promotionExpiresAt: futureExpiry,
    });
    assert.equal(premiumAndPromoted.showSponsorLabel, true);
    assert.equal(premiumAndPromoted.showAdsLabel, true);
    assert.deepEqual(premiumAndPromoted.badges, [
      { type: "sponsor", label: "Sponsored" },
      { type: "ads", label: "Ads" },
    ]);
  });

  it("3. Forwards sponsor and promotion metadata into ShortItem in convertVideoToShortItem without mutating static SHORTS_LIST", () => {
    const futureExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const premiumShortUpload: UploadedVideo = {
      id: "vid-short-premium-1",
      userId: "FT100001",
      creatorName: "Premium Channel",
      channelName: "Premium Channel",
      title: "Paid Sponsor Short",
      description: "",
      videoUrl: "/uploads/videos/sample.mp4",
      thumbnailUrl: "/uploads/images/sample.jpg",
      videoType: "premium",
      contentType: "short",
      category: "Tech",
      duration: "0:45",
      views: 120,
      likes: 15,
      paymentStatus: "paid",
      paymentAmount: 6,
      isPromoted: false,
      createdAt: "2026-11-20T00:00:00.000Z",
      updatedAt: "2026-11-20T00:00:00.000Z",
    };

    const premiumShortItem = convertVideoToShortItem(premiumShortUpload);
    assert.equal(premiumShortItem.videoType, "premium");
    assert.equal(premiumShortItem.isPromoted, false);
    const premiumShortLabels = getVideoBadgeLabels(premiumShortItem);
    assert.equal(premiumShortLabels.showSponsorLabel, true);
    assert.equal(premiumShortLabels.showAdsLabel, false);
    assert.equal(premiumShortLabels.badges[0]?.label, "Sponsored");

    const promotedFreeShortUpload: UploadedVideo = {
      ...premiumShortUpload,
      id: "vid-short-promoted-free-1",
      title: "Promoted Free Short",
      videoType: "free",
      paymentStatus: "not_required",
      paymentAmount: 0,
      isPromoted: true,
      promotionExpiresAt: futureExpiry,
    };

    const promotedFreeShortItem = convertVideoToShortItem(promotedFreeShortUpload);
    assert.equal(promotedFreeShortItem.videoType, "free");
    assert.equal(promotedFreeShortItem.isPromoted, true);
    assert.equal(promotedFreeShortItem.promotionExpiresAt, futureExpiry);
    const promotedFreeShortLabels = getVideoBadgeLabels(promotedFreeShortItem);
    assert.equal(promotedFreeShortLabels.showSponsorLabel, false);
    assert.equal(promotedFreeShortLabels.showAdsLabel, true);

    // Ensure static SHORTS_LIST never introduces hardcoded sponsor status
    const shortsSrc = readSource("src/data/shorts.ts");
    const listStart = shortsSrc.indexOf("export const SHORTS_LIST");
    assert.ok(listStart !== -1);
    const listBody = shortsSrc.slice(listStart);
    assert.equal(
      listBody.includes("premium"),
      false,
      "Static SHORTS_LIST must not hardcode premium/sponsor status",
    );
  });

  it("4. Places Sponsored beside channel name (not below title) and avoids duplicate badges across all target video surfaces", () => {
    const surfacesWithChannelBadge = [
      "src/components/videohub/VideoCard.tsx",
      "src/routes/watch.$videoId.tsx",
      "src/routes/premium-videos.tsx",
      "src/components/videohub/ShortsShelf.tsx",
      "src/routes/shorts.tsx",
      "src/routes/short-videos.tsx",
      "src/routes/history.tsx",
      "src/routes/liked-videos.tsx",
      "src/routes/watch-later.tsx",
      "src/routes/advertisement-videos.tsx",
    ];

    for (const file of surfacesWithChannelBadge) {
      const src = readSource(file);
      assert.ok(src.includes("getVideoBadgeLabels"), `${file} must use getVideoBadgeLabels`);
      assert.ok(src.includes("showSponsorLabel"), `${file} must check showSponsorLabel`);
      assert.ok(src.includes("Sponsored"), `${file} must render Sponsored wording`);
      assert.ok(src.includes("shrink-0"), `${file} must prevent Sponsored badge clipping`);
      assert.ok(src.includes("truncate"), `${file} must keep channel name truncated`);

      const sponsoredOccurrences = src.match(/>\s*Sponsored\s*</g) ?? [];
      assert.equal(
        sponsoredOccurrences.length,
        1,
        `${file} must render Sponsored badge exactly once (found ${sponsoredOccurrences.length})`,
      );

      const legacySponsorBadgeOccurrences = src.match(/>\s*Sponsor\s*</g) ?? [];
      assert.equal(
        legacySponsorBadgeOccurrences.length,
        0,
        `${file} must not retain legacy 'Sponsor' badge label`,
      );
    }

    // Verify VideoCard, watch page, and premium-videos keep Ads below title and Sponsored beside channel name
    for (const file of [
      "src/components/videohub/VideoCard.tsx",
      "src/routes/watch.$videoId.tsx",
      "src/routes/premium-videos.tsx",
    ]) {
      const src = readSource(file);
      const adsIdx = src.indexOf("showAdsLabel");
      const channelIdx = src.indexOf(">{video.channel}<");
      const sponsoredIdx = src.indexOf("showSponsorLabel");
      assert.ok(adsIdx !== -1 && channelIdx !== -1 && sponsoredIdx !== -1);
      assert.ok(adsIdx < channelIdx, `${file} must keep Ads badge above channel row (below title)`);
      assert.ok(
        sponsoredIdx > channelIdx,
        `${file} must render Sponsored badge beside channel name, not above channel row`,
      );
    }

    // Verify shorts.tsx, short-videos.tsx, and index.tsx forward sponsor metadata to ShortItem
    for (const file of ["src/routes/shorts.tsx", "src/routes/short-videos.tsx"]) {
      const src = readSource(file);
      assert.ok(
        src.includes("videoType: v.videoType"),
        `${file} must forward videoType into ShortItem`,
      );
    }
    const indexSrc = readSource("src/routes/index.tsx");
    assert.ok(
      indexSrc.includes("convertVideoToShortItem") && indexSrc.includes("items={homeShorts}"),
      "src/routes/index.tsx must forward uploaded shorts via convertVideoToShortItem into ShortsShelf",
    );
  });
});
