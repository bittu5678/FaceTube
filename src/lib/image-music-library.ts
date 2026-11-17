/**
 * Royalty-free / CC0 synthesized Web Audio music library for FaceTube Image Posts.
 * Zero copyrighted external audio files; works offline and respects browser gesture rules.
 */

export interface ImageMusicTrack {
  id: string;
  title: string;
  artist: string;
  genre: string;
  license: string;
  durationSec: number;
  bpm: number;
  notes: number[]; // Frequencies in Hz for Web Audio synth loop
  waveform: "sine" | "triangle";
}

export interface SelectedImageMusic {
  trackId: string;
  title: string;
  artist: string;
  startTime: number; // seconds
  volume: number; // 0 to 1
}

export const IMAGE_MUSIC_LIBRARY: ImageMusicTrack[] = [
  {
    id: "ft-lofi-horizon",
    title: "Lo-Fi Horizon",
    artist: "FaceTube Studio",
    genre: "Chill / Lo-Fi",
    license: "CC0 Royalty-Free (Synthesized)",
    durationSec: 30,
    bpm: 82,
    notes: [261.63, 329.63, 392.0, 493.88, 392.0, 329.63],
    waveform: "sine",
  },
  {
    id: "ft-golden-hour",
    title: "Golden Hour",
    artist: "FaceTube Studio",
    genre: "Ambient",
    license: "CC0 Royalty-Free (Synthesized)",
    durationSec: 30,
    bpm: 90,
    notes: [293.66, 369.99, 440.0, 554.37, 440.0, 369.99],
    waveform: "triangle",
  },
  {
    id: "ft-urban-pulse",
    title: "Urban Pulse",
    artist: "FaceTube Studio",
    genre: "Upbeat",
    license: "CC0 Royalty-Free (Synthesized)",
    durationSec: 30,
    bpm: 112,
    notes: [329.63, 392.0, 493.88, 587.33, 493.88, 392.0],
    waveform: "triangle",
  },
  {
    id: "ft-midnight-chill",
    title: "Midnight Chill",
    artist: "FaceTube Studio",
    genre: "Deep Chill",
    license: "CC0 Royalty-Free (Synthesized)",
    durationSec: 30,
    bpm: 76,
    notes: [220.0, 261.63, 329.63, 392.0, 329.63, 261.63],
    waveform: "sine",
  },
  {
    id: "ft-creator-spark",
    title: "Creator Spark",
    artist: "FaceTube Studio",
    genre: "Inspiring",
    license: "CC0 Royalty-Free (Synthesized)",
    durationSec: 30,
    bpm: 100,
    notes: [349.23, 440.0, 523.25, 659.25, 523.25, 440.0],
    waveform: "sine",
  },
];

let activeCtx: AudioContext | null = null;
let activeTimer: ReturnType<typeof setInterval> | null = null;
let activeGain: GainNode | null = null;

export function stopMusicPreview() {
  if (activeTimer) {
    clearInterval(activeTimer);
    activeTimer = null;
  }
  if (activeCtx) {
    try {
      activeCtx.close();
    } catch {
      // ignore
    }
    activeCtx = null;
    activeGain = null;
  }
}

export function setMusicPreviewVolume(volume: number) {
  if (activeGain && activeCtx) {
    activeGain.gain.setValueAtTime(Math.max(0, Math.min(1, volume)) * 0.22, activeCtx.currentTime);
  }
}

export function playMusicPreview(
  trackId: string,
  options?: { startTime?: number; volume?: number },
): boolean {
  if (typeof window === "undefined") return false;
  const track = IMAGE_MUSIC_LIBRARY.find((t) => t.id === trackId);
  if (!track) return false;

  stopMusicPreview();

  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) return false;

  try {
    const ctx = new AudioCtx();
    const gain = ctx.createGain();
    const vol = Math.max(0, Math.min(1, options?.volume ?? 0.7)) * 0.22;
    gain.gain.setValueAtTime(vol, ctx.currentTime);
    gain.connect(ctx.destination);

    activeCtx = ctx;
    activeGain = gain;

    const beatMs = Math.round((60 / track.bpm) * 1000);
    let step = Math.floor((options?.startTime ?? 0) % track.notes.length);

    const playNote = () => {
      if (!activeCtx || !activeGain) return;
      const osc = activeCtx.createOscillator();
      const noteGain = activeCtx.createGain();
      osc.type = track.waveform;
      osc.frequency.setValueAtTime(
        track.notes[step % track.notes.length] ?? 261.63,
        activeCtx.currentTime,
      );
      noteGain.gain.setValueAtTime(0.001, activeCtx.currentTime);
      noteGain.gain.exponentialRampToValueAtTime(1, activeCtx.currentTime + 0.04);
      noteGain.gain.exponentialRampToValueAtTime(0.001, activeCtx.currentTime + beatMs / 1000);
      osc.connect(noteGain);
      noteGain.connect(activeGain);
      osc.start();
      osc.stop(activeCtx.currentTime + beatMs / 1000);
      step += 1;
    };

    playNote();
    activeTimer = setInterval(playNote, beatMs);
    return true;
  } catch {
    return false;
  }
}
