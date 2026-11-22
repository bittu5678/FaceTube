import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  CC_BY_3_0_URL,
  CC_BY_4_0_URL,
  IMAGE_MUSIC_CATEGORIES,
  IMAGE_MUSIC_LIBRARY,
  getTracksByCategory,
  hasVerifiedAudioSource,
  resolveMusicTrack,
  toSelectedImageMusic,
  playMusicPreview,
  pauseMusicPreview,
  toggleMusicPreview,
  stopMusicPreview,
  setMusicPreviewVolume,
  getMusicPreviewState,
  setMusicPreviewPlaybackListener,
  type AudioElementLike,
  type ImageMusicTrack,
} from "../lib/image-music-library.ts";
import { normalizeImageMusic } from "../lib/image-service.ts";
import { handleApiRequest, resetInMemoryStore } from "./api-handler.ts";
import { setMysqlPoolForTesting } from "./mysql.ts";

class StubAudioElement implements AudioElementLike {
  src: string;
  volume = 1;
  currentTime = 0;
  paused = true;
  preload = "auto";
  playCalls = 0;
  pauseCalls = 0;
  private listeners = new Map<string, Set<() => void>>();

  constructor(url: string) {
    this.src = url;
  }

  play() {
    this.paused = false;
    this.playCalls += 1;
    return Promise.resolve();
  }

  pause() {
    this.paused = true;
    this.pauseCalls += 1;
  }

  addEventListener(event: string, listener: () => void) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener);
  }

  removeEventListener(event: string, listener: () => void) {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: string) {
    for (const cb of this.listeners.get(event) ?? []) {
      cb();
    }
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}

async function readProjectFile(relPath: string): Promise<string> {
  return fs.readFile(path.resolve(process.cwd(), relPath), "utf8");
}

describe("FaceTube Task 1: Real Licensed Music Audit, Persistence & Gallery Playback Tests", () => {
  afterEach(() => {
    setMusicPreviewPlaybackListener(null);
    stopMusicPreview();
  });

  it("1. Removes all 5 synthesized ringtone tracks and Web Audio oscillator synthesis", async () => {
    const librarySource = await readProjectFile("src/lib/image-music-library.ts");

    const removedTitles = [
      "Lo-Fi Horizon",
      "Golden Hour",
      "Urban Pulse",
      "Midnight Chill",
      "Creator Spark",
    ];
    const removedIds = [
      "ft-lofi-horizon",
      "ft-golden-hour",
      "ft-urban-pulse",
      "ft-midnight-chill",
      "ft-creator-spark",
    ];

    for (const title of removedTitles) {
      assert.equal(
        IMAGE_MUSIC_LIBRARY.some((t) => t.title === title),
        false,
        `Old synthesized track "${title}" must not exist in IMAGE_MUSIC_LIBRARY`,
      );
      assert.equal(
        librarySource.includes(`"${title}"`),
        false,
        `Old synthesized track "${title}" must be removed from source`,
      );
    }

    for (const id of removedIds) {
      assert.equal(
        librarySource.includes(`"${id}"`),
        false,
        `Old synthesized track id "${id}" must be removed from source`,
      );
    }

    assert.equal(librarySource.includes("createOscillator"), false);
    assert.equal(librarySource.includes("AudioContext"), false);
  });

  it("2. Audits all 11 MP3 tracks on disk, ISRC metadata, canonical CC BY 4.0 license & Wikimedia CC BY 3.0 archive fields", async () => {
    assert.deepEqual(
      [...IMAGE_MUSIC_CATEGORIES],
      ["Romantic", "Sad / Emotional", "Motivational", "Lo-Fi", "Happy", "Devotional", "Cinematic"],
    );

    assert.equal(IMAGE_MUSIC_LIBRARY.length, 11);

    for (const category of IMAGE_MUSIC_CATEGORIES) {
      const catTracks = getTracksByCategory(category, IMAGE_MUSIC_LIBRARY);
      assert.ok(
        catTracks.length >= 1,
        `Category "${category}" must have at least 1 verified playable track`,
      );
    }

    for (const track of IMAGE_MUSIC_LIBRARY) {
      assert.equal(hasVerifiedAudioSource(track), true, `Track "${track.title}" must be valid`);
      assert.equal(track.artist, "Kevin MacLeod (incompetech.com)");
      assert.ok(track.isrc.startsWith("USUAN"));
      assert.equal(track.license, "CC BY 4.0");
      assert.equal(track.licenseUrl, CC_BY_4_0_URL);
      assert.equal(
        track.source,
        `https://incompetech.com/music/royalty-free/index.html?isrc=${track.isrc}`,
      );
      assert.ok(track.wikimediaUrl.startsWith("https://commons.wikimedia.org/wiki/File:"));
      assert.equal(track.wikimediaLicense, "CC BY 3.0");
      assert.equal(track.wikimediaLicenseUrl, CC_BY_3_0_URL);
      assert.equal(track.attributionRequired, true);
      assert.ok(track.attributionText.includes(track.title));
      assert.ok(track.attributionText.includes("Creative Commons: By Attribution 4.0"));
      assert.ok(track.durationSec >= 30);
      assert.ok(track.audioUrl.startsWith("/audio/") && track.audioUrl.endsWith(".mp3"));

      const diskPath = path.resolve(process.cwd(), "public", track.audioUrl.replace(/^\//, ""));
      const buf = await fs.readFile(diskPath);
      assert.ok(buf.length > 500_000, `MP3 file for "${track.title}" must be real audio > 500KB`);
      const header = buf.subarray(0, 3).toString("ascii");
      const hasMpegSync = buf[0] === 0xff && ((buf[1] ?? 0) & 0xe0) === 0xe0;
      assert.ok(header === "ID3" || hasMpegSync);
    }
  });

  it("3. Rejects invalid/unlicensed audio and resolves verified tracks cleanly", () => {
    const invalidNoAudio: ImageMusicTrack = {
      id: "bad-1",
      title: "Missing Audio",
      artist: "None",
      category: "Happy",
      audioUrl: "",
      durationSec: 60,
      isrc: "NONE",
      license: "CC BY 4.0",
      licenseUrl: CC_BY_4_0_URL,
      source: "https://example.com",
      wikimediaUrl: "https://commons.wikimedia.org",
      wikimediaLicense: "CC BY 3.0",
      wikimediaLicenseUrl: CC_BY_3_0_URL,
      attributionText: "None",
      attributionRequired: true,
    };

    assert.equal(hasVerifiedAudioSource(invalidNoAudio), false);
    assert.equal(hasVerifiedAudioSource({ ...invalidNoAudio, audioUrl: "/audio/x.html" }), false);
    assert.equal(
      hasVerifiedAudioSource({ ...invalidNoAudio, audioUrl: "/audio/x.mp3", licenseUrl: "" }),
      false,
    );
    assert.equal(resolveMusicTrack({ trackId: "non-existent" }), null);

    const resolved = resolveMusicTrack({ trackId: "km-heartwarming" });
    assert.ok(resolved);
    assert.equal(resolved.audioUrl, "/audio/heartwarming.mp3");

    const normalized = normalizeImageMusic(
      JSON.stringify({ trackId: "km-nu-flute", startTime: 15, volume: 0.5 }),
    );
    assert.ok(normalized);
    assert.equal(normalized.title, "Nu Flute");
    assert.equal(normalized.license, "CC BY 4.0");
    assert.equal(normalized.licenseUrl, CC_BY_4_0_URL);
    assert.equal(normalized.startTime, 15);
    assert.equal(normalized.volume, 0.5);
  });

  it("4. Supports Play/Pause toggle, resume, forceRestart on image switch, volume, ended & cleanup", () => {
    const created: StubAudioElement[] = [];
    const trackA = IMAGE_MUSIC_LIBRARY.find((t) => t.id === "km-heartwarming")!;
    const trackB = IMAGE_MUSIC_LIBRARY.find((t) => t.id === "km-nu-flute")!;

    const stateHistory: Array<{ playingTrackId: string | null; isPlaying: boolean }> = [];
    setMusicPreviewPlaybackListener((s) => {
      stateHistory.push({ playingTrackId: s.playingTrackId, isPlaying: s.isPlaying });
    });

    const createAudio = (url: string) => {
      const el = new StubAudioElement(url);
      created.push(el);
      return el;
    };

    assert.equal(getMusicPreviewState().isPlaying, false);

    // Play track A
    assert.equal(toggleMusicPreview(trackA.id, { startTime: 12, volume: 0.6, createAudio }), true);
    assert.equal(created.length, 1);
    assert.equal(created[0]?.src, "/audio/heartwarming.mp3");
    assert.equal(created[0]?.currentTime, 12);

    // Volume update
    setMusicPreviewVolume(0.35);
    assert.equal(created[0]?.volume, 0.35);

    // Pause track A
    assert.equal(toggleMusicPreview(trackA.id, { createAudio }), false);
    assert.equal(created[0]?.pauseCalls, 1);
    assert.equal(getMusicPreviewState().isPlaying, false);

    // Resume track A without duplicate Audio element
    assert.equal(toggleMusicPreview(trackA.id, { volume: 0.8, createAudio }), true);
    assert.equal(created.length, 1);
    assert.equal(created[0]?.playCalls, 2);

    // Switching images with same track using forceRestart stops previous and restarts cleanly
    assert.equal(
      playMusicPreview(trackA.id, {
        startTime: 20,
        volume: 0.4,
        forceRestart: true,
        createAudio,
      }),
      true,
    );
    assert.equal(created.length, 2);
    assert.equal(created[0]?.src, "");
    assert.equal(created[1]?.currentTime, 20);
    assert.equal(created[1]?.volume, 0.4);

    // Switching to track B stops track A
    assert.equal(playMusicPreview(trackB.id, { createAudio }), true);
    assert.equal(created.length, 3);
    assert.equal(created[1]?.src, "");
    assert.equal(created[2]?.src, "/audio/nu-flute.mp3");

    // Ended event clears playback state
    created[2]?.emit("ended");
    assert.deepEqual(getMusicPreviewState(), {
      playingTrackId: null,
      pausedTrackId: null,
      isPlaying: false,
    });
    assert.equal(stateHistory[stateHistory.length - 1]?.playingTrackId, null);
    assert.equal(pauseMusicPreview(), false);
  });

  it("5. Persists and retrieves selected music metadata via images/create & images/list APIs", async () => {
    const tmpDir = await fs.mkdtemp(path.join("/tmp", "ft-img-music-"));
    const testId = `img-music-test-${Date.now()}`;
    const track = IMAGE_MUSIC_LIBRARY.find((t) => t.id === "km-heartwarming")!;
    const selected = toSelectedImageMusic(track, { startTime: 8, volume: 0.65 });

    const createReq = new Request("http://localhost:3000/api/images/create.php", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: testId,
        userId: "FT102857",
        creatorName: "Test Creator",
        title: "Test Image With Music",
        description: "Testing music persistence",
        imageUrl: "/uploads/images/sample.jpg",
        format: "jpg",
        fileSize: "1.1 MB",
        category: "Coding",
        music: selected,
      }),
    });

    const createRes = await handleApiRequest(createReq, {
      DATA_DIR: tmpDir,
      NODE_ENV: "development",
    });
    assert.ok(createRes);
    assert.equal(createRes.status, 200);
    const createJson = (await createRes.json()) as { success: boolean; image: any };
    assert.equal(createJson.success, true);
    assert.equal(createJson.image.music?.trackId, "km-heartwarming");
    assert.equal(createJson.image.music?.license, "CC BY 4.0");
    assert.equal(createJson.image.music?.startTime, 8);

    const listReq = new Request("http://localhost:3000/api/images/list.php?userId=FT102857", {
      method: "GET",
    });
    const listRes = await handleApiRequest(listReq, {
      DATA_DIR: tmpDir,
      NODE_ENV: "development",
    });
    assert.ok(listRes);
    assert.equal(listRes.status, 200);
    const listJson = (await listRes.json()) as { success: boolean; images: any[] };
    assert.equal(listJson.success, true);
    const saved = listJson.images.find((i) => i.id === testId);
    assert.ok(saved, "Created image must be returned by images/list");
    assert.equal(saved.music?.trackId, "km-heartwarming");
    assert.equal(saved.music?.title, "Heartwarming");
    assert.equal(saved.music?.licenseUrl, CC_BY_4_0_URL);

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("6. Preserves Image Upload, Gallery Play/Pause & exit cleanup, and leaves Video Rotation untouched", async () => {
    const uploadSource = await readProjectFile("src/routes/upload.tsx");
    const gallerySource = await readProjectFile("src/routes/images-uploaded.tsx");
    const playerSource = await readProjectFile("src/components/videohub/FaceTubeVideoPlayer.tsx");
    const schemaSource = await readProjectFile("database/schema.sql");

    // Upload preserves 9:16 crop, filters, and CC BY 4.0 attribution
    assert.ok(uploadSource.includes("cropAndResizeTo9to16"));
    assert.ok(uploadSource.includes("renderFilteredImageToFile"));
    assert.ok(uploadSource.includes("IMAGE_FILTERS"));
    assert.ok(uploadSource.includes("toSelectedImageMusic"));
    assert.ok(uploadSource.includes("CC_BY_4_0_URL"));

    // Gallery renders Play/Pause controls, attribution link, and stops playback on exit/refresh
    assert.ok(gallerySource.includes("handleToggleImageMusic"));
    assert.ok(gallerySource.includes("pauseMusicPreview"));
    assert.ok(gallerySource.includes("stopMusicPreview()"));
    assert.ok(gallerySource.includes("CC_BY_4_0_URL"));
    assert.ok(gallerySource.includes("forceRestart"));

    // Schema includes music_json column on uploaded_images
    assert.ok(schemaSource.includes("`music_json` TEXT DEFAULT NULL"));

    // Video player rotation remains untouched
    assert.ok(playerSource.includes('aria-label="Video rotation controls"'));
    assert.ok(playerSource.includes("RotateCcw"));
    assert.ok(playerSource.includes("RotateCw"));
  });

  it("7. Verifies idempotent 20261121_uploaded_images_music_json.sql migration and Node/PHP SHOW COLUMNS fallback", async () => {
    const migrationPath = "database/migrations/20261121_uploaded_images_music_json.sql";
    const migrationSql = await readProjectFile(migrationPath);

    // Must use INFORMATION_SCHEMA instead of unsupported ADD COLUMN IF NOT EXISTS
    assert.equal(migrationSql.includes("ADD COLUMN IF NOT EXISTS"), false);
    assert.match(migrationSql, /INFORMATION_SCHEMA\.TABLES/i);
    assert.match(migrationSql, /INFORMATION_SCHEMA\.COLUMNS/i);
    assert.match(migrationSql, /TABLE_NAME\s*=\s*'uploaded_images'/i);
    assert.match(migrationSql, /COLUMN_NAME\s*=\s*'music_json'/i);
    assert.match(
      migrationSql,
      /ALTER TABLE `uploaded_images` ADD COLUMN `music_json` TEXT DEFAULT NULL/i,
    );
    assert.match(migrationSql, /PREPARE\s+stmt_add_music_json/i);
    assert.match(migrationSql, /EXECUTE\s+stmt_add_music_json/i);
    assert.match(migrationSql, /DEALLOCATE PREPARE\s+stmt_add_music_json/i);

    // Ensure migration only alters uploaded_images and does not modify or drop unrelated tables
    const alterMatches = migrationSql.match(/ALTER\s+TABLE\s+`?([a-zA-Z0-9_]+)`?/gi) ?? [];
    assert.ok(alterMatches.length >= 1);
    for (const stmt of alterMatches) {
      assert.match(stmt, /ALTER\s+TABLE\s+`?uploaded_images`?/i);
    }
    assert.equal(/\b(DROP|TRUNCATE|DELETE|UPDATE)\b/i.test(migrationSql), false);

    // Node and PHP endpoints must preserve SHOW COLUMNS fallback checks
    const nodeHandlerSource = await readProjectFile("src/server/api-handler.ts");
    const phpCreateSource = await readProjectFile("api/images/create.php");
    const phpListSource = await readProjectFile("api/images/list.php");

    const showColMatches =
      nodeHandlerSource.match(/SHOW COLUMNS FROM uploaded_images LIKE 'music_json'/g) ?? [];
    assert.equal(showColMatches.length, 2);
    assert.ok(phpCreateSource.includes("SHOW COLUMNS FROM uploaded_images LIKE 'music_json'"));
    assert.ok(phpListSource.includes("SHOW COLUMNS FROM uploaded_images LIKE 'music_json'"));
  });

  it("8. MySQL create/list preserve music_json when column exists and gracefully fall back when absent", async () => {
    const tmpDir = await fs.mkdtemp(path.join("/tmp", "ft-img-mysql-"));
    const envKeys = ["DB_HOST", "DB_NAME", "DB_USER", "NODE_ENV", "APP_ENV"] as const;
    const envSnapshot: Record<string, string | undefined> = {};
    for (const k of envKeys) {
      envSnapshot[k] = process.env[k];
    }

    const track = IMAGE_MUSIC_LIBRARY.find((t) => t.id === "km-heartwarming")!;
    const selected = toSelectedImageMusic(track, { startTime: 10, volume: 0.6 });

    try {
      process.env["DB_HOST"] = "127.0.0.1";
      process.env["DB_NAME"] = "facetube_test";
      process.env["DB_USER"] = "test_user";
      process.env["NODE_ENV"] = "development";
      delete process.env["APP_ENV"];

      // Phase A: Migrated database WITH uploaded_images.music_json column
      const migratedQueries: Array<{ sql: string; params: unknown[] | undefined }> = [];
      const migratedRows: Array<Record<string, unknown>> = [];
      setMysqlPoolForTesting({
        async query(sql: string, params?: unknown[]) {
          migratedQueries.push({ sql, params });
          if (sql.includes("SHOW COLUMNS FROM uploaded_images LIKE 'music_json'")) {
            return [[{ Field: "music_json", Type: "text", Null: "YES", Default: null }], []];
          }
          if (sql.startsWith("INSERT INTO uploaded_images")) {
            migratedRows.push({
              id: params?.[0],
              user_id: params?.[1],
              creator_name: params?.[2],
              title: params?.[3],
              description: params?.[4],
              image_url: params?.[5],
              format: params?.[6],
              file_size: params?.[7],
              category: params?.[8],
              music_json: params?.[9],
              views: 0,
              likes: 0,
              created_at: "2026-11-21T19:30:00.000Z",
            });
            return [{ affectedRows: 1 }, []];
          }
          if (sql.includes("FROM uploaded_images")) {
            return [migratedRows, []];
          }
          return [[], []];
        },
      });
      resetInMemoryStore();

      const createWithColRes = await handleApiRequest(
        new Request("http://localhost:3000/api/images/create.php", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: "img-mysql-migrated-1",
            userId: "FT102857",
            creatorName: "Test Creator",
            title: "Migrated DB Image",
            imageUrl: "/uploads/images/migrated.jpg",
            music: selected,
          }),
        }),
        { DATA_DIR: tmpDir, NODE_ENV: "development" },
      );
      assert.ok(createWithColRes);
      assert.equal(createWithColRes.status, 200);
      const insertWithCol = migratedQueries.find((q) =>
        q.sql.includes("INSERT INTO uploaded_images"),
      );
      assert.ok(insertWithCol);
      assert.ok(insertWithCol.sql.includes("music_json"));
      assert.equal(typeof insertWithCol.params?.[9], "string");
      assert.equal(JSON.parse(String(insertWithCol.params?.[9])).trackId, "km-heartwarming");

      const listWithColRes = await handleApiRequest(
        new Request("http://localhost:3000/api/images/list.php?userId=FT102857", { method: "GET" }),
        { DATA_DIR: tmpDir, NODE_ENV: "development" },
      );
      assert.ok(listWithColRes);
      assert.equal(listWithColRes.status, 200);
      const listWithColJson = (await listWithColRes.json()) as { success: boolean; images: any[] };
      assert.equal(listWithColJson.success, true);
      const selectWithCol = migratedQueries.find(
        (q) => q.sql.trimStart().startsWith("SELECT") && q.sql.includes("FROM uploaded_images"),
      );
      assert.ok(selectWithCol?.sql.includes("i.music_json"));
      assert.equal(listWithColJson.images[0]?.music?.trackId, "km-heartwarming");
      assert.equal(listWithColJson.images[0]?.music?.startTime, 10);

      // Phase B: Legacy unmigrated database WITHOUT uploaded_images.music_json column
      const legacyQueries: Array<{ sql: string; params: unknown[] | undefined }> = [];
      const legacyRows: Array<Record<string, unknown>> = [];
      setMysqlPoolForTesting({
        async query(sql: string, params?: unknown[]) {
          legacyQueries.push({ sql, params });
          if (sql.includes("SHOW COLUMNS FROM uploaded_images LIKE 'music_json'")) {
            return [[], []];
          }
          if (sql.includes("music_json")) {
            throw new Error("Unknown column 'music_json' in 'field list'");
          }
          if (sql.startsWith("INSERT INTO uploaded_images")) {
            legacyRows.push({
              id: params?.[0],
              user_id: params?.[1],
              creator_name: params?.[2],
              title: params?.[3],
              description: params?.[4],
              image_url: params?.[5],
              format: params?.[6],
              file_size: params?.[7],
              category: params?.[8],
              views: 0,
              likes: 0,
              created_at: "2026-11-21T19:31:00.000Z",
            });
            return [{ affectedRows: 1 }, []];
          }
          if (sql.includes("FROM uploaded_images")) {
            return [legacyRows, []];
          }
          return [[], []];
        },
      });
      resetInMemoryStore();

      const createNoColRes = await handleApiRequest(
        new Request("http://localhost:3000/api/images/create.php", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: "img-mysql-legacy-1",
            userId: "FT102857",
            creatorName: "Test Creator",
            title: "Unmigrated DB Image",
            imageUrl: "/uploads/images/legacy.jpg",
            music: selected,
          }),
        }),
        { DATA_DIR: tmpDir, NODE_ENV: "development" },
      );
      assert.ok(createNoColRes);
      assert.equal(createNoColRes.status, 200);
      const insertNoCol = legacyQueries.find((q) => q.sql.includes("INSERT INTO uploaded_images"));
      assert.ok(insertNoCol);
      assert.equal(insertNoCol.sql.includes("music_json"), false);

      const listNoColRes = await handleApiRequest(
        new Request("http://localhost:3000/api/images/list.php?userId=FT102857", { method: "GET" }),
        { DATA_DIR: tmpDir, NODE_ENV: "development" },
      );
      assert.ok(listNoColRes);
      assert.equal(listNoColRes.status, 200);
      const listNoColJson = (await listNoColRes.json()) as { success: boolean; images: any[] };
      assert.equal(listNoColJson.success, true);
      const selectNoCol = legacyQueries.find(
        (q) => q.sql.trimStart().startsWith("SELECT") && q.sql.includes("FROM uploaded_images"),
      );
      assert.ok(selectNoCol);
      assert.equal(selectNoCol.sql.includes("music_json"), false);
      assert.equal(listNoColJson.images.length, 1);
      assert.equal(listNoColJson.images[0]?.music ?? null, null);
    } finally {
      setMysqlPoolForTesting(null);
      resetInMemoryStore();
      for (const k of envKeys) {
        if (envSnapshot[k] !== undefined) {
          process.env[k] = envSnapshot[k];
        } else {
          delete process.env[k];
        }
      }
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
