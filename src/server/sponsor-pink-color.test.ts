import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

async function readProjectFile(relPath: string): Promise<string> {
  return fs.readFile(path.resolve(process.cwd(), relPath), "utf8");
}

function extractBetween(source: string, startMarker: string, endMarker: string): string {
  const startIdx = source.indexOf(startMarker);
  assert.notEqual(startIdx, -1, `Expected start marker not found: ${startMarker}`);
  const endIdx = source.indexOf(endMarker, startIdx + startMarker.length);
  assert.notEqual(endIdx, -1, `Expected end marker not found: ${endMarker}`);
  return source.slice(startIdx, endIdx);
}

describe("Task 15: Sponsor Option Pink Colour & Behaviour Regression Tests", () => {
  it("1. Upload page Option 2 (Sponsor) card uses pink styling across default, hover, focus, and CTA states without amber", async () => {
    const uploadSource = await readProjectFile("src/routes/upload.tsx");
    const sponsorCard = extractBetween(
      uploadSource,
      "{/* OPTION 2: Sponsor */}",
      "{/* OPTION 3: Ad */}",
    );

    assert.ok(sponsorCard.includes("border-pink-500/40"));
    assert.ok(sponsorCard.includes("from-pink-500/10"));
    assert.ok(sponsorCard.includes("hover:border-pink-500/70"));
    assert.ok(sponsorCard.includes("bg-pink-500/20"));
    assert.ok(sponsorCard.includes("text-pink-600 dark:text-pink-400"));
    assert.ok(sponsorCard.includes("group-hover:text-pink-600 dark:group-hover:text-pink-400"));
    assert.ok(sponsorCard.includes("text-pink-700 dark:text-pink-300"));
    assert.ok(sponsorCard.includes("hover:bg-pink-500/20"));
    assert.ok(sponsorCard.includes("focus-visible:ring-pink-500/50"));
    assert.ok(sponsorCard.includes("bg-pink-600"));
    assert.ok(sponsorCard.includes("hover:bg-pink-500"));
    assert.ok(sponsorCard.includes("focus-visible:ring-pink-500/60"));
    assert.ok(!sponsorCard.includes("amber-"), "Sponsor card must not retain amber classes");

    // Existing labels, pricing text, and selection handlers remain intact
    assert.ok(sponsorCard.includes("Sponsor · ₹6"));
    assert.ok(sponsorCard.includes("Sponsor Short Video"));
    assert.ok(sponsorCard.includes("Sponsor Long Video"));
    assert.ok(sponsorCard.includes("Upload Sponsor (₹6)"));
    assert.ok(sponsorCard.includes('onSelect("premium", "short")'));
    assert.ok(sponsorCard.includes('onSelect("premium", "long")'));
  });

  it("2. Unrelated Free, Ad, and Image Upload cards retain their original sky, emerald, and teal colours", async () => {
    const uploadSource = await readProjectFile("src/routes/upload.tsx");
    const freeCard = extractBetween(
      uploadSource,
      "{/* OPTION 1: Free */}",
      "{/* OPTION 2: Sponsor */}",
    );
    const adCard = extractBetween(
      uploadSource,
      "{/* OPTION 3: Ad */}",
      "{/* OPTION 4: Image Upload */}",
    );
    const imageCard = extractBetween(
      uploadSource,
      "{/* OPTION 4: Image Upload */}",
      "function BulkVideoUploadView",
    );

    assert.ok(freeCard.includes("border-sky-500/30"));
    assert.ok(freeCard.includes("bg-sky-600"));
    assert.ok(!freeCard.includes("pink-"), "Free option must remain sky, not pink");

    assert.ok(adCard.includes("border-emerald-500/30"));
    assert.ok(adCard.includes("bg-emerald-600"));
    assert.ok(!adCard.includes("pink-"), "Ad option must remain emerald, not pink");

    assert.ok(imageCard.includes("border-teal-500/30"));
    assert.ok(imageCard.includes("bg-teal-600"));
    assert.ok(!imageCard.includes("pink-"), "Image Upload option must remain teal, not pink");
  });

  it("3. Bulk upload Sponsor (₹6) toggle button uses pink selected/hover/focus/disabled states and keeps Free sky", async () => {
    const uploadSource = await readProjectFile("src/routes/upload.tsx");
    const toggleBlock = extractBetween(
      uploadSource,
      "{/* Monetization Option: Free vs Sponsor */}",
      "{/* Category Selector */}",
    );

    assert.ok(toggleBlock.includes("bg-sky-500/20 text-sky-400"));
    assert.ok(
      toggleBlock.includes(
        "bg-pink-500/20 text-pink-700 dark:text-pink-300 border border-pink-500/40",
      ),
    );
    assert.ok(
      toggleBlock.includes("fill-pink-500 text-pink-500 dark:fill-pink-400 dark:text-pink-400"),
    );
    assert.ok(toggleBlock.includes("hover:text-pink-600 dark:hover:text-pink-300"));
    assert.ok(toggleBlock.includes("focus-visible:ring-pink-500/50"));
    assert.ok(toggleBlock.includes("disabled:opacity-50 disabled:cursor-not-allowed"));
    assert.ok(!toggleBlock.includes("amber-"), "Bulk Sponsor toggle must not retain amber classes");
    assert.ok(toggleBlock.includes('updateItem(item.id, { videoType: "premium" })'));
  });

  it("4. PremiumVideoUploadView (Sponsor Video Upload) uses pink accents and preserves consent & ₹6 payment flow", async () => {
    const uploadSource = await readProjectFile("src/routes/upload.tsx");
    const sponsorView = extractBetween(
      uploadSource,
      "function PremiumVideoUploadView(",
      "function AdPromotionUploadView(",
    );

    assert.ok(
      !sponsorView.includes("amber-"),
      "Sponsor Video Upload view must not retain amber classes",
    );
    assert.ok(sponsorView.includes("border-pink-500 bg-pink-500/10 ring-1 ring-pink-500/50"));
    assert.ok(sponsorView.includes("hover:border-pink-500/60 hover:bg-pink-500/5"));
    assert.ok(sponsorView.includes("focus:border-pink-500"));
    assert.ok(sponsorView.includes("border-pink-500/30 bg-pink-500/5"));
    assert.ok(sponsorView.includes("accent-pink-600"));
    assert.ok(
      sponsorView.includes("bg-pink-600 px-8 py-3 text-xs font-bold text-white hover:bg-pink-500"),
    );
    assert.ok(sponsorView.includes("disabled:opacity-50 disabled:cursor-not-allowed"));

    // Sponsor selection, promotion consent, validation, and Razorpay ₹6 payment logic untouched
    assert.ok(sponsorView.includes("if (!promotionConsent)"));
    assert.ok(sponsorView.includes("disabled={uploading || !promotionConsent}"));
    assert.ok(sponsorView.includes("initiatePremiumVideoPayment({"));
    assert.ok(sponsorView.includes("Fee: ₹6 (Razorpay Verified)"));
    assert.ok(sponsorView.includes("Proceed to Pay ₹6.00"));
  });

  it("5. Responsive grid layout and mobile UploadOptionsModal Sponsor option are pink with readable contrast", async () => {
    const uploadSource = await readProjectFile("src/routes/upload.tsx");
    assert.ok(uploadSource.includes("grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4"));

    const modalSource = await readProjectFile("src/components/videohub/UploadOptionsModal.tsx");
    const modalSponsorEntry = extractBetween(modalSource, 'id: "premium",', 'id: "ad_promotion",');

    assert.ok(modalSponsorEntry.includes("border-pink-500/50 hover:border-pink-400"));
    assert.ok(modalSponsorEntry.includes("from-pink-500 to-pink-600 text-white"));
    assert.ok(!modalSponsorEntry.includes("amber-"));
    assert.ok(!modalSponsorEntry.includes("yellow-"));

    assert.ok(
      modalSource.includes(
        "border border-pink-500/40 bg-pink-500/15 text-pink-600 dark:text-pink-300",
      ),
    );
    assert.ok(modalSource.includes("bg-pink-400/35 blur-sm"));
    assert.ok(
      !modalSource.includes("amber-"),
      "UploadOptionsModal must not retain amber for Sponsor",
    );
    assert.ok(modalSource.includes("border-sky-500/30"), "Free option in modal remains sky");
    assert.ok(modalSource.includes("border-emerald-500/30"), "Ad option in modal remains emerald");
    assert.ok(
      modalSource.includes("border-teal-500/30"),
      "Image Upload option in modal remains teal",
    );
  });
});
