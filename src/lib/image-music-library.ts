/**
 * Licensed Background Music Catalog & HTML5 Audio Preview Controller for FaceTube Image Posts.
 *
 * Synthesized Web Audio ringtone/oscillator generators and placeholder tracks have been removed.
 * All tracks below are verified works by Kevin MacLeod (incompetech.com), audited against both:
 *   1. Incompetech upstream ISRC catalog & live license generator (CC BY 4.0)
 *   2. Wikimedia Commons file records (historical CC BY 3.0 archive)
 * Self-hosted under /public/audio/*.mp3 with full attribution metadata.
 */

export const IMAGE_MUSIC_CATEGORIES = [
  "Romantic",
  "Sad / Emotional",
  "Motivational",
  "Lo-Fi",
  "Happy",
  "Devotional",
  "Cinematic",
] as const;

export type ImageMusicCategory = (typeof IMAGE_MUSIC_CATEGORIES)[number];

export interface ImageMusicTrack {
  id: string;
  title: string;
  artist: string;
  category: ImageMusicCategory;
  audioUrl: string;
  durationSec: number;
  isrc: string;
  license: string;
  licenseUrl: string;
  source: string;
  wikimediaUrl: string;
  wikimediaLicense: string;
  wikimediaLicenseUrl: string;
  attributionText: string;
  attributionRequired: boolean;
}

export interface SelectedImageMusic {
  trackId: string;
  title: string;
  artist: string;
  category?: ImageMusicCategory | undefined;
  license?: string | undefined;
  licenseUrl?: string | undefined;
  source?: string | undefined;
  attributionText?: string | undefined;
  audioUrl?: string | undefined;
  startTime: number; // seconds
  volume: number; // 0 to 1
}

export interface MusicPreviewPlaybackState {
  playingTrackId: string | null;
  pausedTrackId: string | null;
  isPlaying: boolean;
}

export const CC_BY_4_0_URL = "https://creativecommons.org/licenses/by/4.0/";
export const CC_BY_3_0_URL = "https://creativecommons.org/licenses/by/3.0/";

function makeTrack(params: {
  id: string;
  title: string;
  category: ImageMusicCategory;
  audioUrl: string;
  durationSec: number;
  isrc: string;
  wikimediaUrl: string;
}): ImageMusicTrack {
  const artist = "Kevin MacLeod (incompetech.com)";
  return {
    id: params.id,
    title: params.title,
    artist,
    category: params.category,
    audioUrl: params.audioUrl,
    durationSec: params.durationSec,
    isrc: params.isrc,
    license: "CC BY 4.0",
    licenseUrl: CC_BY_4_0_URL,
    source: `https://incompetech.com/music/royalty-free/index.html?isrc=${params.isrc}`,
    wikimediaUrl: params.wikimediaUrl,
    wikimediaLicense: "CC BY 3.0",
    wikimediaLicenseUrl: CC_BY_3_0_URL,
    attributionText: `"${params.title}" ${artist} — Licensed under Creative Commons: By Attribution 4.0 (${CC_BY_4_0_URL})`,
    attributionRequired: true,
  };
}

/**
 * Verified licensed music tracks (Canonical Upstream License: CC BY 4.0;
 * Wikimedia Commons Archive License: CC BY 3.0).
 * Every track grants commercial use, streaming, and distribution rights in FaceTube
 * provided creator attribution is displayed.
 */
export const IMAGE_MUSIC_LIBRARY: ImageMusicTrack[] = [
  makeTrack({
    id: "km-heartwarming",
    title: "Heartwarming",
    category: "Romantic",
    audioUrl: "/audio/heartwarming.mp3",
    durationSec: 72,
    isrc: "USUAN1100207",
    wikimediaUrl: "https://commons.wikimedia.org/wiki/File:Heartwarming_(ISRC_USUAN1100207).mp3",
  }),
  makeTrack({
    id: "km-touching-moments-four",
    title: "Touching Moments Four - Melody",
    category: "Sad / Emotional",
    audioUrl: "/audio/touching-moments-four.mp3",
    durationSec: 109,
    isrc: "USUAN1100040",
    wikimediaUrl:
      "https://commons.wikimedia.org/wiki/File:Touching_Moments_Four_-_Melody_(ISRC_USUAN1100040).mp3",
  }),
  makeTrack({
    id: "km-news-of-sorrow",
    title: "News of Sorrow",
    category: "Sad / Emotional",
    audioUrl: "/audio/news-of-sorrow.mp3",
    durationSec: 53,
    isrc: "USUAN1100447",
    wikimediaUrl: "https://commons.wikimedia.org/wiki/File:News_of_Sorrow_(ISRC_USUAN1100447).mp3",
  }),
  makeTrack({
    id: "km-continue-life",
    title: "Continue Life",
    category: "Motivational",
    audioUrl: "/audio/continue-life.mp3",
    durationSec: 114,
    isrc: "USUAN1100282",
    wikimediaUrl: "https://commons.wikimedia.org/wiki/File:Continue_Life_(ISRC_USUAN1100282).mp3",
  }),
  makeTrack({
    id: "km-lift-motif",
    title: "Lift Motif",
    category: "Motivational",
    audioUrl: "/audio/lift-motif.mp3",
    durationSec: 44,
    isrc: "USUAN1100176",
    wikimediaUrl: "https://commons.wikimedia.org/wiki/File:Lift_Motif_(ISRC_USUAN1100176).mp3",
  }),
  makeTrack({
    id: "km-rollin-at-5",
    title: "Rollin at 5",
    category: "Lo-Fi",
    audioUrl: "/audio/rollin-at-5.mp3",
    durationSec: 131,
    isrc: "USUAN1400029",
    wikimediaUrl: "https://commons.wikimedia.org/wiki/File:Rollin_at_5_(ISRC_USUAN1400029).mp3",
  }),
  makeTrack({
    id: "km-happy-alley",
    title: "Happy Alley",
    category: "Happy",
    audioUrl: "/audio/happy-alley.mp3",
    durationSec: 80,
    isrc: "USUAN1100482",
    wikimediaUrl: "https://commons.wikimedia.org/wiki/File:Happy_Alley_(ISRC_USUAN1100482).mp3",
  }),
  makeTrack({
    id: "km-somewhere-sunny",
    title: "Somewhere Sunny",
    category: "Happy",
    audioUrl: "/audio/somewhere-sunny.mp3",
    durationSec: 59,
    isrc: "USUAN1100493",
    wikimediaUrl: "https://commons.wikimedia.org/wiki/File:Somewhere_Sunny_(ISRC_USUAN1100493).mp3",
  }),
  makeTrack({
    id: "km-nu-flute",
    title: "Nu Flute",
    category: "Devotional",
    audioUrl: "/audio/nu-flute.mp3",
    durationSec: 83,
    isrc: "USUAN1100680",
    wikimediaUrl: "https://commons.wikimedia.org/wiki/File:Nu_Flute_(ISRC_USUAN1100680).mp3",
  }),
  makeTrack({
    id: "km-serene",
    title: "Serene",
    category: "Devotional",
    audioUrl: "/audio/serene.mp3",
    durationSec: 131,
    isrc: "USUAN1100082",
    wikimediaUrl: "https://commons.wikimedia.org/wiki/File:Serene_(ISRC_USUAN1100082).mp3",
  }),
  makeTrack({
    id: "km-exciting-trailer",
    title: "Exciting Trailer",
    category: "Cinematic",
    audioUrl: "/audio/exciting-trailer.mp3",
    durationSec: 75,
    isrc: "USUAN1100494",
    wikimediaUrl:
      "https://commons.wikimedia.org/wiki/File:Exciting_Trailer_(ISRC_USUAN1100494).mp3",
  }),
];

const VALID_AUDIO_EXT_RE = /\.(mp3|ogg|wav|m4a|aac|opus)(\?.*)?$/i;

export function hasVerifiedAudioSource(track: {
  audioUrl?: string | undefined;
  license?: string | undefined;
  licenseUrl?: string | undefined;
  durationSec?: number | undefined;
}): boolean {
  const url = (track.audioUrl || "").trim();
  const license = (track.license || "").trim();
  const licenseUrl = (track.licenseUrl || "").trim();
  const dur = track.durationSec ?? 0;
  if (!url || !license || !licenseUrl || dur <= 0) return false;
  const isAllowedOrigin =
    url.startsWith("/") || url.startsWith("https://") || url.startsWith("http://");
  return isAllowedOrigin && VALID_AUDIO_EXT_RE.test(url);
}

export function resolveMusicTrack(
  music?: Partial<SelectedImageMusic> | null,
  tracks: readonly ImageMusicTrack[] = IMAGE_MUSIC_LIBRARY,
): ImageMusicTrack | null {
  const trackId = typeof music?.trackId === "string" ? music.trackId.trim() : "";
  if (!trackId) {
    return null;
  }
  const found = tracks.find((t) => t.id === trackId);
  if (!found || !hasVerifiedAudioSource(found)) {
    return null;
  }
  return found;
}

export function toSelectedImageMusic(
  track: ImageMusicTrack,
  options?: { startTime?: number | undefined; volume?: number | undefined },
): SelectedImageMusic {
  return {
    trackId: track.id,
    title: track.title,
    artist: track.artist,
    category: track.category,
    license: track.license,
    licenseUrl: track.licenseUrl,
    source: track.source,
    attributionText: track.attributionText,
    audioUrl: track.audioUrl,
    startTime: options?.startTime ?? 0,
    volume: options?.volume ?? 0.7,
  };
}

export function formatMusicAttribution(music: {
  title: string;
  artist?: string | undefined;
  license?: string | undefined;
}): string {
  const artist = music.artist || "Kevin MacLeod (incompetech.com)";
  const license = music.license || "CC BY 4.0";
  return `"${music.title}" · ${artist} · ${license}`;
}

export function getTracksByCategory(
  category: ImageMusicCategory | "All",
  tracks: readonly ImageMusicTrack[] = IMAGE_MUSIC_LIBRARY,
): ImageMusicTrack[] {
  const verified = tracks.filter(hasVerifiedAudioSource);
  if (category === "All") return verified;
  return verified.filter((t) => t.category === category);
}

export type AudioElementLike = {
  src: string;
  volume: number;
  currentTime: number;
  paused: boolean;
  preload: string;
  play: () => Promise<void> | void;
  pause: () => void;
  addEventListener: (event: string, listener: () => void) => void;
  removeEventListener: (event: string, listener: () => void) => void;
};

type PlaybackListener = (state: MusicPreviewPlaybackState) => void;

let activeAudio: AudioElementLike | null = null;
let activeTrackId: string | null = null;
let pausedTrackId: string | null = null;
let detachListeners: (() => void) | null = null;
let playbackListener: PlaybackListener | null = null;

function notifyPlaybackState() {
  if (playbackListener) {
    playbackListener(getMusicPreviewState());
  }
}

export function getMusicPreviewState(): MusicPreviewPlaybackState {
  return {
    playingTrackId: activeTrackId,
    pausedTrackId,
    isPlaying: activeTrackId !== null,
  };
}

export function setMusicPreviewPlaybackListener(listener: PlaybackListener | null) {
  playbackListener = listener;
}

export function stopMusicPreview(): void {
  if (detachListeners) {
    detachListeners();
    detachListeners = null;
  }
  if (activeAudio) {
    try {
      activeAudio.pause();
      activeAudio.src = "";
    } catch {
      // ignore cleanup error
    }
    activeAudio = null;
  }
  const changed = activeTrackId !== null || pausedTrackId !== null;
  activeTrackId = null;
  pausedTrackId = null;
  if (changed) {
    notifyPlaybackState();
  }
}

export function pauseMusicPreview(): boolean {
  if (!activeAudio || !activeTrackId) return false;
  try {
    activeAudio.pause();
  } catch {
    // ignore pause error
  }
  pausedTrackId = activeTrackId;
  activeTrackId = null;
  notifyPlaybackState();
  return true;
}

export function setMusicPreviewVolume(volume: number): void {
  if (activeAudio) {
    activeAudio.volume = Math.max(0, Math.min(1, volume));
  }
}

export interface PlayMusicPreviewOptions {
  startTime?: number | undefined;
  volume?: number | undefined;
  forceRestart?: boolean | undefined;
  tracks?: readonly ImageMusicTrack[] | undefined;
  createAudio?: ((url: string) => AudioElementLike) | undefined;
}

function clampStartTime(startTime: number | undefined, durationSec: number): number {
  if (typeof startTime !== "number" || Number.isNaN(startTime) || startTime < 0) {
    return 0;
  }
  return Math.min(startTime, Math.max(0, durationSec - 1));
}

export function playMusicPreview(trackId: string, options?: PlayMusicPreviewOptions): boolean {
  const catalog = options?.tracks ?? IMAGE_MUSIC_LIBRARY;
  const track = catalog.find((t) => t.id === trackId);
  if (!track || !hasVerifiedAudioSource(track)) {
    return false;
  }

  const volume = Math.max(0, Math.min(1, options?.volume ?? 0.7));

  // Resume the exact same paused track without creating duplicate Audio instances
  if (!options?.forceRestart && activeAudio && pausedTrackId === trackId) {
    activeAudio.volume = volume;
    if (typeof options?.startTime === "number") {
      try {
        activeAudio.currentTime = clampStartTime(options.startTime, track.durationSec);
      } catch {
        // ignore seek error before metadata load
      }
    }
    activeTrackId = trackId;
    pausedTrackId = null;
    try {
      const playPromise = activeAudio.play();
      if (playPromise && typeof (playPromise as Promise<void>).catch === "function") {
        (playPromise as Promise<void>).catch(() => {
          stopMusicPreview();
        });
      }
    } catch {
      stopMusicPreview();
      return false;
    }
    notifyPlaybackState();
    return true;
  }

  // Always stop any other active track before starting a new one (prevents duplicate playback)
  stopMusicPreview();

  const createAudio =
    options?.createAudio ??
    (typeof window !== "undefined" && typeof window.Audio === "function"
      ? (url: string) => new window.Audio(url) as unknown as AudioElementLike
      : null);

  if (!createAudio) {
    return false;
  }

  try {
    const audio = createAudio(track.audioUrl);
    audio.preload = "metadata";
    audio.volume = volume;

    const desiredStart = clampStartTime(options?.startTime, track.durationSec);
    if (desiredStart > 0) {
      try {
        audio.currentTime = desiredStart;
      } catch {
        // seek on loadedmetadata below if stream isn't ready yet
      }
    }

    const handleLoadedMetadata = () => {
      if (desiredStart > 0 && audio.currentTime === 0) {
        try {
          audio.currentTime = desiredStart;
        } catch {
          // ignore
        }
      }
    };

    const handleEnded = () => {
      if (activeAudio === audio) {
        stopMusicPreview();
      }
    };

    const handleError = () => {
      if (activeAudio === audio) {
        stopMusicPreview();
      }
    };

    audio.addEventListener("loadedmetadata", handleLoadedMetadata);
    audio.addEventListener("ended", handleEnded);
    audio.addEventListener("error", handleError);

    detachListeners = () => {
      audio.removeEventListener("loadedmetadata", handleLoadedMetadata);
      audio.removeEventListener("ended", handleEnded);
      audio.removeEventListener("error", handleError);
    };

    activeAudio = audio;
    activeTrackId = trackId;
    pausedTrackId = null;

    const playPromise = audio.play();
    if (playPromise && typeof (playPromise as Promise<void>).catch === "function") {
      (playPromise as Promise<void>).catch(() => {
        if (activeAudio === audio) {
          stopMusicPreview();
        }
      });
    }

    notifyPlaybackState();
    return true;
  } catch {
    stopMusicPreview();
    return false;
  }
}

export function toggleMusicPreview(trackId: string, options?: PlayMusicPreviewOptions): boolean {
  if (!options?.forceRestart && activeTrackId === trackId) {
    pauseMusicPreview();
    return false;
  }
  return playMusicPreview(trackId, options);
}
