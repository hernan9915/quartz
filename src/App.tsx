import {
  useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, useDeferredValue,
  useSyncExternalStore, useTransition, memo, lazy, Suspense,
} from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen, emit } from "@tauri-apps/api/event";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { QUEUE } from "./data";
import type { Album, QueueTrack, Device, AlbumStyle } from "./data";
import "./App.css";

// Types + defaults live alongside the component so the type imports are
// cheap (TS-only) and the heavy JSX implementation is lazy-loaded below.
import type { EqSettings } from "./eqTypes";
import { DEFAULT_EQ } from "./eqTypes";

// React.lazy → the EqPanel JS chunk only downloads/parses when the user
// first opens the EQ overlay. Trims the cold-start parse cost on weak CPUs.
const EqPanel = lazy(() => import("./EqPanel"));

// ── Asset URL memo ──────────────────────────────────────────────────
// `convertFileSrc` allocates a fresh URL string every call (Tauri's
// helper concatenates the asset.localhost prefix). In a virtualized
// grid that re-renders cards as the user scrolls, we'd otherwise pay
// that string alloc per cover per scroll tick. Memoising freezes the
// URL identity, which also keeps `<img src>` stable so React doesn't
// tear down and recreate the underlying DOM image element on re-render.
//
// Bounded so we don't leak memory on huge libraries — Map preserves
// insertion order so we can evict the oldest entry when the cap is hit.
const FILE_SRC_CACHE_MAX = 4096;
const fileSrcCache = new Map<string, string>();
function fileSrc(path: string): string {
  let url = fileSrcCache.get(path);
  if (url === undefined) {
    url = convertFileSrc(path);
    if (fileSrcCache.size >= FILE_SRC_CACHE_MAX) {
      const firstKey = fileSrcCache.keys().next().value;
      if (firstKey !== undefined) fileSrcCache.delete(firstKey);
    }
    fileSrcCache.set(path, url);
  }
  return url;
}

// ── Playback state shared store ─────────────────────────────────────
// Single, app-wide listener for the audio engine's "playback-state"
// event. Previously NowPlayingBar, FullscreenPlayer, MiniPlayer, and
// App.tsx each registered their own `listen("playback-state")` —
// every emit therefore paid the IPC JSON-deserialize cost 4× per
// 250 ms (1 cold + 3 redundant). With a single listener fanning out
// to subscribers via `useSyncExternalStore`, the parse happens once.
interface TrackInfo {
  path: string;
  duration: number;
  sample_rate: number;
  channels: number;
  bits_per_sample: number;
  codec: string;
}

interface PbState {
  playing: boolean;
  position: number;
  duration: number;
  exclusive: boolean;
  track: TrackInfo | null;
}

const PB_DEFAULT: PbState = {
  playing: false, position: 0, duration: 0, exclusive: false, track: null,
};
let pbSnapshot: PbState = PB_DEFAULT;
const pbSubscribers = new Set<() => void>();
let pbListenerInited = false;
function ensurePbListener() {
  if (pbListenerInited) return;
  pbListenerInited = true;
  // Fire-and-forget: the unlisten is never needed for the lifetime of
  // the app (the store lives as long as the renderer process does).
  void listen<PbState>("playback-state", (e) => {
    pbSnapshot = e.payload;
    pbSubscribers.forEach((fn) => fn());
  });
}
function subscribePb(fn: () => void): () => void {
  ensurePbListener();
  pbSubscribers.add(fn);
  return () => { pbSubscribers.delete(fn); };
}
function getPbSnapshot(): PbState { return pbSnapshot; }
// Hook: any component that re-renders on playback-state updates.
// getServerSnapshot is required for SSR-safety (we don't SSR, but React
// 18 demands a third argument) — same value works.
function usePbState(): PbState {
  return useSyncExternalStore(subscribePb, getPbSnapshot, getPbSnapshot);
}

// ── Smooth scrub-bar position interpolator ──────────────────────────
// Position events arrive at ~4 Hz. A bar driven directly off them
// steps visibly every 250 ms. This hook interpolates locally via
// requestAnimationFrame between event arrivals: each event resets the
// anchor (position + wall-clock timestamp), and the hook advances the
// returned position by `(now − anchorTime) / 1000` while playing. Net
// result: a 60 fps visual without raising the event rate.
function useInterpolatedPosition(): { position: number; duration: number } {
  const pb = usePbState();
  const anchorPosRef = useRef(pb.position);
  const anchorTimeRef = useRef(performance.now());
  const playingRef = useRef(pb.playing);
  // Snap anchors whenever the upstream snapshot changes meaningfully.
  // We deliberately do not snap on every render — only on the change
  // of position/playing/duration to avoid drift during a steady stream
  // of identical micro-updates.
  useEffect(() => {
    anchorPosRef.current = pb.position;
    anchorTimeRef.current = performance.now();
    playingRef.current = pb.playing;
  }, [pb.position, pb.duration, pb.playing]);

  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!pb.playing) return;
    let raf = 0;
    const loop = () => {
      // setTick forces a re-render at frame rate. Cheap (single integer).
      setTick((t) => (t + 1) & 0xffff);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [pb.playing]);
  // Suppress the unused-tick lint without disabling exhaustive-deps —
  // the dependency is implicit through React's re-render on setTick.
  void tick;

  let position = anchorPosRef.current;
  if (playingRef.current) {
    const elapsed = (performance.now() - anchorTimeRef.current) / 1000;
    position = Math.min(pb.duration || Infinity, anchorPosRef.current + elapsed);
  }
  return { position, duration: pb.duration };
}

// ── Library types (mirror Rust LibraryAlbum / LibraryTrack) ─────────
interface LibraryAlbum {
  id: number;
  title: string;
  artist: string;
  year: number | null;
  genre: string | null;
  track_count: number;
  sample_rate: number | null;
  bits_per_sample: number | null;
  cover_path: string | null;
  /// Vibrant accent extracted from cover_path, `#rrggbb`. Lazily computed
  /// on first play. null = not extracted yet, fall back to chosen accent.
  accent_color: string | null;
}

interface LibraryTrack {
  id: number;
  album_id: number;
  track_no: number | null;
  disc_no: number | null;
  title: string;
  artist: string;
  duration: number | null;
  path: string;
  sample_rate: number | null;
  bits_per_sample: number | null;
}

interface LibraryArtist {
  name: string;
  album_count: number;
  track_count: number;
  cover_paths: string[];
  image_path: string | null;
}

interface ArtistFetchProgress {
  processed: number;
  total: number;
  current_artist: string;
  found: number;
}

interface AlbumCoverProgress {
  processed: number;
  total: number;
  current_album: string;
  found: number;
}

// Phase 25: listening stats wire format. Mirrors ListeningStats / DayCount /
// ArtistStat / AlbumStat in db.rs — serde keeps the field naming identical.
interface DayCount { day_epoch: number; count: number }
interface ArtistStat { name: string; play_count: number }
interface AlbumStat {
  id: number;
  title: string;
  artist: string;
  cover_path: string | null;
  play_count: number;
}
interface ListeningStats {
  total_plays: number;
  total_seconds: number;
  plays_last_7d: number;
  plays_last_30d: number;
  unique_tracks: number;
  unique_artists: number;
  plays_per_day: DayCount[];
  by_hour: number[];
  by_weekday: number[];
  top_artists: ArtistStat[];
  top_albums: AlbumStat[];
}

interface DbPlaylist {
  id: number;
  name: string;
  description: string | null;
  kind: number; // 0=manual, 1=smart
  rules_json: string | null;
  track_count: number;
  created_at: number;
  updated_at: number;
}

interface AiPlaylistResult {
  name: string;
  track_ids: number[];
}

interface ScanProgress {
  scanned: number;
  total: number;
  current_path: string;
}

interface RgProgress {
  done: number;
  total: number;
  scanned: number;
}

interface ReplayGainConfig {
  enabled: boolean;
  target_lufs: number;
}

interface CrossfadeConfig {
  enabled: boolean;
  durationSecs: number;
}

// Convert a library album into the UI's Album shape (procedural cover styling).
const STYLES: AlbumStyle[] = ["ecm", "bluenote", "cartouche", "minimal", "impulsiv"];
const PALETTES: [string, string, string][] = [
  ["#1c2024", "#7a8a92", "#c8c0a8"],
  ["#c44a2a", "#0a0a0a", "#f5e6c8"],
  ["#e8d57a", "#1a1611", "#5a4220"],
  ["#0e1014", "#c9a96e", "#c9a96e"],
  ["#e8a020", "#1a0e0a", "#000000"],
];

// Quality classification used by the corner badges. Returns null for
// anything below CD quality (or unknown).
type QualityBadge = { label: string; tone: "accent" | "muted" };
function qualityBadge(a: Album): QualityBadge | null {
  if (a.format === "DSD") return { label: "DSD", tone: "accent" };
  if (a.bit >= 24 && a.rate >= 44.1) return { label: "HI-RES", tone: "accent" };
  if (a.bit === 16 && a.rate === 44.1) return { label: "CD", tone: "muted" };
  return null;
}

function shuffled<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Persisted-state hook backed by localStorage. Tauri's WebView keeps this
// in the app's user-data folder, so values survive app restarts.
//
// `debounceMs` defers the actual localStorage.setItem write by N ms after the
// most recent change. Critical for large blobs like the queue (which can hold
// 30k+ tracks ≈ 3 MB JSON) — without it, every queue mutation runs a synchronous
// stringify on the main thread, jank-bombing the UI on low-end hardware. The
// React state itself still updates immediately so the UI feels instant; only
// the disk write is delayed. We flush pending writes on tab-hide and unload
// so nothing is lost.
function usePersistedState<T>(
  key: string,
  initial: T,
  debounceMs: number = 0,
): [T, (v: T | ((prev: T) => T)) => void] {
  const storageKey = `quartz:${key}`;
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw === null) return initial;
      return JSON.parse(raw) as T;
    } catch {
      return initial;
    }
  });

  const pendingRef = useRef<T | null>(null);
  const hasPendingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Flush any pending write — used by unmount, visibilitychange, beforeunload.
  // Stored in a ref so listeners don't capture stale closures.
  const flushRef = useRef<() => void>(() => {});
  flushRef.current = () => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    if (hasPendingRef.current) {
      try { localStorage.setItem(storageKey, JSON.stringify(pendingRef.current)); }
      catch { /* quota or disabled */ }
      hasPendingRef.current = false;
      pendingRef.current = null;
    }
  };

  useEffect(() => {
    const onHide = () => { if (document.hidden) flushRef.current(); };
    const onUnload = () => flushRef.current();
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("beforeunload", onUnload);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("beforeunload", onUnload);
      flushRef.current();
    };
  }, []);

  // useCallback makes the returned setter identity-stable across renders so
  // React.memo children don't break.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const update = useCallback((v: T | ((prev: T) => T)) => {
    setValue((prev) => {
      const next = typeof v === "function" ? (v as (p: T) => T)(prev) : v;
      if (debounceMs <= 0) {
        // Immediate write — same as the original behaviour.
        try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* quota */ }
      } else {
        // Defer the write. The pending value is the LATEST one — if more
        // changes arrive before the timer fires, we just overwrite it.
        pendingRef.current = next;
        hasPendingRef.current = true;
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
          if (hasPendingRef.current) {
            try { localStorage.setItem(storageKey, JSON.stringify(pendingRef.current)); }
            catch { /* quota */ }
            hasPendingRef.current = false;
            pendingRef.current = null;
          }
          timerRef.current = null;
        }, debounceMs);
      }
      return next;
    });
  }, [storageKey, debounceMs]);
  return [value, update];
}

function libraryToAlbum(la: LibraryAlbum): Album {
  // Hash id to deterministic style/palette so a given album always looks the same.
  const h = Math.abs(la.id);
  const style = STYLES[h % STYLES.length];
  const palette = PALETTES[h % PALETTES.length];
  const isHiRes = (la.bits_per_sample ?? 16) >= 24 && (la.sample_rate ?? 0) >= 88200;
  return {
    id: `lib-${la.id}`,
    title: la.title,
    artist: la.artist,
    year: la.year ?? 0,
    genre: la.genre ?? "",
    format: "FLAC",
    bit: la.bits_per_sample ?? 16,
    rate: la.sample_rate ? la.sample_rate / 1000 : 44.1,
    label: isHiRes ? "Hi-Res" : "",
    style,
    palette,
    coverUrl: la.cover_path ? fileSrc(la.cover_path) : undefined,
  };
}

// ── Color helpers ───────────────────────────────────────────────────
function hexToRgba(hex: string, a: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

function mix(a: string, b: string, t: number): string {
  const pa = [0, 2, 4].map((i) => parseInt(a.replace("#", "").slice(i, i + 2), 16));
  const pb = [0, 2, 4].map((i) => parseInt(b.replace("#", "").slice(i, i + 2), 16));
  const m = pa.map((v, i) => Math.round(v * (1 - t) + pb[i] * t));
  return "#" + m.map((x) => x.toString(16).padStart(2, "0")).join("");
}

// ── Window controls ─────────────────────────────────────────────────
async function handleWinCtrl(action: "min" | "max" | "close") {
  try {
    const win = getCurrentWindow();
    if (action === "min") await win.minimize();
    else if (action === "max") await win.toggleMaximize();
    else await win.close();
  } catch {
    // no-op in browser preview
  }
}

// ── Cover ───────────────────────────────────────────────────────────
interface CoverProps {
  album: Album;
  size?: number | string;
}

const Cover = memo(function Cover({ album, size = 180 }: CoverProps) {
  const [c0, c1, c2] = album.palette;
  const px = size;

  // Prefer embedded artwork if the library scanner extracted one.
  if (album.coverUrl) {
    return (
      <img
        src={album.coverUrl}
        alt={album.title}
        width={typeof px === "number" ? px : undefined}
        height={typeof px === "number" ? px : undefined}
        // loading="lazy" defers decode until the image is near the viewport —
        // huge win on low-end hardware where decoding 100+ JPEGs at once would
        // saturate the main thread. decoding="async" decodes off-thread.
        loading="lazy"
        decoding="async"
        style={{
          display: "block",
          width: typeof px === "string" ? px : undefined,
          height: typeof px === "string" ? px : undefined,
          aspectRatio: "1 / 1",
          objectFit: "cover",
          borderRadius: 2,
          background: c1,
        }}
        onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
      />
    );
  }

  if (album.style === "ecm") {
    return (
      <svg viewBox="0 0 200 200" width={px} height={px} style={{ display: "block", borderRadius: 2 }}>
        <defs>
          <linearGradient id={`g-${album.id}`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor={c1} />
            <stop offset="1" stopColor={c0} />
          </linearGradient>
          <radialGradient id={`r-${album.id}`} cx="0.3" cy="0.25" r="0.9">
            <stop offset="0" stopColor={c2} stopOpacity="0.35" />
            <stop offset="1" stopColor={c0} stopOpacity="0" />
          </radialGradient>
        </defs>
        <rect width="200" height="200" fill={`url(#g-${album.id})`} />
        <rect width="200" height="200" fill={`url(#r-${album.id})`} />
        <line x1="14" y1="160" x2="60" y2="160" stroke={c2} strokeOpacity="0.65" strokeWidth="0.6" />
        <text x="14" y="174" fill={c2} fillOpacity="0.85"
          style={{ font: "500 7px Geist, sans-serif", letterSpacing: "0.18em", textTransform: "uppercase" }}>
          {album.artist.slice(0, 22)}
        </text>
        <text x="14" y="186" fill={c2} fillOpacity="0.6"
          style={{ font: "italic 8px Lora, serif" }}>
          {album.title.slice(0, 26)}
        </text>
      </svg>
    );
  }

  if (album.style === "bluenote") {
    return (
      <svg viewBox="0 0 200 200" width={px} height={px} style={{ display: "block", borderRadius: 2 }}>
        <rect width="200" height="200" fill={c1} />
        <rect x="0" y="0" width="200" height="120" fill={c0} />
        <circle cx="148" cy="58" r="34" fill={c1} fillOpacity="0.4" />
        <text x="14" y="148" fill={c2}
          style={{ font: "600 22px Lora, serif", fontStyle: "italic" }}>
          {album.title.length > 16 ? album.title.slice(0, 14) + "…" : album.title}
        </text>
        <text x="14" y="170" fill={c2} fillOpacity="0.75"
          style={{ font: "500 8px Geist, sans-serif", letterSpacing: "0.22em", textTransform: "uppercase" }}>
          {album.artist}
        </text>
        <text x="14" y="188" fill={c2} fillOpacity="0.45"
          style={{ font: "400 7px JetBrains Mono, monospace", letterSpacing: "0.2em" }}>
          CN — {album.year}
        </text>
      </svg>
    );
  }

  if (album.style === "cartouche") {
    return (
      <svg viewBox="0 0 200 200" width={px} height={px} style={{ display: "block", borderRadius: 2 }}>
        <rect width="200" height="200" fill={c1} />
        <rect x="0" y="0" width="200" height="18" fill={c0} />
        <text x="100" y="13" textAnchor="middle" fill={c1}
          style={{ font: "700 8px Geist, sans-serif", letterSpacing: "0.38em" }}>
          HELIKON
        </text>
        <rect x="10" y="28" width="180" height="120" fill={c2} fillOpacity="0.08" />
        <line x1="10" y1="148" x2="190" y2="148" stroke={c0} strokeWidth="0.5" />
        <text x="10" y="166" fill={c0}
          style={{ font: "500 11px Lora, serif", fontStyle: "italic" }}>
          {album.title.length > 28 ? album.title.slice(0, 26) + "…" : album.title}
        </text>
        <text x="10" y="180" fill={c2} fillOpacity="0.8"
          style={{ font: "400 8px Geist, sans-serif" }}>
          {album.artist}
        </text>
        <text x="10" y="192" fill={c2} fillOpacity="0.45"
          style={{ font: "400 6.5px JetBrains Mono, monospace", letterSpacing: "0.18em", textTransform: "uppercase" }}>
          {album.sub ?? ""}
        </text>
      </svg>
    );
  }

  if (album.style === "minimal") {
    return (
      <svg viewBox="0 0 200 200" width={px} height={px} style={{ display: "block", borderRadius: 2 }}>
        <rect width="200" height="200" fill={c0} />
        <line x1="20" y1="100" x2="60" y2="100" stroke={c1} strokeWidth="0.8" />
        <text x="20" y="118" fill={c1}
          style={{ font: "500 9px Lora, serif", fontStyle: "italic" }}>
          {album.title.length > 24 ? album.title.slice(0, 22) + "…" : album.title}
        </text>
        <text x="20" y="132" fill={c1} fillOpacity="0.55"
          style={{ font: "400 7px Geist, sans-serif", letterSpacing: "0.2em", textTransform: "uppercase" }}>
          {album.artist}
        </text>
        <text x="20" y="180" fill={c1} fillOpacity="0.35"
          style={{ font: "400 6px JetBrains Mono, monospace", letterSpacing: "0.18em" }}>
          ASTRALIS · {album.year}
        </text>
      </svg>
    );
  }

  if (album.style === "impulsiv") {
    return (
      <svg viewBox="0 0 200 200" width={px} height={px} style={{ display: "block", borderRadius: 2 }}>
        <rect width="200" height="200" fill={c1} />
        <path d="M0 0 L200 0 L200 140 L0 90 Z" fill={c0} />
        <text x="14" y="34" fill={c1}
          style={{ font: "600 16px Lora, serif", fontStyle: "italic" }}>
          {album.title.length > 18 ? album.title.slice(0, 16) + "…" : album.title}
        </text>
        <text x="14" y="50" fill={c1} fillOpacity="0.8"
          style={{ font: "500 8px Geist, sans-serif", letterSpacing: "0.22em", textTransform: "uppercase" }}>
          {album.artist}
        </text>
        <text x="14" y="180" fill={c0}
          style={{ font: "500 8px JetBrains Mono, monospace", letterSpacing: "0.28em" }}>
          IMPULSIV ! {album.year}
        </text>
      </svg>
    );
  }

  return <div style={{ width: px, height: px, background: c0 }} />;
});

// Crossfade wrapper for <Cover>. When album.id changes, renders both the
// previous and new cover stacked and fades between them over ~320 ms.
// Used in the NowPlayingBar + full-screen player + mini player where a
// snap-cut between albums feels jarring; static contexts (album grid)
// continue using <Cover> directly. The two-image stack is mounted only
// during the transition — once the fade finishes, the previous img is
// dropped from the tree to keep idle render cost identical to plain Cover.
function CrossfadeCover({ album, size = 60 }: CoverProps) {
  const [current, setCurrent] = useState<Album>(album);
  const [prev, setPrev] = useState<Album | null>(null);
  useEffect(() => {
    if (album.id !== current.id) {
      setPrev(current);
      setCurrent(album);
    }
  }, [album, current]);
  return (
    <div style={{ position: "relative", width: size, height: size }}>
      {prev && (
        <div
          className="q-cover-fadeout"
          style={{ position: "absolute", inset: 0 }}
          onAnimationEnd={() => setPrev(null)}
        >
          <Cover album={prev} size={size} />
        </div>
      )}
      <div className="q-cover-fadein" key={current.id}>
        <Cover album={current} size={size} />
      </div>
    </div>
  );
}

// ── Logo marks ──────────────────────────────────────────────────────
type LogoKind = "prism" | "cluster" | "facet" | "monogram" | "wave" | "tuning";

interface LogoMarkProps {
  kind: LogoKind;
  size?: number;
}

function LogoMark({ kind, size = 14 }: LogoMarkProps) {
  const c = "var(--accent)";

  if (kind === "prism") {
    return (
      <svg width={size} height={size + 2} viewBox="0 0 20 22">
        <path d="M10 1 L17 6 L17 16 L10 21 L3 16 L3 6 Z" fill="none" stroke={c} strokeWidth="1.1" strokeLinejoin="round" />
        <path d="M10 1 L10 21 M3 6 L17 6 M3 16 L17 16" stroke={c} strokeOpacity="0.32" strokeWidth="0.7" />
        <path d="M10 1 L13 11 L10 21 L7 11 Z" fill={c} fillOpacity="0.18" stroke="none" />
      </svg>
    );
  }
  if (kind === "cluster") {
    return (
      <svg width={size + 2} height={size + 2} viewBox="0 0 22 22">
        <path d="M7 2 L11 7 L7 20 L3 7 Z" fill="none" stroke={c} strokeWidth="1" strokeLinejoin="round" />
        <path d="M14 4 L18 9 L14 20 L10 9 Z" fill={c} fillOpacity="0.14" stroke={c} strokeWidth="1" strokeLinejoin="round" />
      </svg>
    );
  }
  if (kind === "facet") {
    return (
      <svg width={size + 2} height={size} viewBox="0 0 22 20">
        <path d="M4 7 L11 1 L18 7 L11 19 Z" fill="none" stroke={c} strokeWidth="1.1" strokeLinejoin="round" />
        <path d="M4 7 L18 7 M7 7 L11 1 L15 7 M7 7 L11 19 M15 7 L11 19" stroke={c} strokeOpacity="0.4" strokeWidth="0.7" />
      </svg>
    );
  }
  if (kind === "monogram") {
    return (
      <svg width={size + 2} height={size + 2} viewBox="0 0 22 22">
        <circle cx="10" cy="11" r="7.5" fill="none" stroke={c} strokeWidth="1.2" />
        <line x1="13.5" y1="14.5" x2="18.5" y2="19.5" stroke={c} strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    );
  }
  if (kind === "wave") {
    return (
      <svg width={size + 2} height={size + 2} viewBox="0 0 22 22">
        <circle cx="11" cy="11" r="9" fill="none" stroke={c} strokeWidth="1" strokeOpacity="0.55" />
        <path d="M3 11 Q 6 5, 9 11 T 15 11 T 21 11" fill="none" stroke={c} strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    );
  }
  if (kind === "tuning") {
    return (
      <svg width={size} height={size + 2} viewBox="0 0 18 22">
        <path d="M5 2 L5 11 A 4 4 0 0 0 13 11 L13 2" fill="none" stroke={c} strokeWidth="1.2" strokeLinejoin="round" />
        <line x1="9" y1="13" x2="9" y2="20" stroke={c} strokeWidth="1.2" strokeLinecap="round" />
        <line x1="6" y1="20" x2="12" y2="20" stroke={c} strokeWidth="1.2" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24">
      <path d="M12 2 L20 8 L17 20 L7 20 L4 8 Z" fill="none" stroke={c} strokeWidth="1.2" />
    </svg>
  );
}

// ── Title bar ───────────────────────────────────────────────────────
function TitleBar({ logo, onOpenSettings, settingsActive, albumCount, artistCount, trackCount }: {
  logo: LogoKind;
  onOpenSettings?: () => void;
  settingsActive?: boolean;
  albumCount: number;
  artistCount: number;
  trackCount: number;
}) {
  return (
    <div
      data-tauri-drag-region
      style={{
        height: 36,
        display: "grid",
        gridTemplateColumns: "240px 1fr auto",
        alignItems: "center",
        borderBottom: "1px solid var(--line)",
        background: "linear-gradient(to bottom, rgba(255,255,255,0.025), transparent)",
        userSelect: "none",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, paddingLeft: 18 }}>
        <LogoMark kind={logo} size={14} />
        <span style={{ fontFamily: "var(--serif)", fontStyle: "italic", fontSize: 15, letterSpacing: "0.04em", color: "var(--text)" }}>
          Quartz
        </span>
        <span className="mono" style={{ fontSize: 9, color: "var(--text-faint)", letterSpacing: "0.18em", marginLeft: 4 }}>
          v{__APP_VERSION__}
        </span>
      </div>

      <div style={{ display: "flex", justifyContent: "center", alignItems: "center" }}>
        <span className="micro">
          Library
          {" · "}{albumCount.toLocaleString()} {albumCount === 1 ? "album" : "albums"}
          {" · "}{artistCount.toLocaleString()} {artistCount === 1 ? "artist" : "artists"}
          {" · "}{trackCount.toLocaleString()} {trackCount === 1 ? "track" : "tracks"}
        </span>
      </div>

      <div data-tauri-drag-region="false" style={{ display: "flex", height: 36 }}>
        <button
          data-tauri-drag-region="false"
          onClick={onOpenSettings}
          title="Settings"
          style={{
            width: 46, height: 36, background: "transparent", border: 0,
            color: settingsActive ? "var(--accent)" : "var(--text-dim)", cursor: "pointer",
            display: "grid", placeItems: "center",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.05)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        >
          <svg width="12" height="12" viewBox="0 0 14 14">
            <circle cx="7" cy="7" r="3" stroke="currentColor" fill="none" strokeWidth="1" />
            <circle cx="7" cy="7" r="6" stroke="currentColor" fill="none" strokeWidth="1" strokeDasharray="2 2" />
          </svg>
        </button>
        {(["min", "max", "close"] as const).map((k) => (
          <button
            key={k}
            data-tauri-drag-region="false"
            onClick={() => handleWinCtrl(k)}
            style={{
              width: 46, height: 36, background: "transparent", border: 0,
              color: "var(--text-dim)", cursor: "pointer",
              display: "grid", placeItems: "center",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = k === "close" ? "#c44a2a" : "rgba(255,255,255,0.05)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            {k === "min" && <svg width="10" height="10" viewBox="0 0 10 10"><line x1="1" y1="5" x2="9" y2="5" stroke="currentColor" strokeWidth="1" /></svg>}
            {k === "max" && <svg width="10" height="10" viewBox="0 0 10 10"><rect x="1.5" y="1.5" width="7" height="7" stroke="currentColor" fill="none" strokeWidth="1" /></svg>}
            {k === "close" && <svg width="10" height="10" viewBox="0 0 10 10"><line x1="1.5" y1="1.5" x2="8.5" y2="8.5" stroke="currentColor" strokeWidth="1" /><line x1="8.5" y1="1.5" x2="1.5" y2="8.5" stroke="currentColor" strokeWidth="1" /></svg>}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Sidebar ─────────────────────────────────────────────────────────
interface SidebarProps {
  section: string;
  setSection: (s: string) => void;
  albumCount?: number;
  artistCount?: number;
  trackCount?: number;
  query: string;
  onQueryChange: (q: string) => void;
  searchInputRef?: React.Ref<HTMLInputElement>;
  recentAlbums: Album[];
  onOpenAlbum: (a: Album) => void;
  favoriteCount: number;
  playlists: DbPlaylist[];
  selectedPlaylistId: number | null;
  onSelectPlaylist: (id: number) => void;
  onNewPlaylist: () => void;
  onAiPlaylist: () => void;
  hasAiKey: boolean;
}

const Sidebar = memo(function Sidebar({ section, setSection, albumCount, artistCount, trackCount, favoriteCount, query, onQueryChange, searchInputRef, recentAlbums, onOpenAlbum, playlists, selectedPlaylistId, onSelectPlaylist, onNewPlaylist, onAiPlaylist, hasAiKey }: SidebarProps) {
  const ac = albumCount ?? 0;
  const arc = artistCount ?? 0;
  const items = [
    { key: "albums", label: "Albums", count: ac.toLocaleString() },
    { key: "artists", label: "Artists", count: arc.toLocaleString() },
    { key: "tracks", label: "Tracks", count: trackCount?.toLocaleString() ?? "—" },
    { key: "favorites", label: "Favorites", count: favoriteCount > 0 ? favoriteCount.toLocaleString() : "" },
  ];
  // Phase 18: built-in dynamic views. Count is omitted because the lists
  // are computed lazily on-click — we don't precompute four extra queries
  // on every library refresh.
  const smartItems = [
    { key: "smart-added", label: "Recently Added" },
    { key: "smart-played", label: "Recently Played" },
    { key: "smart-most", label: "Most Played" },
    { key: "smart-never", label: "Never Played" },
  ];

  return (
    <div style={{
      width: 240, borderRight: "1px solid var(--line)", background: "var(--bg)",
      display: "flex", flexDirection: "column", overflow: "hidden",
    }}>
      {/* search */}
      <div style={{ padding: "16px 18px 12px", borderBottom: "1px solid var(--line)" }}>
        <label style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "7px 10px", background: "var(--panel)",
          border: "1px solid var(--line-strong)", borderRadius: 4,
        }}>
          <svg width="11" height="11" viewBox="0 0 14 14" style={{ flexShrink: 0 }}>
            <circle cx="6" cy="6" r="4.5" fill="none" stroke="var(--text-faint)" strokeWidth="1" />
            <line x1="9.5" y1="9.5" x2="13" y2="13" stroke="var(--text-faint)" strokeWidth="1" />
          </svg>
          <input
            ref={searchInputRef}
            type="text"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Search library…"
            style={{
              flex: 1, minWidth: 0,
              background: "transparent", border: 0, outline: "none",
              fontSize: 12, color: "var(--text)",
              fontStyle: query ? "normal" : "italic",
              fontFamily: "var(--serif)",
            }}
          />
          {query && (
            <button
              onClick={() => onQueryChange("")}
              style={{
                background: "transparent", border: 0, padding: 0, cursor: "pointer",
                color: "var(--text-faint)", display: "grid", placeItems: "center",
              }}
              title="Clear"
            >
              <svg width="10" height="10" viewBox="0 0 10 10">
                <line x1="1" y1="1" x2="9" y2="9" stroke="currentColor" strokeWidth="1" />
                <line x1="9" y1="1" x2="1" y2="9" stroke="currentColor" strokeWidth="1" />
              </svg>
            </button>
          )}
        </label>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "14px 0" }}>
        {/* Library section */}
        <div style={{ padding: "0 18px 6px" }}>
          <div className="micro-strong">Library</div>
        </div>
        <div style={{ padding: "4px 8px 14px", display: "flex", flexDirection: "column", gap: 1 }}>
          {items.map((it) => {
            const active = it.key === section;
            return (
              <button key={it.key} onClick={() => setSection(it.key)} style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                padding: "6px 10px",
                background: active ? "var(--accent-soft)" : "transparent",
                border: 0,
                borderLeft: active ? "2px solid var(--accent)" : "2px solid transparent",
                color: active ? "var(--text)" : "var(--text-dim)",
                fontSize: 13, fontFamily: "var(--sans)", cursor: "pointer",
                textAlign: "left", borderRadius: 0,
                marginLeft: active ? 0 : 2,
              }}>
                <span style={{ fontWeight: active ? 500 : 400 }}>{it.label}</span>
                <span className="mono" style={{ fontSize: 10, color: "var(--text-faint)" }}>{it.count}</span>
              </button>
            );
          })}
        </div>

        {/* Phase 18: Smart views (Recently Added / Played, Most / Never Played) */}
        <div style={{ padding: "0 18px 6px" }}>
          <div className="micro-strong">Smart</div>
        </div>
        <div style={{ padding: "4px 8px 14px", display: "flex", flexDirection: "column", gap: 1 }}>
          {smartItems.map((it) => {
            const active = it.key === section;
            return (
              <button key={it.key} onClick={() => setSection(it.key)} style={{
                display: "flex", alignItems: "center",
                padding: "6px 10px",
                background: active ? "var(--accent-soft)" : "transparent",
                border: 0,
                borderLeft: active ? "2px solid var(--accent)" : "2px solid transparent",
                color: active ? "var(--text)" : "var(--text-dim)",
                fontSize: 13, fontFamily: "var(--sans)", cursor: "pointer",
                textAlign: "left", borderRadius: 0,
                marginLeft: active ? 0 : 2,
              }}>
                <span style={{ fontWeight: active ? 500 : 400 }}>{it.label}</span>
              </button>
            );
          })}
        </div>

        {/* Playlists section. AI button is hidden until the user pastes an
            Anthropic key in Settings — there's no point dangling a button
            that always errors. Import lives in Settings now (under
            "Library") so the sidebar stays focused on browse + filter. */}
        <div style={{ padding: "8px 18px 6px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div className="micro-strong">Playlists</div>
          <div style={{ display: "flex", gap: 4 }}>
            {hasAiKey && (
              <button
                onClick={onAiPlaylist}
                title="Create AI playlist"
                style={{
                  background: "transparent", border: "1px solid var(--line-strong)",
                  borderRadius: 3, padding: "2px 6px",
                  color: "var(--accent)", cursor: "pointer",
                  fontSize: 9, fontFamily: "var(--sans)", letterSpacing: "0.1em",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--accent)")}
                onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--line-strong)")}
              >AI</button>
            )}
            <button
              onClick={onNewPlaylist}
              title="New playlist"
              style={{
                background: "transparent", border: "1px solid var(--line-strong)",
                borderRadius: 3, padding: "2px 6px",
                color: "var(--text-dim)", cursor: "pointer",
                fontSize: 13, lineHeight: 1, display: "grid", placeItems: "center",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text)")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-dim)")}
            >+</button>
          </div>
        </div>
        <div style={{ padding: "4px 8px 14px", display: "flex", flexDirection: "column", gap: 1 }}>
          {playlists.length === 0 && (
            <div style={{ padding: "4px 10px", fontSize: 11.5, color: "var(--text-faint)", fontStyle: "italic", fontFamily: "var(--serif)" }}>
              No playlists yet
            </div>
          )}
          {playlists.map((p) => {
            const active = p.id === selectedPlaylistId;
            return (
              <button key={p.id} onClick={() => onSelectPlaylist(p.id)} style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                padding: "6px 10px",
                background: active ? "var(--accent-soft)" : "transparent",
                border: 0,
                borderLeft: active ? "2px solid var(--accent)" : "2px solid transparent",
                color: active ? "var(--text)" : "var(--text-dim)",
                fontSize: 13, fontFamily: "var(--sans)", cursor: "pointer",
                textAlign: "left", borderRadius: 0,
                marginLeft: active ? 0 : 2,
              }}>
                <span style={{ fontStyle: "italic", fontFamily: "var(--serif)", fontSize: 13.5, fontWeight: active ? 500 : 400 }}>{p.name}</span>
                <span className="mono" style={{ fontSize: 10, color: "var(--text-faint)" }}>{p.track_count > 0 ? p.track_count : ""}</span>
              </button>
            );
          })}
        </div>

        {/* Recently Played */}
        {recentAlbums.length > 0 && (
          <>
            <div style={{ padding: "8px 18px 6px" }}>
              <div className="micro-strong">Recently Played</div>
            </div>
            <div style={{ padding: "4px 8px 14px", display: "flex", flexDirection: "column", gap: 2 }}>
              {recentAlbums.slice(0, 10).map((a) => (
                <button
                  key={a.id}
                  onClick={() => onOpenAlbum(a)}
                  style={{
                    display: "grid", gridTemplateColumns: "32px 1fr",
                    gap: 10, alignItems: "center",
                    padding: "5px 10px",
                    background: "transparent", border: 0,
                    cursor: "pointer", textAlign: "left",
                    borderRadius: 3,
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "var(--panel)")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                >
                  <div style={{ width: 32, height: 32, overflow: "hidden", borderRadius: 2, flexShrink: 0 }}>
                    <Cover album={a} size={32} />
                  </div>
                  <div style={{ minWidth: 0, overflow: "hidden" }}>
                    <div style={{
                      fontFamily: "var(--serif)", fontStyle: "italic", fontSize: 12.5,
                      color: "var(--text)",
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    }}>{a.title}</div>
                    <div style={{
                      fontSize: 10.5, color: "var(--text-faint)",
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                      marginTop: 1,
                    }}>{a.artist}</div>
                  </div>
                </button>
              ))}
            </div>
          </>
        )}

      </div>

      {/* Footer */}
      <div style={{
        padding: "10px 18px", borderTop: "1px solid var(--line)",
        display: "flex", justifyContent: "flex-end", alignItems: "center",
      }}>
        <div style={{ display: "flex", gap: 4 }}>
          <div style={{ width: 22, height: 3, background: "var(--accent)", opacity: 0.9, borderRadius: 1 }} />
          <div style={{ width: 2, height: 3, background: "var(--line-strong)", borderRadius: 1 }} />
        </div>
      </div>
    </div>
  );
});

function DeviceCard({ device: d, isCurrent, onClick }: {
  device: Device;
  isCurrent: boolean;
  onClick: () => void;
}) {
  return (
    <div
      onClick={onClick}
      style={{
        padding: "8px 10px",
        background: isCurrent ? "var(--panel)" : "transparent",
        border: isCurrent ? "1px solid var(--accent)" : "1px solid transparent",
        borderRadius: 4, marginBottom: 4, cursor: "pointer",
        transition: "background 120ms, border-color 120ms",
      }}
      onMouseEnter={(e) => { if (!isCurrent) e.currentTarget.style.background = "var(--bg-elev)"; }}
      onMouseLeave={(e) => { if (!isCurrent) e.currentTarget.style.background = "transparent"; }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {isCurrent ? (
          <div style={{
            width: 6, height: 6, borderRadius: "50%",
            background: "var(--bit-perfect)",
            animation: "pulse-bit 2.4s ease-in-out infinite",
          }} />
        ) : (
          <div style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--text-faint)", opacity: 0.4 }} />
        )}
        <span style={{ fontSize: 12, color: isCurrent ? "var(--text)" : "var(--text-dim)", fontWeight: isCurrent ? 500 : 400 }}>
          {d.name}
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4, paddingLeft: 12 }}>
        <span className="mono" style={{ fontSize: 9.5, color: "var(--text-faint)", letterSpacing: "0.12em" }}>
          {d.driver}
        </span>
        {d.exclusive && isCurrent && (
          <span style={{
            fontSize: 9, color: "var(--accent)", letterSpacing: "0.18em", marginRight: "-0.18em",
            fontFamily: "var(--mono)", padding: "1px 5px",
            border: "1px solid var(--accent)", borderRadius: 2,
          }}>EXCLUSIVE</span>
        )}
      </div>
      {isCurrent && d.formats && (
        <div className="mono" style={{ fontSize: 9, color: "var(--text-faint)", marginTop: 4, paddingLeft: 12 }}>
          {d.formats}
        </div>
      )}
    </div>
  );
}

// ── Browse header ───────────────────────────────────────────────────
type Sort = "recent" | "artist" | "year" | "random";

// Deterministic Fisher-Yates shuffle, seeded by a number so the order is
// stable across re-renders (otherwise the album grid would reshuffle every
// time the user types in the search box). LCG params from Numerical Recipes.
function seededShuffle<T>(arr: T[], seed: number): T[] {
  let s = seed >>> 0;
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

interface BrowseHeaderProps {
  sort: Sort;
  setSort: (s: Sort) => void;
  albumCount?: number;
  viewMode: "grid" | "list";
  setViewMode: (m: "grid" | "list") => void;
}

function BrowseHeader({ sort, setSort, albumCount = 0, viewMode, setViewMode }: BrowseHeaderProps) {
  const sortLabels: Record<Sort, string> = { recent: "recently added", artist: "artist", year: "year", random: "random" };
  const nextSort: Record<Sort, Sort> = { recent: "artist", artist: "year", year: "random", random: "recent" };

  return (
    <div style={{
      padding: "20px 32px 14px", borderBottom: "1px solid var(--line)",
      display: "flex", alignItems: "flex-end", justifyContent: "space-between",
    }}>
      <div>
        <div className="micro" style={{ marginBottom: 8 }}>Library</div>
        <h1 style={{
          margin: 0, fontFamily: "var(--serif)", fontStyle: "italic", fontWeight: 400,
          fontSize: 38, letterSpacing: "-0.01em", color: "var(--text)", lineHeight: 1,
        }}>Albums</h1>
        <div style={{ marginTop: 6, color: "var(--text-dim)", fontSize: 12.5 }}>
          <span className="mono" style={{ color: "var(--text-dim)" }}>{albumCount.toLocaleString()}</span>
          <span style={{ margin: "0 8px", color: "var(--text-faint)" }}>·</span>
          <span style={{ fontStyle: "italic", fontFamily: "var(--serif)" }}>sorted by</span>
          <button onClick={() => setSort(nextSort[sort])} style={{
            background: "transparent", border: 0, color: "var(--accent)",
            fontFamily: "var(--serif)", fontStyle: "italic", fontSize: 12.5,
            cursor: "pointer", padding: "0 4px",
          }}>
            {sortLabels[sort]}
          </button>
        </div>
      </div>

      {/* View toggle */}
      <div style={{
        display: "flex", border: "1px solid var(--line-strong)",
        borderRadius: 3, overflow: "hidden",
      }}>
        {(["grid", "list"] as const).map((v) => (
          <button key={v} onClick={() => setViewMode(v)} style={{
            background: v === viewMode ? "var(--panel-2)" : "transparent",
            border: 0, padding: "6px 10px",
            color: v === viewMode ? "var(--text)" : "var(--text-faint)",
            cursor: "pointer",
          }}>
            {v === "grid"
              ? <svg width="11" height="11" viewBox="0 0 12 12"><rect x="1" y="1" width="4" height="4" fill="currentColor" /><rect x="7" y="1" width="4" height="4" fill="currentColor" /><rect x="1" y="7" width="4" height="4" fill="currentColor" /><rect x="7" y="7" width="4" height="4" fill="currentColor" /></svg>
              : <svg width="11" height="11" viewBox="0 0 12 12"><line x1="1" y1="3" x2="11" y2="3" stroke="currentColor" /><line x1="1" y1="6" x2="11" y2="6" stroke="currentColor" /><line x1="1" y1="9" x2="11" y2="9" stroke="currentColor" /></svg>
            }
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Album grid ──────────────────────────────────────────────────────
interface AlbumGridProps {
  albums: Album[];
  currentId: string;
  onPlay: (a: Album) => void;
  onQuickPlay?: (a: Album) => void;
  // When true (default), the grid owns scroll and virtualizes rows. When
  // false, renders a plain CSS grid that flows in the parent's scroll —
  // for use inside ArtistDetail or PlaylistDetail where the parent already
  // scrolls and the album count is small enough to skip virtualization.
  virtualized?: boolean;
}

// Single card — memoized so the entire grid doesn't re-render every time
// the parent App re-renders (which happens on currentId / queue / playlist
// changes). With memo, only the previous-current and new-current cards
// re-render when the now-playing track changes.
interface AlbumCardProps {
  album: Album;
  isCurrent: boolean;
  onPlay: (a: Album) => void;
  onQuickPlay?: (a: Album) => void;
}
const AlbumCard = memo(function AlbumCard({ album, isCurrent, onPlay, onQuickPlay }: AlbumCardProps) {
  const q = qualityBadge(album);
  return (
    <div className="q-card" onClick={() => onPlay(album)}>
      <div className="q-card-cover">
        <Cover album={album} size="100%" />

        {/* Hover overlay — CSS :hover, no React state, no JS handlers */}
        <div className="q-card-overlay">
          <button
            onClick={(e) => { e.stopPropagation(); onQuickPlay?.(album); }}
            style={{
              width: 32, height: 32, borderRadius: "50%", background: "var(--accent)",
              display: "grid", placeItems: "center",
              border: 0, padding: 0, cursor: "pointer",
            }}
            title="Play album"
          >
            <svg width="10" height="10" viewBox="0 0 10 10">
              <path d="M2 1 L9 5 L2 9 Z" fill="var(--bg)" />
            </svg>
          </button>
          {album.format === "DSD" && (
            <span style={{
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              padding: "2px 6px", border: "1px solid rgba(255,255,255,0.5)",
              borderRadius: 2, lineHeight: 1,
            }}>
              <span className="mono" style={{ fontSize: 9, color: "#fff", lineHeight: 1 }}>DSD</span>
            </span>
          )}
          {album.bit >= 24 && album.rate >= 44.1 && album.format !== "DSD" && (
            <span style={{
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              padding: "2px 6px", border: "1px solid rgba(255,255,255,0.5)",
              borderRadius: 2, lineHeight: 1,
            }}>
              <span className="mono" style={{ fontSize: 9, color: "#fff", lineHeight: 1 }}>
                {album.bit}/{album.rate}
              </span>
            </span>
          )}
        </div>

        {/* Quality chip — solid background (no backdrop blur) */}
        {q && (
          <div className="q-chip" style={{ position: "absolute", top: 8, right: 8 }}>
            <span className="mono" style={{
              fontSize: 8.5,
              color: q.tone === "accent" ? "var(--accent)" : "var(--text-dim)",
              lineHeight: 1, fontWeight: 500,
            }}>{q.label}</span>
          </div>
        )}

        {/* NOW badge */}
        {isCurrent && (
          <div className="q-chip" style={{ position: "absolute", top: 8, left: 8, gap: 4 }}>
            <SpectrumMini bars={3} />
            <span className="mono" style={{
              fontSize: 8.5, color: "var(--accent)",
              letterSpacing: "0.18em", marginRight: "-0.18em",
            }}>NOW</span>
          </div>
        )}
      </div>

      <div style={{ marginTop: 12, padding: "0 2px" }}>
        <div style={{
          fontFamily: "var(--serif)", fontStyle: "italic", fontSize: 14,
          color: "var(--text)", lineHeight: 1.25,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>{album.title}</div>
        <div style={{
          fontSize: 11.5, color: "var(--text-dim)", marginTop: 3,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>{album.artist}</div>
        <div className="mono" style={{ fontSize: 9, color: "var(--text-faint)", letterSpacing: "0.14em", marginTop: 5 }}>
          {album.year} · {album.format} {album.format === "DSD" ? `${Math.floor(album.rate / 1000)}` : `${album.bit}/${album.rate}`}
        </div>
      </div>
    </div>
  );
});

// Virtualized responsive grid. The DOM only holds the rows visible in the
// viewport (plus a small overscan). With 30k tracks / thousands of albums
// this is the difference between a smooth 60 fps scroll and a 5 fps
// freeze on low-end hardware. Items per row are computed from the actual
// container width so the layout still adapts to window resizes.
function AlbumGrid({ albums, currentId, onPlay, onQuickPlay, virtualized = true }: AlbumGridProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewHeight, setViewHeight] = useState(800);
  const [viewWidth, setViewWidth] = useState(1000);

  // Track container size and scroll position. We use a ResizeObserver so
  // we react cleanly to window resizes (the grid is responsive).
  useEffect(() => {
    if (!virtualized) return;
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setViewHeight(el.clientHeight);
      setViewWidth(el.clientWidth);
    });
    ro.observe(el);
    setViewHeight(el.clientHeight);
    setViewWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [virtualized]);

  // Non-virtualized fallback — used inside ArtistDetail / PlaylistDetail
  // where the parent already scrolls and album counts are small (≤100).
  if (!virtualized) {
    return (
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(168px, 1fr))",
        gap: "28px 22px",
      }}>
        {albums.map((a) => (
          <AlbumCard
            key={a.id}
            album={a}
            isCurrent={a.id === currentId}
            onPlay={onPlay}
            onQuickPlay={onQuickPlay}
          />
        ))}
      </div>
    );
  }

  // Layout maths — must match the CSS values: 32px side padding, 22px col
  // gap, 28px row gap, 168px min item width, item height = cover (square,
  // == column width) + 12px top margin + ~48px title/artist/meta block.
  const PAD_X = 32, PAD_Y_TOP = 24, PAD_Y_BOTTOM = 32;
  const COL_GAP = 22, ROW_GAP = 28, MIN_ITEM = 168;
  const TEXT_BLOCK = 60; // title + artist + meta + spacing

  const innerW = Math.max(0, viewWidth - PAD_X * 2);
  const itemsPerRow = Math.max(1, Math.floor((innerW + COL_GAP) / (MIN_ITEM + COL_GAP)));
  const itemW = (innerW - COL_GAP * (itemsPerRow - 1)) / itemsPerRow;
  const itemH = itemW + TEXT_BLOCK;        // cover (== itemW) + text block
  const rowH = itemH + ROW_GAP;
  const totalRows = Math.ceil(albums.length / itemsPerRow);
  const totalHeight = PAD_Y_TOP + totalRows * rowH - ROW_GAP + PAD_Y_BOTTOM;

  // Overscan a couple of rows above and below so quick scrolls don't show
  // blanks. Cheap because each row is at most `itemsPerRow` cards.
  const OVERSCAN = 2;
  const firstRow = Math.max(0, Math.floor((scrollTop - PAD_Y_TOP) / rowH) - OVERSCAN);
  const lastRow = Math.min(totalRows, Math.ceil((scrollTop - PAD_Y_TOP + viewHeight) / rowH) + OVERSCAN);
  const startIdx = firstRow * itemsPerRow;
  const endIdx = Math.min(albums.length, lastRow * itemsPerRow);

  return (
    <div
      ref={containerRef}
      className="q-grid-virt"
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
    >
      <div style={{ height: totalHeight, position: "relative" }}>
        {(() => {
          const out: React.ReactNode[] = [];
          for (let i = startIdx; i < endIdx; i++) {
            const a = albums[i];
            if (!a) continue;
            const row = Math.floor(i / itemsPerRow);
            const col = i % itemsPerRow;
            const x = PAD_X + col * (itemW + COL_GAP);
            const y = PAD_Y_TOP + row * rowH;
            out.push(
              <div
                key={a.id}
                style={{
                  position: "absolute",
                  left: x, top: y, width: itemW, height: itemH,
                }}
              >
                <AlbumCard
                  album={a}
                  isCurrent={a.id === currentId}
                  onPlay={onPlay}
                  onQuickPlay={onQuickPlay}
                />
              </div>
            );
          }
          return out;
        })()}
      </div>
    </div>
  );
}

// ── Album list (table view) ─────────────────────────────────────────
type AlbumSortKey = "title" | "artist" | "year" | "format" | "tracks";

function AlbumList({ albums, currentId, onPlay }: AlbumGridProps) {
  const [sortKey, setSortKey] = useState<AlbumSortKey>("artist");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const collator = useMemo(
    () => new Intl.Collator(undefined, { sensitivity: "base", numeric: true }),
    [],
  );

  const sorted = useMemo(() => {
    const xs = albums.slice();
    const dir = sortDir === "asc" ? 1 : -1;
    // Approximate "format quality" rank so sorting by format actually
    // groups DSD > Hi-Res > CD > other.
    const rankFmt = (a: Album) => {
      if (a.format === "DSD") return 3;
      if (a.bit >= 24 && a.rate >= 44.1) return 2;
      if (a.bit === 16 && a.rate === 44.1) return 1;
      return 0;
    };
    xs.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "title":  cmp = collator.compare(a.title, b.title); break;
        case "artist": cmp = collator.compare(a.artist, b.artist); break;
        case "year":   cmp = (a.year ?? 0) - (b.year ?? 0); break;
        case "format": cmp = rankFmt(a) - rankFmt(b); break;
        case "tracks": cmp = 0; break; // track_count not on UI Album shape; placeholder
      }
      return cmp * dir;
    });
    return xs;
  }, [albums, sortKey, sortDir, collator]);

  const handleSortClick = (k: AlbumSortKey) => {
    if (sortKey === k) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(k);
      setSortDir("asc");
    }
  };

  return (
    <div style={{ overflowY: "auto", padding: "0 32px 32px" }}>
      <div style={{
        display: "grid",
        gridTemplateColumns: "48px 1fr 1fr 70px 110px",
        gap: 16, padding: "8px 12px 8px",
        borderBottom: "1px solid var(--line)",
        position: "sticky", top: 0, background: "var(--bg)",
        zIndex: 1,
      }}>
        <span></span>
        <SortHeader label="Title"  k="title"  sortKey={sortKey} sortDir={sortDir} onClick={handleSortClick} />
        <SortHeader label="Artist" k="artist" sortKey={sortKey} sortDir={sortDir} onClick={handleSortClick} />
        <SortHeader label="Year"   k="year"   sortKey={sortKey} sortDir={sortDir} onClick={handleSortClick} align="right" />
        <SortHeader label="Format" k="format" sortKey={sortKey} sortDir={sortDir} onClick={handleSortClick} align="right" />
      </div>
      {sorted.map((a) => {
        const isCurrent = a.id === currentId;
        const q = qualityBadge(a);
        const fmtStr = a.format === "DSD" ? "DSD" : `${a.bit}/${a.rate}`;
        return (
          <div
            key={a.id}
            onClick={() => onPlay(a)}
            style={{
              display: "grid",
              gridTemplateColumns: "48px 1fr 1fr 70px 110px",
              gap: 16, padding: "10px 12px",
              alignItems: "center",
              cursor: "pointer",
              borderRadius: 3,
              background: isCurrent ? "var(--accent-soft)" : "transparent",
            }}
            onMouseEnter={(e) => { if (!isCurrent) e.currentTarget.style.background = "var(--panel)"; }}
            onMouseLeave={(e) => { if (!isCurrent) e.currentTarget.style.background = "transparent"; }}
          >
            <div style={{ width: 40, height: 40, overflow: "hidden", borderRadius: 2, flexShrink: 0 }}>
              <Cover album={a} size={40} />
            </div>
            <span style={{
              fontFamily: "var(--serif)", fontStyle: "italic", fontSize: 14,
              color: isCurrent ? "var(--accent)" : "var(--text)",
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}>{a.title}</span>
            <span style={{ fontSize: 12, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {a.artist}
            </span>
            <span className="mono" style={{ fontSize: 11, color: "var(--text-faint)", textAlign: "right" }}>
              {a.year || ""}
            </span>
            <span className="mono" style={{
              fontSize: 10, textAlign: "right",
              color: q?.tone === "accent" ? "var(--accent)" : q?.tone === "muted" ? "var(--text-dim)" : "var(--text-faint)",
              letterSpacing: "0.12em",
            }}>{fmtStr}</span>
          </div>
        );
      })}
    </div>
  );
}

// ── Sortable column header (used by track list + album list) ────────
function SortHeader<K extends string>({
  label, k, sortKey, sortDir, onClick, align,
}: {
  label: string;
  k: K;
  sortKey: K;
  sortDir: SortDir;
  onClick: (k: K) => void;
  align?: "right";
}) {
  const active = sortKey === k;
  return (
    <button
      onClick={() => onClick(k)}
      style={{
        background: "transparent", border: 0, padding: 0, cursor: "pointer",
        display: "flex", alignItems: "center",
        justifyContent: align === "right" ? "flex-end" : "flex-start",
        gap: 4,
        color: active ? "var(--accent)" : "var(--text-dim)",
        fontFamily: "var(--sans)", fontSize: 10,
        letterSpacing: "0.18em", textTransform: "uppercase",
        fontWeight: 500,
      }}
      onMouseEnter={(e) => { if (!active) e.currentTarget.style.color = "var(--text)"; }}
      onMouseLeave={(e) => { if (!active) e.currentTarget.style.color = "var(--text-dim)"; }}
    >
      <span>{label}</span>
      {active && (
        <svg width="8" height="6" viewBox="0 0 8 6" style={{
          transform: sortDir === "desc" ? "rotate(180deg)" : "none",
          transition: "transform 120ms",
        }}>
          <path d="M0 5 L4 1 L8 5" stroke="currentColor" fill="none" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </button>
  );
}

// ── Column-resize affordance: wraps a SortHeader and adds a draggable
//    handle on the right edge that the user can grab to resize the column.
function ResizableHeaderCell({ children, onResize }: {
  children: React.ReactNode;
  onResize: (e: React.MouseEvent) => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <div style={{ position: "relative", minWidth: 0 }}>
      {children}
      <div
        onMouseDown={onResize}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          position: "absolute", top: -8, bottom: -8, right: -10,
          width: 12, cursor: "col-resize",
          // Subtle vertical guide on hover so user knows the grab target.
          background: hover
            ? "linear-gradient(to right, transparent 5px, var(--accent) 5px, var(--accent) 7px, transparent 7px)"
            : "transparent",
          opacity: hover ? 0.6 : 0,
          transition: "opacity 120ms",
          zIndex: 2,
        }}
      />
    </div>
  );
}

// ── Virtualized track list ──────────────────────────────────────────
type TrackSortKey = "track_no" | "title" | "artist" | "album" | "duration";
type SortDir = "asc" | "desc";

// Persisted column widths (px). The track# and duration columns stay fixed —
// they're narrow numeric fields nobody resizes. Title / artist / album are
// drag-resizable via handles on their right edges.
interface TrackColWidths {
  trackNo: number;
  title: number;
  artist: number;
  album: number;
  duration: number;
}
// Defaults tuned to fit comfortably inside the default-sized window's middle
// pane (~880 px). 44 + 300 + 160 + 220 + 60 + 4×16 gap + 24 padding = 892 —
// a hair over, so a small horizontal scrollbar may appear; the user can
// always tighten via the drag handles.
const DEFAULT_TRACK_COLS: TrackColWidths = {
  trackNo: 44, title: 300, artist: 160, album: 220, duration: 60,
};
const COL_MIN: Record<keyof TrackColWidths, number> = {
  trackNo: 36, title: 120, artist: 80, album: 100, duration: 50,
};
const COL_MAX: Record<keyof TrackColWidths, number> = {
  trackNo: 80, title: 700, artist: 400, album: 500, duration: 120,
};

interface TrackListProps {
  tracks: LibraryTrack[];
  albumMap: Record<string, Album>;
  currentTrackPath?: string;
  playing: boolean;
  // The caller passes the index into the *sorted* list — so we expose the
  // sorted array via onPlay's closure rather than the raw input.
  onPlay: (sortedList: LibraryTrack[], index: number) => void;
  // Right-click handler — opens the App's context menu at the click point.
  // Optional so callers that don't want the menu can simply omit it.
  onContextMenu?: (track: LibraryTrack, x: number, y: number) => void;
  // Click handlers for the artist/album cells. When provided, those cells
  // become clickable and navigate to the respective detail view instead
  // of falling through to the row's onPlay. Optional — older callers that
  // don't pass them keep the row-only-play behavior.
  onOpenArtist?: (name: string) => void;
  onOpenAlbum?: (albumId: number) => void;
}

const TrackList = memo(function TrackList({ tracks, albumMap, currentTrackPath, playing, onPlay, onContextMenu, onOpenArtist, onOpenAlbum }: TrackListProps) {
  const ROW = 40;
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);
  const containerRef = useRef<HTMLDivElement>(null);
  const [sortKey, setSortKey] = useState<TrackSortKey>("artist");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  // Resizable column widths. Persisted in localStorage so they survive restarts.
  const [cols, setCols] = usePersistedState<TrackColWidths>("trackCols", DEFAULT_TRACK_COLS);
  const gridTemplate = `${cols.trackNo}px ${cols.title}px ${cols.artist}px ${cols.album}px ${cols.duration}px`;

  // Drag handler for the column resize handles. Captures the starting width
  // and updates the column live as the mouse moves. Clamped to per-column
  // min/max so columns can't disappear or hog the layout.
  const startResize = (col: keyof TrackColWidths, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = cols[col];
    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX;
      const next = Math.max(COL_MIN[col], Math.min(COL_MAX[col], startW + delta));
      setCols((prev) => ({ ...prev, [col]: next }));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
  };

  // Cached locale comparator — much faster than calling localeCompare per
  // pair on a 40k-row sort.
  const collator = useMemo(
    () => new Intl.Collator(undefined, { sensitivity: "base", numeric: true }),
    [],
  );

  const sorted = useMemo(() => {
    const xs = tracks.slice();
    const dir = sortDir === "asc" ? 1 : -1;
    xs.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "track_no":
          cmp = (a.track_no ?? 0) - (b.track_no ?? 0);
          break;
        case "title":
          cmp = collator.compare(a.title, b.title);
          break;
        case "artist":
          cmp = collator.compare(a.artist, b.artist);
          break;
        case "album": {
          const at = albumMap[`lib-${a.album_id}`]?.title ?? "";
          const bt = albumMap[`lib-${b.album_id}`]?.title ?? "";
          cmp = collator.compare(at, bt);
          break;
        }
        case "duration":
          cmp = (a.duration ?? 0) - (b.duration ?? 0);
          break;
      }
      return cmp * dir;
    });
    return xs;
  }, [tracks, sortKey, sortDir, albumMap, collator]);

  const handleSortClick = (key: TrackSortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
    // Reset scroll to top when sort changes
    if (containerRef.current) containerRef.current.scrollTop = 0;
    setScrollTop(0);
  };

  // Measure container height on mount / resize
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setHeight(el.clientHeight));
    observer.observe(el);
    setHeight(el.clientHeight);
    return () => observer.disconnect();
  }, []);

  const startIdx = Math.max(0, Math.floor(scrollTop / ROW) - 5);
  const endIdx = Math.min(sorted.length, Math.ceil((scrollTop + height) / ROW) + 5);
  const visible = sorted.slice(startIdx, endIdx);
  const totalHeight = sorted.length * ROW;

  return (
    <div
      ref={containerRef}
      className="q-list-virt"
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      style={{ padding: "0 32px 0 32px" }}
    >
      {/* Sticky header */}
      <div style={{
        display: "grid",
        gridTemplateColumns: gridTemplate,
        gap: 16, padding: "8px 12px",
        borderBottom: "1px solid var(--line)",
        position: "sticky", top: 0, background: "var(--bg)",
        zIndex: 1,
      }}>
        <ResizableHeaderCell onResize={(e) => startResize("trackNo", e)}>
          <SortHeader label="#" k="track_no" sortKey={sortKey} sortDir={sortDir} onClick={handleSortClick} align="right" />
        </ResizableHeaderCell>
        <ResizableHeaderCell onResize={(e) => startResize("title", e)}>
          <SortHeader label="Title" k="title" sortKey={sortKey} sortDir={sortDir} onClick={handleSortClick} />
        </ResizableHeaderCell>
        <ResizableHeaderCell onResize={(e) => startResize("artist", e)}>
          <SortHeader label="Artist" k="artist" sortKey={sortKey} sortDir={sortDir} onClick={handleSortClick} />
        </ResizableHeaderCell>
        <ResizableHeaderCell onResize={(e) => startResize("album", e)}>
          <SortHeader label="Album" k="album" sortKey={sortKey} sortDir={sortDir} onClick={handleSortClick} />
        </ResizableHeaderCell>
        {/* Time column isn't resizable — no handle. */}
        <SortHeader label="Time" k="duration" sortKey={sortKey} sortDir={sortDir} onClick={handleSortClick} align="right" />
      </div>

      {/* Spacer that gives the scrollbar correct total height */}
      <div style={{ position: "relative", height: totalHeight }}>
        {visible.map((t, i) => {
          const idx = startIdx + i;
          const isCurrent = t.path === currentTrackPath;
          const dur = t.duration ?? 0;
          const durLabel = dur > 0
            ? `${Math.floor(dur / 60)}:${String(Math.floor(dur % 60)).padStart(2, "0")}`
            : "—";
          const album = albumMap[`lib-${t.album_id}`];
          const albumTitle = album?.title ?? "";
          return (
            <div
              key={t.id}
              onClick={() => onPlay(sorted, idx)}
              onContextMenu={onContextMenu ? (e) => {
                e.preventDefault();
                onContextMenu(t, e.clientX, e.clientY);
              } : undefined}
              className={"q-row" + (isCurrent ? " is-current" : "")}
              style={{
                position: "absolute", top: idx * ROW, left: 0, right: 0, height: ROW,
                display: "grid", gridTemplateColumns: gridTemplate,
                gap: 16, padding: "0 12px",
                alignItems: "center",
              }}
            >
              <div style={{ textAlign: "right" }}>
                {isCurrent ? (
                  <span style={{ display: "inline-flex", alignItems: "center", color: "var(--accent)" }}>
                    {playing ? <SpectrumMini bars={3} /> : (
                      <svg width="10" height="10" viewBox="0 0 12 12"><rect x="3" y="2" width="2" height="8" fill="currentColor" /><rect x="7" y="2" width="2" height="8" fill="currentColor" /></svg>
                    )}
                  </span>
                ) : (
                  <span className="mono" style={{ fontSize: 11, color: "var(--text-faint)" }}>
                    {t.track_no ? String(t.track_no).padStart(2, "0") : ""}
                  </span>
                )}
              </div>
              <span style={{
                fontFamily: "var(--serif)", fontStyle: "italic", fontSize: 13.5,
                color: isCurrent ? "var(--accent)" : "var(--text)",
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}>{t.title}</span>
              {/* Artist cell — clickable when onOpenArtist is provided.
                  stopPropagation so the row's onClick doesn't fire (which
                  would start playing the track on what the user expects
                  to be a navigation click). */}
              {onOpenArtist ? (
                <span
                  className="q-row-link"
                  onClick={(e) => { e.stopPropagation(); onOpenArtist(t.artist); }}
                  style={{
                    fontSize: 12, color: "var(--text-dim)",
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    cursor: "pointer",
                  }}
                  title={`View ${t.artist}`}
                >{t.artist}</span>
              ) : (
                <span style={{
                  fontSize: 12, color: "var(--text-dim)",
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}>{t.artist}</span>
              )}
              {onOpenAlbum && albumTitle ? (
                <span
                  className="q-row-link"
                  onClick={(e) => { e.stopPropagation(); onOpenAlbum(t.album_id); }}
                  style={{
                    fontSize: 12, color: "var(--text-faint)",
                    fontFamily: "var(--serif)", fontStyle: "italic",
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    cursor: "pointer",
                  }}
                  title={`View ${albumTitle}`}
                >{albumTitle}</span>
              ) : (
                <span style={{
                  fontSize: 12, color: "var(--text-faint)",
                  fontFamily: "var(--serif)", fontStyle: "italic",
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}>{albumTitle}</span>
              )}
              <span className="mono" style={{ fontSize: 11, color: "var(--text-faint)", textAlign: "right" }}>
                {durLabel}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
});

// ── Simple section header (no sort / view toggle) ───────────────────
function SectionHero({ title, count, unitSingular, unitPlural, right }: {
  title: string;
  count: number;
  unitSingular: string;
  unitPlural: string;
  right?: React.ReactNode;
}) {
  return (
    <div style={{
      padding: "20px 32px 14px", borderBottom: "1px solid var(--line)",
      display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16,
    }}>
      <div>
        <div className="micro" style={{ marginBottom: 8 }}>Library</div>
        <h1 style={{
          margin: 0, fontFamily: "var(--serif)", fontStyle: "italic", fontWeight: 400,
          fontSize: 38, letterSpacing: "-0.01em", color: "var(--text)", lineHeight: 1,
        }}>{title}</h1>
        <div style={{ marginTop: 6, color: "var(--text-dim)", fontSize: 12.5 }}>
          <span className="mono">{count.toLocaleString()}</span>
          <span style={{ margin: "0 8px", color: "var(--text-faint)" }}>·</span>
          <span style={{ fontStyle: "italic", fontFamily: "var(--serif)" }}>
            {count === 1 ? unitSingular : unitPlural}
          </span>
        </div>
      </div>
      {right}
    </div>
  );
}

// ── Artist photo with composite-cover fallback ──────────────────────
const ArtistImage = memo(function ArtistImage({ imagePath, coverPaths, size }: {
  imagePath: string | null;
  coverPaths: string[];
  size: number | string;
}) {
  const [imgFailed, setImgFailed] = useState(false);
  if (imagePath && !imgFailed) {
    return (
      <img
        src={fileSrc(imagePath)}
        alt=""
        loading="lazy"
        decoding="async"
        style={{
          width: typeof size === "number" ? size : "100%",
          height: typeof size === "number" ? size : "100%",
          aspectRatio: "1 / 1",
          objectFit: "cover",
          display: "block",
          borderRadius: 2,
          background: "var(--bg-elev)",
        }}
        onError={() => setImgFailed(true)}
      />
    );
  }
  return <CompositeCover paths={coverPaths} size={size} />;
});

// ── Composite cover (2×2 grid built from album cover paths) ─────────
const CompositeCover = memo(function CompositeCover({ paths, size }: { paths: string[]; size: number | string }) {
  // Take up to 4 paths and pad to 4 with empty slots
  const filled = paths.slice(0, 4);
  const cells: (string | null)[] = [
    filled[0] ?? null, filled[1] ?? filled[0] ?? null,
    filled[2] ?? filled[0] ?? null, filled[3] ?? filled[1] ?? filled[0] ?? null,
  ];
  // If only one cover, fill all four with it (looks like a full cover)
  // If two, alternate. The fallbacks above approximate that.
  return (
    <div style={{
      width: typeof size === "number" ? size : "100%",
      height: typeof size === "number" ? size : "100%",
      aspectRatio: "1 / 1",
      display: "grid",
      gridTemplateColumns: "1fr 1fr",
      gridTemplateRows: "1fr 1fr",
      gap: 0,
      background: "var(--bg-elev)",
      borderRadius: 2,
      overflow: "hidden",
    }}>
      {cells.map((p, i) => (
        <div key={i} style={{
          background: p ? "transparent" : "var(--panel)",
          overflow: "hidden",
        }}>
          {p && (
            <img
              src={fileSrc(p)}
              alt=""
              loading="lazy"
              decoding="async"
              style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
            />
          )}
        </div>
      ))}
    </div>
  );
});

// ── Artist grid ─────────────────────────────────────────────────────
interface ArtistGridProps {
  artists: LibraryArtist[];
  onOpen: (name: string) => void;
}

// Memoized single artist card. Same pattern as AlbumCard — keeps parent
// re-renders from cascading into thousands of card subtrees.
interface ArtistCardProps {
  artist: LibraryArtist;
  onOpen: (name: string) => void;
}
const ArtistCard = memo(function ArtistCard({ artist, onOpen }: ArtistCardProps) {
  return (
    <div className="q-card" onClick={() => onOpen(artist.name)}>
      <div className="q-card-cover">
        <ArtistImage imagePath={artist.image_path} coverPaths={artist.cover_paths} size="100%" />
      </div>
      <div style={{ marginTop: 12 }}>
        <div style={{
          fontFamily: "var(--serif)", fontStyle: "italic", fontSize: 14,
          color: "var(--text)", lineHeight: 1.3,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>{artist.name}</div>
        <div className="mono" style={{
          fontSize: 10, color: "var(--text-faint)",
          marginTop: 4, letterSpacing: "0.04em",
        }}>
          {artist.album_count} {artist.album_count === 1 ? "album" : "albums"} · {artist.track_count} tracks
        </div>
      </div>
    </div>
  );
});

// Virtualized artist grid — same approach as AlbumGrid above.
function ArtistGrid({ artists, onOpen }: ArtistGridProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewHeight, setViewHeight] = useState(800);
  const [viewWidth, setViewWidth] = useState(1000);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setViewHeight(el.clientHeight);
      setViewWidth(el.clientWidth);
    });
    ro.observe(el);
    setViewHeight(el.clientHeight);
    setViewWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const PAD_X = 32, PAD_Y_TOP = 24, PAD_Y_BOTTOM = 32;
  const COL_GAP = 22, ROW_GAP = 28, MIN_ITEM = 168;
  const TEXT_BLOCK = 50; // name + meta

  const innerW = Math.max(0, viewWidth - PAD_X * 2);
  const itemsPerRow = Math.max(1, Math.floor((innerW + COL_GAP) / (MIN_ITEM + COL_GAP)));
  const itemW = (innerW - COL_GAP * (itemsPerRow - 1)) / itemsPerRow;
  const itemH = itemW + TEXT_BLOCK;
  const rowH = itemH + ROW_GAP;
  const totalRows = Math.ceil(artists.length / itemsPerRow);
  const totalHeight = PAD_Y_TOP + totalRows * rowH - ROW_GAP + PAD_Y_BOTTOM;

  const OVERSCAN = 2;
  const firstRow = Math.max(0, Math.floor((scrollTop - PAD_Y_TOP) / rowH) - OVERSCAN);
  const lastRow = Math.min(totalRows, Math.ceil((scrollTop - PAD_Y_TOP + viewHeight) / rowH) + OVERSCAN);
  const startIdx = firstRow * itemsPerRow;
  const endIdx = Math.min(artists.length, lastRow * itemsPerRow);

  return (
    <div
      ref={containerRef}
      className="q-grid-virt"
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
    >
      <div style={{ height: totalHeight, position: "relative" }}>
        {(() => {
          const out: React.ReactNode[] = [];
          for (let i = startIdx; i < endIdx; i++) {
            const a = artists[i];
            if (!a) continue;
            const row = Math.floor(i / itemsPerRow);
            const col = i % itemsPerRow;
            const x = PAD_X + col * (itemW + COL_GAP);
            const y = PAD_Y_TOP + row * rowH;
            out.push(
              <div
                key={a.name}
                style={{
                  position: "absolute",
                  left: x, top: y, width: itemW, height: itemH,
                }}
              >
                <ArtistCard artist={a} onOpen={onOpen} />
              </div>
            );
          }
          return out;
        })()}
      </div>
    </div>
  );
}

// ── Artist A-Z list view ────────────────────────────────────────────
// Stylized alphabetical browse — large serif letter headers, dense list
// underneath. Designed as a complement to ArtistGrid for users who'd rather
// scan an index than scroll through tiles.
function ArtistList({ artists, onOpen }: ArtistGridProps) {
  const groups = useMemo(() => {
    const collator = new Intl.Collator(undefined, { sensitivity: "base" });
    const sorted = artists.slice().sort((a, b) => collator.compare(a.name, b.name));
    const map = new Map<string, LibraryArtist[]>();
    for (const artist of sorted) {
      // Strip leading "The " for grouping ("The Beatles" → B).
      const stripped = artist.name.replace(/^the\s+/i, "");
      const firstChar = stripped.charAt(0).toUpperCase();
      const key = /[A-Z]/.test(firstChar) ? firstChar : "#";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(artist);
    }
    // A-Z first, "#" (non-alpha) bucket last.
    const keys = Array.from(map.keys()).sort((a, b) => {
      if (a === "#") return 1;
      if (b === "#") return -1;
      return a.localeCompare(b);
    });
    return keys.map((k) => ({ letter: k, artists: map.get(k)! }));
  }, [artists]);

  return (
    <div style={{ padding: "24px 32px 32px", overflowY: "auto" }}>
      {groups.map((group) => (
        <section key={group.letter} style={{ marginBottom: 36 }}>
          <header style={{
            display: "flex", alignItems: "baseline", gap: 16,
            paddingBottom: 10, borderBottom: "1px solid var(--line)", marginBottom: 14,
          }}>
            <h2 style={{
              margin: 0, fontFamily: "var(--serif)", fontStyle: "italic", fontWeight: 400,
              fontSize: 52, lineHeight: 1, color: "var(--accent)",
              letterSpacing: "-0.02em",
            }}>{group.letter}</h2>
            <span className="mono" style={{
              fontSize: 10, color: "var(--text-faint)", letterSpacing: "0.08em",
              textTransform: "uppercase",
            }}>
              {group.artists.length} {group.artists.length === 1 ? "artist" : "artists"}
            </span>
          </header>
          <div style={{
            display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
            columnGap: 28, rowGap: 2,
          }}>
            {group.artists.map((a) => (
              <button key={a.name} onClick={() => onOpen(a.name)} style={{
                background: "transparent", border: 0, padding: "6px 0",
                textAlign: "left", cursor: "pointer", color: "var(--text)",
                display: "flex", alignItems: "baseline", justifyContent: "space-between",
                gap: 12, overflow: "hidden", transition: "color 120ms",
              }}
                onMouseEnter={(e) => (e.currentTarget.style.color = "var(--accent)")}
                onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text)")}
              >
                <span style={{
                  fontFamily: "var(--serif)", fontStyle: "italic", fontSize: 16,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  minWidth: 0,
                }}>{a.name}</span>
                <span className="mono" style={{
                  fontSize: 10, color: "var(--text-faint)", flexShrink: 0,
                  letterSpacing: "0.04em",
                }}>
                  {a.album_count} · {a.track_count}
                </span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

// ── Grid/list toggle (reusable for the artists hero) ────────────────
function ViewToggle({ value, onChange }: {
  value: "grid" | "list";
  onChange: (v: "grid" | "list") => void;
}) {
  return (
    <div style={{
      display: "flex", border: "1px solid var(--line-strong)",
      borderRadius: 3, overflow: "hidden",
    }}>
      {(["grid", "list"] as const).map((v) => (
        <button key={v} onClick={() => onChange(v)} style={{
          background: v === value ? "var(--panel-2)" : "transparent",
          border: 0, padding: "6px 10px",
          color: v === value ? "var(--text)" : "var(--text-faint)",
          cursor: "pointer",
        }}>
          {v === "grid"
            ? <svg width="11" height="11" viewBox="0 0 12 12"><rect x="1" y="1" width="4" height="4" fill="currentColor" /><rect x="7" y="1" width="4" height="4" fill="currentColor" /><rect x="1" y="7" width="4" height="4" fill="currentColor" /><rect x="7" y="7" width="4" height="4" fill="currentColor" /></svg>
            : <svg width="11" height="11" viewBox="0 0 12 12"><line x1="1" y1="3" x2="11" y2="3" stroke="currentColor" /><line x1="1" y1="6" x2="11" y2="6" stroke="currentColor" /><line x1="1" y1="9" x2="11" y2="9" stroke="currentColor" /></svg>
          }
        </button>
      ))}
    </div>
  );
}

// ── Artist detail view ──────────────────────────────────────────────
interface ArtistDetailProps {
  artist: LibraryArtist;
  albums: Album[];
  currentAlbumId: string;
  onBack: () => void;
  onOpenAlbum: (a: Album) => void;
  onQuickPlay: (a: Album) => void;
}

function ArtistDetail({ artist, albums, currentAlbumId, onBack, onOpenAlbum, onQuickPlay }: ArtistDetailProps) {
  return (
    <div style={{ overflowY: "auto", padding: "20px 32px 32px" }}>
      {/* Top bar */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
        <button
          onClick={onBack}
          style={{
            background: "transparent", border: 0, padding: "6px 10px 6px 4px",
            color: "var(--text-dim)", cursor: "pointer",
            display: "flex", alignItems: "center", gap: 6,
            fontFamily: "var(--sans)", fontSize: 12,
            letterSpacing: "0.04em",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text)")}
          onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-dim)")}
        >
          <svg width="11" height="11" viewBox="0 0 12 12">
            <path d="M7 2 L3 6 L7 10" stroke="currentColor" fill="none" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Artists
        </button>
      </div>

      {/* Hero */}
      <div style={{ display: "grid", gridTemplateColumns: "240px 1fr", gap: 28, marginBottom: 32 }}>
        <div style={{ width: 240, height: 240, boxShadow: "var(--shadow-art)", borderRadius: 3, overflow: "hidden" }}>
          <ArtistImage imagePath={artist.image_path} coverPaths={artist.cover_paths} size={240} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "flex-end", minWidth: 0 }}>
          <div className="micro" style={{ marginBottom: 10 }}>Artist</div>
          <h1 style={{
            margin: 0, fontFamily: "var(--serif)", fontStyle: "italic", fontWeight: 400,
            fontSize: 34, lineHeight: 1.1, color: "var(--text)",
            overflow: "hidden", textOverflow: "ellipsis",
          }}>{artist.name}</h1>
          <div style={{ fontSize: 12, color: "var(--text-faint)", marginTop: 14, display: "flex", gap: 10, alignItems: "center" }}>
            <span className="mono">{artist.album_count} {artist.album_count === 1 ? "album" : "albums"}</span>
            <span>·</span>
            <span className="mono">{artist.track_count} tracks</span>
          </div>
        </div>
      </div>

      {/* Albums */}
      <div className="micro-strong" style={{ marginBottom: 10, color: "var(--accent)" }}>Albums</div>
      <AlbumGrid
        albums={albums}
        currentId={currentAlbumId}
        onPlay={onOpenAlbum}
        onQuickPlay={onQuickPlay}
        virtualized={false}
      />
    </div>
  );
}

// ── Album detail view ───────────────────────────────────────────────
interface AlbumDetailProps {
  album: Album | null;
  tracks: LibraryTrack[];
  currentTrackPath?: string;
  isPlayingThisAlbum: boolean;
  playing: boolean;
  devices: Device[];
  favoriteIds: Set<number>;
  onToggleFavorite: (id: number) => void;
  playlists: DbPlaylist[];
  onAddToPlaylist: (trackId: number, playlistId: number) => void;
  onBack: () => void;
  onPlayAll: () => void;
  onShufflePlay: () => void;
  onPlayTrack: (index: number) => void;
  /// Right-click handler — opens the App's context menu. Optional.
  onContextMenu?: (track: LibraryTrack, x: number, y: number) => void;
}

function AlbumDetail({
  album, tracks, currentTrackPath, isPlayingThisAlbum, playing, devices,
  favoriteIds, onToggleFavorite,
  playlists, onAddToPlaylist,
  onBack, onPlayAll, onShufflePlay, onPlayTrack,
  onContextMenu,
}: AlbumDetailProps) {
  const [addMenu, setAddMenu] = useState<{ trackId: number; x: number; y: number } | null>(null);
  useEffect(() => {
    if (!addMenu) return;
    const close = () => setAddMenu(null);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [addMenu]);
  if (!album) {
    return (
      <div style={{ padding: 32, color: "var(--text-faint)" }}>
        Loading…
      </div>
    );
  }

  const totalSecs = tracks.reduce((s, t) => s + (t.duration ?? 0), 0);
  const totalLabel = totalSecs > 0
    ? `${Math.floor(totalSecs / 60)} min`
    : "";
  const fmtStr = album.format === "DSD" ? "DSD" : `${album.bit} bit · ${album.rate} kHz`;
  const q = qualityBadge(album);

  void devices; // device list isn't shown here yet — reserved for future signal-path inline

  return (
    <div style={{ overflowY: "auto", padding: "20px 32px 32px" }}>
      {/* Top bar */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
        <button
          onClick={onBack}
          style={{
            background: "transparent", border: 0, padding: "6px 10px 6px 4px",
            color: "var(--text-dim)", cursor: "pointer",
            display: "flex", alignItems: "center", gap: 6,
            fontFamily: "var(--sans)", fontSize: 12,
            letterSpacing: "0.04em",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text)")}
          onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-dim)")}
        >
          <svg width="11" height="11" viewBox="0 0 12 12">
            <path d="M7 2 L3 6 L7 10" stroke="currentColor" fill="none" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Library
        </button>
      </div>

      {/* Hero */}
      <div style={{ display: "grid", gridTemplateColumns: "240px 1fr", gap: 28, marginBottom: 32 }}>
        <div style={{ width: 240, height: 240, boxShadow: "var(--shadow-art)", borderRadius: 3, overflow: "hidden" }}>
          <Cover album={album} size={240} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "flex-end", minWidth: 0 }}>
          <div className="micro" style={{ marginBottom: 10 }}>Album</div>
          <h1 style={{
            margin: 0, fontFamily: "var(--serif)", fontStyle: "italic", fontWeight: 400,
            fontSize: 34, lineHeight: 1.1, color: "var(--text)",
            overflow: "hidden", textOverflow: "ellipsis",
          }}>{album.title}</h1>
          <div style={{ fontSize: 15, color: "var(--text-dim)", marginTop: 10 }}>
            {album.artist}
          </div>
          <div style={{ fontSize: 12, color: "var(--text-faint)", marginTop: 14, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            {album.year > 0 && <span className="mono">{album.year}</span>}
            {album.year > 0 && <span>·</span>}
            <span className="mono">{fmtStr}</span>
            {q && (
              <>
                <span>·</span>
                <span style={{
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  padding: "3px 8px",
                  border: `1px solid ${q.tone === "accent" ? "var(--accent)" : "var(--line-strong)"}`,
                  borderRadius: 2,
                  lineHeight: 1,
                }}>
                  <span className="mono" style={{
                    fontSize: 9.5,
                    color: q.tone === "accent" ? "var(--accent)" : "var(--text-dim)",
                    lineHeight: 1, fontWeight: 500,
                  }}>{q.label}</span>
                </span>
              </>
            )}
            <span>·</span>
            <span className="mono">{tracks.length} {tracks.length === 1 ? "track" : "tracks"}</span>
            {totalLabel && (
              <>
                <span>·</span>
                <span className="mono">{totalLabel}</span>
              </>
            )}
          </div>

          {/* Actions */}
          <div style={{ display: "flex", gap: 10, marginTop: 22 }}>
            <button
              onClick={onPlayAll}
              style={{
                display: "flex", alignItems: "center", gap: 8,
                padding: "9px 18px",
                background: "var(--accent)", color: "var(--bg)",
                border: 0, borderRadius: 3,
                fontSize: 12, letterSpacing: "0.14em", textTransform: "uppercase",
                fontWeight: 500, fontFamily: "var(--sans)",
                cursor: "pointer",
                boxShadow: "0 4px 14px -4px var(--accent)",
              }}
            >
              <svg width="11" height="11" viewBox="0 0 12 12">
                <path d="M3 2 L10 6 L3 10 Z" fill="currentColor" />
              </svg>
              Play
            </button>
            <button
              onClick={onShufflePlay}
              style={{
                display: "flex", alignItems: "center", gap: 8,
                padding: "9px 16px",
                background: "transparent", color: "var(--text-dim)",
                border: "1px solid var(--line-strong)", borderRadius: 3,
                fontSize: 12, letterSpacing: "0.14em", textTransform: "uppercase",
                fontWeight: 500, fontFamily: "var(--sans)",
                cursor: "pointer",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text)")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-dim)")}
            >
              <svg width="11" height="11" viewBox="0 0 14 14" fill="none">
                <path d="M1 3 L4 3 L9 11 L13 11 M10 8 L13 11 L10 14" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M1 11 L4 11 L6 8 M8 6 L9 3 L13 3 M10 0 L13 3 L10 6" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Shuffle
            </button>
          </div>
        </div>
      </div>

      {/* Track list */}
      <div className="micro-strong" style={{ marginBottom: 10, color: "var(--accent)" }}>Tracks</div>
      <div style={{
        display: "grid", gridTemplateColumns: "40px 1fr 24px 24px 60px",
        gap: 12, padding: "6px 8px 8px",
        borderBottom: "1px solid var(--line)",
      }}>
        <span className="micro" style={{ textAlign: "right" }}>#</span>
        <span className="micro">Title</span>
        <span />

        <span className="micro" style={{ textAlign: "right" }}>Time</span>
      </div>
      <div>
        {tracks.map((t, i) => {
          const isCurrent = isPlayingThisAlbum && t.path === currentTrackPath;
          const dur = t.duration ?? 0;
          const durLabel = dur > 0
            ? `${Math.floor(dur / 60)}:${String(Math.floor(dur % 60)).padStart(2, "0")}`
            : "—";
          const isFav = favoriteIds.has(t.id);
          return (
            <div
              key={t.id}
              onClick={() => onPlayTrack(i)}
              onContextMenu={onContextMenu ? (e) => {
                e.preventDefault();
                onContextMenu(t, e.clientX, e.clientY);
              } : undefined}
              className={"q-album-row" + (isCurrent ? " is-current" : "")}
              style={{
                display: "grid", gridTemplateColumns: "40px 1fr 24px 24px 60px",
                gap: 12, padding: "10px 8px",
                alignItems: "center",
                position: "relative",
              }}
            >
              <div style={{ position: "relative", textAlign: "right" }}>
                {isCurrent ? (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 2, color: "var(--accent)" }}>
                    {playing ? <SpectrumMini bars={3} /> : (
                      <svg width="10" height="10" viewBox="0 0 12 12"><rect x="3" y="2" width="2" height="8" fill="currentColor" /><rect x="7" y="2" width="2" height="8" fill="currentColor" /></svg>
                    )}
                  </span>
                ) : (
                  <>
                    <span className="track-num mono" style={{ fontSize: 11, color: "var(--text-faint)" }}>
                      {String(t.track_no ?? i + 1).padStart(2, "0")}
                    </span>
                    <span className="track-play" style={{
                      position: "absolute", right: 0, top: "50%",
                      transform: "translateY(-50%)",
                      color: "var(--text)",
                      display: "inline-flex", alignItems: "center",
                    }}>
                      <svg width="11" height="11" viewBox="0 0 12 12">
                        <path d="M3 2 L10 6 L3 10 Z" fill="currentColor" />
                      </svg>
                    </span>
                  </>
                )}
              </div>
              <span style={{
                fontSize: 13,
                color: isCurrent ? "var(--accent)" : "var(--text)",
                fontFamily: "var(--serif)",
                fontStyle: isCurrent ? "italic" : "normal",
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}>{t.title}</span>
              <button
                onClick={(e) => { e.stopPropagation(); onToggleFavorite(t.id); }}
                title={isFav ? "Remove from favorites" : "Add to favorites"}
                style={{
                  background: "transparent", border: 0, padding: 0,
                  cursor: "pointer", display: "grid", placeItems: "center",
                  color: isFav ? "var(--accent)" : "var(--text-faint)",
                }}
                className={"track-fav" + (isFav ? " is-fav" : "")}
              >
                <svg width="13" height="13" viewBox="0 0 16 16">
                  <path d="M8 14 C8 14 1 9.5 1 5.5 A3.5 3.5 0 0 1 8 3.5 A3.5 3.5 0 0 1 15 5.5 C15 9.5 8 14 8 14 Z"
                    fill={isFav ? "currentColor" : "none"}
                    stroke="currentColor" strokeWidth="1.2" />
                </svg>
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); setAddMenu({ trackId: t.id, x: r.left, y: r.bottom + 4 }); }}
                title="Add to playlist"
                style={{
                  background: "transparent", border: 0, padding: 0,
                  cursor: "pointer", display: "grid", placeItems: "center",
                  color: "var(--text-faint)",
                }}
                className="track-add"
                onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text)")}
                onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-faint)")}
              >
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
                  <circle cx="8" cy="8" r="6.5" />
                  <line x1="8" y1="5" x2="8" y2="11" />
                  <line x1="5" y1="8" x2="11" y2="8" />
                </svg>
              </button>
              <span className="mono" style={{ fontSize: 11, color: "var(--text-faint)", textAlign: "right" }}>
                {durLabel}
              </span>
            </div>
          );
        })}
      </div>
      {addMenu && (
        <div
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            position: "fixed", top: addMenu.y, left: addMenu.x, zIndex: 200,
            background: "var(--panel)", border: "1px solid var(--line-strong)",
            borderRadius: 4, minWidth: 160,
            boxShadow: "0 4px 20px rgba(0,0,0,0.5)", padding: "4px 0",
          }}
        >
          {playlists.length === 0 ? (
            <div style={{ padding: "8px 12px", fontSize: 12, color: "var(--text-faint)", fontFamily: "var(--sans)" }}>
              No playlists yet
            </div>
          ) : playlists.map((p) => (
            <button
              key={p.id}
              onMouseDown={(e) => { e.stopPropagation(); onAddToPlaylist(addMenu.trackId, p.id); setAddMenu(null); }}
              style={{
                display: "block", width: "100%", padding: "7px 14px", textAlign: "left",
                background: "transparent", border: 0,
                fontSize: 12, color: "var(--text)", cursor: "pointer",
                fontFamily: "var(--sans)",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--line)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >{p.name}</button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Playlist detail view ─────────────────────────────────────────────
interface PlaylistDetailProps {
  playlist: DbPlaylist | null;
  tracks: LibraryTrack[];
  currentTrackPath?: string;
  playing: boolean;
  onBack: () => void;
  onPlayAll: () => void;
  onShufflePlay: () => void;
  onPlayTrack: (index: number) => void;
  onDelete: () => void;
  onRename: (newName: string) => void;
  /// Right-click handler — opens a context menu with playlist-aware
  /// items ("Remove from this playlist", favorites, edit tags). Provided
  /// by App via the curried `openPlaylistTrackContextMenu`.
  onContextMenu?: (track: LibraryTrack, x: number, y: number) => void;
  /// Phase 20: export this playlist to a .m3u8 file via the OS save dialog.
  onExport?: () => void;
}

function PlaylistDetail({ playlist, tracks, currentTrackPath, playing, onBack, onPlayAll, onShufflePlay, onPlayTrack, onDelete, onRename, onContextMenu, onExport }: PlaylistDetailProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editing, setEditing] = useState(false);
  const [nameValue, setNameValue] = useState("");
  const nameInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editing) nameInputRef.current?.focus(); }, [editing]);
  if (!playlist) return null;

  const totalSecs = tracks.reduce((s, t) => s + (t.duration ?? 0), 0);
  const totalLabel = totalSecs > 3600
    ? `${Math.floor(totalSecs / 3600)}h ${Math.floor((totalSecs % 3600) / 60)}m`
    : totalSecs > 0 ? `${Math.floor(totalSecs / 60)}m` : null;

  return (
    <div style={{ overflowY: "auto", flex: 1, padding: "24px 32px 40px" }}>
      {/* Back */}
      <button
        onClick={onBack}
        style={{
          background: "transparent", border: 0, padding: "6px 10px 6px 4px",
          color: "var(--text-dim)", cursor: "pointer",
          display: "flex", alignItems: "center", gap: 6,
          fontFamily: "var(--sans)", fontSize: 12, letterSpacing: "0.04em",
          marginBottom: 20,
        }}
        onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text)")}
        onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-dim)")}
      >
        <svg width="11" height="11" viewBox="0 0 12 12">
          <path d="M7 2 L3 6 L7 10" stroke="currentColor" fill="none" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Playlists
      </button>

      {/* Header */}
      <div style={{ marginBottom: 28 }}>
        <div className="micro" style={{ marginBottom: 8 }}>{playlist.kind === 1 ? "Smart Playlist" : "Playlist"}</div>
        {editing ? (
          <input
            ref={nameInputRef}
            value={nameValue}
            onChange={(e) => setNameValue(e.target.value)}
            onBlur={() => {
              const t = nameValue.trim();
              if (t && t !== playlist.name) onRename(t);
              setEditing(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") { const t = nameValue.trim(); if (t && t !== playlist.name) onRename(t); setEditing(false); }
              if (e.key === "Escape") setEditing(false);
            }}
            style={{
              fontFamily: "var(--serif)", fontStyle: "italic", fontWeight: 400,
              fontSize: 36, letterSpacing: "-0.01em", color: "var(--text)", lineHeight: 1.1,
              background: "transparent", border: 0, borderBottom: "1px solid var(--accent)",
              outline: "none", padding: "0 0 2px", width: "100%", marginBottom: 10,
              display: "block",
            }}
          />
        ) : (
          <h1
            onClick={() => { setNameValue(playlist.name); setEditing(true); }}
            title="Click to rename"
            style={{
              margin: 0, fontFamily: "var(--serif)", fontStyle: "italic", fontWeight: 400,
              fontSize: 36, letterSpacing: "-0.01em", color: "var(--text)", lineHeight: 1.1,
              marginBottom: 10, cursor: "text",
            }}
          >{playlist.name}</h1>
        )}
        {playlist.description && (
          <div style={{ fontSize: 13, color: "var(--text-dim)", marginBottom: 8 }}>{playlist.description}</div>
        )}
        <div className="mono" style={{ fontSize: 10, color: "var(--text-faint)", letterSpacing: "0.12em", display: "flex", gap: 12 }}>
          <span>{tracks.length} {tracks.length === 1 ? "track" : "tracks"}</span>
          {totalLabel && <span>{totalLabel}</span>}
        </div>

        <div style={{ display: "flex", gap: 10, marginTop: 22, alignItems: "center" }}>
          <button
            onClick={onPlayAll}
            style={{
              display: "flex", alignItems: "center", gap: 8,
              padding: "9px 18px",
              background: "var(--accent)", color: "var(--bg)",
              border: 0, borderRadius: 3,
              fontSize: 12, letterSpacing: "0.14em", textTransform: "uppercase",
              fontWeight: 500, fontFamily: "var(--sans)",
              cursor: "pointer",
              boxShadow: "0 4px 14px -4px var(--accent)",
            }}
          >
            <svg width="11" height="11" viewBox="0 0 12 12"><path d="M3 2 L10 6 L3 10 Z" fill="currentColor" /></svg>
            Play
          </button>
          <button
            onClick={onShufflePlay}
            style={{
              display: "flex", alignItems: "center", gap: 8,
              padding: "9px 16px",
              background: "transparent", color: "var(--text-dim)",
              border: "1px solid var(--line-strong)", borderRadius: 3,
              fontSize: 12, letterSpacing: "0.14em", textTransform: "uppercase",
              fontWeight: 500, fontFamily: "var(--sans)", cursor: "pointer",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text)")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-dim)")}
          >
            <svg width="11" height="11" viewBox="0 0 14 14" fill="none">
              <path d="M1 3 L4 3 L9 11 L13 11 M10 8 L13 11 L10 14" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M1 11 L4 11 L6 8 M8 6 L9 3 L13 3 M10 0 L13 3 L10 6" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Shuffle
          </button>
          <div style={{ flex: 1 }} />
          {onExport && (
            <button
              onClick={onExport}
              title="Export as .m3u8"
              style={{
                background: "transparent", border: 0, padding: "6px 10px",
                color: "var(--text-faint)", cursor: "pointer",
                fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase",
                fontFamily: "var(--sans)",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text)")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-faint)")}
            >Export</button>
          )}
          {!confirmDelete ? (
            <button
              onClick={() => setConfirmDelete(true)}
              style={{
                background: "transparent", border: 0, padding: "6px 10px",
                color: "var(--text-faint)", cursor: "pointer",
                fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase",
                fontFamily: "var(--sans)",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "var(--danger)")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-faint)")}
            >Delete</button>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 11, color: "var(--text-dim)" }}>Delete this playlist?</span>
              <button
                onClick={onDelete}
                style={{
                  background: "var(--danger)", border: 0, borderRadius: 3,
                  padding: "6px 12px", color: "#fff", cursor: "pointer",
                  fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase",
                  fontFamily: "var(--sans)", fontWeight: 500,
                }}
              >Yes, delete</button>
              <button
                onClick={() => setConfirmDelete(false)}
                style={{
                  background: "transparent", border: "1px solid var(--line-strong)", borderRadius: 3,
                  padding: "6px 12px", color: "var(--text-dim)", cursor: "pointer",
                  fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase",
                  fontFamily: "var(--sans)",
                }}
              >Cancel</button>
            </div>
          )}
        </div>
      </div>

      {/* Track list */}
      {tracks.length === 0 ? (
        <div style={{ color: "var(--text-faint)", fontSize: 13, fontStyle: "italic", fontFamily: "var(--serif)", paddingTop: 16 }}>
          This playlist is empty.
        </div>
      ) : (
        <>
          <div className="micro-strong" style={{ marginBottom: 10, color: "var(--accent)" }}>Tracks</div>
          <div style={{
            display: "grid", gridTemplateColumns: "40px 1fr 60px",
            gap: 12, padding: "6px 8px 8px",
            borderBottom: "1px solid var(--line)",
          }}>
            <span className="micro" style={{ textAlign: "right" }}>#</span>
            <span className="micro">Title · Artist</span>
            <span className="micro" style={{ textAlign: "right" }}>Time</span>
          </div>
          <div>
            {tracks.map((t, i) => {
              const isCurrent = t.path === currentTrackPath;
              const dur = t.duration ?? 0;
              const durLabel = dur > 0
                ? `${Math.floor(dur / 60)}:${String(Math.floor(dur % 60)).padStart(2, "0")}`
                : "—";
              return (
                <div
                  key={t.id}
                  onClick={() => onPlayTrack(i)}
                  onContextMenu={onContextMenu ? (e) => {
                    e.preventDefault();
                    onContextMenu(t, e.clientX, e.clientY);
                  } : undefined}
                  className={"q-row" + (isCurrent ? " is-current" : "")}
                  style={{
                    display: "grid", gridTemplateColumns: "40px 1fr 60px",
                    gap: 12, padding: "10px 8px",
                    alignItems: "center",
                    position: "relative",
                  }}
                >
                  <span className="mono" style={{ fontSize: 11, color: isCurrent ? "var(--accent)" : "var(--text-faint)", textAlign: "right" }}>
                    {isCurrent && playing ? <SpectrumMini bars={3} /> : String(i + 1).padStart(2, "0")}
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div style={{
                      fontSize: 13, color: isCurrent ? "var(--accent)" : "var(--text)",
                      fontFamily: "var(--serif)", fontStyle: isCurrent ? "italic" : "normal",
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    }}>{t.title}</div>
                    <div style={{
                      fontSize: 11, color: "var(--text-faint)", marginTop: 2,
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    }}>{t.artist}</div>
                  </div>
                  <span className="mono" style={{ fontSize: 11, color: "var(--text-faint)", textAlign: "right" }}>{durLabel}</span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// ── AI Playlist Dialog ────────────────────────────────────────────────
interface AiPlaylistDialogProps {
  open: boolean;
  prompt: string;
  onPromptChange: (v: string) => void;
  loading: boolean;
  error: string | null;
  hasApiKey: boolean;
  onGenerate: () => void;
  onClose: () => void;
}

function AiPlaylistDialog({ open, prompt, onPromptChange, loading, error, hasApiKey, onGenerate, onClose }: AiPlaylistDialogProps) {
  if (!open) return null;
  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 900,
        background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)",
        display: "grid", placeItems: "center",
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        background: "var(--bg-elev)", border: "1px solid var(--line-strong)",
        borderRadius: 6, padding: 28, width: 460, maxWidth: "90vw",
      }}>
        <div style={{ marginBottom: 20 }}>
          <div className="micro" style={{ marginBottom: 8 }}>Quartz · Anthropic</div>
          <h2 style={{
            margin: 0, fontFamily: "var(--serif)", fontStyle: "italic", fontWeight: 400,
            fontSize: 24, color: "var(--text)",
          }}>AI Playlist</h2>
          <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 8, lineHeight: 1.5 }}>
            Describe the mood, genre, or context for your playlist. Claude selects tracks from your library.
          </div>
        </div>

        {!hasApiKey && (
          <div style={{
            padding: "10px 14px", borderRadius: 4,
            background: "rgba(200, 80, 60, 0.1)", border: "1px solid rgba(200, 80, 60, 0.3)",
            fontSize: 12, color: "var(--text-dim)", marginBottom: 16,
          }}>
            Add your Anthropic API key in <strong>Settings → Integrations</strong> to use this feature.
          </div>
        )}

        <textarea
          value={prompt}
          onChange={(e) => onPromptChange(e.target.value)}
          placeholder="e.g. late night jazz piano, cinematic and melancholic…"
          disabled={loading}
          rows={3}
          style={{
            width: "100%", resize: "none",
            background: "var(--bg)", border: "1px solid var(--line-strong)",
            borderRadius: 4, padding: "10px 12px",
            color: "var(--text)", fontFamily: "var(--serif)", fontStyle: "italic", fontSize: 14,
            outline: "none", boxSizing: "border-box",
            opacity: loading ? 0.5 : 1,
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); onGenerate(); }
            if (e.key === "Escape") onClose();
          }}
          autoFocus
        />

        {error && (
          <div style={{ marginTop: 10, fontSize: 12, color: "var(--danger)", lineHeight: 1.5 }}>{error}</div>
        )}

        <div style={{ display: "flex", gap: 10, marginTop: 20, justifyContent: "flex-end" }}>
          <button
            onClick={onClose}
            style={{
              padding: "9px 18px", background: "transparent",
              border: "1px solid var(--line-strong)", borderRadius: 3,
              color: "var(--text-dim)", cursor: "pointer",
              fontSize: 11, letterSpacing: "0.14em", textTransform: "uppercase",
              fontFamily: "var(--sans)",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text)")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-dim)")}
          >Cancel</button>
          <button
            onClick={onGenerate}
            disabled={loading || !prompt.trim() || !hasApiKey}
            style={{
              padding: "9px 18px",
              background: loading || !prompt.trim() || !hasApiKey ? "transparent" : "var(--accent)",
              color: loading || !prompt.trim() || !hasApiKey ? "var(--text-faint)" : "var(--bg)",
              border: loading || !prompt.trim() || !hasApiKey ? "1px solid var(--line-strong)" : 0,
              borderRadius: 3, cursor: loading || !prompt.trim() || !hasApiKey ? "not-allowed" : "pointer",
              fontSize: 11, letterSpacing: "0.14em", textTransform: "uppercase",
              fontWeight: 500, fontFamily: "var(--sans)",
            }}
          >{loading ? "Generating…" : "Generate"}</button>
        </div>
      </div>
    </div>
  );
}

// ── Queue panel ─────────────────────────────────────────────────────
interface QueuePanelProps {
  queue: QueueTrack[];
  albumMap: Record<string, Album>;
  devices: Device[];
  onPlayIndex?: (index: number) => void;
  /// Move queue[from] so it lands just before the item currently at
  /// queue[insertBefore]. `insertBefore === queue.length` means "drop at end".
  onReorder?: (from: number, insertBefore: number) => void;
}

const QueuePanel = memo(function QueuePanel({ queue, albumMap, devices, onPlayIndex, onReorder }: QueuePanelProps) {
  // ── Pointer-events drag-to-reorder ────────────────────────────────
  // HTML5 drag-and-drop is unreliable inside Tauri/WebView2 — the browser
  // often shows a "forbidden" cursor even when preventDefault() is called.
  // Pointer events (mousedown → global mousemove/mouseup) work everywhere.
  const rowContainerRef = useRef<HTMLDivElement>(null);
  const dragFromRef = useRef<number | null>(null);   // queueIdx being dragged
  const dragOverRef = useRef<number | null>(null);   // insert-before queueIdx
  const dragStartYRef = useRef<number>(0);           // Y at mousedown
  const didDragRef = useRef<boolean>(false);         // moved past 4px threshold?
  const [dragFromIdx, setDragFromIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);

  // Keep the callback in a ref so the effect can read the latest version
  // without being re-registered every time onReorder identity changes.
  const onReorderRef = useRef(onReorder);
  onReorderRef.current = onReorder;
  const currentIdxRef = useRef(0);

  const currentIdx = queue.findIndex((t) => t.current);
  const current = currentIdx >= 0 ? queue[currentIdx] : queue[0];
  const currentAlbum = current ? albumMap[current.albumId] : undefined;
  // Up Next = everything after the currently-playing track
  const upNext = currentIdx >= 0 ? queue.slice(currentIdx + 1) : queue.filter((t) => !t.current);
  // Cap rendered rows to prevent DOM bloat when the queue is the full All Tracks
  // list (could be 40k tracks). We show a "+N more" footer for the rest.
  const UPNEXT_LIMIT = 200;
  const visibleUpNext = upNext.length > UPNEXT_LIMIT ? upNext.slice(0, UPNEXT_LIMIT) : upNext;
  const hiddenCount = upNext.length - visibleUpNext.length;
  currentIdxRef.current = currentIdx;

  // Register global handlers once. All drag state is read via refs so
  // there are no stale-closure issues and no need to re-register.
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (dragFromRef.current === null) return;
      // Don't start visual drag until the user moves at least 4 px (avoids
      // treating a normal click as a drag).
      if (!didDragRef.current) {
        if (Math.abs(e.clientY - dragStartYRef.current) < 4) return;
        didDragRef.current = true;
        document.body.style.cursor = "grabbing";
      }
      if (!rowContainerRef.current) return;
      const base = (currentIdxRef.current >= 0 ? currentIdxRef.current : 0) + 1;
      // Only measure rows (not the "+N more" footer, which has no data-qr attr)
      const rows = rowContainerRef.current.querySelectorAll<HTMLElement>("[data-qr]");
      let insertBefore = base + rows.length; // default: append at end
      for (let i = 0; i < rows.length; i++) {
        const rect = rows[i].getBoundingClientRect();
        if (e.clientY < rect.top + rect.height / 2) {
          insertBefore = base + i;
          break;
        }
      }
      if (dragOverRef.current !== insertBefore) {
        dragOverRef.current = insertBefore;
        setDragOverIdx(insertBefore);
      }
    };

    const onUp = () => {
      if (dragFromRef.current !== null && didDragRef.current) {
        const from = dragFromRef.current;
        const over = dragOverRef.current;
        if (over !== null) onReorderRef.current?.(from, over);
      }
      dragFromRef.current = null;
      dragOverRef.current = null;
      didDragRef.current = false;
      setDragFromIdx(null);
      setDragOverIdx(null);
      document.body.style.cursor = "";
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []); // empty — reads everything via refs

  if (!current || !currentAlbum) {
    return (
      <div style={{
        width: 320, borderLeft: "1px solid var(--line)", background: "var(--bg)",
        display: "flex", flexDirection: "column", overflow: "hidden",
        padding: "18px 22px", color: "var(--text-faint)",
      }}>
        <div className="micro">Now Playing</div>
        <div style={{ marginTop: 12, fontFamily: "var(--serif)", fontStyle: "italic", fontSize: 16, color: "var(--text-dim)" }}>
          Nothing queued
        </div>
        <div style={{ fontSize: 12, marginTop: 8 }}>Pick an album to start.</div>
      </div>
    );
  }

  return (
    <div style={{
      width: 320, borderLeft: "1px solid var(--line)", background: "var(--bg)",
      display: "flex", flexDirection: "column", overflow: "hidden",
    }}>
      {/* Header */}
      <div style={{
        padding: "18px 22px 16px", borderBottom: "1px solid var(--line)",
        display: "flex", alignItems: "center", justifyContent: "space-between",
      }}>
        <div>
          <div className="micro">Now Playing</div>
          <div style={{ marginTop: 4, fontFamily: "var(--serif)", fontStyle: "italic", fontSize: 17, color: "var(--text)" }}>
            From {currentAlbum.title.split(",")[0]}
          </div>
        </div>
        <button style={{
          background: "transparent", border: "1px solid var(--line-strong)",
          color: "var(--text-dim)", borderRadius: 2,
          width: 24, height: 24, cursor: "pointer", display: "grid", placeItems: "center",
        }}>
          <svg width="10" height="10" viewBox="0 0 12 12">
            <path d="M1 3 L6 8 L11 3" stroke="currentColor" fill="none" strokeWidth="1" />
          </svg>
        </button>
      </div>

      {/* Cover + track info */}
      <div style={{ padding: "20px 22px 16px", overflowY: "auto", flex: 1 }}>
        <div style={{ position: "relative", boxShadow: "var(--shadow-art)", borderRadius: 2, overflow: "hidden" }}>
          <Cover album={currentAlbum} size="100%" />
        </div>

        <div style={{ marginTop: 16 }}>
          <div style={{ fontFamily: "var(--serif)", fontStyle: "italic", fontSize: 16, lineHeight: 1.3, color: "var(--text)" }}>
            {current.title}
          </div>
          <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 4 }}>
            {currentAlbum.artist}{currentAlbum.sub ? ` · ${currentAlbum.sub}` : ""}
          </div>
        </div>

        <SignalPath album={currentAlbum} devices={devices} />

        {/* Up Next */}
        <div style={{ padding: "16px 0 6px", display: "flex", justifyContent: "space-between" }}>
          <div className="micro">Up Next</div>
          <div className="micro">{upNext.length} tracks</div>
        </div>
        <div ref={rowContainerRef}>
          {visibleUpNext.map((t, i) => {
            // The index in the underlying queue array
            const queueIdx = (currentIdx >= 0 ? currentIdx : 0) + 1 + i;
            const isLast = i === visibleUpNext.length - 1;
            const isDragging = dragFromIdx === queueIdx;
            // Accent line above/below the row signals the current drop position.
            const showTopLine = dragOverIdx === queueIdx && dragFromIdx !== null && dragFromIdx !== queueIdx;
            const showBottomLine = isLast
              && dragOverIdx === queueIdx + 1
              && dragFromIdx !== null
              && dragFromIdx !== queueIdx;
            return (
              <div
                key={i}
                data-qr=""  // marks this as a draggable row (vs the footer)
                onMouseDown={(e) => {
                  if (e.button !== 0) return; // left-click only
                  e.preventDefault();         // prevent text-selection ghost
                  dragFromRef.current = queueIdx;
                  dragStartYRef.current = e.clientY;
                  didDragRef.current = false;
                  dragOverRef.current = null;
                  setDragFromIdx(queueIdx);
                  setDragOverIdx(null);
                }}
                onClick={() => {
                  // Suppress click when it ended a real drag (> 4 px movement)
                  if (didDragRef.current) return;
                  onPlayIndex?.(queueIdx);
                }}
                style={{
                  display: "grid", gridTemplateColumns: "20px 1fr auto",
                  alignItems: "center", gap: 8, padding: "8px 8px", borderRadius: 3,
                  cursor: dragFromIdx !== null ? "grabbing" : "pointer",
                  opacity: isDragging ? 0.4 : 1,
                  boxShadow: [
                    showTopLine ? "inset 0 2px 0 var(--accent)" : "",
                    showBottomLine ? "inset 0 -2px 0 var(--accent)" : "",
                  ].filter(Boolean).join(", ") || "none",
                  transition: "opacity 120ms",
                }}
                onMouseEnter={(e) => { if (!isDragging) e.currentTarget.style.background = "var(--panel)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
              >
                <span className="mono" style={{ fontSize: 10, color: "var(--text-faint)", textAlign: "right" }}>
                  {String(t.track).padStart(2, "0")}
                </span>
                <span style={{ fontSize: 12, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {t.title}
                </span>
                <span className="mono" style={{ fontSize: 10, color: "var(--text-faint)" }}>{t.duration}</span>
              </div>
            );
          })}
          {hiddenCount > 0 && (
            <div style={{
              padding: "10px 8px", color: "var(--text-faint)",
              fontSize: 11, textAlign: "center", fontStyle: "italic",
            }}>
              + {hiddenCount.toLocaleString()} more tracks
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

// ── Signal path card ────────────────────────────────────────────────
function SignalPath({ album, devices }: { album: Album; devices: Device[] }) {
  const dev = devices.find((d) => d.current) ?? devices[0];
  const isDSD = album.format === "DSD";
  const rateStr = isDSD ? `DSD ${Math.floor(album.rate / 1000)}` : `${album.bit} bit / ${album.rate} kHz`;

  const rows = [
    { label: "Source", value: rateStr, sub: album.format },
    { label: "Decode", value: "No DSP · No Resample", sub: "pass-through" },
    { label: "Driver", value: dev?.driver ?? "—", sub: dev ? "Exclusive Mode" : "loading…" },
    { label: "Device", value: dev?.name ?? "—", sub: dev?.formats ?? "" },
  ];

  return (
    <div style={{
      marginTop: 18, padding: "12px 14px", background: "var(--panel)",
      border: "1px solid var(--line-strong)", borderRadius: 3,
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <div className="micro-strong" style={{ color: "var(--accent)" }}>Signal Path</div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <div style={{
            width: 5, height: 5, borderRadius: "50%", background: "var(--bit-perfect)",
            animation: "pulse-bit 2.4s ease-in-out infinite",
          }} />
          <span className="mono" style={{ fontSize: 9, color: "var(--bit-perfect)", letterSpacing: "0.18em", marginRight: "-0.18em" }}>BIT-PERFECT</span>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {rows.map((row, i) => (
          <div key={row.label}>
            <div style={{ display: "grid", gridTemplateColumns: "60px 1fr", gap: 10, alignItems: "baseline" }}>
              <span className="micro">{row.label}</span>
              <div>
                <div style={{ fontSize: 11.5, color: "var(--text)", fontFamily: "var(--mono)", letterSpacing: "0.02em" }}>
                  {row.value}
                </div>
                <div style={{ fontSize: 10, color: "var(--text-faint)", marginTop: 1, fontStyle: "italic", fontFamily: "var(--serif)" }}>
                  {row.sub}
                </div>
              </div>
            </div>
            {i < rows.length - 1 && (
              <div style={{ height: 8, marginLeft: 18, borderLeft: "1px dashed var(--line-strong)" }} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Spectrum ────────────────────────────────────────────────────────
// Self-contained canvas-based spectrum visualizer.
//
// Previously this rendered 22 <div> elements with inline height + opacity
// styles, mutated at 30 Hz. That's ~660 style writes per second of playback,
// each triggering a style-recalc on a flex container. The browser handles
// it, but on integrated GPUs (Iris, Vega 3) and weak CPUs the cumulative
// cost was a clear contributor to playback-time main-thread pressure.
//
// One <canvas>, one 2D draw call per tick, zero DOM mutations. The canvas
// backing store is DPR-scaled so bars stay crisp on HiDPI displays.
//
// Payload is now a `Uint8Array`-equivalent (Rust emits `Vec<u8>`) which
// JSON-deserializes to a `number[]` of values in [0..=255]. We treat it
// as opaque integer heights and only divide by 255 inside the draw call.
function SpectrumLive({ bars = 22, height = 22 }: { bars?: number; height?: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Latest bins (mutable buffer; same reference across ticks so React never
  // sees a state change). Padded out to `bars` with zeros if the engine
  // sends fewer values than we render.
  const binsRef = useRef<Float32Array>(new Float32Array(bars));
  // Seeded fallback animation values, used until the first real event.
  const seedsRef = useRef<{ base: number; speed: number; phase: number }[]>(
    Array.from({ length: bars }, () => ({
      base: 0.2 + Math.random() * 0.5,
      speed: 0.7 + Math.random() * 1.6,
      phase: Math.random() * Math.PI * 2,
    })),
  );
  const hasRealBinsRef = useRef(false);
  // Cached accent values + a per-frame read of the CSS vars so the canvas
  // tracks any change to --accent-runtime (dynamic-from-cover-art accent)
  // OR --accent (user's chosen accent) without remounting. The lookup is
  // one getComputedStyle per RAF — measured negligible vs the canvas draw.
  const accentRef = useRef<{ accent: string; accentDim: string }>({
    accent: "#c9a96e", accentDim: "#8a754d",
  });
  const readAccent = () => {
    const cs = getComputedStyle(document.documentElement);
    // Prefer --accent-runtime (dynamic-from-art); fall back to --accent.
    const a = (cs.getPropertyValue("--accent-runtime").trim() || cs.getPropertyValue("--accent").trim());
    const ad = (cs.getPropertyValue("--accent-runtime-dim").trim() || cs.getPropertyValue("--accent-dim").trim());
    if (a) accentRef.current.accent = a;
    if (ad) accentRef.current.accentDim = ad;
  };
  // Initial read on mount so the first paint matches the theme.
  useEffect(() => { readAccent(); }, []);

  // Resize backing store on DPR / size change. Done in effect so the canvas
  // ref is mounted; the `style.width/height` keeps layout independent of DPR.
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const cssW = bars * 4;
    const cssH = height;
    c.width = Math.round(cssW * dpr);
    c.height = Math.round(cssH * dpr);
    c.style.width = `${cssW}px`;
    c.style.height = `${cssH}px`;
  }, [bars, height]);

  // Subscribe to spectrum-bins. Writes into the mutable Float32Array;
  // does NOT setState — the next rAF picks the new values up directly.
  // When the engine sends fewer bins than we render (FullscreenPlayer
  // shows 60 bars but the engine emits 22), we linearly interpolate so
  // the wider visualiser stays "alive" all the way across instead of
  // leaving bars 22..59 dead-zero.
  useEffect(() => {
    let alive = true;
    const u = listen<number[]>("spectrum-bins", (e) => {
      if (!alive) return;
      if (typeof document !== "undefined" && document.hidden) return;
      const arr = binsRef.current;
      const v = e.payload;
      const inN = v.length;
      const outN = arr.length;
      if (inN === 0) {
        for (let i = 0; i < outN; i++) arr[i] = 0;
      } else if (inN === outN) {
        // Fast path — direct copy, no interpolation.
        for (let i = 0; i < outN; i++) arr[i] = (v[i] ?? 0) / 255;
      } else if (inN >= outN) {
        // Downsample: pick the max in each slice so peaks survive.
        const step = inN / outN;
        for (let i = 0; i < outN; i++) {
          const lo = Math.floor(i * step);
          const hi = Math.min(inN, Math.floor((i + 1) * step) + 1);
          let mx = 0;
          for (let j = lo; j < hi; j++) {
            const sample = v[j] ?? 0;
            if (sample > mx) mx = sample;
          }
          arr[i] = mx / 255;
        }
      } else {
        // Upsample: linear interpolation.
        const denom = outN - 1 || 1;
        for (let i = 0; i < outN; i++) {
          const x = (i / denom) * (inN - 1);
          const lo = Math.floor(x);
          const hi = Math.min(inN - 1, lo + 1);
          const t = x - lo;
          arr[i] = (((v[lo] ?? 0) * (1 - t) + (v[hi] ?? 0) * t)) / 255;
        }
      }
      hasRealBinsRef.current = true;
    });
    return () => { alive = false; u.then((f) => f()); };
  }, [bars]);

  // Single rAF draw loop. Runs as long as the component is mounted; cheap
  // enough at idle (one clearRect + ~22 rects) that it's not worth gating
  // on document.hidden — rAF naturally pauses when the page isn't visible.
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    const start = performance.now();
    // Re-read CSS-var accents periodically so theme + dynamic-accent changes
    // propagate without remounting. Every ~16 frames (≈4 Hz at 60fps) is
    // plenty given color changes take 300ms+ to perceive.
    let accentTick = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const w = c.width;
      const h = c.height;
      ctx.clearRect(0, 0, w, h);

      if ((accentTick++ & 15) === 0) readAccent();

      const arr = binsRef.current;
      const hasReal = hasRealBinsRef.current;
      const elapsed = (performance.now() - start) / 1000;
      const seeds = seedsRef.current;

      // Bar metrics in backing-store pixels. CSS width is bars*4, so
      // each bar takes 2.5 px content + 1.5 px gap.
      const dpr = w / (bars * 4);
      const barW = 2.5 * dpr;
      const gap = 1.5 * dpr;

      // Vertical gradient: accent at base, accentDim near tip.
      const grad = ctx.createLinearGradient(0, h, 0, 0);
      grad.addColorStop(0, accentRef.current.accent);
      grad.addColorStop(0.6, accentRef.current.accent);
      grad.addColorStop(1, accentRef.current.accentDim);
      ctx.fillStyle = grad;

      // Envelope (precomputed conceptually; cheap to recompute per frame
      // given the tiny bar count). Matches the previous DOM look.
      const center = bars / 2.4;
      for (let i = 0; i < bars; i++) {
        let v: number;
        if (hasReal) {
          v = arr[i];
        } else {
          const s = seeds[i];
          const env = Math.exp(-Math.pow((i - center) / center, 2) * 1.2);
          v = (s.base + 0.35 * Math.sin(elapsed * s.speed * 2 + s.phase)) * env;
        }
        const barH = Math.max(2 * dpr, v * h);
        const x = i * (barW + gap);
        // Rounded top via two rects + tiny circle is overkill — flat bar
        // with 0.5 px radius is already barely visible at this size, so
        // we draw plain rects to keep the loop pure.
        ctx.fillRect(x, h - barH, barW, barH);
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [bars]);

  return <canvas ref={canvasRef} className="q-spec-canvas" />;
}

// `Spectrum` (DOM-div based) and its `SpectrumSeed` interface were removed
// when the visualiser moved to <canvas> — see `SpectrumLive` above. The
// MiniPlayer / row "now playing" indicator still uses the tiny 3-bar
// `SpectrumMini` because it's not driven by real FFT data and renders
// nothing during scroll-heavy moments either way.

function SpectrumMini({ bars = 3 }: { bars?: number }) {
  const seeds = useMemo(() =>
    Array.from({ length: bars }, () => ({
      speed: 1 + Math.random() * 1.8,
      phase: Math.random() * Math.PI * 2,
    })), [bars]);

  const [t, setT] = useState(0);
  useEffect(() => {
    let raf: number;
    const start = performance.now();
    const tick = (now: number) => { setT((now - start) / 1000); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 1.5, height: 10 }}>
      {seeds.map((s, i) => {
        const h = 0.45 + 0.55 * Math.abs(Math.sin(t * s.speed + s.phase));
        return <div key={i} style={{ width: 2, height: h * 10, background: "var(--accent)", borderRadius: 0.5 }} />;
      })}
    </div>
  );
}

// ── Scrub bar variants ──────────────────────────────────────────────
// Two display styles: a flat progress bar (the classic) and a waveform
// (pre-decoded peak envelope per track). The user picks via Settings.

export type ScrubStyle = "bar" | "waveform";

interface ScrubProps {
  progress: number;       // 0–1
  totalSec: number;       // for the seek event
  onSeekSecs: (secs: number) => void;
  // accentVar lets the FullscreenPlayer pass a different CSS-var scope
  // (its accent is set per-track from the cover palette).
  accentVar?: string;
}

interface BarScrubProps extends ScrubProps {
  showThumb?: boolean;
}

/// Original flat scrub bar — kept as the "bar" style.
const FlatScrubBar = memo(function FlatScrubBar({
  progress, totalSec, onSeekSecs, accentVar = "var(--accent)", showThumb = true,
}: BarScrubProps) {
  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (totalSec <= 0) return;
    const el = e.currentTarget;
    const seekFromEvent = (clientX: number) => {
      const r = el.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
      onSeekSecs(frac * totalSec);
    };
    seekFromEvent(e.clientX);
    const onMove = (ev: MouseEvent) => seekFromEvent(ev.clientX);
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };
  return (
    <div
      onMouseDown={handleMouseDown}
      style={{
        position: "relative", height: 14, display: "flex", alignItems: "center",
        cursor: totalSec > 0 ? "pointer" : "default",
      }}
    >
      <div style={{ position: "relative", height: 3, width: "100%", background: "var(--line-strong)", borderRadius: 1 }}>
        <div style={{
          position: "absolute", left: 0, top: 0, bottom: 0,
          width: `${progress * 100}%`, background: accentVar, borderRadius: 1,
        }} />
        {showThumb && (
          <div style={{
            position: "absolute", left: `${progress * 100}%`, top: "50%",
            width: 8, height: 8, borderRadius: "50%", background: accentVar,
            transform: "translate(-50%, -50%)", boxShadow: "0 0 0 3px var(--bg-elev)",
          }} />
        )}
      </div>
    </div>
  );
});

interface WaveformScrubProps extends ScrubProps {
  peaks: number[] | null;
  /// Display height for the waveform area in pixels.
  height?: number;
}

/// Waveform scrub bar. Renders the peak envelope as an SVG and uses a
/// single inline `clip-path` style update to show the played portion —
/// the bar rects themselves only mount once per peaks change, so progress
/// ticks at 4 Hz cost effectively zero DOM work. While peaks are loading,
/// a faint flat bar is shown so the layout doesn't jump.
const WaveformScrubBar = memo(function WaveformScrubBar({
  peaks, progress, totalSec, onSeekSecs, accentVar = "var(--accent)", height = 36,
}: WaveformScrubProps) {
  // Stable seek handler — same drag logic as the flat bar.
  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (totalSec <= 0) return;
    const el = e.currentTarget;
    const seekFromEvent = (clientX: number) => {
      const r = el.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
      onSeekSecs(frac * totalSec);
    };
    seekFromEvent(e.clientX);
    const onMove = (ev: MouseEvent) => seekFromEvent(ev.clientX);
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // Memoize the <rect>s so progress ticks don't allocate a fresh JSX array.
  // Bars are rendered once per peaks update; both SVG layers reuse them
  // with different `color` properties (fill="currentColor" lets one
  // rect set be styled two ways).
  const bars = useMemo(() => {
    if (!peaks || peaks.length === 0) return null;
    // Phase 28 — Per-track peak normalize + gamma shaping.
    //   1. Find max peak. Tracks vary by 30+ dB so linear-normalize is
    //      essential to make a quiet ambient piece fill the viewport.
    //   2. Apply a gamma 0.6 curve. Modern masters cluster their peaks
    //      near full-scale; raw linear bars then look like a brick. The
    //      gamma curve visually amplifies the *deviations* below max
    //      without distorting the overall envelope shape.
    //   3. Minimum bar height of 0.6 px is small enough that silent gaps
    //      genuinely look like silence rather than a forced 2 px floor.
    let maxPeak = 0;
    for (const p of peaks) {
      if (p > maxPeak) maxPeak = p;
    }
    const scale = maxPeak > 0.01 ? 1.0 / maxPeak : 1.0;
    const n = peaks.length;
    const out: React.ReactNode[] = [];
    for (let i = 0; i < n; i++) {
      const norm = Math.min(1, peaks[i] * scale);
      const visual = Math.pow(norm, 0.6);
      const h = Math.max(0.6, visual * 100);
      out.push(
        <rect
          key={i}
          x={i + 0.15}
          y={(100 - h) / 2}
          width={0.7}
          height={h}
          fill="currentColor"
        />,
      );
    }
    return out;
  }, [peaks]);

  // Phase 28 — Wipe-in animation key. Incremented every time peaks
  // changes reference, which causes the overlay layer to remount and
  // the CSS keyframe to restart. Stable across progress ticks.
  const [wipeKey, setWipeKey] = useState(0);
  const lastPeaksRef = useRef(peaks);
  useEffect(() => {
    if (peaks !== lastPeaksRef.current && peaks && peaks.length > 0) {
      lastPeaksRef.current = peaks;
      setWipeKey((k) => k + 1);
    }
  }, [peaks]);

  // Loading state: faint flat bar so the layout doesn't pop when peaks land.
  if (!peaks || peaks.length === 0 || !bars) {
    return (
      <div
        onMouseDown={handleMouseDown}
        style={{
          position: "relative", height, display: "flex", alignItems: "center",
          cursor: totalSec > 0 ? "pointer" : "default",
        }}
      >
        <div style={{ height: 3, width: "100%", background: "var(--line-strong)", borderRadius: 1 }}>
          <div style={{ height: "100%", width: `${progress * 100}%`, background: accentVar, borderRadius: 1 }} />
        </div>
      </div>
    );
  }

  const viewBox = `0 0 ${peaks.length} 100`;
  const clipRight = (1 - progress) * 100;

  return (
    <div
      onMouseDown={handleMouseDown}
      style={{
        position: "relative", height, cursor: totalSec > 0 ? "pointer" : "default",
      }}
    >
      {/* Unplayed (background) — dim text-faint */}
      <svg
        width="100%" height="100%" viewBox={viewBox} preserveAspectRatio="none"
        style={{
          position: "absolute", inset: 0, display: "block",
          color: "var(--text-faint)", opacity: 0.45,
        }}
      >
        {bars}
      </svg>
      {/* Played (foreground) — accent, revealed by clip-path */}
      <svg
        width="100%" height="100%" viewBox={viewBox} preserveAspectRatio="none"
        style={{
          position: "absolute", inset: 0, display: "block",
          color: accentVar,
          clipPath: `inset(0 ${clipRight}% 0 0)`,
        }}
      >
        {bars}
      </svg>
      {/* Wipe-in overlay (Phase 28). Mounts on every peaks change via the
          incrementing key, plays the wipe keyframe once, then fades out
          leaving the steady-state two layers above visible. Pointer-events
          is none in CSS so it never intercepts the seek drag. */}
      <svg
        key={wipeKey}
        className="q-waveform-wipe"
        width="100%" height="100%" viewBox={viewBox} preserveAspectRatio="none"
        style={{
          position: "absolute", inset: 0, display: "block",
          color: accentVar,
        }}
      >
        {bars}
      </svg>
    </div>
  );
});

// ── Now-playing bar ─────────────────────────────────────────────────
function IconBtn({ children, small, onClick, active, title }: {
  children: React.ReactNode;
  small?: boolean;
  onClick?: () => void;
  active?: boolean;
  title?: string;
}) {
  const baseColor = active ? "var(--accent)" : "var(--text-dim)";
  const hoverColor = active ? "var(--accent)" : "var(--text)";
  return (
    <button onClick={onClick} title={title} style={{
      background: "transparent", border: 0,
      width: small ? 26 : 32, height: small ? 26 : 32,
      color: baseColor, cursor: "pointer",
      display: "grid", placeItems: "center", borderRadius: 3,
      position: "relative",
    }}
      onMouseEnter={(e) => (e.currentTarget.style.color = hoverColor)}
      onMouseLeave={(e) => (e.currentTarget.style.color = baseColor)}
    >{children}</button>
  );
}

interface NowPlayingBarProps {
  current: QueueTrack;
  currentAlbum: Album;
  playing: boolean;
  setPlaying: (p: boolean) => void;
  initialPosition: number;
  initialDuration: number;
  exclusive: boolean;
  exclusiveEnabled: boolean;
  onToggleExclusive: () => void;
  liveTrack: TrackInfo | null;
  onPrev?: () => void;
  onNext?: () => void;
  volume: number;
  onVolumeChange: (v: number) => void;
  shuffle: boolean;
  onShuffleToggle: () => void;
  repeatMode: "off" | "all" | "one";
  onRepeatCycle: () => void;
  onOpenFullscreen: () => void;
  onOpenEq: () => void;
  eqEnabled: boolean;
  scrubStyle: ScrubStyle;
  waveformPeaks: number[] | null;
  /// Currently-playing track id (from the queue). null when nothing has
  /// been loaded yet; the heart button is disabled in that case.
  currentTrackId: number | null;
  isFavorite: boolean;
  onToggleFavorite: () => void;
  /// Sleep timer state. Indicator chip renders only when active.
  sleepTimer: SleepTimer;
  onCancelSleepTimer: () => void;
}

function NowPlayingBar({
  current, currentAlbum, playing, setPlaying,
  initialPosition, initialDuration,
  exclusive, exclusiveEnabled, onToggleExclusive,
  liveTrack,
  onPrev, onNext, volume, onVolumeChange,
  shuffle, onShuffleToggle, repeatMode, onRepeatCycle,
  onOpenFullscreen, onOpenEq, eqEnabled,
  scrubStyle, waveformPeaks,
  currentTrackId, isFavorite, onToggleFavorite,
  sleepTimer, onCancelSleepTimer,
}: NowPlayingBarProps) {
  // Subscribe to the shared playback-state store and interpolate position
  // locally via requestAnimationFrame. The store fans out from a single
  // Tauri listener (saves N − 1 deserializations per emit), and the
  // interpolator gives us a 60 fps scrub bar from the 4 Hz event stream.
  // initialPosition/initialDuration are honoured if the store hasn't
  // received its first event yet.
  const interp = useInterpolatedPosition();
  const position = interp.position || initialPosition;
  const duration = interp.duration || initialDuration;
  const totalSec = duration || 226;
  const progress = totalSec > 0 ? position / totalSec : 0;
  const elapsed = Math.floor(position);
  const remaining = Math.max(0, Math.floor(totalSec - position));

  // Prefer the live decoder's format info over the (mock) album metadata.
  const liveBit = liveTrack?.bits_per_sample ?? currentAlbum.bit;
  const liveRate = liveTrack ? liveTrack.sample_rate / 1000 : currentAlbum.rate;
  const liveFmt = liveTrack ? (liveBit === 1 ? "DSD" : "FLAC") : currentAlbum.format;
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  // Memoized seek handler — this used to be `(s) => invoke("seek_to", …)`
  // declared inline twice (both scrub-bar variants), allocating two fresh
  // function instances per render. Identity-stable via useCallback.
  const onSeek = useCallback((s: number) => {
    invoke("seek_to", { secs: s }).catch(console.error);
  }, []);

  return (
    // NowPlayingBar is the most-frequently-re-rendered host in the app
    // (4 Hz tick during playback + every rAF step from the interpolator).
    // Static layout / borders / gradient live in CSS (.q-npb*) so each
    // render no longer allocates a forest of style objects.
    <div className="q-npb">
      {/* Left: art + meta */}
      <div className="q-npb-left">
        <div onClick={onOpenFullscreen} title="Fullscreen (F)" className="q-npb-art">
          <CrossfadeCover album={currentAlbum} size={60} />
        </div>
        <div className="q-npb-meta">
          <div className="q-npb-title">
            {current.title.split(" — ")[1] ?? current.title}
          </div>
          <div className="q-npb-subtitle">
            {currentAlbum.artist}
            <span style={{ margin: "0 6px", color: "var(--text-faint)" }}>·</span>
            <span style={{ fontStyle: "italic", fontFamily: "var(--serif)" }}>{currentAlbum.title.split(",")[0]}</span>
          </div>
          <div className="q-npb-fav-row">
            <button
              onClick={() => { if (currentTrackId != null) onToggleFavorite(); }}
              disabled={currentTrackId == null}
              title={
                currentTrackId == null
                  ? "No track loaded"
                  : isFavorite ? "Remove from favorites" : "Add to favorites"
              }
              className={`q-npb-fav${isFavorite ? " is-fav" : ""}`}
              style={{ color: isFavorite ? "var(--accent)" : "var(--text-faint)" }}
            >
              <svg width="12" height="12" viewBox="0 0 16 16">
                <path
                  d="M8 14 C8 14 1 9.5 1 5.5 A3.5 3.5 0 0 1 8 3.5 A3.5 3.5 0 0 1 15 5.5 C15 9.5 8 14 8 14 Z"
                  fill={isFavorite ? "currentColor" : "none"}
                  stroke="currentColor"
                  strokeWidth="1.2"
                />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* Center: transport + scrubber */}
      <div className="q-npb-center" data-scrub={scrubStyle}>
        <div className="q-npb-transport">
          <IconBtn onClick={onPrev} title="Previous">
            <svg width="14" height="14" viewBox="0 0 16 16">
              <path d="M3 4 V12 M14 3 L7 8 L14 13 Z" stroke="currentColor" fill="currentColor" strokeWidth="0.5" strokeLinejoin="round" />
            </svg>
          </IconBtn>
          <IconBtn small onClick={onShuffleToggle} active={shuffle} title={shuffle ? "Shuffle: on" : "Shuffle: off"}>
            {/* Shuffle: two crossing arrows */}
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
              <path d="M1 3 L4 3 L9 11 L13 11 M10 8 L13 11 L10 14" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M1 11 L4 11 L6 8 M8 6 L9 3 L13 3 M10 0 L13 3 L10 6" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </IconBtn>
          <button onClick={() => setPlaying(!playing)} className="q-npb-play">
            {playing
              ? <svg width="14" height="14" viewBox="0 0 14 14"><rect x="3" y="2" width="3" height="10" fill="var(--bg)" /><rect x="8" y="2" width="3" height="10" fill="var(--bg)" /></svg>
              : <svg width="14" height="14" viewBox="0 0 14 14"><path d="M4 2 L12 7 L4 12 Z" fill="var(--bg)" /></svg>
            }
          </button>
          <IconBtn small onClick={onRepeatCycle} active={repeatMode !== "off"} title={`Repeat: ${repeatMode}`}>
            {/* Repeat: loop with arrow */}
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
              <path d="M3 5 L3 4 A1.5 1.5 0 0 1 4.5 2.5 L9.5 2.5 L8 1 M8 4 L9.5 2.5 M11 9 L11 10 A1.5 1.5 0 0 1 9.5 11.5 L4.5 11.5 L6 13 M6 10 L4.5 11.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {repeatMode === "one" && (
              <span style={{
                position: "absolute", right: 2, bottom: 1,
                fontSize: 7, fontFamily: "var(--mono)", fontWeight: 600,
                color: "var(--accent)", lineHeight: 1,
                background: "var(--bg-elev)", padding: "1px 2px",
                borderRadius: 1,
              }}>1</span>
            )}
          </IconBtn>
          <IconBtn onClick={onNext} title="Next">
            <svg width="14" height="14" viewBox="0 0 16 16">
              <path d="M13 4 V12 M2 3 L9 8 L2 13 Z" stroke="currentColor" fill="currentColor" strokeWidth="0.5" strokeLinejoin="round" />
            </svg>
          </IconBtn>
        </div>

        {/* Scrubber — switches between flat bar and waveform per setting */}
        <div className="q-npb-scrub">
          <span className="mono q-npb-time left">{fmt(elapsed)}</span>
          {scrubStyle === "waveform" ? (
            <WaveformScrubBar
              peaks={waveformPeaks}
              progress={progress}
              totalSec={totalSec}
              onSeekSecs={onSeek}
              height={32}
            />
          ) : (
            <FlatScrubBar
              progress={progress}
              totalSec={totalSec}
              onSeekSecs={onSeek}
            />
          )}
          <span className="mono q-npb-time">−{fmt(remaining)}</span>
        </div>
      </div>

      {/* Right: signal + visualizer + volume */}
      <div className="q-npb-right">
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
          <SpectrumLive bars={22} height={22} />
          <div className="q-signal-row">
            <div className="q-signal-dot" />
            <span className="q-signal-text">
              {liveFmt === "DSD" ? `DSD${Math.floor(liveRate)}` : `${liveBit} BIT · ${liveRate} kHz`}
            </span>
            {/* Mode chip — reflects the engine's actual current mode AND
                doubles as the user's toggle. Accent when exclusive is active,
                muted when shared. Dashed border = user wants exclusive but
                the negotiation failed (e.g. another app has the device). */}
            <button
              onClick={onToggleExclusive}
              title={
                exclusiveEnabled
                  ? "Exclusive mode enabled — click to switch to shared so other apps can play audio"
                  : "Shared mode — click to attempt exclusive (bit-perfect) negotiation"
              }
              className={
                "q-mode-chip" +
                (exclusive ? " is-excl" : "") +
                (exclusiveEnabled && !exclusive ? " is-pending" : "")
              }
            >
              {exclusive ? "EXCL" : "SHARED"}
            </button>
            {/* EQ button */}
            <button
              onClick={onOpenEq}
              title="Parametric EQ"
              className={"q-eq-chip" + (eqEnabled ? " is-on" : "")}
            >EQ</button>
            {/* Phase 24: Sleep timer indicator. Only renders when a timer
                is active; click to cancel. Setup happens in Settings. */}
            <SleepTimerIndicator timer={sleepTimer} onCancel={onCancelSleepTimer} />
          </div>
        </div>

        <div className="q-divider-v" />

        <VolumeKnob value={volume} onChange={onVolumeChange} />
      </div>
    </div>
  );
}

// ── Sleep timer (Phase 24) ─────────────────────────────────────────
type SleepTimer =
  | { kind: "off" }
  | { kind: "minutes"; endsAt: number; total: number }
  | { kind: "end-of-track" };

const SLEEP_PRESETS = [15, 30, 60, 90];

/// Inert indicator chip rendered in the NowPlayingBar toolbar — visible
/// only when a timer is active. Click cancels. Setup happens in the
/// Settings → Playback → Sleep timer panel; this chip is purely an
/// "ambient status" widget so the toolbar isn't cluttered when nothing's
/// scheduled.
function SleepTimerIndicator({
  timer, onCancel,
}: {
  timer: SleepTimer;
  onCancel: () => void;
}) {
  // Tick the label every 30s so the "Xm left" stays current.
  const [, setNowTick] = useState(0);
  useEffect(() => {
    if (timer.kind !== "minutes") return;
    const id = setInterval(() => setNowTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, [timer.kind]);

  if (timer.kind === "off") return null;

  const minutesLeft = timer.kind === "minutes"
    ? Math.max(0, Math.ceil((timer.endsAt - Date.now()) / 60_000))
    : 0;
  const label = timer.kind === "end-of-track" ? "EOT" : `${minutesLeft}m`;
  const titleText = timer.kind === "end-of-track"
    ? "Sleep at end of current track — click to cancel"
    : `Sleep in ${minutesLeft} minute${minutesLeft === 1 ? "" : "s"} — click to cancel`;

  return (
    <button
      onClick={onCancel}
      title={titleText}
      className="q-eq-chip is-on"
      style={{ display: "flex", alignItems: "center", gap: 4 }}
    >
      <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
        <path d="M10 7.5 A4.5 4.5 0 1 1 4.5 2 A3.5 3.5 0 0 0 10 7.5 Z"
          fill="currentColor" stroke="currentColor" strokeWidth="0.5" strokeLinejoin="round" />
      </svg>
      <span style={{ fontSize: 9, letterSpacing: "0.05em" }}>{label}</span>
    </button>
  );
}

/// Settings-side controls for setting / cancelling the sleep timer.
/// Reused exactly the preset layout from the old chip popover.
function SleepTimerControls({
  timer, onSetMinutes, onSetEndOfTrack, onCancel,
}: {
  timer: SleepTimer;
  onSetMinutes: (mins: number) => void;
  onSetEndOfTrack: () => void;
  onCancel: () => void;
}) {
  const [custom, setCustom] = useState("");
  const minutesLeft = timer.kind === "minutes"
    ? Math.max(0, Math.ceil((timer.endsAt - Date.now()) / 60_000))
    : 0;
  const statusLine = timer.kind === "off"
    ? null
    : timer.kind === "end-of-track"
      ? "Active — stops at end of current track."
      : `Active — stops in ${minutesLeft} minute${minutesLeft === 1 ? "" : "s"}.`;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {statusLine && (
        <div style={{ fontSize: 12, color: "var(--accent)" }}>{statusLine}</div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6 }}>
        {SLEEP_PRESETS.map((m) => (
          <button
            key={m}
            onClick={() => onSetMinutes(m)}
            style={{
              padding: "10px 12px",
              background: "transparent",
              color: "var(--text)",
              border: "1px solid var(--line-strong)",
              borderRadius: 3,
              fontSize: 11, fontFamily: "var(--sans)",
              cursor: "pointer",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--accent)")}
            onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--line-strong)")}
          >{m} min</button>
        ))}
      </div>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <input
          type="number"
          min={1}
          max={600}
          placeholder="custom min"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          style={{
            flex: 1, minWidth: 0,
            background: "var(--bg-elev)",
            border: "1px solid var(--line-strong)",
            borderRadius: 3,
            padding: "8px 10px",
            color: "var(--text)",
            fontSize: 11, fontFamily: "var(--mono)",
            outline: "none",
          }}
        />
        <button
          onClick={() => {
            const n = parseInt(custom, 10);
            if (!isNaN(n) && n > 0 && n <= 600) {
              onSetMinutes(n);
              setCustom("");
            }
          }}
          style={{
            padding: "8px 14px",
            background: "var(--accent)",
            color: "var(--bg)",
            border: 0,
            borderRadius: 3,
            fontSize: 10, letterSpacing: "0.14em",
            textTransform: "uppercase", fontWeight: 500,
            fontFamily: "var(--sans)",
            cursor: "pointer",
          }}
        >Set</button>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button
          onClick={onSetEndOfTrack}
          style={{
            flex: 1,
            padding: "9px 12px",
            background: timer.kind === "end-of-track" ? "var(--accent-soft)" : "transparent",
            color: timer.kind === "end-of-track" ? "var(--accent)" : "var(--text)",
            border: "1px solid " + (timer.kind === "end-of-track" ? "var(--accent)" : "var(--line-strong)"),
            borderRadius: 3,
            fontSize: 11, fontFamily: "var(--sans)",
            cursor: "pointer",
            textAlign: "center",
          }}
        >End of current track</button>
        {timer.kind !== "off" && (
          <button
            onClick={onCancel}
            style={{
              padding: "9px 14px",
              background: "transparent",
              color: "var(--danger)",
              border: "1px solid var(--line)",
              borderRadius: 3,
              fontSize: 10, letterSpacing: "0.14em",
              textTransform: "uppercase",
              fontFamily: "var(--sans)",
              cursor: "pointer",
            }}
          >Cancel</button>
        )}
      </div>
    </div>
  );
}

// ── Fullscreen now-playing overlay ────────────────────────────────────
interface FullscreenPlayerProps {
  open: boolean;
  onClose: () => void;
  currentAlbum: Album;
  current: QueueTrack;
  playing: boolean;
  setPlaying: (p: boolean) => void;
  initialPosition: number;
  initialDuration: number;
  exclusive: boolean;
  exclusiveEnabled: boolean;
  onToggleExclusive: () => void;
  liveTrack: TrackInfo | null;
  onPrev?: () => void;
  onNext?: () => void;
  volume: number;
  onVolumeChange: (v: number) => void;
  shuffle: boolean;
  onShuffleToggle: () => void;
  repeatMode: "off" | "all" | "one";
  onRepeatCycle: () => void;
  onOpenMiniPlayer: () => void;
  accentName: string;
  /// v0.2.0 dynamic accent: the extracted vibrant color from the currently
  /// playing album's cover, or null if extraction hasn't run / no cover.
  /// FullscreenPlayer always wants a dark-friendly accent (backdrop is
  /// near-black), and the Rust extractor already clamps lightness into a
  /// good band, so we can use this raw when present.
  dynamicAccentColor: string | null;
  dynamicAccent: boolean;
  scrubStyle: ScrubStyle;
  waveformPeaks: number[] | null;
  /// Currently-playing track id; null = nothing loaded. When null the
  /// heart button is shown disabled.
  currentTrackId: number | null;
  isFavorite: boolean;
  onToggleFavorite: () => void;
}

function FullscreenPlayer({
  open, onClose,
  currentAlbum, current, playing, setPlaying,
  initialPosition, initialDuration,
  exclusive, exclusiveEnabled, onToggleExclusive,
  liveTrack, onPrev, onNext, volume, onVolumeChange,
  shuffle, onShuffleToggle, repeatMode, onRepeatCycle,
  onOpenMiniPlayer, accentName,
  dynamicAccentColor, dynamicAccent,
  scrubStyle, waveformPeaks,
  currentTrackId, isFavorite, onToggleFavorite,
}: FullscreenPlayerProps) {
  // Same shared-store + rAF-interpolation strategy as NowPlayingBar.
  const interp = useInterpolatedPosition();
  const position = interp.position || initialPosition;
  const duration = interp.duration || initialDuration;
  // Phase 23: lyrics overlay state. Local to FullscreenPlayer so it
  // automatically resets when the user closes the player. The lyrics
  // themselves are fetched inside LyricsPanel.
  const [lyricsOpen, setLyricsOpen] = useState(false);

  // Escape closes the overlay.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const artUrl = currentAlbum.coverUrl ?? null;
  const totalSec = duration || 1;
  const progress = totalSec > 0 ? position / totalSec : 0;
  const elapsed = Math.floor(position);
  const remaining = Math.max(0, Math.floor(totalSec - position));
  const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  const liveBit = liveTrack?.bits_per_sample ?? currentAlbum.bit;
  const liveRate = liveTrack ? liveTrack.sample_rate / 1000 : currentAlbum.rate;
  const liveFmt = liveTrack ? (liveBit === 1 ? "DSD" : "FLAC") : currentAlbum.format;
  const trackTitle = current.title.split(" — ")[1] ?? current.title;

  // Pick the accent: dynamic-from-cover wins when enabled and we've got
  // an extracted color, otherwise fall back to the user's chosen accent's
  // dark variant. The Rust extractor clamps lightness into [0.42, 0.68]
  // which reads well against the blurred-dark backdrop, so no further
  // adjustment is needed here.
  const fsAccent = (dynamicAccent && dynamicAccentColor)
    ? dynamicAccentColor
    : getAccentHex(accentName, "dark");
  const fsAccentDim = mix(fsAccent, "#000000", 0.35);

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 9999,
        display: "flex", flexDirection: "column", overflow: "hidden",
        // Solid background so the overlay is always fully opaque even before
        // the blurred art backdrop has loaded (or if artUrl 404s / is null).
        // Without this, the 38%-opacity vignette is the only thing blocking
        // the underlying app — and 62% of it bleeds through.
        background: "#0a0a0c",
        // Local CSS-var scope so SpectrumLive + any other child using var(--accent)
        // always sees the dark-mode accent, regardless of the active app theme.
        "--accent": fsAccent,
        "--accent-dim": fsAccentDim,
      } as React.CSSProperties}
    >
      {/* ── Blurred art backdrop (always dark) ── */}
      {artUrl && (
        <div style={{
          position: "absolute", inset: "-10%",
          backgroundImage: `url("${artUrl}")`,
          backgroundSize: "cover", backgroundPosition: "center",
          backgroundColor: "#0a0a0c",
          filter: "blur(60px) brightness(0.22) saturate(1.5)",
        }} />
      )}
      {/* Extra vignette for contrast */}
      <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.38)" }} />

      {/* ── Interactive content ── */}
      <div style={{ position: "relative", zIndex: 1, flex: 1, display: "flex", flexDirection: "column", padding: "0 48px" }}>

        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", height: 52, flexShrink: 0 }}>
          <button onClick={onClose} style={{
            background: "transparent", border: 0, cursor: "pointer",
            display: "flex", alignItems: "center", gap: 8,
            color: "rgba(255,255,255,0.55)", fontSize: 13, fontFamily: "var(--sans)",
          }}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M10 4L6 8L10 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Back
          </button>
          <LogoMark kind="prism" size={18} />
          <button onClick={onOpenMiniPlayer} style={{
            background: "transparent", border: "1px solid rgba(255,255,255,0.18)",
            color: "rgba(255,255,255,0.45)", cursor: "pointer",
            display: "flex", alignItems: "center", gap: 6,
            fontSize: 10, fontFamily: "var(--sans)", letterSpacing: "0.16em",
            padding: "4px 10px", borderRadius: 3,
          }}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <rect x="0.5" y="2.5" width="11" height="7" rx="1" stroke="currentColor" strokeWidth="1" />
              <line x1="3" y1="6" x2="9" y2="6" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
            </svg>
            MINI
          </button>
        </div>

        {/* Main: art + info */}
        <div style={{
          flex: 1, display: "grid", gridTemplateColumns: "1fr 1fr",
          gap: 60, alignItems: "center",
          maxWidth: 1040, margin: "0 auto", width: "100%",
        }}>
          {/* Left: large album art */}
          <div style={{ display: "flex", justifyContent: "center", alignItems: "center" }}>
            <div style={{
              width: "min(380px, 38vw)", aspectRatio: "1 / 1",
              boxShadow: "0 40px 100px -24px rgba(0,0,0,0.9), 0 12px 30px -10px rgba(0,0,0,0.7)",
              borderRadius: 6, overflow: "hidden",
            }}>
              <Cover album={currentAlbum} size="100%" />
            </div>
          </div>

          {/* Right: metadata + controls */}
          <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
            {/* Track info + favorite */}
            <div>
              <div style={{
                fontFamily: "var(--serif)", fontStyle: "italic",
                fontSize: 30, lineHeight: 1.18, color: "rgba(255,255,255,0.95)",
                overflow: "hidden",
                display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
              }}>{trackTitle}</div>
              <div style={{ fontSize: 15, color: "rgba(255,255,255,0.62)", marginTop: 10 }}>
                {currentAlbum.artist}
              </div>
              <div style={{
                display: "flex", alignItems: "center", gap: 12,
                marginTop: 4,
              }}>
                <div style={{
                  fontSize: 13, color: "rgba(255,255,255,0.38)",
                  fontStyle: "italic", fontFamily: "var(--serif)",
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  flex: "0 1 auto", minWidth: 0,
                }}>
                  {currentAlbum.title}{currentAlbum.year ? ` · ${currentAlbum.year}` : ""}
                </div>
                <button
                  onClick={() => { if (currentTrackId != null) onToggleFavorite(); }}
                  disabled={currentTrackId == null}
                  title={
                    currentTrackId == null
                      ? "No track loaded"
                      : isFavorite ? "Remove from favorites" : "Add to favorites"
                  }
                  style={{
                    background: "transparent", border: 0, padding: 4,
                    cursor: currentTrackId == null ? "default" : "pointer",
                    color: isFavorite ? fsAccent : "rgba(255,255,255,0.45)",
                    display: "grid", placeItems: "center",
                    transition: "color 120ms, transform 120ms",
                    flexShrink: 0,
                  }}
                  onMouseEnter={(e) => {
                    if (currentTrackId != null && !isFavorite) {
                      e.currentTarget.style.color = "rgba(255,255,255,0.85)";
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (currentTrackId != null && !isFavorite) {
                      e.currentTarget.style.color = "rgba(255,255,255,0.45)";
                    }
                  }}
                >
                  <svg width="18" height="18" viewBox="0 0 16 16">
                    <path
                      d="M8 14 C8 14 1 9.5 1 5.5 A3.5 3.5 0 0 1 8 3.5 A3.5 3.5 0 0 1 15 5.5 C15 9.5 8 14 8 14 Z"
                      fill={isFavorite ? "currentColor" : "none"}
                      stroke="currentColor"
                      strokeWidth="1.2"
                    />
                  </svg>
                </button>
                {/* Phase 23: lyrics toggle. Lazily fetches when opened
                    so the FullscreenPlayer doesn't pay the IPC cost for
                    every track change while the user isn't looking. */}
                <button
                  onClick={() => setLyricsOpen((o) => !o)}
                  disabled={currentTrackId == null}
                  title={currentTrackId == null ? "No track loaded" : "Lyrics"}
                  style={{
                    background: "transparent", border: 0, padding: 4,
                    cursor: currentTrackId == null ? "default" : "pointer",
                    color: lyricsOpen ? fsAccent : "rgba(255,255,255,0.45)",
                    display: "grid", placeItems: "center",
                    transition: "color 120ms",
                    flexShrink: 0,
                  }}
                  onMouseEnter={(e) => { if (currentTrackId != null && !lyricsOpen) e.currentTarget.style.color = "rgba(255,255,255,0.85)"; }}
                  onMouseLeave={(e) => { if (currentTrackId != null && !lyricsOpen) e.currentTarget.style.color = "rgba(255,255,255,0.45)"; }}
                >
                  <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
                    <path d="M2 3 L11 3 M2 6 L13 6 M2 9 L9 9 M2 12 L12 12"
                      stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                  </svg>
                </button>
              </div>
            </div>

            {/* Scrubber — flat bar or waveform per user setting.
                Waveform is rendered taller here (60 px) so it feels at
                home in the fullscreen player's larger layout. */}
            <div>
              {scrubStyle === "waveform" ? (
                <WaveformScrubBar
                  peaks={waveformPeaks}
                  progress={progress}
                  totalSec={totalSec}
                  onSeekSecs={(s) => invoke("seek_to", { secs: s }).catch(console.error)}
                  accentVar={fsAccent}
                  height={60}
                />
              ) : (
                <FlatScrubBar
                  progress={progress}
                  totalSec={totalSec}
                  onSeekSecs={(s) => invoke("seek_to", { secs: s }).catch(console.error)}
                  accentVar={fsAccent}
                />
              )}
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6 }}>
                <span className="mono" style={{ fontSize: 10, color: "rgba(255,255,255,0.35)" }}>{fmtTime(elapsed)}</span>
                <span className="mono" style={{ fontSize: 10, color: "rgba(255,255,255,0.35)" }}>−{fmtTime(remaining)}</span>
              </div>
            </div>

            {/* Transport */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 26 }}>
              <button onClick={onPrev} style={{ background: "transparent", border: 0, color: "rgba(255,255,255,0.70)", cursor: "pointer", padding: 4 }} title="Previous">
                <svg width="18" height="18" viewBox="0 0 16 16"><path d="M3 4 V12 M14 3 L7 8 L14 13 Z" stroke="currentColor" fill="currentColor" strokeWidth="0.5" strokeLinejoin="round" /></svg>
              </button>
              <button onClick={onShuffleToggle} style={{ background: "transparent", border: 0, color: shuffle ? fsAccent : "rgba(255,255,255,0.38)", cursor: "pointer", padding: 4 }} title={shuffle ? "Shuffle: on" : "Shuffle: off"}>
                <svg width="15" height="15" viewBox="0 0 14 14" fill="none">
                  <path d="M1 3 L4 3 L9 11 L13 11 M10 8 L13 11 L10 14" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M1 11 L4 11 L6 8 M8 6 L9 3 L13 3 M10 0 L13 3 L10 6" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <button
                onClick={() => setPlaying(!playing)}
                style={{
                  width: 62, height: 62, borderRadius: "50%", background: fsAccent,
                  border: 0, cursor: "pointer", display: "grid", placeItems: "center",
                  boxShadow: `0 8px 24px -6px ${fsAccent}aa`,
                  transition: "transform 80ms",
                }}
                onMouseDown={(e) => (e.currentTarget.style.transform = "scale(0.95)")}
                onMouseUp={(e) => (e.currentTarget.style.transform = "scale(1)")}
                onMouseLeave={(e) => (e.currentTarget.style.transform = "scale(1)")}
              >
                {playing
                  ? <svg width="20" height="20" viewBox="0 0 14 14"><rect x="3" y="2" width="3" height="10" fill="white" /><rect x="8" y="2" width="3" height="10" fill="white" /></svg>
                  : <svg width="20" height="20" viewBox="0 0 14 14"><path d="M4 2 L12 7 L4 12 Z" fill="white" /></svg>
                }
              </button>
              <button onClick={onRepeatCycle} style={{ position: "relative", background: "transparent", border: 0, color: repeatMode !== "off" ? fsAccent : "rgba(255,255,255,0.38)", cursor: "pointer", padding: 4 }} title={`Repeat: ${repeatMode}`}>
                <svg width="15" height="15" viewBox="0 0 14 14" fill="none">
                  <path d="M3 5 L3 4 A1.5 1.5 0 0 1 4.5 2.5 L9.5 2.5 L8 1 M8 4 L9.5 2.5 M11 9 L11 10 A1.5 1.5 0 0 1 9.5 11.5 L4.5 11.5 L6 13 M6 10 L4.5 11.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {repeatMode === "one" && <span style={{ position: "absolute", right: 1, bottom: 1, fontSize: 7, fontFamily: "var(--mono)", fontWeight: 600, color: fsAccent }}>1</span>}
              </button>
              <button onClick={onNext} style={{ background: "transparent", border: 0, color: "rgba(255,255,255,0.70)", cursor: "pointer", padding: 4 }} title="Next">
                <svg width="18" height="18" viewBox="0 0 16 16"><path d="M13 4 V12 M2 3 L9 8 L2 13 Z" stroke="currentColor" fill="currentColor" strokeWidth="0.5" strokeLinejoin="round" /></svg>
              </button>
            </div>

            {/* Volume */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10 }}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ color: "rgba(255,255,255,0.38)", flexShrink: 0 }}>
                <path d="M2 5H5L8 2V12L5 9H2V5Z" fill="currentColor" />
                <path d="M10 4.5C11.2 5.4 11.8 6.2 11.8 7C11.8 7.8 11.2 8.6 10 9.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
              </svg>
              <input
                type="range" min={0} max={1} step={0.01}
                value={volume}
                onChange={(e) => onVolumeChange(parseFloat(e.target.value))}
                style={{ width: 130, cursor: "pointer", accentColor: fsAccent }}
              />
              <span className="mono" style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", minWidth: 26, textAlign: "left" }}>
                {Math.round(volume * 100)}
              </span>
            </div>
          </div>
        </div>

        {/* Footer: spectrum + format */}
        <div style={{ flexShrink: 0, paddingBottom: 22, display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", justifyContent: "center" }}>
            <SpectrumLive bars={60} height={36} />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", maxWidth: 1040, margin: "0 auto", width: "100%" }}>
            <span className="mono" style={{ fontSize: 9.5, color: "rgba(255,255,255,0.28)", letterSpacing: "0.14em" }}>
              {liveFmt === "DSD" ? `DSD${Math.floor(liveRate)}` : `${liveFmt} · ${liveBit}-BIT · ${liveRate} kHz`}
            </span>
            <button onClick={onToggleExclusive} style={{
              fontSize: 8.5, letterSpacing: "0.18em", fontFamily: "var(--mono)",
              padding: "1px 6px", borderRadius: 2, background: "transparent", cursor: "pointer",
              color: exclusive ? fsAccent : "rgba(255,255,255,0.26)",
              border: `1px ${exclusiveEnabled && !exclusive ? "dashed" : "solid"} ${exclusive ? fsAccent : "rgba(255,255,255,0.18)"}`,
            }}>
              {exclusive ? "EXCL" : "SHARED"}
            </button>
          </div>
        </div>

      </div>

      {/* Phase 23: lyrics overlay. Sits above the fullscreen player chrome
          but inside the same fixed-position container so the user's blurred
          album-art backdrop bleeds through. */}
      {lyricsOpen && currentTrackId != null && (
        <LyricsPanel
          trackId={currentTrackId}
          position={position}
          onClose={() => setLyricsOpen(false)}
          onSeek={(s) => invoke("seek_to", { secs: s }).catch(console.error)}
          accent={fsAccent}
        />
      )}
    </div>
  );
}

// ── Lyrics panel (Phase 23) ────────────────────────────────────────
interface LyricsPanelProps {
  trackId: number;
  position: number;
  onClose: () => void;
  onSeek: (secs: number) => void;
  accent: string;
}

interface SyncedLine { time: number; text: string }
interface TrackLyrics { unsynced: string | null; synced: SyncedLine[] }

/// Fullscreen lyrics overlay inside FullscreenPlayer. Two modes:
///   - Synced lyrics (.lrc sidecar exists) → centered current line, dim
///     surrounding lines, auto-scroll, click to seek
///   - Plain lyrics (embedded USLT/LYRICS only) → scrollable block of text
/// Falls back to a friendly empty state when neither is available.
function LyricsPanel({ trackId, position, onClose, onSeek, accent }: LyricsPanelProps) {
  const [lyrics, setLyrics] = useState<TrackLyrics | null>(null);
  const [loading, setLoading] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);

  // Fetch lyrics whenever the track changes. The cache here is the OS file
  // system — the Rust command re-reads the tags / .lrc sidecar each call,
  // which is fast for a single file and saves us from invalidation games.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setLyrics(null);
    invoke<TrackLyrics>("get_track_lyrics", { trackId })
      .then((data) => {
        if (alive) setLyrics(data);
      })
      .catch((err) => console.error("[quartz] get_track_lyrics failed:", err))
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [trackId]);

  // Determine the current line index for synced lyrics. We scan in order
  // since there are typically only a few hundred lines per song — a binary
  // search would be marginal gain and harder to maintain.
  const currentIdx = useMemo(() => {
    if (!lyrics?.synced || lyrics.synced.length === 0) return -1;
    let idx = -1;
    for (let i = 0; i < lyrics.synced.length; i++) {
      if (lyrics.synced[i].time <= position) idx = i;
      else break;
    }
    return idx;
  }, [lyrics, position]);

  // Auto-scroll the current synced line into view. CSS `scroll-behavior:
  // smooth` on the container animates each jump.
  useEffect(() => {
    if (currentIdx < 0) return;
    const container = containerRef.current;
    if (!container) return;
    const line = container.querySelector<HTMLDivElement>(`[data-lrc="${currentIdx}"]`);
    if (line) {
      const containerRect = container.getBoundingClientRect();
      const lineRect = line.getBoundingClientRect();
      const offset = lineRect.top - containerRect.top - containerRect.height / 2 + lineRect.height / 2;
      container.scrollBy({ top: offset, behavior: "smooth" });
    }
  }, [currentIdx]);

  return (
    <div style={{
      position: "absolute", inset: 0, zIndex: 2,
      background: "rgba(8,8,10,0.78)",
      backdropFilter: "blur(20px)",
      display: "flex", flexDirection: "column",
    }}>
      {/* Header with close button */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "18px 48px", flexShrink: 0,
      }}>
        <div className="micro-strong" style={{ color: accent, letterSpacing: "0.2em" }}>
          Lyrics
        </div>
        <button
          onClick={onClose}
          style={{
            background: "transparent", border: 0, cursor: "pointer",
            color: "rgba(255,255,255,0.55)", padding: 6,
            display: "grid", placeItems: "center",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.color = "rgba(255,255,255,0.9)")}
          onMouseLeave={(e) => (e.currentTarget.style.color = "rgba(255,255,255,0.55)")}
          title="Close lyrics"
        >
          <svg width="14" height="14" viewBox="0 0 14 14">
            <line x1="2" y1="2" x2="12" y2="12" stroke="currentColor" strokeWidth="1.3" />
            <line x1="12" y1="2" x2="2" y2="12" stroke="currentColor" strokeWidth="1.3" />
          </svg>
        </button>
      </div>

      {/* Body */}
      <div
        ref={containerRef}
        style={{
          flex: 1, overflowY: "auto", scrollBehavior: "smooth",
          padding: "30% 48px",
          textAlign: "center",
        }}
      >
        {loading ? (
          <div style={{ color: "rgba(255,255,255,0.55)" }}>Loading lyrics…</div>
        ) : (lyrics?.synced?.length ?? 0) > 0 ? (
          lyrics!.synced.map((line, i) => {
            const isCurrent = i === currentIdx;
            const distance = Math.abs(i - currentIdx);
            const opacity = currentIdx < 0
              ? 0.5
              : isCurrent ? 1
              : distance === 1 ? 0.55
              : distance === 2 ? 0.35
              : 0.22;
            return (
              <div
                key={i}
                data-lrc={i}
                onClick={() => onSeek(line.time)}
                style={{
                  fontFamily: "var(--serif)",
                  fontSize: isCurrent ? 30 : 22,
                  fontStyle: isCurrent ? "normal" : "italic",
                  fontWeight: isCurrent ? 500 : 400,
                  lineHeight: 1.4,
                  color: isCurrent ? "#fff" : "rgba(255,255,255,0.9)",
                  opacity,
                  padding: "8px 0",
                  cursor: "pointer",
                  transition: "all 200ms ease",
                }}
              >
                {line.text || "♪"}
              </div>
            );
          })
        ) : lyrics?.unsynced ? (
          <div style={{
            fontFamily: "var(--serif)", fontSize: 18, lineHeight: 1.7,
            color: "rgba(255,255,255,0.85)", whiteSpace: "pre-wrap",
            textAlign: "left", maxWidth: 540, margin: "0 auto",
          }}>
            {lyrics.unsynced}
          </div>
        ) : (
          <div style={{
            display: "grid", placeItems: "center", height: "100%",
            color: "rgba(255,255,255,0.45)", fontStyle: "italic",
            fontFamily: "var(--serif)", fontSize: 18,
          }}>
            No lyrics for this track.<br />
            <span style={{ fontSize: 12, marginTop: 14, color: "rgba(255,255,255,0.3)", fontStyle: "normal", fontFamily: "var(--sans)" }}>
              Embed lyrics in the file's USLT/LYRICS tag, or drop a sibling .lrc file next to it.
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Volume knob ─────────────────────────────────────────────────────
interface VolumeKnobProps {
  value: number;
  onChange: (v: number) => void;
}
function VolumeKnob({ value, onChange }: VolumeKnobProps) {
  const v = value;
  const setV = onChange;
  const ref = useRef<HTMLDivElement>(null);

  const onDown = (e: React.MouseEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const update = (ev: MouseEvent) => {
      const dx = ev.clientX - cx, dy = ev.clientY - cy;
      let deg = Math.atan2(dy, dx) * 180 / Math.PI;
      if (deg < -135) deg += 360;
      const norm = (deg - (-135)) / 270;
      setV(Math.max(0, Math.min(1, norm)));
    };
    const onMove = (ev: MouseEvent) => update(ev);
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    update(e.nativeEvent);
  };

  // CSS rotation for the inner indicator line. Must match the SVG outer-tick
  // angle (startA + v*270) so the two markers point the same way. At v=0 the
  // tick is at 7:30 (45° clockwise from 6 o'clock rest position); at v=1 it's
  // at 4:30 (315° clockwise). Previous formula (−135 + v*270, +90 offset) put
  // the inner indicator on the opposite side of the dial.
  const indicatorRotation = 45 + v * 270;
  const dB = v < 0.01 ? "−∞" : (-60 + v * 60).toFixed(1);

  const cx = 28, cy = 28, r = 24;
  const polar = (deg: number, rad = r): [number, number] => {
    const a = (deg - 90) * Math.PI / 180;
    return [cx + rad * Math.cos(a), cy + rad * Math.sin(a)];
  };
  const startA = 225, endA = 495;
  const [sx, sy] = polar(startA);
  const [ex, ey] = polar(endA);
  const trackD = `M ${sx} ${sy} A ${r} ${r} 0 1 1 ${ex} ${ey}`;
  const [fx, fy] = polar(startA + v * 270);
  const fillD = `M ${sx} ${sy} A ${r} ${r} 0 ${v * 270 > 180 ? 1 : 0} 1 ${fx} ${fy}`;
  const [unityX1, unityY1] = polar(endA, r - 2);
  const [unityX2, unityY2] = polar(endA, r + 3);
  const [ix1, iy1] = polar(startA + v * 270, 19);
  const [ix2, iy2] = polar(startA + v * 270, 22);

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
      <div style={{ position: "relative", width: 56, height: 56 }}>
        <svg width="56" height="56" viewBox="0 0 56 56" style={{ position: "absolute", inset: 0, overflow: "visible" }}>
          <path d={trackD} fill="none" stroke="var(--line-strong)" strokeWidth="1.5" strokeLinecap="round" />
          {v > 0.005 && (
            <path d={fillD} fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" />
          )}
          <line x1={unityX1} y1={unityY1} x2={unityX2} y2={unityY2} stroke="var(--text-faint)" strokeWidth="0.8" />
          <line x1={ix1} y1={iy1} x2={ix2} y2={iy2}
            stroke="var(--accent)" strokeWidth="2" strokeLinecap="round"
            style={{ filter: "drop-shadow(0 0 3px var(--accent))" }}
          />
        </svg>

        <div ref={ref} onMouseDown={onDown}
          onWheel={(e) => { e.preventDefault(); setV(Math.max(0, Math.min(1, v - e.deltaY * 0.0008))); }}
          style={{
            position: "absolute", top: 10, left: 10, width: 36, height: 36,
            borderRadius: "50%",
            background: "radial-gradient(circle at 50% 28%, #2a2a30 0%, #16161a 55%, #08080a 100%)",
            border: "1px solid #2a2a30", cursor: "grab",
            boxShadow: "inset 0 1px 0 rgba(255,255,255,0.07), inset 0 -1px 2px rgba(0,0,0,0.6), 0 2px 5px rgba(0,0,0,0.5)",
          }}
        >
          <div style={{
            position: "absolute", inset: 5, borderRadius: "50%",
            border: "1px solid rgba(255,255,255,0.04)",
            background: "radial-gradient(circle at 50% 35%, rgba(255,255,255,0.05), transparent 65%)",
          }} />
          <div style={{
            position: "absolute", left: "50%", top: "50%",
            width: 0, height: 0,
            transform: `translate(-50%, -50%) rotate(${indicatorRotation}deg)`,
          }}>
            <div style={{
              position: "absolute", left: "50%", top: 4,
              width: 1.5, height: 6, background: "var(--accent)",
              opacity: 0.55, borderRadius: 1, transform: "translateX(-50%)",
            }} />
          </div>
        </div>
      </div>
      <span className="mono" style={{ fontSize: 9, color: "var(--text-faint)", letterSpacing: "0.08em" }}>{dB} dB</span>
    </div>
  );
}

// ── Root app ────────────────────────────────────────────────────────
type Theme = "dark" | "sepia" | "light" | "rose";

// PbState / TrackInfo declared once near the top of the file, alongside
// the shared pb-state store. Don't redeclare here.

export default function App() {
  const [section, setSection] = useState("albums");
  const [sort, setSort] = usePersistedState<Sort>("sort", "recent");
  // Re-seeds whenever the sort mode changes; only consulted when sort==="random".
  // Each cycle through to "random" produces a fresh shuffle.
  const [randomSeed, setRandomSeed] = useState(() => Math.floor(Math.random() * 0x7fffffff));
  const handleSortChange = (next: Sort) => {
    setSort(next);
    setRandomSeed(Math.floor(Math.random() * 0x7fffffff));
  };
  const [artistView, setArtistView] = usePersistedState<"grid" | "list">("artistView", "grid");
  const [theme, setTheme] = usePersistedState<Theme>("theme", "dark");
  const [accentName, setAccentName] = usePersistedState<string>("accent", "Brass");
  // v0.2.0: dynamic per-album accent extracted from cover art. When on, the
  // UI tint follows whatever's playing; when off, it sticks to the
  // user-chosen `accentName`. Defaults on because it's the headline feature.
  const [dynamicAccent, setDynamicAccent] = usePersistedState<boolean>("dynamicAccent", true);
  const [logo] = useState<LogoKind>("prism");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [fullscreenOpen, setFullscreenOpen] = useState(false);

  const [devices, setDevices] = useState<Device[]>([]);
  // User's selected audio device id. null = use Windows default. Persisted so
  // the DAC choice survives restarts. The Rust audio thread is told about it
  // on mount (see effect below) and again whenever the user picks a new one.
  const [selectedDeviceId, setSelectedDeviceId] = usePersistedState<string | null>("selectedDeviceId", null);
  const onSelectDevice = (id: string) => {
    setSelectedDeviceId(id);
    invoke("set_device", { id }).catch(console.error);
  };
  // Whether the engine should attempt WASAPI exclusive negotiation. Persisted
  // so the user's preference survives restarts. When false, the engine goes
  // straight to shared+convert and other apps can mix audio with us.
  const [exclusiveEnabled, setExclusiveEnabled] = usePersistedState<boolean>("exclusiveEnabled", true);
  const onToggleExclusive = () => {
    const next = !exclusiveEnabled;
    setExclusiveEnabled(next);
    invoke("set_exclusive_mode", { enabled: next }).catch(console.error);
  };
  // fanart.tv API key for the artist photo fetcher. Stored as a plain string;
  // empty = not configured (engine falls back to the Wikidata/Commons path).
  const [fanartApiKey, setFanartApiKey] = usePersistedState<string>("fanartApiKey", "");
  // pbMeta holds the rarely-changing fields (playing / exclusive / track).
  // position and duration update at 10 Hz — keeping them here would re-render
  // the entire App tree 10× per second. Instead they live in pbStateRef (a
  // plain ref) and are read directly by NowPlayingBar / FullscreenPlayer,
  // which subscribe to "playback-state" themselves (same pattern as SpectrumLive).
  const pbStateRef = useRef<PbState>((() => {
    try {
      const raw = localStorage.getItem("quartz:session");
      if (raw) {
        const s = JSON.parse(raw) as { track: TrackInfo | null; position: number; duration: number };
        return { playing: false, position: s.position, duration: s.duration, exclusive: false, track: s.track };
      }
    } catch { /* ignore */ }
    return { playing: false, position: 0, duration: 0, exclusive: false, track: null };
  })());
  const [pbMeta, setPbMeta] = useState<{ playing: boolean; exclusive: boolean; track: TrackInfo | null }>(() => {
    try {
      const raw = localStorage.getItem("quartz:session");
      if (raw) {
        const s = JSON.parse(raw) as { track: TrackInfo | null };
        return { playing: false, exclusive: false, track: s.track };
      }
    } catch { /* ignore */ }
    return { playing: false, exclusive: false, track: null };
  });
  // (spectrumBins state used to live here — moved into SpectrumLive so the
  // 30 Hz event firehose doesn't re-render the whole App tree.)
  // Volume slider fires onChange on every pixel of drag — debounce the
  // localStorage write so we're not stringify-ing a number 60×/sec.
  const [volume, setVolume] = usePersistedState<number>("volume", 0.72, 200);

  const onVolumeChange = (v: number) => {
    setVolume(v);
    invoke("set_volume", { v }).catch(console.error);
  };

  const cycleRepeat = () => {
    const order: Array<"off" | "all" | "one"> = ["off", "all", "one"];
    const i = order.indexOf(repeatMode);
    setRepeatMode(order[(i + 1) % order.length]);
  };

  // Push initial volume to the engine once it's ready
  useEffect(() => {
    invoke("set_volume", { v: volume }).catch(() => { /* ignore — engine may not be ready yet */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist session info (track + position) to localStorage. Save when the
  // position has moved ≥1 second since the last save to throttle writes.
  const lastSavedPosRef = useRef(0);
  useEffect(() => {
    const id = setInterval(() => {
      const { track, position, duration } = pbStateRef.current;
      if (!track) return;
      if (Math.abs(position - lastSavedPosRef.current) < 1) return;
      lastSavedPosRef.current = position;
      setSavedSession({ track, position, duration });
    }, 1000);
    return () => clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Library state
  const [libAlbums, setLibAlbums] = useState<LibraryAlbum[]>([]);
  const [currentLibAlbumId, setCurrentLibAlbumId] = usePersistedState<number | null>("currentLibAlbumId", null);
  // Queue can be 30k+ tracks — debounce the localStorage write so rapid
  // edits don't pin the main thread on JSON.stringify of a multi-MB blob.
  const [queue, setQueue] = usePersistedState<LibraryTrack[]>("queue", [], 300);
  const [queueIndex, setQueueIndex] = usePersistedState<number>("queueIndex", 0);

  // Drag-reorder: move queue[from] so it sits just before queue[insertBefore]
  // in the original-indexing space. The currently-playing index is preserved
  // by re-locating the same track object after the splice — no playback
  // interruption, just the upcoming order changes.
  // Reads via refs so useCallback deps stay stable; the refs are always current.
  const reorderQueue = useCallback((from: number, insertBefore: number) => {
    if (from === insertBefore || from === insertBefore - 1) return;
    const q = queueRef.current;
    const qi = queueIndexRef.current;
    const current = q[qi];
    const newQ = q.slice();
    const [moved] = newQ.splice(from, 1);
    const insertAt = insertBefore > from ? insertBefore - 1 : insertBefore;
    newQ.splice(insertAt, 0, moved);
    setQueue(newQ);
    if (current) {
      const newIdx = newQ.indexOf(current);
      if (newIdx >= 0) setQueueIndex(newIdx);
    }
  }, [setQueue, setQueueIndex]); // eslint-disable-line react-hooks/exhaustive-deps

  // Open (or focus) the always-on-top miniplayer window.
  const openMiniPlayer = useCallback(async () => {
    try {
      const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      const existing = await WebviewWindow.getByLabel("miniplayer");
      if (existing) {
        existing.show().catch(() => {});
        existing.setFocus().catch(() => {});
        return;
      }
      const win = new WebviewWindow("miniplayer", {
        url: "/?mini=1",
        title: "Quartz Mini",
        width: 360,
        height: 96,
        resizable: false,
        decorations: false,
        alwaysOnTop: true,
        skipTaskbar: false,
      });
      win.once("tauri://error", (err) => console.error("[quartz] miniplayer error:", err));
    } catch (err) {
      console.error("[quartz] Could not open miniplayer:", err);
    }
  }, []);

  const [scanning, setScanning] = useState<ScanProgress | null>(null);

  // Persisted "session" — the last-played track + where we were in it.
  // This lets us show the now-playing bar pre-populated on cold start.
  const [savedSession, setSavedSession] = usePersistedState<{
    track: TrackInfo | null;
    position: number;
    duration: number;
  }>("session", { track: null, position: 0, duration: 0 });

  // True once the audio engine has actually loaded a track (either via
  // user action or resume-on-launch). Determines whether the play button
  // resumes vs starts fresh from the saved position.
  const engineLoadedRef = useRef(false);

  // Album detail view state — null means "show grid/list"
  const [detailAlbumId, setDetailAlbumId] = useState<number | null>(null);
  const [detailTracks, setDetailTracks] = useState<LibraryTrack[]>([]);

  // Artists view state
  const [libArtists, setLibArtists] = useState<LibraryArtist[]>([]);
  const [detailArtistName, setDetailArtistName] = useState<string | null>(null);
  const [artistDetailAlbums, setArtistDetailAlbums] = useState<LibraryAlbum[]>([]);

  // All-tracks tab state — loaded lazily on first visit
  const [allTracks, setAllTracks] = useState<LibraryTrack[]>([]);
  const [tracksLoaded, setTracksLoaded] = useState(false);
  const [tracksLoading, setTracksLoading] = useState(false);
  // Phase 18: smart-view track list. Re-fetched each time the user opens a
  // smart-view section because these are dynamic (a played track updates
  // recently-played / most-played / never-played simultaneously).
  const [smartTracks, setSmartTracks] = useState<LibraryTrack[]>([]);
  const [smartLoading, setSmartLoading] = useState(false);

  // Phase 10 — Playlists & Favorites
  const [playlists, setPlaylists] = useState<DbPlaylist[]>([]);
  const [favoriteIds, setFavoriteIds] = useState<Set<number>>(new Set());
  const [favoriteTracks, setFavoriteTracks] = useState<LibraryTrack[]>([]);
  const [anthropicApiKey, setAnthropicApiKey] = usePersistedState<string>("anthropicApiKey", "");

  // Right-click context menu + tag editor state — both global so any
  // row in any list can trigger the same menu/modal.
  const [contextMenu, setContextMenu] = useState<{
    x: number; y: number; items: ContextMenuItem[];
  } | null>(null);
  const [editingTrack, setEditingTrack] = useState<TagEditorTarget | null>(null);

  // Scrub-bar style choice. "bar" is the classic flat progress bar, "waveform"
  // shows the decoded peak envelope. Persisted so the user's pick survives restarts.
  const [scrubStyle, setScrubStyle] = usePersistedState<ScrubStyle>("scrubStyle", "bar");
  // Cached waveform peaks for the currently-playing track. Loaded async by
  // the effect below whenever the queue's current track changes.
  const [currentWaveform, setCurrentWaveform] = useState<number[] | null>(null);
  // Waveform scan UI state (mirrors the RG scan pattern).
  const [waveformProgress, setWaveformProgress] = useState<RgProgress | null>(null);
  const [waveformScanning, setWaveformScanning] = useState(false);

  // Parametric EQ — persisted in localStorage, synced to engine on change
  // EQ band dragging fires many setEqSettings calls per second; debounce
  // the disk write so the slider feels native.
  const [eqSettings, setEqSettings] = usePersistedState<EqSettings>("eq", DEFAULT_EQ, 200);
  const [eqOpen, setEqOpen] = useState(false);

  // ReplayGain — persisted config + scan progress
  const [rgConfig, setRgConfig] = usePersistedState<ReplayGainConfig>("rgConfig", { enabled: false, target_lufs: -14 });
  const [rgProgress, setRgProgress] = useState<RgProgress | null>(null);
  const [rgScanning, setRgScanning] = useState(false);

  // Crossfade config — shared mode only. Persisted across sessions; synced
  // to the audio engine on change via the effect below.
  const [crossfadeConfig, setCrossfadeConfig] = usePersistedState<CrossfadeConfig>(
    "crossfade",
    { enabled: false, durationSecs: 4 },
  );

  const [detailPlaylistId, setDetailPlaylistId] = useState<number | null>(null);
  const [detailPlaylistTracks, setDetailPlaylistTracks] = useState<LibraryTrack[]>([]);
  const [showAiDialog, setShowAiDialog] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  // MusicBrainz artist-photo fetch state
  const [fetchingArtists, setFetchingArtists] = useState<ArtistFetchProgress | null>(null);
  const [fetchingCovers, setFetchingCovers] = useState<AlbumCoverProgress | null>(null);
  const [dragHover, setDragHover] = useState(false);
  // Sleep timer — lifted from the chip so Settings can drive it and the
  // chip becomes a slim "active-only" indicator. The countdown + end-of-
  // track listeners live below in dedicated effects.
  const [sleepTimer, setSleepTimer] = useState<SleepTimer>({ kind: "off" });
  // Search query — typing stays instant via useDeferredValue. Unlike a
  // setTimeout debounce, useDeferredValue keeps the input update at high
  // priority while marking the *consumers* (filter + grid render) as low
  // priority — React abandons in-flight filter work when the user keeps
  // typing and only commits when the main thread is genuinely idle. This
  // is strictly better than a fixed-interval debounce on low-end CPUs.
  const [queryInput, setQueryInput] = useState("");
  const query = useDeferredValue(queryInput);
  const [viewMode, setViewMode] = usePersistedState<"grid" | "list">("viewMode", "grid");
  const [shuffle, setShuffle] = usePersistedState<boolean>("shuffle", false);
  const [repeatMode, setRepeatMode] = usePersistedState<"off" | "all" | "one">("repeat", "off");
  // Tracked folders — paths Quartz keeps in sync with the library.
  // Migration: read the old single-folder key into the array on first load.
  const [trackedFolders, setTrackedFolders] = usePersistedState<string[]>("trackedFolders", (() => {
    try {
      const old = localStorage.getItem("quartz:lastScanFolder");
      if (old) {
        const parsed = JSON.parse(old);
        if (typeof parsed === "string") return [parsed];
      }
    } catch { /* ignore */ }
    return [];
  })());
  const [recentAlbumIds, setRecentAlbumIds] = usePersistedState<number[]>("recentAlbumIds", []);

  // Push an album to the front of the recents list, dedupe, cap at 20.
  const pushRecent = useCallback((libId: number) => {
    setRecentAlbumIds((prev) => [libId, ...prev.filter((id) => id !== libId)].slice(0, 20));
  }, [setRecentAlbumIds]);

  const searchInputRef = useRef<HTMLInputElement>(null);

  // Refs so the keyboard handler (registered once) always sees the latest values
  const volumeRef = useRef(volume);
  const playingRef = useRef(pbMeta.playing);
  const shuffleRef = useRef(shuffle);
  const repeatModeRef = useRef(repeatMode);
  // trackedFoldersRef lets the one-shot bootstrap effect read the persisted
  // folders for the Phase 16 migration without depending on the array
  // (which would re-run the effect every time a folder is added/removed).
  const trackedFoldersRef = useRef(trackedFolders);
  useEffect(() => { volumeRef.current = volume; }, [volume]);
  useEffect(() => { playingRef.current = pbMeta.playing; }, [pbMeta.playing]);
  useEffect(() => { shuffleRef.current = shuffle; }, [shuffle]);
  useEffect(() => { repeatModeRef.current = repeatMode; }, [repeatMode]);
  useEffect(() => { trackedFoldersRef.current = trackedFolders; }, [trackedFolders]);

  // Keep refs in sync so the `track-ended` listener (registered once) can
  // read the latest queue without stale closure capture.
  const queueRef = useRef<LibraryTrack[]>([]);
  const queueIndexRef = useRef(0);
  // Stores the queue index sent to the engine via queue_next_track.
  // When `track-changed` fires the engine has already moved to that index.
  const pendingNextIdxRef = useRef<number | null>(null);
  useEffect(() => { queueRef.current = queue; }, [queue]);
  useEffect(() => { queueIndexRef.current = queueIndex; }, [queueIndex]);

  // Compute and apply the active accent. Depends on:
  //   - theme: each theme has its own variant of the named accents
  //   - accentName: user's chosen palette in Settings (fallback)
  //   - dynamicAccent + currentLibAlbumId: when on, override accent with the
  //     extracted vibrant color from the currently-playing album's cover
  //   - libAlbums: source of truth for the extracted accent_color
  // Track lookup is by id so re-renders are O(log n) on a 30k-album library.
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    const userAccent = getAccentHex(accentName, theme);
    let active = userAccent;
    if (dynamicAccent && currentLibAlbumId != null) {
      const album = libAlbums.find((a) => a.id === currentLibAlbumId);
      const extracted = album?.accent_color;
      if (extracted) {
        // Light/sepia themes need the accent darkened a touch so it
        // reads as a tint on a light background. Dark/rose themes use
        // it as-is (the Rust extractor already clamps lightness into
        // a UI-friendly band).
        active = (theme === "light" || theme === "sepia")
          ? mix(extracted, "#000000", 0.28)
          : extracted;
      }
    }
    const accentDim = mix(active, "#000000", 0.35);
    const accentSoft = hexToRgba(active, 0.12);
    document.documentElement.style.setProperty("--accent", active);
    document.documentElement.style.setProperty("--accent-dim", accentDim);
    document.documentElement.style.setProperty("--accent-soft", accentSoft);
    // Broadcast to the mini-player window (separate webview, doesn't share
    // documentElement style). localStorage is the initial-paint channel:
    // it's set synchronously here AND read synchronously when the mini
    // player mounts, so there's no flash of the default gold on launch.
    // The Tauri event is the runtime-update channel: triggers an instant
    // swap on every track change without each window doing its own IPC.
    try { localStorage.setItem("quartz:activeAccent", active); } catch {}
    void emit("accent-changed", active).catch(() => {});
  }, [theme, accentName, dynamicAccent, currentLibAlbumId, libAlbums]);

  // Lazy extraction trigger: when a track starts playing and the album's
  // accent_color is still NULL, ask Rust to extract + cache it. The fetch
  // resolves with the hex on success; we patch it into libAlbums so the
  // accent effect above picks it up on its next run. Skips if dynamicAccent
  // is off (no point burning CPU on extractions the user can't see).
  useEffect(() => {
    if (!dynamicAccent || currentLibAlbumId == null) return;
    const album = libAlbums.find((a) => a.id === currentLibAlbumId);
    if (!album || album.accent_color) return; // already cached
    let cancelled = false;
    invoke<string | null>("get_album_accent_color", { albumId: currentLibAlbumId })
      .then((hex) => {
        if (cancelled || !hex) return;
        setLibAlbums((xs) => xs.map((a) =>
          a.id === currentLibAlbumId ? { ...a, accent_color: hex } : a
        ));
      })
      .catch((err) => console.error("[quartz] get_album_accent_color failed:", err));
    return () => { cancelled = true; };
  }, [dynamicAccent, currentLibAlbumId, libAlbums]);

  const refreshAlbums = () => {
    invoke<LibraryAlbum[]>("list_albums")
      .then((xs) => {
        console.log("[quartz] albums:", xs.length);
        setLibAlbums(xs);
      })
      .catch((err) => console.error("[quartz] list_albums failed:", err));
    invoke<LibraryArtist[]>("list_artists")
      .then((xs) => setLibArtists(xs))
      .catch((err) => console.error("[quartz] list_artists failed:", err));
    // Invalidate the all-tracks cache so the next visit reloads
    setTracksLoaded(false);
    setAllTracks([]);
  };

  const loadAllTracks = async () => {
    if (tracksLoaded || tracksLoading) return;
    setTracksLoading(true);
    try {
      const ts = await invoke<LibraryTrack[]>("list_all_tracks");
      setAllTracks(ts);
      setTracksLoaded(true);
    } catch (err) {
      console.error("[quartz] list_all_tracks failed:", err);
    } finally {
      setTracksLoading(false);
    }
  };

  // Lazy-load tracks the first time the user opens the Tracks tab
  useEffect(() => {
    if (section === "tracks" && !tracksLoaded && !tracksLoading) {
      loadAllTracks();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section]);

  // Phase 18: when the user enters a smart-view section, fetch the right
  // slice. We always re-fetch on entry — these are dynamic and a stale list
  // would be confusing (e.g. you played a track, came back to "Never Played"
  // and it's still there).
  useEffect(() => {
    if (!section.startsWith("smart-")) return;
    const SMART_LIMIT = 200;
    const cmd =
      section === "smart-added" ? "get_recently_added"
      : section === "smart-played" ? "get_recently_played"
      : section === "smart-most" ? "get_most_played"
      : section === "smart-never" ? "get_never_played"
      : null;
    if (!cmd) return;
    setSmartLoading(true);
    setSmartTracks([]);
    invoke<any[]>(cmd, { limit: SMART_LIMIT })
      .then((rows) => {
        // get_most_played returns MostPlayedTrack which has a nested track
        // (flattened by serde) — the wire shape is just LibraryTrack with
        // extra play_count/last_played_at fields, so we can cast it.
        setSmartTracks(rows as LibraryTrack[]);
      })
      .catch((err) => console.error(`[quartz] ${cmd} failed:`, err))
      .finally(() => setSmartLoading(false));
  }, [section]);

  useEffect(() => {
    invoke<Device[]>("get_devices")
      .then(setDevices)
      .catch((err) => console.error("[quartz] get_devices failed:", err));
    // Re-apply the persisted device selection on launch so the audio engine
    // routes to the DAC the user last picked. If the device is gone, Rust
    // silently falls back to the Windows default.
    if (selectedDeviceId) {
      invoke("set_device", { id: selectedDeviceId }).catch(console.error);
    }
    // Sync the persisted exclusive-mode preference on launch — engine defaults
    // to true, so we only need to send when it's false; sending true is also
    // harmless (idempotent).
    invoke("set_exclusive_mode", { enabled: exclusiveEnabled }).catch(console.error);
    // Sync persisted EQ to the engine on startup.
    invoke("set_eq_settings", { settings: eqSettings }).catch(console.error);
    // Sync persisted RG config to the engine on startup.
    invoke("set_replaygain_settings", { config: rgConfig }).catch(console.error);
    // Sync persisted crossfade config to the engine on startup.
    invoke("set_crossfade", { config: crossfadeConfig }).catch(console.error);
    refreshAlbums();
    refreshPlaylists();
    refreshFavorites();

    // Sync library folders with Rust on startup. Two paths:
    //   1. Rust has folders → they are the source of truth; mirror into JS.
    //   2. Rust is empty but JS has persisted folders from before the Phase 16
    //      migration → push them up so the watcher attaches across restarts.
    invoke<{ path: string }[]>("list_library_folders")
      .then((rustFolders) => {
        if (rustFolders.length > 0) {
          setTrackedFolders(rustFolders.map((f) => f.path));
          return;
        }
        // Migrate any pre-Phase-16 folders from JS persisted state.
        const persisted = trackedFoldersRef.current;
        if (persisted.length === 0) return;
        Promise.all(
          persisted.map((p) =>
            invoke("add_library_folder", { path: p }).catch(console.error)
          )
        ).catch(console.error);
      })
      .catch((err) => console.error("[quartz] list_library_folders failed:", err));

    // Subscribe to the shared pb-state store. The store owns the single
    // Tauri listener — this callback runs after each fan-out, on the same
    // thread, with the parsed payload already in `pbSnapshot`. No second
    // deserialization.
    const unsubscribeState = subscribePb(() => {
      const payload = getPbSnapshot();
      if (payload.track) engineLoadedRef.current = true;
      pbStateRef.current = payload;
      // Only trigger a React re-render when the rarely-changing meta fields
      // change. Position / duration tick at 4 Hz and are read via the ref
      // by the components that actually need them (NowPlayingBar etc).
      setPbMeta((prev) => {
        if (
          prev.playing === payload.playing &&
          prev.exclusive === payload.exclusive &&
          (prev.track?.path ?? null) === (payload.track?.path ?? null)
        ) return prev;
        return { playing: payload.playing, exclusive: payload.exclusive, track: payload.track };
      });
    });
    // spectrum-bins is now subscribed to directly by <SpectrumLive>.
    const unlistenError = listen<string>("playback-error", (e) => {
      console.error("[quartz] PLAYBACK ERROR:", e.payload);
      // Auto-skip past the failing track. Rust emits playback-error and
      // breaks the audio session WITHOUT firing track-ended, which means
      // the queue would dead-end here without manual user action. Common
      // causes: file deleted after scan, corrupt file, unsupported sample
      // rate, device rejected exclusive mode. Re-using the same advance
      // logic as track-ended keeps the queue moving.
      const q = queueRef.current;
      const curIdx = queueIndexRef.current;
      if (q.length === 0) return;
      // Don't infinite-loop on repeat-one — that's how the user gets stuck.
      const effectiveRepeat = repeatModeRef.current === "one" ? "off" : repeatModeRef.current;
      let nextIdx: number | null;
      if (shuffleRef.current && q.length > 1) {
        let r: number;
        do { r = Math.floor(Math.random() * q.length); } while (r === curIdx);
        nextIdx = r;
      } else {
        const i = curIdx + 1;
        if (i < q.length) nextIdx = i;
        else if (effectiveRepeat === "all") nextIdx = 0;
        else nextIdx = null;
      }
      if (nextIdx !== null) {
        const idx = nextIdx;
        queueIndexRef.current = idx;
        setQueueIndex(idx);
        // If the new track is in a different album (e.g. Tracks tab,
        // smart playlist, or any mixed-album queue), update the currently-
        // shown album state. Without this, NowPlayingBar / FullscreenPlayer /
        // mini player all keep showing the OLD album's artist + title.
        setCurrentLibAlbumId(q[idx].album_id);
        pushRecent(q[idx].album_id);
        invoke("play_file", { path: q[idx].path }).catch(console.error);
        invoke("log_play", { trackId: q[idx].id }).catch(() => {});
        const nextNextIdx = computeNextIndex(idx, q.length);
        pendingNextIdxRef.current = nextNextIdx;
        if (nextNextIdx !== null) {
          invoke("queue_next_track", { path: q[nextNextIdx].path }).catch(console.error);
        }
      }
    });
    const unlistenEnded = listen("track-ended", () => {
      const q = queueRef.current;
      const curIdx = queueIndexRef.current;
      if (q.length === 0) return;
      if (repeatModeRef.current === "one") {
        invoke("play_file", { path: q[curIdx].path }).catch(console.error);
        return;
      }
      let nextIdx: number | null;
      if (shuffleRef.current && q.length > 1) {
        let r: number;
        do {
          r = Math.floor(Math.random() * q.length);
        } while (r === curIdx);
        nextIdx = r;
      } else {
        const i = curIdx + 1;
        if (i < q.length) nextIdx = i;
        else if (repeatModeRef.current === "all") nextIdx = 0;
        else nextIdx = null;
      }
      if (nextIdx !== null) {
        // Update queueIndex + ref synchronously BEFORE invoking play_file.
        // If we waited for the invoke promise to resolve, the next track-ended
        // (which can fire seconds later if it's a short track) would read a
        // stale queueIndexRef and either replay the same track or fail to
        // advance. Also pre-queue the track-after-that for gapless.
        const idx = nextIdx;
        queueIndexRef.current = idx;
        setQueueIndex(idx);
        // Also update the currently-shown album so the UI (NPB, FullscreenPlayer,
        // mini player) reflects the new album when auto-advance crosses an
        // album boundary (Tracks tab, smart playlists, Favorites, mixed queues).
        setCurrentLibAlbumId(q[idx].album_id);
        pushRecent(q[idx].album_id);
        invoke("play_file", { path: q[idx].path }).catch(console.error);
        invoke("log_play", { trackId: q[idx].id }).catch(() => {});
        const nextNextIdx = computeNextIndex(idx, q.length);
        pendingNextIdxRef.current = nextNextIdx;
        if (nextNextIdx !== null) {
          invoke("queue_next_track", { path: q[nextNextIdx].path }).catch(console.error);
        }
      }
    });
    // Gapless: engine crossed a track boundary seamlessly — advance the queue
    // index and send the next-next track without calling play_file.
    const unlistenChanged = listen("track-changed", () => {
      const q = queueRef.current;
      const newIdx = pendingNextIdxRef.current;
      if (newIdx === null || q.length === 0) return;
      setQueueIndex(newIdx);
      // Cross-album gapless transitions need the album state to follow too.
      setCurrentLibAlbumId(q[newIdx].album_id);
      pushRecent(q[newIdx].album_id);
      invoke("log_play", { trackId: q[newIdx].id }).catch(() => {});
      // Queue the track after the one we just moved to.
      const nextNextIdx = computeNextIndex(newIdx, q.length);
      pendingNextIdxRef.current = nextNextIdx;
      if (nextNextIdx !== null) {
        invoke("queue_next_track", { path: q[nextNextIdx].path }).catch(console.error);
      }
    });
    const unlistenScan = listen<ScanProgress>("library-scan-progress", (e) => {
      // Just mirror progress to the overlay. The caller (addFolder /
      // rescanAll) refreshes albums explicitly when *all* folders are done
      // — refreshing per-folder triggers a giant grid re-render in between
      // scans that freezes the UI on big libraries.
      setScanning(e.payload);
    });
    const unlistenArtistFetch = listen<ArtistFetchProgress>("artist-fetch-progress", (e) => {
      setFetchingArtists(e.payload);
    });

    // Phase 21: album cover fetch progress
    const unlistenAlbumCover = listen<AlbumCoverProgress>("album-cover-progress", (e) => {
      setFetchingCovers(e.payload);
    });

    // Phase 22: drag-and-drop from Explorer. Three events fire:
    //   tauri://drag-enter — pointer entered the window with files
    //   tauri://drag-leave — pointer left without dropping
    //   tauri://drag-drop  — files released over the window
    // We only show the visual hint on enter, hide on leave or drop. The
    // actual import happens on drop; the Rust helper classifies each
    // path (folder vs audio file) and dispatches scans accordingly.
    const unlistenDragEnter = listen("tauri://drag-enter", () => setDragHover(true));
    const unlistenDragLeave = listen("tauri://drag-leave", () => setDragHover(false));
    const unlistenDragDrop = listen<{ paths: string[] }>("tauri://drag-drop", async (e) => {
      setDragHover(false);
      const paths = e.payload?.paths ?? [];
      if (paths.length === 0) return;
      try {
        const roots = await invoke<string[]>("handle_dropped_paths", { paths });
        if (roots.length === 0) return;
        // Merge into trackedFolders dedup-style so the Settings page reflects
        // any new folders that came in through drop.
        setTrackedFolders((prev) => {
          const set = new Set(prev);
          for (const r of roots) set.add(r);
          return Array.from(set);
        });
        refreshAlbums();
      } catch (err) {
        console.error("[quartz] drag-drop import failed:", err);
      }
    });

    const unlistenRgProgress = listen<RgProgress>("rg-progress", (e) => {
      setRgProgress(e.payload);
      if (e.payload.done >= e.payload.total) {
        setRgScanning(false);
        setTimeout(() => setRgProgress(null), 2000);
      }
    });

    // Phase 17: when the file watcher rescans after a folder change,
    // refresh albums + artists so the UI shows the new tracks. The Tracks
    // tab is lazy-loaded so we just invalidate its cache.
    const unlistenLibUpdated = listen("library-updated", () => {
      refreshAlbums();
    });

    return () => {
      unsubscribeState();
      unlistenError.then((f) => f());
      unlistenEnded.then((f) => f());
      unlistenChanged.then((f) => f());
      unlistenScan.then((f) => f());
      unlistenArtistFetch.then((f) => f());
      unlistenRgProgress.then((f) => f());
      unlistenLibUpdated.then((f) => f());
      unlistenAlbumCover.then((f) => f());
      unlistenDragEnter.then((f) => f());
      unlistenDragLeave.then((f) => f());
      unlistenDragDrop.then((f) => f());
    };
  }, []);

  // Sync EQ settings to the audio engine whenever they change
  // (skip on first render — startup effect already sends the initial value).
  const eqInitRef = useRef(false);
  useEffect(() => {
    if (!eqInitRef.current) { eqInitRef.current = true; return; }
    invoke("set_eq_settings", { settings: eqSettings }).catch(console.error);
  }, [eqSettings]);

  // Sync RG config to the backend whenever it changes
  const rgInitRef = useRef(false);
  useEffect(() => {
    if (!rgInitRef.current) { rgInitRef.current = true; return; }
    invoke("set_replaygain_settings", { config: rgConfig }).catch(console.error);
  }, [rgConfig]);

  // Sync crossfade config to the backend whenever it changes
  const xfInitRef = useRef(false);
  useEffect(() => {
    if (!xfInitRef.current) { xfInitRef.current = true; return; }
    invoke("set_crossfade", { config: crossfadeConfig }).catch(console.error);
  }, [crossfadeConfig]);

  // Fetch the waveform peaks for the current track whenever it changes.
  // Skips when the user has the flat-bar style selected — no point doing
  // the work. The cancel guard handles fast track-switching: if the user
  // skips tracks faster than peaks load, the stale result is discarded.
  const currentTrackId = queue[queueIndex]?.id;
  useEffect(() => {
    if (scrubStyle !== "waveform" || currentTrackId == null) {
      setCurrentWaveform(null);
      return;
    }
    let cancelled = false;
    setCurrentWaveform(null);
    invoke<number[]>("get_waveform", { trackId: currentTrackId, numPeaks: 500 })
      .then((peaks) => { if (!cancelled) setCurrentWaveform(peaks); })
      .catch((err) => { console.error("[quartz] waveform load:", err); });
    return () => { cancelled = true; };
  }, [currentTrackId, scrubStyle]);

  // Waveform scan progress listener
  useEffect(() => {
    const u = listen<RgProgress>("waveform-scan-progress", (e) => {
      setWaveformProgress(e.payload);
      if (e.payload.done >= e.payload.total) {
        setWaveformScanning(false);
        setTimeout(() => setWaveformProgress(null), 2000);
      }
    });
    return () => { u.then((f) => f()); };
  }, []);

  // Sleep-timer countdown driver. Polls each second rather than relying
  // on a single long setTimeout (which can drift / suspend under browser
  // tab-throttling). When the boundary's crossed we pause and reset.
  useEffect(() => {
    if (sleepTimer.kind !== "minutes") return;
    const id = setInterval(() => {
      if (Date.now() >= sleepTimer.endsAt) {
        invoke("pause_playback").catch(() => {});
        setSleepTimer({ kind: "off" });
      }
    }, 1000);
    return () => clearInterval(id);
  }, [sleepTimer]);

  // End-of-track sleep: one-shot listener on `track-ended`, pauses + clears.
  useEffect(() => {
    if (sleepTimer.kind !== "end-of-track") return;
    let fired = false;
    const unlisten = listen("track-ended", () => {
      if (fired) return;
      fired = true;
      invoke("pause_playback").catch(() => {});
      setSleepTimer({ kind: "off" });
    });
    return () => { unlisten.then((f) => f()); };
  }, [sleepTimer]);

  const setPlaying = (p: boolean) => {
    if (!p) {
      invoke("pause_playback").catch(console.error);
      setPbMeta((s) => ({ ...s, playing: false }));
      return;
    }
    // Resuming. If the engine hasn't loaded a track yet (cold start with a
    // persisted queue), load the saved track at the saved position.
    if (!engineLoadedRef.current && queue.length > 0 && queueIndex < queue.length) {
      const t = queue[queueIndex];
      invoke("play_file", { path: t.path, startSecs: savedSession.position || 0 })
        .catch(console.error);
      // Don't optimistically flip `playing` — wait for the state event from Rust.
    } else {
      invoke("resume_playback").catch(console.error);
      setPbMeta((s) => ({ ...s, playing: true }));
    }
  };

  // ── Keyboard shortcuts ────────────────────────────────────────────
  useEffect(() => {
    const isInTextField = (el: EventTarget | null): boolean => {
      const node = el as HTMLElement | null;
      if (!node) return false;
      const tag = node.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || node.isContentEditable === true;
    };

    const onKey = (e: KeyboardEvent) => {
      // Ctrl+F always focuses search, even from within other inputs
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        return;
      }

      // Esc clears + blurs the search input when focused there
      if (e.key === "Escape") {
        if (document.activeElement === searchInputRef.current) {
          setQueryInput("");
          searchInputRef.current?.blur();
          e.preventDefault();
          return;
        }
      }

      // The rest only fire when no text field has focus
      if (isInTextField(e.target)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      switch (e.key) {
        case " ":
          e.preventDefault();
          setPlaying(!playingRef.current);
          break;
        case "ArrowRight":
          e.preventDefault();
          next();
          break;
        case "ArrowLeft":
          e.preventDefault();
          prev();
          break;
        case "ArrowUp":
          e.preventDefault();
          onVolumeChange(Math.min(1, volumeRef.current + 0.05));
          break;
        case "ArrowDown":
          e.preventDefault();
          onVolumeChange(Math.max(0, volumeRef.current - 0.05));
          break;
        case "f":
        case "F":
          setFullscreenOpen((o) => !o);
          break;
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Open the OS folder picker, register the chosen folder in the DB
  // (so the file watcher picks it up across restarts), then scan it.
  const addFolder = async () => {
    try {
      const folder = await openDialog({ directory: true, multiple: false });
      if (typeof folder !== "string") return;
      // Register with Rust first — the watcher attaches immediately and the
      // (mtime, size) delta-scan inside scan_library is a no-op for already-
      // indexed files so a re-add of an existing folder is cheap.
      await invoke<boolean>("add_library_folder", { path: folder });
      setTrackedFolders((prev) => prev.includes(folder) ? prev : [...prev, folder]);
      setScanning({ scanned: 0, total: 0, current_path: folder });
      await invoke<number>("scan_library", { folder });
    } catch (err) {
      console.error("[quartz] scan failed:", err);
    } finally {
      refreshAlbums();
      setScanning(null);
    }
  };

  // Remove a folder from the tracked list AND unregister it in Rust so the
  // file watcher stops listening. Existing indexed tracks under the folder
  // stay in the DB — that's intentional: an external drive disappearing
  // shouldn't permanently lose its library entries.
  const removeFolder = (folder: string) => {
    invoke("remove_library_folder", { path: folder }).catch(console.error);
    setTrackedFolders((prev) => prev.filter((f) => f !== folder));
  };

  // Rescan every tracked folder in sequence. If no folders, open the picker.
  const rescanAll = async () => {
    if (trackedFolders.length === 0) {
      addFolder();
      return;
    }
    try {
      for (const folder of trackedFolders) {
        setScanning({ scanned: 0, total: 0, current_path: folder });
        await invoke<number>("scan_library", { folder });
      }
    } catch (err) {
      console.error("[quartz] rescan failed:", err);
    } finally {
      refreshAlbums();
      setScanning(null);
    }
  };

  const fetchArtistPhotos = async () => {
    if (fetchingArtists) return; // already running
    setFetchingArtists({ processed: 0, total: 0, current_artist: "", found: 0 });
    try {
      await invoke<number>("fetch_artist_photos", { fanartApiKey: fanartApiKey || null });
    } catch (err) {
      console.error("[quartz] fetch_artist_photos failed:", err);
    } finally {
      // Refresh artists so new images appear
      invoke<LibraryArtist[]>("list_artists")
        .then((xs) => setLibArtists(xs))
        .catch(console.error);
      setFetchingArtists(null);
    }
  };

  // Phase 21: fetch missing album covers from Cover Art Archive. Albums
  // with embedded art already on disk are skipped (the Rust query filters
  // by cover_path IS NULL).
  const fetchAlbumCovers = async () => {
    if (fetchingCovers) return;
    setFetchingCovers({ processed: 0, total: 0, current_album: "", found: 0 });
    try {
      await invoke<number>("fetch_album_covers_cmd");
    } catch (err) {
      console.error("[quartz] fetch_album_covers failed:", err);
    } finally {
      refreshAlbums();
      setFetchingCovers(null);
    }
  };

  // Clear the cached artist photos and re-run the fetcher. Used when the
  // user wants to upgrade existing photos to a different source (e.g., after
  // pasting a fanart.tv key for the first time).
  const refetchArtistPhotos = async () => {
    if (fetchingArtists) return;
    try {
      await invoke("wipe_artist_images");
      // Wipe in-memory image_path on the artists so the UI shows fallbacks
      // immediately rather than stale images.
      setLibArtists((xs) => xs.map((a) => ({ ...a, image_path: null })));
    } catch (err) {
      console.error("[quartz] wipe_artist_images failed:", err);
    }
    await fetchArtistPhotos();
  };

  const wipeLibrary = async () => {
    try {
      await invoke("wipe_library");
      // Clear in-memory state and any saved session pointing at deleted files.
      setLibAlbums([]);
      setLibArtists([]);
      setQueue([]);
      setQueueIndex(0);
      setCurrentLibAlbumId(null);
      setRecentAlbumIds([]);
      setSavedSession({ track: null, position: 0, duration: 0 });
      pbStateRef.current = { playing: false, position: 0, duration: 0, exclusive: false, track: null };
      setPbMeta({ playing: false, exclusive: false, track: null });
      invoke("stop_playback").catch(() => { /* ignore — no track */ });
    } catch (err) {
      console.error("[quartz] wipe failed:", err);
    }
  };

  const playTrackAt = useCallback(async (tracks: LibraryTrack[], index: number) => {
    if (index < 0 || index >= tracks.length) return;
    try {
      await invoke("play_file", { path: tracks[index].path });
      setQueueIndex(index);
      // Update displayed album when manual prev/next or queue clicks cross
      // an album boundary. Without this, NPB / FullscreenPlayer / mini player
      // keep showing the OLD album.
      setCurrentLibAlbumId(tracks[index].album_id);
      pushRecent(tracks[index].album_id);
      // Pre-queue next track for gapless playback.
      const nextIdx = computeNextIndex(index, tracks.length);
      pendingNextIdxRef.current = nextIdx;
      if (nextIdx !== null) {
        invoke("queue_next_track", { path: tracks[nextIdx].path }).catch(console.error);
      }
    } catch (err) {
      console.error("[quartz] play_file failed:", err);
    }
  }, [setQueueIndex, setCurrentLibAlbumId, pushRecent]); // computeNextIndex reads stable refs — no dep needed

  const openArtist = useCallback(async (name: string) => {
    setDetailArtistName(name);
    try {
      const albums = await invoke<LibraryAlbum[]>("list_albums_by_artist", { artist: name });
      setArtistDetailAlbums(albums);
    } catch (err) {
      console.error("[quartz] list_albums_by_artist failed:", err);
    }
  }, []);

  const closeArtist = () => {
    setDetailArtistName(null);
    setArtistDetailAlbums([]);
  };

  const openAlbum = useCallback(async (libId: number) => {
    // Clear other detail views — the conditional ladder in the main render
    // checks artist + playlist before album, so leaving either set would
    // keep the wrong panel visible (this was the artist→album navigation bug).
    setDetailArtistName(null);
    setArtistDetailAlbums([]);
    setDetailPlaylistId(null);
    setDetailPlaylistTracks([]);
    setDetailAlbumId(libId);
    try {
      const tracks = await invoke<LibraryTrack[]>("list_tracks", { albumId: libId });
      setDetailTracks(tracks);
    } catch (err) {
      console.error("[quartz] openAlbum failed:", err);
    }
  }, []);

  // Play a specific track from a flat track list (used by the Tracks tab).
  // The whole list becomes the queue so auto-advance keeps working.
  const playTrackFromList = useCallback((tracks: LibraryTrack[], index: number) => {
    if (index < 0 || index >= tracks.length) return;
    const t = tracks[index];
    setCurrentLibAlbumId(t.album_id);
    setQueue(tracks);
    setQueueIndex(index);
    pushRecent(t.album_id);
    invoke("play_file", { path: t.path }).catch(console.error);
    invoke("log_play", { trackId: t.id }).catch(() => {});
    // Pre-queue next for gapless auto-advance.
    const nextIdx = index + 1 < tracks.length ? index + 1 : null;
    pendingNextIdxRef.current = nextIdx;
    if (nextIdx !== null) {
      invoke("queue_next_track", { path: tracks[nextIdx].path }).catch(console.error);
    }
  }, [setCurrentLibAlbumId, setQueue, setQueueIndex, pushRecent]);

  // Play an album without opening the detail view (used by hover-play in the grid).
  const quickPlayAlbum = useCallback(async (libId: number) => {
    try {
      const tracks = await invoke<LibraryTrack[]>("list_tracks", { albumId: libId });
      if (tracks.length === 0) return;
      setCurrentLibAlbumId(libId);
      setQueue(tracks);
      setQueueIndex(0);
      pushRecent(libId);
      await invoke("play_file", { path: tracks[0].path });
      invoke("log_play", { trackId: tracks[0].id }).catch(() => {});
      // Pre-queue next for gapless auto-advance.
      const nextIdx = tracks.length > 1 ? 1 : null;
      pendingNextIdxRef.current = nextIdx;
      if (nextIdx !== null) {
        invoke("queue_next_track", { path: tracks[nextIdx].path }).catch(console.error);
      }
    } catch (err) {
      console.error("[quartz] quickPlayAlbum failed:", err);
    }
  }, [setCurrentLibAlbumId, setQueue, setQueueIndex, pushRecent]);

  // Stable adapter callbacks for the grid → keeps memoized AlbumCard from
  // re-rendering on every parent render. Each card receives identity-stable
  // onPlay/onQuickPlay regardless of how often App re-renders.
  const handleAlbumCardPlay = useCallback((a: Album) => {
    const libId = parseInt(a.id.replace("lib-", ""), 10);
    if (!isNaN(libId)) openAlbum(libId);
  }, [openAlbum]);
  const handleAlbumCardQuickPlay = useCallback((a: Album) => {
    const libId = parseInt(a.id.replace("lib-", ""), 10);
    if (!isNaN(libId)) quickPlayAlbum(libId);
  }, [quickPlayAlbum]);

  const closeAlbum = () => {
    setDetailAlbumId(null);
    setDetailTracks([]);
  };

  // ── Playlist helpers ───────────────────────────────────────────────
  const refreshPlaylists = useCallback(() => {
    invoke<DbPlaylist[]>("list_playlists")
      .then(setPlaylists)
      .catch(console.error);
  }, []);

  const refreshFavorites = useCallback(() => {
    invoke<number[]>("get_favorite_track_ids")
      .then((ids) => setFavoriteIds(new Set(ids)))
      .catch(console.error);
  }, []);

  const toggleFavorite = useCallback((trackId: number) => {
    setFavoriteIds((prev) => {
      const next = new Set(prev);
      if (next.has(trackId)) next.delete(trackId);
      else next.add(trackId);
      return next;
    });
    invoke("toggle_favorite_track", { trackId }).catch(console.error);
  }, []);

  const openPlaylist = useCallback(async (id: number) => {
    setDetailPlaylistId(id);
    setDetailAlbumId(null);
    setDetailTracks([]);
    setDetailArtistName(null);
    setArtistDetailAlbums([]);
    setSettingsOpen(false);
    try {
      const tracks = await invoke<LibraryTrack[]>("get_playlist_tracks", { playlistId: id });
      setDetailPlaylistTracks(tracks);
    } catch (err) {
      console.error("[quartz] get_playlist_tracks failed:", err);
    }
  }, []);

  const closePlaylist = useCallback(() => {
    setDetailPlaylistId(null);
    setDetailPlaylistTracks([]);
  }, []);

  const deletePlaylist = useCallback(async (id: number) => {
    await invoke("delete_playlist", { id }).catch(console.error);
    const fresh = await invoke<DbPlaylist[]>("list_playlists").catch(() => [] as DbPlaylist[]);
    setPlaylists(fresh as DbPlaylist[]);
    closePlaylist();
  }, [closePlaylist]);

  const renamePlaylist = useCallback(async (id: number, newName: string) => {
    await invoke("rename_playlist", { id, name: newName, description: null }).catch(console.error);
    setPlaylists((prev) => prev.map((p) => p.id === id ? { ...p, name: newName } : p));
  }, []);

  const addTrackToPlaylist = useCallback(async (trackId: number, playlistId: number) => {
    await invoke("add_tracks_to_playlist", { playlistId, trackIds: [trackId] }).catch(console.error);
    setPlaylists((prev) => prev.map((p) => p.id === playlistId ? { ...p, track_count: p.track_count + 1 } : p));
  }, []);

  const playFromPlaylist = (startIndex: number, doShuffle = false) => {
    if (detailPlaylistTracks.length === 0) return;
    const tracks = doShuffle ? shuffled(detailPlaylistTracks) : detailPlaylistTracks;
    const start = doShuffle ? 0 : startIndex;
    setCurrentLibAlbumId(tracks[start]?.album_id ?? null);
    setQueue(tracks);
    setQueueIndex(start);
    invoke("play_file", { path: tracks[start].path }).catch(console.error);
    invoke("log_play", { trackId: tracks[start].id }).catch(() => {});
    // Pre-queue next for gapless.
    const nextIdx = start + 1 < tracks.length ? start + 1 : null;
    pendingNextIdxRef.current = nextIdx;
    if (nextIdx !== null) {
      invoke("queue_next_track", { path: tracks[nextIdx].path }).catch(console.error);
    }
  };

  const createAiPlaylist = async () => {
    if (!aiPrompt.trim() || !anthropicApiKey.trim()) return;
    setAiLoading(true);
    setAiError(null);
    try {
      const result = await invoke<AiPlaylistResult>("create_ai_playlist", {
        prompt: aiPrompt,
        apiKey: anthropicApiKey,
      });
      const playlistId = await invoke<number>("create_playlist", {
        name: result.name,
        description: null,
        kind: 0,
        rulesJson: null,
      });
      if (result.track_ids.length > 0) {
        await invoke("add_tracks_to_playlist", {
          playlistId,
          trackIds: result.track_ids,
        });
      }
      // Await the refresh so playlists state is updated in the same React
      // batch as setDetailPlaylistId — PlaylistDetail finds the row immediately.
      const fresh = await invoke<DbPlaylist[]>("list_playlists");
      setPlaylists(fresh);
      setShowAiDialog(false);
      setAiPrompt("");
      openPlaylist(playlistId);
    } catch (err) {
      setAiError(String(err));
    } finally {
      setAiLoading(false);
    }
  };

  const newManualPlaylist = async () => {
    const name = `Playlist ${playlists.length + 1}`;
    try {
      const id = await invoke<number>("create_playlist", {
        name,
        description: null,
        kind: 0,
        rulesJson: null,
      });
      const fresh = await invoke<DbPlaylist[]>("list_playlists");
      setPlaylists(fresh);
      openPlaylist(id);
    } catch (err) {
      console.error("[quartz] create_playlist failed:", err);
    }
  };

  // Phase 20: open the OS file picker for an .m3u/.m3u8, ask Rust to parse
  // it, then create a new manual playlist containing every entry that
  // resolved to a real library track. Unresolved entries are logged so the
  // user can see what didn't match.
  const importM3uPlaylist = async () => {
    try {
      const file = await openDialog({
        multiple: false,
        directory: false,
        filters: [{ name: "Playlist", extensions: ["m3u", "m3u8"] }],
      });
      if (typeof file !== "string") return;
      const result = await invoke<{
        name: string;
        entries: { track_id: number | null; source: string }[];
      }>("import_m3u_playlist", { filePath: file });
      const matched = result.entries.filter((e) => e.track_id != null).map((e) => e.track_id as number);
      const unmatched = result.entries.length - matched.length;
      if (matched.length === 0) {
        console.warn("[quartz] M3U import: no entries matched any tracks in the library");
        return;
      }
      const id = await invoke<number>("create_playlist", {
        name: result.name,
        description: unmatched > 0 ? `${unmatched} track(s) couldn't be matched` : null,
        kind: 0,
        rulesJson: null,
      });
      await invoke("add_tracks_to_playlist", { playlistId: id, trackIds: matched });
      const fresh = await invoke<DbPlaylist[]>("list_playlists");
      setPlaylists(fresh);
      openPlaylist(id);
    } catch (err) {
      console.error("[quartz] import_m3u_playlist failed:", err);
    }
  };

  // Phase 20: write the active playlist (by id) to an .m3u8 file chosen via
  // the OS save-dialog. Defaults the filename to the playlist's name.
  const exportPlaylistAsM3u = useCallback(async (playlistId: number) => {
    const pl = playlists.find((p) => p.id === playlistId);
    if (!pl) return;
    try {
      const file = await saveDialog({
        defaultPath: `${pl.name}.m3u8`,
        filters: [{ name: "Playlist", extensions: ["m3u8"] }],
      });
      if (typeof file !== "string") return;
      await invoke("export_m3u_playlist", { filePath: file, playlistId });
    } catch (err) {
      console.error("[quartz] export_m3u_playlist failed:", err);
    }
  }, [playlists]);

  const loadFavoriteTracks = useCallback(async () => {
    try {
      const tracks = await invoke<LibraryTrack[]>("get_favorite_tracks");
      setFavoriteTracks(tracks);
    } catch (err) {
      console.error("[quartz] get_favorite_tracks failed:", err);
    }
  }, []);

  // Start playing an album from a specific index. Used by both the
  // "Play" button on the detail view and clicks on individual tracks.
  const playFromDetail = (startIndex: number, doShuffle = false) => {
    if (detailTracks.length === 0 || detailAlbumId === null) return;
    setCurrentLibAlbumId(detailAlbumId);
    const tracks = doShuffle ? shuffled(detailTracks) : detailTracks;
    const start = doShuffle ? 0 : startIndex;
    setQueue(tracks);
    setQueueIndex(start);
    pushRecent(detailAlbumId);
    invoke("play_file", { path: tracks[start].path }).catch(console.error);
    invoke("log_play", { trackId: tracks[start].id }).catch(() => {});
    // Pre-queue next for gapless (tracks array is local, already shuffled if needed).
    const nextIdx = start + 1 < tracks.length ? start + 1 : null;
    pendingNextIdxRef.current = nextIdx;
    if (nextIdx !== null) {
      invoke("queue_next_track", { path: tracks[nextIdx].path }).catch(console.error);
    }
  };

  const playQueueIndex = useCallback((index: number) => {
    playTrackAt(queueRef.current, index);
  }, [playTrackAt]);

  const pickNextIndex = (): number | null => {
    const q = queueRef.current;
    if (q.length === 0) return null;
    if (shuffleRef.current && q.length > 1) {
      let r: number;
      do {
        r = Math.floor(Math.random() * q.length);
      } while (r === queueIndexRef.current);
      return r;
    }
    const i = queueIndexRef.current + 1;
    if (i < q.length) return i;
    if (repeatModeRef.current === "all") return 0;
    return null;
  };

  // Like pickNextIndex but takes an explicit fromIdx instead of reading the
  // ref — needed for gapless where the ref hasn't updated yet.
  const computeNextIndex = (fromIdx: number, queueLen: number): number | null => {
    if (queueLen === 0) return null;
    if (repeatModeRef.current === "one") return fromIdx;
    if (shuffleRef.current && queueLen > 1) {
      let r: number;
      do { r = Math.floor(Math.random() * queueLen); } while (r === fromIdx);
      return r;
    }
    const i = fromIdx + 1;
    if (i < queueLen) return i;
    if (repeatModeRef.current === "all") return 0;
    return null;
  };

  const next = () => {
    const i = pickNextIndex();
    if (i !== null) playTrackAt(queueRef.current, i);
  };

  const prev = () => {
    // Restart current track if past 3 sec; otherwise go to previous track
    if (pbStateRef.current.position > 3 && queueIndexRef.current >= 0) {
      invoke("seek_to", { secs: 0 }).catch(console.error);
      return;
    }
    const i = queueIndexRef.current - 1;
    if (i >= 0) playTrackAt(queueRef.current, i);
  };

  // Convert library albums into UI Album objects
  const uiAlbums = useMemo(() => libAlbums.map(libraryToAlbum), [libAlbums]);
  const albumMap = useMemo(
    () => Object.fromEntries(uiAlbums.map((a) => [a.id, a])),
    [uiAlbums],
  );

  // Helper used by both context-menu factories — builds the track-level
  // items (favorites + edit tags) that show up in every track menu.
  const buildBaseTrackMenuItems = useCallback((track: LibraryTrack): ContextMenuItem[] => {
    const uiAlbum = albumMap[`lib-${track.album_id}`];
    const initialAlbum = uiAlbum?.title ?? "";
    const initialAlbumArtist = uiAlbum?.artist ?? track.artist;
    const initialYear = uiAlbum?.year && uiAlbum.year > 0 ? uiAlbum.year : null;
    const initialGenre = uiAlbum?.genre ?? "";
    const isFav = favoriteIds.has(track.id);
    return [
      {
        label: isFav ? "Remove from favorites" : "Add to favorites",
        onClick: () => toggleFavorite(track.id),
      },
      { label: "", separator: true, onClick: () => {} },
      {
        label: "Edit tags…",
        onClick: () => setEditingTrack({
          trackId: track.id,
          initialTitle: track.title,
          initialArtist: track.artist,
          initialAlbum,
          initialAlbumArtist,
          initialYear,
          initialGenre,
          initialTrackNo: track.track_no,
          initialDiscNo: track.disc_no,
        }),
      },
    ];
  }, [albumMap, favoriteIds, toggleFavorite]);

  // Generic track context menu — used by TrackList rows (Tracks tab, Favorites).
  const openTrackContextMenu = useCallback((track: LibraryTrack, x: number, y: number) => {
    setContextMenu({ x, y, items: buildBaseTrackMenuItems(track) });
  }, [buildBaseTrackMenuItems]);

  // Playlist-aware track context menu — adds a "Remove from this playlist"
  // item at the top so users can curate a playlist with right-clicks. The
  // playlist id comes from the App-level `detailPlaylistId`, which is set
  // exactly when the user is viewing a playlist.
  const openPlaylistTrackContextMenu = useCallback((track: LibraryTrack, x: number, y: number) => {
    const playlistId = detailPlaylistId;
    if (playlistId == null) return;
    const items: ContextMenuItem[] = [
      {
        label: "Remove from this playlist",
        destructive: true,
        onClick: async () => {
          try {
            await invoke("remove_track_from_playlist", { playlistId, trackId: track.id });
            // Refresh the open playlist's tracks + the sidebar's track-count.
            const updated = await invoke<LibraryTrack[]>("get_playlist_tracks", { playlistId });
            setDetailPlaylistTracks(updated);
            refreshPlaylists();
          } catch (err) {
            console.error("[quartz] remove_track_from_playlist failed:", err);
          }
        },
      },
      { label: "", separator: true, onClick: () => {} },
      ...buildBaseTrackMenuItems(track),
    ];
    setContextMenu({ x, y, items });
  }, [detailPlaylistId, buildBaseTrackMenuItems, refreshPlaylists]);

  // Map recent IDs → UI Album objects, dropping any that no longer exist in the library
  const recentAlbums = useMemo(
    () => recentAlbumIds
      .map((id) => albumMap[`lib-${id}`])
      .filter((a): a is Album => Boolean(a)),
    [recentAlbumIds, albumMap],
  );

  // Total track count for the title bar — sum from album track_count rather
  // than fetching the full track list.
  const totalTrackCount = useMemo(
    () => libAlbums.reduce((sum, a) => sum + a.track_count, 0),
    [libAlbums],
  );

  const filtered = useMemo(() => {
    let xs = uiAlbums.slice();
    const q = query.trim().toLowerCase();
    if (q) {
      xs = xs.filter(
        (a) =>
          a.title.toLowerCase().includes(q) ||
          a.artist.toLowerCase().includes(q),
      );
    }
    if (sort === "artist") xs.sort((a, b) => a.artist.localeCompare(b.artist));
    else if (sort === "year") xs.sort((a, b) => b.year - a.year);
    else if (sort === "random") xs = seededShuffle(xs, randomSeed);
    return xs;
  }, [uiAlbums, sort, query, randomSeed]);

  const filteredTracks = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allTracks;
    return allTracks.filter((t) =>
      t.title.toLowerCase().includes(q) ||
      t.artist.toLowerCase().includes(q)
    );
  }, [allTracks, query]);

  const currentUiId = currentLibAlbumId !== null ? `lib-${currentLibAlbumId}` : null;

  // Memo all three derived values below — App re-renders 40× per second
  // during playback (10 Hz playback-state + 30 Hz spectrum-bins), and
  // without memoization these were rebuilt every time, cascading
  // unnecessary re-renders into NowPlayingBar / QueuePanel / their
  // children. The deps here are deliberately narrow so pbState ticks don't
  // invalidate the memo.
  const currentAlbum = useMemo<Album>(
    () =>
      (currentUiId && albumMap[currentUiId]) ||
      uiAlbums[0] ||
      // last-resort placeholder so the NowPlayingBar always has something to render
      ({ id: "none", title: "No track", artist: "", year: 0, genre: "", format: "FLAC", bit: 16, rate: 44.1, label: "", style: "minimal", palette: ["#0a0a0c", "#c9a96e", "#c9a96e"] } as Album),
    [currentUiId, albumMap, uiAlbums],
  );

  const playingTrack = queue[queueIndex];
  const currentQueueTrack = useMemo<QueueTrack>(
    () =>
      playingTrack
        ? { albumId: currentUiId ?? "none", track: playingTrack.track_no ?? queueIndex + 1, title: playingTrack.title, duration: "", current: true }
        : { albumId: "none", track: 1, title: "—", duration: "" },
    [playingTrack, currentUiId, queueIndex],
  );

  const uiQueue = useMemo<QueueTrack[]>(
    () =>
      queue.length > 0
        ? queue.map((t, i) => ({
            albumId: currentUiId ?? "",
            track: t.track_no ?? i + 1,
            title: t.title,
            duration: t.duration ? `${Math.floor(t.duration / 60)}:${String(Math.floor(t.duration % 60)).padStart(2, "0")}` : "",
            current: i === queueIndex,
          }))
        : QUEUE,
    [queue, queueIndex, currentUiId],
  );

  // ── SMTC: push now-playing metadata to the OS ─────────────────────
  // Fires once per real track change (the deps are narrow on purpose —
  // we don't want to repush metadata on every 4 Hz position tick). The
  // Rust side keeps the OS tile updated with the displayed title,
  // artist, album, cover thumbnail, and total duration.
  useEffect(() => {
    if (!playingTrack) return;
    invoke("set_media_metadata", {
      title: playingTrack.title || "Unknown",
      artist: playingTrack.artist || currentAlbum.artist || "Unknown",
      album: currentAlbum.title || "Unknown",
      coverUrl: currentAlbum.coverUrl ?? null,
      duration: playingTrack.duration ?? 0,
    }).catch(() => { /* SMTC may be unavailable — silent fallback */ });
  }, [playingTrack, currentAlbum]);

  // ── SMTC: push playback state on every play/pause/track-change ───
  // We don't tick this at 4 Hz — SMTC interpolates the displayed
  // progress between updates using elapsed wall-clock time. We only
  // call it on transitions: a play, a pause, or a fresh track.
  useEffect(() => {
    const pos = pbStateRef.current?.position ?? 0;
    if (!pbMeta.track) {
      invoke("set_media_playback", { playing: false, stopped: true, position: 0 })
        .catch(() => {});
      return;
    }
    invoke("set_media_playback", {
      playing: pbMeta.playing,
      stopped: false,
      position: pos,
    }).catch(() => {});
  }, [pbMeta.playing, pbMeta.track]);

  // ── SMTC: listen for hardware media keys / lock-screen buttons ───
  // Registered once. Routes to the same handlers the keyboard shortcuts
  // use so behavior is identical whether the user presses Space on the
  // keyboard or the Play tile on the lock screen.
  useEffect(() => {
    const u = listen<string>("media-button", (e) => {
      switch (e.payload) {
        case "play":
          setPlaying(true);
          break;
        case "pause":
          setPlaying(false);
          break;
        case "toggle":
          setPlaying(!playingRef.current);
          break;
        case "next":
          next();
          break;
        case "prev":
          prev();
          break;
        case "stop":
          invoke("stop_playback").catch(() => {});
          break;
      }
    });
    const u2 = listen<number>("media-seek", (e) => {
      invoke("seek_to", { secs: e.payload }).catch(console.error);
    });
    return () => {
      u.then((f) => f());
      u2.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // useTransition lets React keep the sidebar click feedback instant while
  // the expensive content-area re-render (album grid, track list…) is
  // marked as a low-priority update. Without this, clicking a tab on a
  // weak CPU could stall input feedback for 100+ ms while React laid out
  // the new section.
  const [, startSectionTransition] = useTransition();

  // Stable callbacks for memoized Sidebar — recreated only when deps change,
  // not on every render, so memo() actually prevents re-renders.
  const sidebarSetSection = useCallback((s: string) => {
    // Synchronous resets that the click should commit immediately —
    // they're cheap (a handful of `set*(null/[])` writes) and the user
    // expects detail panels to close instantly on a tab change.
    setSettingsOpen(false);
    setDetailAlbumId(null);
    setDetailTracks([]);
    setDetailArtistName(null);
    setArtistDetailAlbums([]);
    setDetailPlaylistId(null);
    setDetailPlaylistTracks([]);
    if (s === "favorites") loadFavoriteTracks();
    // The actual section swap drives the heavy re-render of the content
    // pane — defer it via a transition so the input handler returns
    // immediately and the browser can paint the active-tab style change.
    startSectionTransition(() => {
      setSection(s);
    });
  }, [loadFavoriteTracks]);

  const sidebarOpenAlbum = useCallback((a: Album) => {
    const libId = parseInt(a.id.replace("lib-", ""), 10);
    if (!isNaN(libId)) openAlbum(libId);
  }, [openAlbum]);

  const sidebarSelectPlaylist = useCallback((id: number) => {
    setDetailAlbumId(null);
    setDetailTracks([]);
    setDetailArtistName(null);
    setArtistDetailAlbums([]);
    setSettingsOpen(false);
    openPlaylist(id);
  }, [openPlaylist]);

  const sidebarAiPlaylist = useCallback(() => {
    setAiError(null);
    setShowAiDialog(true);
  }, []);

  // Animation trigger key for screen transitions. Whenever the user
  // navigates (sidebar item, opens a detail view, settings, etc.) this
  // string changes, the content panel's div remounts with key=routeKey,
  // and its CSS class .q-screen fires the fade+rise enter animation.
  // Tradeoff: virtualized grids reset scroll position on remount. Worth
  // it for the perceived polish.
  const routeKey = settingsOpen
    ? "settings"
    : detailPlaylistId !== null
      ? `playlist-${detailPlaylistId}`
      : detailArtistName !== null
        ? `artist-${detailArtistName}`
        : detailAlbumId !== null
          ? `album-${detailAlbumId}`
          : `section-${section}`;

  return (
    <div className="app-shell" data-scrub={scrubStyle} style={{ position: "relative" }}>
      <TitleBar
        logo={logo}
        onOpenSettings={() => setSettingsOpen((s) => !s)}
        settingsActive={settingsOpen}
        albumCount={libAlbums.length}
        artistCount={libArtists.length}
        trackCount={totalTrackCount}
      />
      <div className="middle-row">
        <Sidebar
          section={section}
          setSection={sidebarSetSection}
          albumCount={libAlbums.length}
          artistCount={libArtists.length}
          trackCount={totalTrackCount}
          favoriteCount={favoriteIds.size}
          query={queryInput}
          onQueryChange={setQueryInput}
          searchInputRef={searchInputRef}
          recentAlbums={recentAlbums}
          onOpenAlbum={sidebarOpenAlbum}
          playlists={playlists}
          selectedPlaylistId={detailPlaylistId}
          onSelectPlaylist={sidebarSelectPlaylist}
          onNewPlaylist={newManualPlaylist}
          onAiPlaylist={sidebarAiPlaylist}
          hasAiKey={!!anthropicApiKey.trim()}
        />
        <div key={routeKey} className="q-screen" style={{ display: "grid", gridTemplateRows: settingsOpen || detailAlbumId !== null || detailArtistName !== null || detailPlaylistId !== null ? "1fr" : "auto 1fr", overflow: "hidden", background: "var(--bg)", position: "relative" }}>
          {settingsOpen ? (
            <SettingsPage
              theme={theme}
              setTheme={setTheme}
              accentName={accentName}
              setAccentName={setAccentName}
              dynamicAccent={dynamicAccent}
              onDynamicAccentChange={setDynamicAccent}
              devices={devices}
              selectedDeviceId={selectedDeviceId}
              onSelectDevice={onSelectDevice}
              trackedFolders={trackedFolders}
              albumCount={libAlbums.length}
              artistCount={libArtists.length}
              onAddFolder={() => { setSettingsOpen(false); addFolder(); }}
              onRemoveFolder={removeFolder}
              onRescanAll={() => { setSettingsOpen(false); rescanAll(); }}
              onWipeLibrary={wipeLibrary}
              onFetchArtistPhotos={() => { setSettingsOpen(false); fetchArtistPhotos(); }}
              onRefetchArtistPhotos={() => { setSettingsOpen(false); refetchArtistPhotos(); }}
              onFetchAlbumCovers={() => { setSettingsOpen(false); fetchAlbumCovers(); }}
              fetchingCovers={!!fetchingCovers}
              fanartApiKey={fanartApiKey}
              onFanartApiKeyChange={setFanartApiKey}
              fetchingArtists={!!fetchingArtists}
              anthropicApiKey={anthropicApiKey}
              onAnthropicApiKeyChange={setAnthropicApiKey}
              onBack={() => setSettingsOpen(false)}
              rgConfig={rgConfig}
              onRgConfigChange={(c) => setRgConfig(c)}
              rgProgress={rgProgress}
              rgScanning={rgScanning}
              onScanReplaygain={() => {
                setRgScanning(true);
                setRgProgress(null);
                invoke("scan_replaygain")
                  .then(() => setRgScanning(false))
                  .catch((e) => { console.error(e); setRgScanning(false); });
              }}
              onClearReplaygain={() => {
                invoke("clear_replaygain").catch(console.error);
                setRgProgress(null);
              }}
              scrubStyle={scrubStyle}
              onScrubStyleChange={setScrubStyle}
              waveformProgress={waveformProgress}
              waveformScanning={waveformScanning}
              onScanWaveforms={() => {
                setWaveformScanning(true);
                setWaveformProgress(null);
                invoke("scan_waveforms", { numPeaks: 500 })
                  .then(() => setWaveformScanning(false))
                  .catch((e) => { console.error(e); setWaveformScanning(false); });
              }}
              onClearWaveforms={() => {
                invoke("clear_waveforms").catch(console.error);
                setWaveformProgress(null);
              }}
              crossfadeConfig={crossfadeConfig}
              onCrossfadeConfigChange={setCrossfadeConfig}
              exclusiveActive={pbMeta.exclusive}
              onImportM3u={() => { setSettingsOpen(false); importM3uPlaylist(); }}
              onViewStats={() => { setSettingsOpen(false); setSection("stats"); }}
              sleepTimer={sleepTimer}
              onSetSleepMinutes={(mins) =>
                setSleepTimer({ kind: "minutes", endsAt: Date.now() + mins * 60_000, total: mins })
              }
              onSetSleepEndOfTrack={() => setSleepTimer({ kind: "end-of-track" })}
              onCancelSleepTimer={() => setSleepTimer({ kind: "off" })}
            />
          ) : detailPlaylistId !== null ? (
            <PlaylistDetail
              playlist={playlists.find((p) => p.id === detailPlaylistId) ?? null}
              tracks={detailPlaylistTracks}
              currentTrackPath={queue[queueIndex]?.path}
              playing={pbMeta.playing}
              onBack={closePlaylist}
              onPlayAll={() => playFromPlaylist(0)}
              onShufflePlay={() => playFromPlaylist(0, true)}
              onPlayTrack={(i) => {
                playFromPlaylist(i);
              }}
              onDelete={() => deletePlaylist(detailPlaylistId)}
              onRename={(newName) => renamePlaylist(detailPlaylistId, newName)}
              onContextMenu={openPlaylistTrackContextMenu}
              onExport={detailPlaylistId !== null ? () => exportPlaylistAsM3u(detailPlaylistId) : undefined}
            />
          ) : detailArtistName !== null ? (
            <ArtistDetail
              artist={libArtists.find((a) => a.name === detailArtistName) ?? { name: detailArtistName, album_count: artistDetailAlbums.length, track_count: 0, cover_paths: [], image_path: null }}
              albums={artistDetailAlbums.map(libraryToAlbum)}
              currentAlbumId={currentUiId ?? ""}
              onBack={closeArtist}
              onOpenAlbum={(a) => {
                const libId = parseInt(a.id.replace("lib-", ""), 10);
                if (!isNaN(libId)) openAlbum(libId);
              }}
              onQuickPlay={(a) => {
                const libId = parseInt(a.id.replace("lib-", ""), 10);
                if (!isNaN(libId)) quickPlayAlbum(libId);
              }}
            />
          ) : detailAlbumId !== null ? (
            <AlbumDetail
              album={uiAlbums.find((a) => a.id === `lib-${detailAlbumId}`) ?? null}
              tracks={detailTracks}
              currentTrackPath={queue[queueIndex]?.path}
              isPlayingThisAlbum={currentLibAlbumId === detailAlbumId}
              playing={pbMeta.playing}
              devices={devices}
              favoriteIds={favoriteIds}
              onToggleFavorite={toggleFavorite}
              playlists={playlists}
              onAddToPlaylist={addTrackToPlaylist}
              onBack={closeAlbum}
              onPlayAll={() => playFromDetail(0)}
              onShufflePlay={() => playFromDetail(0, true)}
              onPlayTrack={(i) => playFromDetail(i)}
              onContextMenu={openTrackContextMenu}
            />
          ) : section === "stats" ? (
            <StatsPage
              onOpenAlbum={openAlbum}
              onOpenArtist={openArtist}
            />
          ) : section === "favorites" ? (
            <div style={{ display: "grid", gridTemplateRows: "auto 1fr", overflow: "hidden" }}>
              <SectionHero
                title="Favorites"
                count={favoriteTracks.length}
                unitSingular="track"
                unitPlural="tracks"
              />
              {favoriteTracks.length === 0 ? (
                <div style={{ display: "grid", placeItems: "center", color: "var(--text-faint)", fontSize: 13, fontStyle: "italic", fontFamily: "var(--serif)" }}>
                  No favorites yet — click ♥ on any track
                </div>
              ) : (
                <TrackList
                  tracks={favoriteTracks}
                  albumMap={albumMap}
                  currentTrackPath={queue[queueIndex]?.path}
                  playing={pbMeta.playing}
                  onPlay={playTrackFromList}
                  onContextMenu={openTrackContextMenu}
                  onOpenArtist={openArtist}
                  onOpenAlbum={openAlbum}
                />
              )}
            </div>
          ) : section.startsWith("smart-") ? (
            <div style={{ display: "grid", gridTemplateRows: "auto 1fr", overflow: "hidden" }}>
              <SectionHero
                title={
                  section === "smart-added" ? "Recently Added"
                  : section === "smart-played" ? "Recently Played"
                  : section === "smart-most" ? "Most Played"
                  : "Never Played"
                }
                count={smartTracks.length}
                unitSingular="track"
                unitPlural="tracks"
              />
              {smartLoading ? (
                <div style={{ display: "grid", placeItems: "center", color: "var(--text-faint)" }}>Loading…</div>
              ) : smartTracks.length === 0 ? (
                <div style={{ display: "grid", placeItems: "center", color: "var(--text-faint)", fontSize: 13, fontStyle: "italic", fontFamily: "var(--serif)" }}>
                  {
                    section === "smart-added" ? "No recently-added tracks yet"
                    : section === "smart-played" ? "You haven't played anything yet"
                    : section === "smart-most" ? "No plays logged yet"
                    : "Every track in your library has been played"
                  }
                </div>
              ) : (
                <TrackList
                  tracks={smartTracks}
                  albumMap={albumMap}
                  currentTrackPath={queue[queueIndex]?.path}
                  playing={pbMeta.playing}
                  onPlay={playTrackFromList}
                  onContextMenu={openTrackContextMenu}
                  onOpenArtist={openArtist}
                  onOpenAlbum={openAlbum}
                />
              )}
            </div>
          ) : section === "artists" ? (
            <>
              <SectionHero
                title="Artists"
                count={libArtists.length}
                unitSingular="artist"
                unitPlural="artists"
                right={libArtists.length > 0 ? <ViewToggle value={artistView} onChange={setArtistView} /> : null}
              />
              {libArtists.length === 0 && !scanning ? (
                <EmptyLibrary onChooseFolder={addFolder} />
              ) : artistView === "grid" ? (
                <ArtistGrid artists={libArtists} onOpen={openArtist} />
              ) : (
                <ArtistList artists={libArtists} onOpen={openArtist} />
              )}
            </>
          ) : section === "tracks" ? (
            <div style={{ display: "grid", gridTemplateRows: "auto 1fr", overflow: "hidden" }}>
              <SectionHero
                title="Tracks"
                count={filteredTracks.length}
                unitSingular="track"
                unitPlural="tracks"
              />
              {tracksLoading ? (
                <div style={{ display: "grid", placeItems: "center", color: "var(--text-faint)" }}>
                  Loading…
                </div>
              ) : allTracks.length === 0 && !scanning ? (
                <EmptyLibrary onChooseFolder={addFolder} />
              ) : (
                <TrackList
                  tracks={filteredTracks}
                  albumMap={albumMap}
                  currentTrackPath={queue[queueIndex]?.path}
                  playing={pbMeta.playing}
                  onPlay={playTrackFromList}
                  onContextMenu={openTrackContextMenu}
                  onOpenArtist={openArtist}
                  onOpenAlbum={openAlbum}
                />
              )}
            </div>
          ) : (
            <>
              <BrowseHeader sort={sort} setSort={handleSortChange} albumCount={filtered.length} viewMode={viewMode} setViewMode={setViewMode} />
              {libAlbums.length === 0 && !scanning ? (
                <EmptyLibrary onChooseFolder={addFolder} />
              ) : viewMode === "list" ? (
                <AlbumList
                  albums={filtered}
                  currentId={currentUiId ?? ""}
                  onPlay={(a) => {
                    const libId = parseInt(a.id.replace("lib-", ""), 10);
                    if (!isNaN(libId)) openAlbum(libId);
                  }}
                />
              ) : (
                <AlbumGrid
                  albums={filtered}
                  currentId={currentUiId ?? ""}
                  onPlay={handleAlbumCardPlay}
                  onQuickPlay={handleAlbumCardQuickPlay}
                />
              )}
            </>
          )}
          {scanning && <ScanOverlay progress={scanning} />}
          {fetchingArtists && <ArtistFetchOverlay progress={fetchingArtists} />}
          {fetchingCovers && <AlbumCoverOverlay progress={fetchingCovers} />}
        </div>
        <QueuePanel
          queue={uiQueue}
          albumMap={albumMap}
          devices={devices}
          onPlayIndex={playQueueIndex}
          onReorder={reorderQueue}
        />
      </div>
      <NowPlayingBar
        current={currentQueueTrack}
        currentAlbum={currentAlbum}
        playing={pbMeta.playing}
        setPlaying={setPlaying}
        initialPosition={savedSession.position}
        initialDuration={savedSession.duration}
        exclusive={pbMeta.exclusive}
        exclusiveEnabled={exclusiveEnabled}
        onToggleExclusive={onToggleExclusive}
        liveTrack={pbMeta.track}
        onPrev={prev}
        onNext={next}
        volume={volume}
        onVolumeChange={onVolumeChange}
        shuffle={shuffle}
        onShuffleToggle={() => setShuffle(!shuffle)}
        repeatMode={repeatMode}
        onRepeatCycle={cycleRepeat}
        onOpenFullscreen={() => setFullscreenOpen(true)}
        onOpenEq={() => setEqOpen(true)}
        eqEnabled={eqSettings.enabled}
        scrubStyle={scrubStyle}
        waveformPeaks={currentWaveform}
        currentTrackId={currentTrackId ?? null}
        isFavorite={currentTrackId != null && favoriteIds.has(currentTrackId)}
        onToggleFavorite={() => { if (currentTrackId != null) toggleFavorite(currentTrackId); }}
        sleepTimer={sleepTimer}
        onCancelSleepTimer={() => setSleepTimer({ kind: "off" })}
      />
      {/* EqPanel is lazy-loaded; the Suspense fallback renders nothing
          while the chunk fetches (~tens of ms on first open). The panel
          early-returns null when `open=false` so the chunk doesn't even
          start fetching until the user first opens it. */}
      <Suspense fallback={null}>
        {eqOpen && (
          <EqPanel
            open={eqOpen}
            onClose={() => setEqOpen(false)}
            eq={eqSettings}
            onChange={setEqSettings}
          />
        )}
      </Suspense>
      <FullscreenPlayer
        open={fullscreenOpen}
        onClose={() => setFullscreenOpen(false)}
        currentAlbum={currentAlbum}
        current={currentQueueTrack}
        playing={pbMeta.playing}
        setPlaying={setPlaying}
        initialPosition={savedSession.position}
        initialDuration={savedSession.duration}
        exclusive={pbMeta.exclusive}
        exclusiveEnabled={exclusiveEnabled}
        onToggleExclusive={onToggleExclusive}
        liveTrack={pbMeta.track}
        onPrev={prev}
        onNext={next}
        volume={volume}
        onVolumeChange={onVolumeChange}
        shuffle={shuffle}
        onShuffleToggle={() => setShuffle(!shuffle)}
        repeatMode={repeatMode}
        onRepeatCycle={cycleRepeat}
        onOpenMiniPlayer={openMiniPlayer}
        accentName={accentName}
        dynamicAccent={dynamicAccent}
        dynamicAccentColor={
          currentLibAlbumId != null
            ? (libAlbums.find((a) => a.id === currentLibAlbumId)?.accent_color ?? null)
            : null
        }
        scrubStyle={scrubStyle}
        waveformPeaks={currentWaveform}
        currentTrackId={currentTrackId ?? null}
        isFavorite={currentTrackId != null && favoriteIds.has(currentTrackId)}
        onToggleFavorite={() => { if (currentTrackId != null) toggleFavorite(currentTrackId); }}
      />
      <AiPlaylistDialog
        open={showAiDialog}
        prompt={aiPrompt}
        onPromptChange={setAiPrompt}
        loading={aiLoading}
        error={aiError}
        hasApiKey={!!anthropicApiKey.trim()}
        onGenerate={createAiPlaylist}
        onClose={() => { setShowAiDialog(false); setAiError(null); }}
      />

      {/* Phase 19: first-run welcome. Shown only when nothing's been set
          up yet — once a folder is registered, the user never sees this
          overlay again unless they wipe the library AND unregister all
          folders. The scan-in-progress check prevents a flicker where
          the overlay re-appears between addFolder() and the first scan
          progress event. */}
      {trackedFolders.length === 0 && libAlbums.length === 0 && !scanning && (
        <FirstRunWelcome onChooseFolder={addFolder} />
      )}

      {/* Phase 27: auto-updater prompt. Mounts unconditionally; the
          component decides internally whether to render anything (it
          only shows after a successful update-check finds a newer
          version). Lives above the NowPlayingBar but below modals. */}
      <UpdaterPrompt />

      {/* Phase 22: drag-drop visual hint. Pointer-events: none so the
          overlay never absorbs the drop itself — the OS-level drag-drop
          handler still fires on the underlying window. z-index above
          everything else so the user sees the same hint regardless of
          which panel they're hovering. */}
      {dragHover && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 8500,
          background: "rgba(10,10,12,0.65)",
          backdropFilter: "blur(6px)",
          border: "3px dashed var(--accent)",
          display: "grid", placeItems: "center",
          pointerEvents: "none",
        }}>
          <div style={{ textAlign: "center", color: "var(--text)" }}>
            <div className="micro" style={{ color: "var(--accent)", marginBottom: 14, letterSpacing: "0.2em" }}>
              Release to import
            </div>
            <div style={{
              fontFamily: "var(--serif)", fontStyle: "italic", fontSize: 36,
              color: "var(--text)", lineHeight: 1.2,
            }}>
              Drop folders or audio files
            </div>
            <div style={{ marginTop: 14, fontSize: 12, color: "var(--text-dim)" }}>
              Folders are added to your library · files scan their parent folder
            </div>
          </div>
        </div>
      )}

      {/* Right-click context menu + tag editor modal — globally mounted so
          they can be opened from any list (Tracks tab, Favorites, etc.). */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenu.items}
          onClose={() => setContextMenu(null)}
        />
      )}
      <TagEditor
        target={editingTrack}
        onClose={() => setEditingTrack(null)}
        onSaved={() => {
          // Refresh the views that show the edited row. The artist count
          // may have changed if the user moved the track to a new artist.
          refreshAlbums();
          refreshFavorites();
          // If the user is in the Tracks tab, refresh the full track list.
          if (tracksLoaded) {
            invoke<LibraryTrack[]>("list_all_tracks")
              .then(setAllTracks)
              .catch(console.error);
          }
          // If the album detail view is open and shows this track, refresh.
          if (detailAlbumId !== null) {
            invoke<LibraryTrack[]>("list_tracks", { albumId: detailAlbumId })
              .then(setDetailTracks)
              .catch(console.error);
          }
        }}
      />
    </div>
  );
}

// ── Parametric EQ panel (moved to ./EqPanel.tsx for code-splitting) ──
//
// The EqPanel implementation lives in its own module so React.lazy can
// emit it as a separate JS chunk that only downloads when the user opens
// the EQ overlay. See the lazy() import at the top of this file.

// ── Tag editor ──────────────────────────────────────────────────────
// A modal form for editing a track's tags (title, artist, album, year,
// genre, track #, disc #, album artist). On Save, invokes Tauri's
// `edit_track_tags` command which writes the tags back to disk and
// resyncs the library DB via the same code path as the bulk scanner.

export interface TagEditorTarget {
  trackId: number;
  initialTitle: string;
  initialArtist: string;
  initialAlbum: string;
  initialAlbumArtist: string;
  initialYear: number | null;
  initialGenre: string;
  initialTrackNo: number | null;
  initialDiscNo: number | null;
}

interface TagEditorProps {
  target: TagEditorTarget | null;
  onClose: () => void;
  onSaved: () => void;
}

function TagEditor({ target, onClose, onSaved }: TagEditorProps) {
  const [title, setTitle]             = useState("");
  const [artist, setArtist]           = useState("");
  const [album, setAlbum]             = useState("");
  const [albumArtist, setAlbumArtist] = useState("");
  const [year, setYear]               = useState("");
  const [genre, setGenre]             = useState("");
  const [trackNo, setTrackNo]         = useState("");
  const [discNo, setDiscNo]           = useState("");
  const [saving, setSaving]           = useState(false);
  const [error, setError]             = useState<string | null>(null);

  // Re-seed fields when a new target is opened.
  useEffect(() => {
    if (!target) return;
    setTitle(target.initialTitle);
    setArtist(target.initialArtist);
    setAlbum(target.initialAlbum);
    setAlbumArtist(target.initialAlbumArtist);
    setYear(target.initialYear != null ? String(target.initialYear) : "");
    setGenre(target.initialGenre);
    setTrackNo(target.initialTrackNo != null ? String(target.initialTrackNo) : "");
    setDiscNo(target.initialDiscNo != null ? String(target.initialDiscNo) : "");
    setError(null);
    setSaving(false);
  }, [target]);

  // Esc to cancel
  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [target, onClose]);

  if (!target) return null;

  const intOrNull = (s: string): number | null => {
    const t = s.trim();
    if (t === "") return null;
    const n = parseInt(t, 10);
    return isNaN(n) ? null : n;
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    const edit = {
      title: title.trim(),
      artist: artist.trim(),
      album: album.trim(),
      albumArtist: albumArtist.trim(),
      year: intOrNull(year),
      genre: genre.trim(),
      trackNo: intOrNull(trackNo),
      discNo: intOrNull(discNo),
    };
    try {
      await invoke("edit_track_tags", { trackId: target.trackId, edit });
      onSaved();
      onClose();
    } catch (e) {
      setError(String(e));
      setSaving(false);
    }
  };

  const inputStyle: React.CSSProperties = {
    background: "var(--bg)",
    border: "1px solid var(--line-strong)",
    borderRadius: 3,
    color: "var(--text)",
    fontFamily: "var(--sans)",
    fontSize: 12,
    padding: "8px 10px",
    outline: "none",
    width: "100%",
  };
  const labelStyle: React.CSSProperties = {
    fontSize: 10,
    color: "var(--text-dim)",
    fontFamily: "var(--sans)",
    letterSpacing: "0.12em",
    textTransform: "uppercase",
    marginBottom: 4,
  };

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 350,
        background: "rgba(0,0,0,0.55)",
        display: "grid", placeItems: "center",
      }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        width: "min(560px, 92vw)",
        background: "var(--bg-elev)",
        border: "1px solid var(--line-strong)",
        borderRadius: 6,
        padding: "20px 24px 18px",
        boxShadow: "0 12px 40px rgba(0,0,0,0.5)",
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
          <div style={{ fontFamily: "var(--serif)", fontStyle: "italic", fontSize: 20, color: "var(--text)" }}>
            Edit tags
          </div>
          <button
            onClick={onClose}
            style={{
              background: "transparent", border: 0, padding: 4,
              cursor: "pointer", color: "var(--text-faint)",
              display: "grid", placeItems: "center",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text)")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-faint)")}
            title="Close"
          >
            <svg width="14" height="14" viewBox="0 0 12 12">
              <line x1="1" y1="1" x2="11" y2="11" stroke="currentColor" strokeWidth="1.5" />
              <line x1="11" y1="1" x2="1" y2="11" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px 14px" }}>
          <div style={{ gridColumn: "1 / span 2" }}>
            <div style={labelStyle}>Title</div>
            <input style={inputStyle} value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
          </div>

          <div>
            <div style={labelStyle}>Artist</div>
            <input style={inputStyle} value={artist} onChange={(e) => setArtist(e.target.value)} />
          </div>
          <div>
            <div style={labelStyle}>Album artist</div>
            <input
              style={inputStyle}
              value={albumArtist}
              onChange={(e) => setAlbumArtist(e.target.value)}
              placeholder="(same as artist)"
            />
          </div>

          <div style={{ gridColumn: "1 / span 2" }}>
            <div style={labelStyle}>Album</div>
            <input style={inputStyle} value={album} onChange={(e) => setAlbum(e.target.value)} />
          </div>

          <div>
            <div style={labelStyle}>Year</div>
            <input
              style={inputStyle} value={year}
              onChange={(e) => setYear(e.target.value.replace(/[^0-9]/g, ""))}
              maxLength={4}
            />
          </div>
          <div>
            <div style={labelStyle}>Genre</div>
            <input style={inputStyle} value={genre} onChange={(e) => setGenre(e.target.value)} />
          </div>

          <div>
            <div style={labelStyle}>Track #</div>
            <input
              style={inputStyle} value={trackNo}
              onChange={(e) => setTrackNo(e.target.value.replace(/[^0-9]/g, ""))}
            />
          </div>
          <div>
            <div style={labelStyle}>Disc #</div>
            <input
              style={inputStyle} value={discNo}
              onChange={(e) => setDiscNo(e.target.value.replace(/[^0-9]/g, ""))}
            />
          </div>
        </div>

        {error && (
          <div style={{
            marginTop: 14, padding: "8px 10px",
            background: "rgba(201,122,110,0.10)",
            border: "1px solid var(--danger)",
            borderRadius: 3, color: "var(--danger)",
            fontFamily: "var(--mono)", fontSize: 11, lineHeight: 1.4,
          }}>{error}</div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
          <button
            onClick={onClose}
            disabled={saving}
            style={{
              padding: "9px 18px",
              background: "transparent", color: "var(--text-dim)",
              border: "1px solid var(--line-strong)", borderRadius: 3,
              fontSize: 11, letterSpacing: "0.14em",
              textTransform: "uppercase", fontWeight: 500,
              fontFamily: "var(--sans)",
              cursor: saving ? "not-allowed" : "pointer",
            }}
          >Cancel</button>
          <button
            onClick={handleSave}
            disabled={saving}
            style={{
              padding: "9px 18px",
              background: saving ? "transparent" : "var(--accent)",
              color: saving ? "var(--text-faint)" : "var(--bg)",
              border: saving ? "1px solid var(--line-strong)" : 0,
              borderRadius: 3,
              fontSize: 11, letterSpacing: "0.14em",
              textTransform: "uppercase", fontWeight: 500,
              fontFamily: "var(--sans)",
              cursor: saving ? "not-allowed" : "pointer",
            }}
          >{saving ? "Saving…" : "Save"}</button>
        </div>
      </div>
    </div>
  );
}

// ── Context menu (right-click popup) ────────────────────────────────
// Stateless popup; just renders at the given coordinates and dispatches
// the picked item's `onClick`. Clicking outside closes via the overlay.

export interface ContextMenuItem {
  label: string;
  onClick: () => void;
  destructive?: boolean;
  separator?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  // Clamp to viewport so we don't render off-screen.
  const [pos, setPos] = useState({ x, y });
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth, h = el.offsetHeight;
    let nx = x, ny = y;
    if (x + w > window.innerWidth)  nx = window.innerWidth  - w - 6;
    if (y + h > window.innerHeight) ny = window.innerHeight - h - 6;
    setPos({ x: Math.max(4, nx), y: Math.max(4, ny) });
  }, [x, y]);

  // Close on Esc.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <div
        style={{ position: "fixed", inset: 0, zIndex: 399 }}
        onMouseDown={onClose}
        onContextMenu={(e) => { e.preventDefault(); onClose(); }}
      />
      <div
        ref={ref}
        className="q-ctxmenu"
        style={{ top: pos.y, left: pos.x }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {items.map((item, i) => item.separator
          ? <div key={`sep-${i}`} className="q-ctxmenu-sep" />
          : (
            <div
              key={i}
              className="q-ctxmenu-item"
              style={item.destructive ? { color: "var(--danger)" } : undefined}
              onClick={() => { item.onClick(); onClose(); }}
            >{item.label}</div>
          )
        )}
      </div>
    </>
  );
}

// ── Empty / scanning overlays ───────────────────────────────────────
// ── Settings popover ────────────────────────────────────────────────
// Per-theme accent variants ensure readability on all backgrounds.
// Dark variants are vivid/pale (on near-black), light/sepia/rose variants
// are deeply saturated so they pop against cream/pink backgrounds.
const ACCENT_OPTIONS: { name: string; variants: Record<Theme, string> }[] = [
  { name: "Brass",   variants: { dark: "#c9a96e", sepia: "#7a5010", light: "#7a5010", rose: "#8a5818" } },
  { name: "Cognac",  variants: { dark: "#9a7050", sepia: "#6a3810", light: "#6a3810", rose: "#6a3810" } },
  { name: "Crimson", variants: { dark: "#a85040", sepia: "#882818", light: "#882818", rose: "#882818" } },
  { name: "Sage",    variants: { dark: "#8aa090", sepia: "#3a6848", light: "#3a6848", rose: "#3a6848" } },
  { name: "Slate",   variants: { dark: "#7a8a9a", sepia: "#385870", light: "#385870", rose: "#385870" } },
  { name: "Rose",    variants: { dark: "#c4899a", sepia: "#8a3058", light: "#8a3058", rose: "#7a1840" } },
];

function getAccentHex(name: string, theme: Theme): string {
  const opt = ACCENT_OPTIONS.find((a) => a.name === name) ?? ACCENT_OPTIONS[0];
  return opt.variants[theme];
}

interface SettingsPageProps {
  theme: Theme;
  setTheme: (t: Theme) => void;
  accentName: string;
  setAccentName: (n: string) => void;
  dynamicAccent: boolean;
  onDynamicAccentChange: (v: boolean) => void;
  devices: Device[];
  selectedDeviceId: string | null;
  onSelectDevice: (id: string) => void;
  trackedFolders: string[];
  onAddFolder: () => void;
  onRemoveFolder: (folder: string) => void;
  onRescanAll: () => void;
  onWipeLibrary: () => void;
  onFetchArtistPhotos: () => void;
  onRefetchArtistPhotos: () => void;
  fanartApiKey: string;
  onFanartApiKeyChange: (k: string) => void;
  fetchingArtists: boolean;
  onFetchAlbumCovers: () => void;
  fetchingCovers: boolean;
  anthropicApiKey: string;
  onAnthropicApiKeyChange: (k: string) => void;
  albumCount: number;
  artistCount: number;
  onBack: () => void;
  rgConfig: ReplayGainConfig;
  onRgConfigChange: (c: ReplayGainConfig) => void;
  rgProgress: RgProgress | null;
  rgScanning: boolean;
  onScanReplaygain: () => void;
  onClearReplaygain: () => void;
  scrubStyle: ScrubStyle;
  onScrubStyleChange: (s: ScrubStyle) => void;
  waveformProgress: RgProgress | null;
  waveformScanning: boolean;
  onScanWaveforms: () => void;
  onClearWaveforms: () => void;
  crossfadeConfig: CrossfadeConfig;
  onCrossfadeConfigChange: (c: CrossfadeConfig) => void;
  exclusiveActive: boolean;
  // Moved from sidebar — gathers the actions that used to be scattered.
  onImportM3u: () => void;
  onViewStats: () => void;
  // Sleep timer controls live here now; chip in NowPlayingBar is indicator-only.
  sleepTimer: SleepTimer;
  onSetSleepMinutes: (mins: number) => void;
  onSetSleepEndOfTrack: () => void;
  onCancelSleepTimer: () => void;
}

function SettingsPage({
  theme, setTheme, accentName, setAccentName,
  dynamicAccent, onDynamicAccentChange,
  devices, selectedDeviceId, onSelectDevice,
  trackedFolders, onAddFolder, onRemoveFolder, onRescanAll, onWipeLibrary,
  onFetchArtistPhotos, onRefetchArtistPhotos,
  onFetchAlbumCovers, fetchingCovers,
  fanartApiKey, onFanartApiKeyChange,
  fetchingArtists,
  anthropicApiKey, onAnthropicApiKeyChange,
  albumCount, artistCount, onBack,
  rgConfig, onRgConfigChange, rgProgress, rgScanning, onScanReplaygain, onClearReplaygain,
  scrubStyle, onScrubStyleChange, waveformProgress, waveformScanning, onScanWaveforms, onClearWaveforms,
  crossfadeConfig, onCrossfadeConfigChange, exclusiveActive,
  onImportM3u, onViewStats,
  sleepTimer, onSetSleepMinutes, onSetSleepEndOfTrack, onCancelSleepTimer,
}: SettingsPageProps) {
  const hasFolders = trackedFolders.length > 0;
  const [confirmingWipe, setConfirmingWipe] = useState(false);
  return (
    <div style={{ overflowY: "auto", padding: "20px 32px 32px" }}>
      {/* Top bar */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
        <button
          onClick={onBack}
          style={{
            background: "transparent", border: 0, padding: "6px 10px 6px 4px",
            color: "var(--text-dim)", cursor: "pointer",
            display: "flex", alignItems: "center", gap: 6,
            fontFamily: "var(--sans)", fontSize: 12,
            letterSpacing: "0.04em",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text)")}
          onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-dim)")}
        >
          <svg width="11" height="11" viewBox="0 0 12 12">
            <path d="M7 2 L3 6 L7 10" stroke="currentColor" fill="none" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Library
        </button>
      </div>

      {/* Title */}
      <div style={{ marginBottom: 32 }}>
        <div className="micro" style={{ marginBottom: 8 }}>Quartz</div>
        <h1 style={{
          margin: 0, fontFamily: "var(--serif)", fontStyle: "italic", fontWeight: 400,
          fontSize: 38, letterSpacing: "-0.01em", color: "var(--text)", lineHeight: 1,
        }}>Settings</h1>
      </div>

      <div style={{ maxWidth: 560 }}>
        {/* Appearance */}
        <SectionHeader>Appearance</SectionHeader>

        <SettingRow label="Theme">
          <div style={{ display: "flex", gap: 8, flex: 1 }}>
            {(["dark", "sepia", "light", "rose"] as Theme[]).map((t) => (
              <button
                key={t}
                onClick={() => setTheme(t)}
                style={{
                  flex: 1, padding: "10px 0",
                  background: t === theme ? "var(--accent-soft)" : "transparent",
                  border: t === theme ? "1px solid var(--accent)" : "1px solid var(--line-strong)",
                  color: t === theme ? "var(--accent)" : "var(--text-dim)",
                  fontSize: 11, letterSpacing: "0.14em",
                  textTransform: "uppercase", fontFamily: "var(--sans)",
                  cursor: "pointer", borderRadius: 3,
                }}
              >{t}</button>
            ))}
          </div>
        </SettingRow>

        <SettingRow label="Accent">
          <div style={{ display: "flex", gap: 10 }}>
            {ACCENT_OPTIONS.map((c) => {
              const selected = c.name === accentName;
              const hex = c.variants[theme];
              return (
                <button
                  key={c.name}
                  onClick={() => setAccentName(c.name)}
                  title={c.name}
                  style={{
                    width: 36, height: 36, borderRadius: "50%",
                    background: hex, cursor: "pointer",
                    border: selected ? "2px solid var(--text)" : "1px solid var(--line-strong)",
                    boxShadow: selected ? `0 0 0 3px ${hex}55` : "none",
                    padding: 0,
                    transition: "box-shadow 120ms",
                  }}
                />
              );
            })}
          </div>
        </SettingRow>

        <SettingRow label="Match accent to cover art">
          <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1 }}>
            <div style={{ display: "flex", gap: 8 }}>
              {([
                { v: true,  label: "On"  },
                { v: false, label: "Off" },
              ]).map((opt) => (
                <button
                  key={String(opt.v)}
                  onClick={() => onDynamicAccentChange(opt.v)}
                  style={{
                    flex: 1, padding: "10px 0",
                    background: opt.v === dynamicAccent ? "var(--accent-soft)" : "transparent",
                    border: opt.v === dynamicAccent ? "1px solid var(--accent)" : "1px solid var(--line-strong)",
                    color: opt.v === dynamicAccent ? "var(--accent)" : "var(--text-dim)",
                    fontSize: 11, letterSpacing: "0.14em",
                    textTransform: "uppercase", fontFamily: "var(--sans)",
                    cursor: "pointer", borderRadius: 3,
                  }}
                >{opt.label}</button>
              ))}
            </div>
            <div style={{ fontSize: 11, color: "var(--text-faint)", lineHeight: 1.5 }}>
              Tints the play button, scrub fill, and spectrum bars with the
              dominant color of the currently-playing album's cover.
              Falls back to the accent above when there's no cover or the
              cover is grayscale.
            </div>
          </div>
        </SettingRow>

        <SettingRow label="Scrub bar">
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", gap: 8 }}>
              {(["bar", "waveform"] as ScrubStyle[]).map((s) => (
                <button
                  key={s}
                  onClick={() => onScrubStyleChange(s)}
                  style={{
                    flex: 1, padding: "10px 16px",
                    background: s === scrubStyle ? "var(--accent-soft)" : "transparent",
                    border: s === scrubStyle ? "1px solid var(--accent)" : "1px solid var(--line-strong)",
                    color: s === scrubStyle ? "var(--accent)" : "var(--text-dim)",
                    fontSize: 11, letterSpacing: "0.14em",
                    textTransform: "uppercase", fontFamily: "var(--sans)",
                    cursor: "pointer", borderRadius: 3,
                  }}
                >{s === "bar" ? "Bar" : "Waveform"}</button>
              ))}
            </div>
            <div style={{ fontSize: 11, color: "var(--text-faint)", lineHeight: 1.5 }}>
              Waveform shows the decoded peak envelope for the playing track.
              Computed on first play and cached on disk; pre-compute below to
              avoid a brief delay on new tracks.
            </div>
          </div>
        </SettingRow>

        {/* Output Device */}
        <SectionHeader>Output Device</SectionHeader>
        <div style={{ padding: "12px 0", borderBottom: "1px solid var(--line)" }}>
          {devices.length === 0 && (
            <div className="micro" style={{ color: "var(--text-faint)" }}>No devices found</div>
          )}
          {devices.map((d) => {
            // The user's explicit selection wins; otherwise Windows default
            // (d.current from the Rust enumeration) is shown as current.
            const isCurrent = selectedDeviceId ? selectedDeviceId === d.id : d.current;
            return (
              <DeviceCard
                key={d.id}
                device={d}
                isCurrent={isCurrent}
                onClick={() => onSelectDevice(d.id)}
              />
            );
          })}
        </div>

        {/* Library */}
        <SectionHeader>Library</SectionHeader>
        <SettingRow label="Indexed">
          <div className="micro" style={{ color: "var(--text-faint)" }}>
            {albumCount.toLocaleString()} albums · {artistCount.toLocaleString()} artists
          </div>
        </SettingRow>
        <SettingRow label="Tracked folders">
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 6 }}>
            {trackedFolders.length === 0 && (
              <div className="micro" style={{ color: "var(--text-faint)" }}>None yet</div>
            )}
            {trackedFolders.map((f) => (
              <div key={f} style={{
                display: "flex", alignItems: "center", gap: 8,
                padding: "8px 10px",
                background: "var(--bg-elev)",
                border: "1px solid var(--line-strong)",
                borderRadius: 3,
              }}>
                <span className="mono" style={{
                  flex: 1, minWidth: 0,
                  fontSize: 11, color: "var(--text-dim)",
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }} title={f}>{f}</span>
                <button
                  onClick={() => onRemoveFolder(f)}
                  title="Remove"
                  style={{
                    background: "transparent", border: 0, padding: 4,
                    cursor: "pointer", color: "var(--text-faint)",
                    display: "grid", placeItems: "center",
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = "var(--danger)")}
                  onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-faint)")}
                >
                  <svg width="10" height="10" viewBox="0 0 10 10">
                    <line x1="1" y1="1" x2="9" y2="9" stroke="currentColor" strokeWidth="1" />
                    <line x1="9" y1="1" x2="1" y2="9" stroke="currentColor" strokeWidth="1" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        </SettingRow>
        <SettingRow label="Actions">
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={onRescanAll}
              disabled={!hasFolders}
              style={{
                padding: "10px 18px",
                background: hasFolders ? "var(--accent)" : "transparent",
                color: hasFolders ? "var(--bg)" : "var(--text-faint)",
                border: hasFolders ? 0 : "1px solid var(--line-strong)",
                borderRadius: 3,
                fontSize: 11, letterSpacing: "0.14em",
                textTransform: "uppercase", fontWeight: 500,
                fontFamily: "var(--sans)",
                cursor: hasFolders ? "pointer" : "not-allowed",
              }}
            >Rescan all</button>
            <button
              onClick={onAddFolder}
              style={{
                padding: "10px 18px",
                background: "transparent", color: "var(--text-dim)",
                border: "1px solid var(--line-strong)", borderRadius: 3,
                fontSize: 11, letterSpacing: "0.14em",
                textTransform: "uppercase", fontWeight: 500,
                fontFamily: "var(--sans)",
                cursor: "pointer",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text)")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-dim)")}
            >+ Add folder</button>
            <button
              onClick={onImportM3u}
              title="Import a .m3u or .m3u8 playlist file"
              style={{
                padding: "10px 18px",
                background: "transparent", color: "var(--text-dim)",
                border: "1px solid var(--line-strong)", borderRadius: 3,
                fontSize: 11, letterSpacing: "0.14em",
                textTransform: "uppercase", fontWeight: 500,
                fontFamily: "var(--sans)",
                cursor: "pointer",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text)")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-dim)")}
            >Import playlist…</button>
            <button
              onClick={onViewStats}
              title="View aggregated listening history"
              style={{
                padding: "10px 18px",
                background: "transparent", color: "var(--text-dim)",
                border: "1px solid var(--line-strong)", borderRadius: 3,
                fontSize: 11, letterSpacing: "0.14em",
                textTransform: "uppercase", fontWeight: 500,
                fontFamily: "var(--sans)",
                cursor: "pointer",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text)")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-dim)")}
            >View stats</button>
          </div>
        </SettingRow>
        <SettingRow label="fanart.tv key">
          <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1, minWidth: 0 }}>
            <input
              type="text"
              value={fanartApiKey}
              onChange={(e) => onFanartApiKeyChange(e.target.value)}
              placeholder="Paste your fanart.tv personal API key (optional)"
              spellCheck={false}
              autoComplete="off"
              style={{
                background: "var(--bg-elev)",
                border: "1px solid var(--line-strong)",
                borderRadius: 3,
                color: "var(--text)",
                fontFamily: "var(--mono)",
                fontSize: 11,
                padding: "8px 10px",
                outline: "none",
                width: "100%",
              }}
            />
            <div style={{ fontSize: 11, color: "var(--text-faint)", lineHeight: 1.5 }}>
              Get one at{" "}
              <a
                href="https://fanart.tv/get-an-api-key/"
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: "var(--accent)", textDecoration: "none" }}
              >fanart.tv/get-an-api-key</a>
              {" "}— free, takes a minute. When set, artist photos are pulled from
              fanart.tv (curated for music apps) instead of Wikimedia Commons.
              Leave blank to use the Wikidata fallback only.
            </div>
          </div>
        </SettingRow>
        <SectionHeader>Integrations</SectionHeader>
        <SettingRow label="Anthropic key">
          <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1, minWidth: 0 }}>
            <input
              type="password"
              value={anthropicApiKey}
              onChange={(e) => onAnthropicApiKeyChange(e.target.value)}
              placeholder="sk-ant-… (for AI playlist generation)"
              spellCheck={false}
              autoComplete="off"
              style={{
                background: "var(--bg-elev)",
                border: "1px solid var(--line-strong)",
                borderRadius: 3,
                color: "var(--text)",
                fontFamily: "var(--mono)",
                fontSize: 11,
                padding: "8px 10px",
                outline: "none",
                width: "100%",
              }}
            />
            <div style={{ fontSize: 11, color: "var(--text-faint)", lineHeight: 1.5 }}>
              Used for AI playlist generation via Claude. Stored locally, never sent
              anywhere except the Anthropic API. Get a key at{" "}
              <a
                href="https://console.anthropic.com/settings/keys"
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: "var(--accent)", textDecoration: "none" }}
              >console.anthropic.com</a>.
            </div>
          </div>
        </SettingRow>
        <SettingRow label="Artist photos">
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ fontSize: 12, color: "var(--text-dim)", maxWidth: 420 }}>
              Pull photos for artists in your library. Tries fanart.tv first
              (if a key is set), falls back to MusicBrainz + Wikidata. Goes
              one at a time (~1 req/sec) so a 500-artist library takes
              ~20 minutes. Falls back to a composite of album covers when no
              photo is available.
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={onFetchArtistPhotos}
                disabled={fetchingArtists}
                style={{
                  padding: "10px 18px",
                  background: fetchingArtists ? "transparent" : "var(--accent)",
                  color: fetchingArtists ? "var(--text-faint)" : "var(--bg)",
                  border: fetchingArtists ? "1px solid var(--line-strong)" : 0,
                  borderRadius: 3,
                  fontSize: 11, letterSpacing: "0.14em",
                  textTransform: "uppercase", fontWeight: 500,
                  fontFamily: "var(--sans)",
                  cursor: fetchingArtists ? "not-allowed" : "pointer",
                }}
              >{fetchingArtists ? "Fetching…" : "Fetch missing"}</button>
              <button
                onClick={onRefetchArtistPhotos}
                disabled={fetchingArtists}
                title="Clear all existing photos and re-fetch every artist. Use after changing source (e.g., after pasting a fanart.tv key)."
                style={{
                  padding: "10px 18px",
                  background: "transparent",
                  color: fetchingArtists ? "var(--text-faint)" : "var(--text-dim)",
                  border: "1px solid var(--line-strong)",
                  borderRadius: 3,
                  fontSize: 11, letterSpacing: "0.14em",
                  textTransform: "uppercase", fontWeight: 500,
                  fontFamily: "var(--sans)",
                  cursor: fetchingArtists ? "not-allowed" : "pointer",
                }}
                onMouseEnter={(e) => { if (!fetchingArtists) e.currentTarget.style.color = "var(--text)"; }}
                onMouseLeave={(e) => { if (!fetchingArtists) e.currentTarget.style.color = "var(--text-dim)"; }}
              >Re-fetch all</button>
            </div>
          </div>
        </SettingRow>
        <SettingRow label="Album covers">
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ fontSize: 12, color: "var(--text-dim)", maxWidth: 420 }}>
              Fill in missing album art from{" "}
              <a
                href="https://coverartarchive.org/"
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: "var(--accent)", textDecoration: "none" }}
              >Cover Art Archive</a>. Looks up each album with no embedded
              cover on MusicBrainz, downloads the front cover, and resizes
              to 512 px. Albums whose tags don't match any MB release are
              skipped silently.
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={onFetchAlbumCovers}
                disabled={!!fetchingCovers}
                style={{
                  padding: "10px 18px",
                  background: fetchingCovers ? "transparent" : "var(--accent)",
                  color: fetchingCovers ? "var(--text-faint)" : "var(--bg)",
                  border: fetchingCovers ? "1px solid var(--line-strong)" : 0,
                  borderRadius: 3,
                  fontSize: 11, letterSpacing: "0.14em",
                  textTransform: "uppercase", fontWeight: 500,
                  fontFamily: "var(--sans)",
                  cursor: fetchingCovers ? "not-allowed" : "pointer",
                }}
              >{fetchingCovers ? "Fetching…" : "Fetch missing"}</button>
            </div>
          </div>
        </SettingRow>
        {/* ReplayGain */}
        <SectionHeader>Sound</SectionHeader>
        <SettingRow label="ReplayGain">
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ fontSize: 12, color: "var(--text-dim)", maxWidth: 420, lineHeight: 1.5 }}>
              Normalises track loudness using EBU R128 (ITU-BS.1770) so every
              track plays at the same perceived volume. Scan your library first,
              then enable. Target −14 LUFS matches most streaming services.
            </div>

            {/* Enable + Target LUFS */}
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                <input
                  type="checkbox" checked={rgConfig.enabled}
                  onChange={(e) => onRgConfigChange({ ...rgConfig, enabled: e.target.checked })}
                  style={{ accentColor: "var(--accent)", cursor: "pointer" }}
                />
                <span style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--sans)" }}>Enabled</span>
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                <span style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--sans)" }}>Target LUFS</span>
                <input
                  type="number" min={-24} max={-6} step={0.5}
                  value={rgConfig.target_lufs}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    if (!isNaN(v)) onRgConfigChange({ ...rgConfig, target_lufs: v });
                  }}
                  style={{
                    width: 60, background: "var(--bg-elev)",
                    border: "1px solid var(--line-strong)", borderRadius: 2,
                    color: "var(--text)", fontFamily: "var(--mono)", fontSize: 11,
                    padding: "3px 6px", outline: "none", textAlign: "right",
                    MozAppearance: "textfield",
                  }}
                />
              </label>
            </div>

            {/* Scan controls */}
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button
                onClick={onScanReplaygain}
                disabled={rgScanning}
                style={{
                  padding: "10px 18px",
                  background: rgScanning ? "transparent" : "var(--accent)",
                  color: rgScanning ? "var(--text-faint)" : "var(--bg)",
                  border: rgScanning ? "1px solid var(--line-strong)" : 0,
                  borderRadius: 3, fontSize: 11, letterSpacing: "0.14em",
                  textTransform: "uppercase", fontWeight: 500, fontFamily: "var(--sans)",
                  cursor: rgScanning ? "not-allowed" : "pointer",
                }}
              >{rgScanning ? "Scanning…" : "Scan library"}</button>
              <button
                onClick={onClearReplaygain}
                disabled={rgScanning}
                title="Clear all stored loudness data so you can re-scan"
                style={{
                  padding: "10px 18px",
                  background: "transparent", color: rgScanning ? "var(--text-faint)" : "var(--text-dim)",
                  border: "1px solid var(--line-strong)", borderRadius: 3,
                  fontSize: 11, letterSpacing: "0.14em",
                  textTransform: "uppercase", fontWeight: 500, fontFamily: "var(--sans)",
                  cursor: rgScanning ? "not-allowed" : "pointer",
                }}
                onMouseEnter={(e) => { if (!rgScanning) e.currentTarget.style.color = "var(--text)"; }}
                onMouseLeave={(e) => { if (!rgScanning) e.currentTarget.style.color = "var(--text-dim)"; }}
              >Clear data</button>
            </div>

            {/* Progress bar */}
            {rgProgress && (
              <div style={{ maxWidth: 340 }}>
                <div style={{
                  height: 3, width: "100%", background: "var(--line-strong)",
                  borderRadius: 2, overflow: "hidden", marginBottom: 6,
                }}>
                  <div style={{
                    height: "100%",
                    width: `${rgProgress.total > 0 ? Math.round((rgProgress.done / rgProgress.total) * 100) : 0}%`,
                    background: "var(--accent)", transition: "width 0.3s linear",
                  }} />
                </div>
                <div className="mono" style={{ fontSize: 10, color: "var(--text-faint)" }}>
                  {rgProgress.scanned} scanned · {rgProgress.done} of {rgProgress.total} files
                </div>
              </div>
            )}
          </div>
        </SettingRow>

        <SettingRow label="Waveforms">
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ fontSize: 12, color: "var(--text-dim)", maxWidth: 420, lineHeight: 1.5 }}>
              Pre-compute peak waveforms for every track so the waveform
              scrubber appears instantly on track change. Each file is decoded
              once and the result cached on disk (~2 KB per track).
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button
                onClick={onScanWaveforms}
                disabled={waveformScanning}
                style={{
                  padding: "10px 18px",
                  background: waveformScanning ? "transparent" : "var(--accent)",
                  color: waveformScanning ? "var(--text-faint)" : "var(--bg)",
                  border: waveformScanning ? "1px solid var(--line-strong)" : 0,
                  borderRadius: 3, fontSize: 11, letterSpacing: "0.14em",
                  textTransform: "uppercase", fontWeight: 500, fontFamily: "var(--sans)",
                  cursor: waveformScanning ? "not-allowed" : "pointer",
                }}
              >{waveformScanning ? "Scanning…" : "Pre-compute all"}</button>
              <button
                onClick={onClearWaveforms}
                disabled={waveformScanning}
                title="Delete all cached waveform files"
                style={{
                  padding: "10px 18px",
                  background: "transparent", color: waveformScanning ? "var(--text-faint)" : "var(--text-dim)",
                  border: "1px solid var(--line-strong)", borderRadius: 3,
                  fontSize: 11, letterSpacing: "0.14em",
                  textTransform: "uppercase", fontWeight: 500, fontFamily: "var(--sans)",
                  cursor: waveformScanning ? "not-allowed" : "pointer",
                }}
                onMouseEnter={(e) => { if (!waveformScanning) e.currentTarget.style.color = "var(--text)"; }}
                onMouseLeave={(e) => { if (!waveformScanning) e.currentTarget.style.color = "var(--text-dim)"; }}
              >Clear cache</button>
            </div>
            {waveformProgress && (
              <div style={{ maxWidth: 340 }}>
                <div style={{
                  height: 3, width: "100%", background: "var(--line-strong)",
                  borderRadius: 2, overflow: "hidden", marginBottom: 6,
                }}>
                  <div style={{
                    height: "100%",
                    width: `${waveformProgress.total > 0 ? Math.round((waveformProgress.done / waveformProgress.total) * 100) : 0}%`,
                    background: "var(--accent)", transition: "width 0.3s linear",
                  }} />
                </div>
                <div className="mono" style={{ fontSize: 10, color: "var(--text-faint)" }}>
                  {waveformProgress.scanned} computed · {waveformProgress.done} of {waveformProgress.total} files
                </div>
              </div>
            )}
          </div>
        </SettingRow>

        <SettingRow label="Crossfade">
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ fontSize: 12, color: "var(--text-dim)", maxWidth: 460, lineHeight: 1.5 }}>
              Blend the end of one track into the start of the next using an
              equal-power curve. Only works in shared mode — exclusive mode
              keeps the path bit-perfect with no mixing.
              {exclusiveActive && crossfadeConfig.enabled && (
                <div style={{
                  marginTop: 6, padding: "6px 8px",
                  background: "rgba(201,122,110,0.10)",
                  border: "1px solid var(--danger)",
                  borderRadius: 3, color: "var(--danger)",
                  fontFamily: "var(--mono)", fontSize: 11,
                }}>
                  Currently in exclusive mode — crossfade is inactive. Switch
                  to shared mode (chip in the player bar) to enable it.
                </div>
              )}
            </div>

            <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
              <input
                type="checkbox" checked={crossfadeConfig.enabled}
                onChange={(e) => onCrossfadeConfigChange({ ...crossfadeConfig, enabled: e.target.checked })}
                style={{ accentColor: "var(--accent)", cursor: "pointer" }}
              />
              <span style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--sans)" }}>Enabled</span>
            </label>

            <div style={{
              display: "grid", gridTemplateColumns: "auto 1fr 60px",
              alignItems: "center", gap: 12, maxWidth: 360,
              opacity: crossfadeConfig.enabled ? 1 : 0.45,
              pointerEvents: crossfadeConfig.enabled ? "auto" : "none",
            }}>
              <span style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--sans)" }}>Duration</span>
              <input
                type="range" min={1} max={8} step={0.5}
                value={crossfadeConfig.durationSecs}
                onChange={(e) => onCrossfadeConfigChange({
                  ...crossfadeConfig,
                  durationSecs: parseFloat(e.target.value),
                })}
                style={{ accentColor: "var(--accent)" }}
              />
              <span className="mono" style={{ fontSize: 11, color: "var(--text)", textAlign: "right" }}>
                {crossfadeConfig.durationSecs.toFixed(1)} s
              </span>
            </div>
          </div>
        </SettingRow>

        <SettingRow label="Sleep timer">
          <div style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 460 }}>
            <div style={{ fontSize: 12, color: "var(--text-dim)", lineHeight: 1.5 }}>
              Pause playback after a fixed number of minutes, or at the end
              of the current track. While active, a small indicator appears
              in the player bar; click it to cancel.
            </div>
            <SleepTimerControls
              timer={sleepTimer}
              onSetMinutes={onSetSleepMinutes}
              onSetEndOfTrack={onSetSleepEndOfTrack}
              onCancel={onCancelSleepTimer}
            />
          </div>
        </SettingRow>

        <SettingRow label="Danger zone">
          {!confirmingWipe ? (
            <button
              onClick={() => setConfirmingWipe(true)}
              style={{
                padding: "10px 18px",
                background: "transparent", color: "var(--danger)",
                border: "1px solid var(--danger)", borderRadius: 3,
                fontSize: 11, letterSpacing: "0.14em",
                textTransform: "uppercase", fontWeight: 500,
                fontFamily: "var(--sans)",
                cursor: "pointer", alignSelf: "flex-start",
              }}
            >Wipe library…</button>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ fontSize: 12, color: "var(--text-dim)", maxWidth: 380 }}>
                This removes every indexed album, track, and cached cover. Your
                music files on disk are not touched. Tracked folders stay so
                you can rescan immediately. Continue?
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  onClick={() => { setConfirmingWipe(false); onWipeLibrary(); }}
                  style={{
                    padding: "10px 18px",
                    background: "var(--danger)", color: "var(--bg)",
                    border: 0, borderRadius: 3,
                    fontSize: 11, letterSpacing: "0.14em",
                    textTransform: "uppercase", fontWeight: 500,
                    fontFamily: "var(--sans)", cursor: "pointer",
                  }}
                >Yes, wipe</button>
                <button
                  onClick={() => setConfirmingWipe(false)}
                  style={{
                    padding: "10px 18px",
                    background: "transparent", color: "var(--text-dim)",
                    border: "1px solid var(--line-strong)", borderRadius: 3,
                    fontSize: 11, letterSpacing: "0.14em",
                    textTransform: "uppercase", fontWeight: 500,
                    fontFamily: "var(--sans)", cursor: "pointer",
                  }}
                >Cancel</button>
              </div>
            </div>
          )}
        </SettingRow>
      </div>
    </div>
  );
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      marginTop: 26, marginBottom: 10,
      paddingBottom: 8, borderBottom: "1px solid var(--line)",
    }}>
      <div className="micro-strong" style={{ color: "var(--accent)" }}>{children}</div>
    </div>
  );
}

function SettingRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{
      display: "grid", gridTemplateColumns: "140px 1fr",
      gap: 24, padding: "16px 0",
      borderBottom: "1px solid var(--line)",
      alignItems: "center",
    }}>
      <div style={{
        fontFamily: "var(--serif)", fontStyle: "italic", fontSize: 13.5,
        color: "var(--text-dim)",
      }}>{label}</div>
      <div>{children}</div>
    </div>
  );
}

// ── Stats page (Phase 25) ──────────────────────────────────────────
interface StatsPageProps {
  onOpenAlbum: (libId: number) => void;
  onOpenArtist: (name: string) => void;
}

/// Aggregated listening-history view backed by a single Rust composite
/// query. Loads once when the user opens the section; refreshes itself
/// every time the section is re-entered so freshly-logged plays show up
/// (the section switcher unmounts/remounts the page on each entry).
function StatsPage({ onOpenAlbum, onOpenArtist }: StatsPageProps) {
  const [stats, setStats] = useState<ListeningStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    invoke<ListeningStats>("get_listening_stats")
      .then((s) => { if (alive) setStats(s); })
      .catch((err) => console.error("[quartz] get_listening_stats failed:", err))
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  if (loading || !stats) {
    return (
      <div style={{ display: "grid", placeItems: "center", height: "100%", color: "var(--text-faint)" }}>
        Loading…
      </div>
    );
  }

  if (stats.total_plays === 0) {
    return (
      <div style={{ display: "grid", placeItems: "center", height: "100%", padding: 40 }}>
        <div style={{ textAlign: "center", maxWidth: 440, color: "var(--text-dim)" }}>
          <div style={{ fontFamily: "var(--serif)", fontStyle: "italic", fontSize: 26, color: "var(--text)", marginBottom: 12 }}>
            Nothing to show yet
          </div>
          <p style={{ fontSize: 13, lineHeight: 1.6 }}>
            Stats appear once you've played something. Pick an album and start
            listening — your history accumulates locally and never leaves
            the machine.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ overflowY: "auto", flex: 1, padding: "24px 32px 40px" }}>
      {/* Title */}
      <div style={{ marginBottom: 32 }}>
        <div className="micro" style={{ marginBottom: 8 }}>Insights</div>
        <h1 style={{
          margin: 0, fontFamily: "var(--serif)", fontStyle: "italic", fontWeight: 400,
          fontSize: 38, letterSpacing: "-0.01em", color: "var(--text)", lineHeight: 1,
        }}>Listening stats</h1>
      </div>

      {/* Hero counters */}
      <div style={{
        display: "grid", gridTemplateColumns: "repeat(4, 1fr)",
        gap: 16, marginBottom: 36,
      }}>
        <HeroCounter label="Total plays" value={stats.total_plays.toLocaleString()} />
        <HeroCounter label="Time listened" value={formatHoursMinutes(stats.total_seconds)} />
        <HeroCounter label="Unique tracks" value={stats.unique_tracks.toLocaleString()} />
        <HeroCounter label="Unique artists" value={stats.unique_artists.toLocaleString()} />
      </div>

      {/* Recent activity */}
      <div style={{
        display: "grid", gridTemplateColumns: "1fr 1fr",
        gap: 16, marginBottom: 36,
      }}>
        <HeroCounter
          label="Plays in the last 7 days"
          value={stats.plays_last_7d.toLocaleString()}
          accent
        />
        <HeroCounter
          label="Plays in the last 30 days"
          value={stats.plays_last_30d.toLocaleString()}
          accent
        />
      </div>

      {/* Plays per day chart */}
      <SectionHeader>Last 30 days</SectionHeader>
      <PlaysPerDayChart data={stats.plays_per_day} />

      {/* By-hour + by-weekday side-by-side */}
      <div style={{
        display: "grid", gridTemplateColumns: "2fr 1fr",
        gap: 24, marginTop: 36, marginBottom: 36,
      }}>
        <div>
          <SectionHeader>By hour of day</SectionHeader>
          <ByHourChart data={stats.by_hour} />
        </div>
        <div>
          <SectionHeader>By weekday</SectionHeader>
          <ByWeekdayChart data={stats.by_weekday} />
        </div>
      </div>

      {/* Top artists / albums */}
      <div style={{
        display: "grid", gridTemplateColumns: "1fr 1fr",
        gap: 24, marginTop: 28,
      }}>
        <div>
          <SectionHeader>Top artists</SectionHeader>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {stats.top_artists.length === 0 && (
              <div className="micro" style={{ color: "var(--text-faint)" }}>None yet</div>
            )}
            {stats.top_artists.map((a, i) => (
              <button
                key={a.name}
                onClick={() => onOpenArtist(a.name)}
                style={{
                  display: "grid", gridTemplateColumns: "24px 1fr auto",
                  alignItems: "center", gap: 10,
                  padding: "8px 12px",
                  background: "transparent", border: 0,
                  borderRadius: 3, cursor: "pointer", textAlign: "left",
                  color: "var(--text)",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "var(--panel)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              >
                <span className="mono" style={{ fontSize: 11, color: "var(--text-faint)" }}>
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {a.name}
                </span>
                <span className="mono" style={{ fontSize: 11, color: "var(--accent)" }}>
                  {a.play_count}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div>
          <SectionHeader>Top albums</SectionHeader>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {stats.top_albums.length === 0 && (
              <div className="micro" style={{ color: "var(--text-faint)" }}>None yet</div>
            )}
            {stats.top_albums.map((alb, i) => (
              <button
                key={alb.id}
                onClick={() => onOpenAlbum(alb.id)}
                style={{
                  display: "grid", gridTemplateColumns: "24px 36px 1fr auto",
                  alignItems: "center", gap: 10,
                  padding: "6px 10px",
                  background: "transparent", border: 0,
                  borderRadius: 3, cursor: "pointer", textAlign: "left",
                  color: "var(--text)",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "var(--panel)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              >
                <span className="mono" style={{ fontSize: 11, color: "var(--text-faint)" }}>
                  {String(i + 1).padStart(2, "0")}
                </span>
                <div style={{ width: 36, height: 36, borderRadius: 2, overflow: "hidden", background: "var(--panel-2)" }}>
                  {alb.cover_path ? (
                    <img
                      src={convertFileSrc(alb.cover_path)}
                      alt=""
                      width={36}
                      height={36}
                      loading="lazy"
                      decoding="async"
                      style={{ width: 36, height: 36, objectFit: "cover", display: "block" }}
                    />
                  ) : null}
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{
                    fontFamily: "var(--serif)", fontStyle: "italic", fontSize: 13,
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  }}>{alb.title}</div>
                  <div style={{
                    fontSize: 11, color: "var(--text-faint)",
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 1,
                  }}>{alb.artist}</div>
                </div>
                <span className="mono" style={{ fontSize: 11, color: "var(--accent)" }}>
                  {alb.play_count}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function HeroCounter({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div style={{
      padding: "18px 20px",
      background: "var(--bg-elev)",
      border: "1px solid var(--line-strong)",
      borderRadius: 4,
    }}>
      <div className="micro" style={{ marginBottom: 8 }}>{label}</div>
      <div style={{
        fontFamily: "var(--serif)", fontStyle: "italic",
        fontSize: 26, color: accent ? "var(--accent)" : "var(--text)",
        lineHeight: 1.1,
      }}>{value}</div>
    </div>
  );
}

/// Format seconds as e.g. "127h 14m" or "47m" — always whole minutes.
function formatHoursMinutes(secs: number): string {
  if (!isFinite(secs) || secs <= 0) return "0m";
  const totalMin = Math.floor(secs / 60);
  const hr = Math.floor(totalMin / 60);
  const mn = totalMin % 60;
  if (hr === 0) return `${mn}m`;
  return `${hr.toLocaleString()}h ${mn}m`;
}

/// Pure-SVG bar chart for plays-per-day over a 30-day window. The
/// backend returns sparse rows (only days with plays); we fill in the
/// gaps locally so the X axis is a continuous timeline.
function PlaysPerDayChart({ data }: { data: DayCount[] }) {
  // Build a complete 30-day series ending today.
  const days = 30;
  const todayMidnight = Math.floor(Date.now() / 1000 / 86400) * 86400;
  const series: { date: Date; count: number }[] = [];
  // Index the backend's sparse data by epoch for O(1) lookup.
  const byDay = new Map(data.map((d) => [d.day_epoch, d.count]));
  for (let i = days - 1; i >= 0; i--) {
    const dayEpoch = todayMidnight - i * 86400;
    series.push({
      date: new Date(dayEpoch * 1000),
      count: byDay.get(dayEpoch) ?? 0,
    });
  }
  const maxCount = Math.max(1, ...series.map((s) => s.count));
  const W = 100;  // viewBox width (responsive via preserveAspectRatio)
  const H = 28;
  const barW = W / days;
  const pad = 0.18;

  return (
    <div style={{
      background: "var(--bg-elev)",
      border: "1px solid var(--line-strong)",
      borderRadius: 4,
      padding: "14px 16px 8px",
    }}>
      <svg
        viewBox={`0 0 ${W} ${H + 4}`}
        preserveAspectRatio="none"
        style={{ width: "100%", height: 140, display: "block" }}
      >
        {series.map((s, i) => {
          const h = (s.count / maxCount) * H;
          return (
            <g key={i}>
              <rect
                x={i * barW + barW * pad}
                y={H - h}
                width={barW * (1 - pad * 2)}
                height={Math.max(0.4, h)}
                fill={s.count > 0 ? "var(--accent)" : "var(--line-strong)"}
                opacity={s.count > 0 ? 1 : 0.45}
              >
                <title>{`${s.date.toLocaleDateString()} — ${s.count} plays`}</title>
              </rect>
            </g>
          );
        })}
      </svg>
      <div style={{
        display: "flex", justifyContent: "space-between",
        marginTop: 6, fontSize: 10, color: "var(--text-faint)", fontFamily: "var(--mono)",
      }}>
        <span>{series[0].date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
        <span>Max {maxCount} per day</span>
        <span>{series[series.length - 1].date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
      </div>
    </div>
  );
}

// Shared fixed height for both stats histograms — keeps the by-hour and
// by-weekday cards visually aligned regardless of differing inner content.
// 156 px matches the by-hour SVG's natural rendered height (110 SVG +
// vertical padding + axis labels).
const STATS_CHART_HEIGHT = 156;

function ByHourChart({ data }: { data: number[] }) {
  const max = Math.max(1, ...data);
  const W = 100; const H = 24;
  const barW = W / 24;
  return (
    <div style={{
      background: "var(--bg-elev)",
      border: "1px solid var(--line-strong)",
      borderRadius: 4,
      padding: "14px 16px 8px",
      height: STATS_CHART_HEIGHT,
      display: "flex", flexDirection: "column",
    }}>
      <div style={{ flex: 1, minHeight: 0 }}>
        <svg
          viewBox={`0 0 ${W} ${H + 3}`}
          preserveAspectRatio="none"
          style={{ width: "100%", height: "100%", display: "block" }}
        >
          {data.map((c, i) => {
            const h = (c / max) * H;
            return (
              <rect
                key={i}
                x={i * barW + barW * 0.15}
                y={H - h}
                width={barW * 0.7}
                height={Math.max(0.4, h)}
                fill="var(--accent)"
                opacity={c > 0 ? 1 : 0.25}
              >
                <title>{`${String(i).padStart(2, "0")}:00 — ${c} plays`}</title>
              </rect>
            );
          })}
        </svg>
      </div>
      <div style={{
        display: "flex", justifyContent: "space-between",
        marginTop: 6, fontSize: 10, color: "var(--text-faint)", fontFamily: "var(--mono)",
      }}>
        <span>00</span><span>06</span><span>12</span><span>18</span><span>23</span>
      </div>
    </div>
  );
}

function ByWeekdayChart({ data }: { data: number[] }) {
  // SQL returns Sunday-first (0=Sun). Display labels match.
  const labels = ["S", "M", "T", "W", "T", "F", "S"];
  const max = Math.max(1, ...data);
  return (
    <div style={{
      background: "var(--bg-elev)",
      border: "1px solid var(--line-strong)",
      borderRadius: 4,
      padding: "14px 16px 8px",
      height: STATS_CHART_HEIGHT,
      display: "flex", flexDirection: "column",
    }}>
      <div style={{
        display: "grid", gridTemplateColumns: "repeat(7, 1fr)",
        gap: 6, flex: 1, minHeight: 0, alignItems: "end",
      }}>
        {data.map((c, i) => {
          const h = (c / max) * 100;
          return (
            <div key={i} style={{
              height: `${Math.max(2, h)}%`,
              background: c > 0 ? "var(--accent)" : "var(--line-strong)",
              opacity: c > 0 ? 1 : 0.25,
              borderRadius: 2,
            }}
              title={`${labels[i]} — ${c} plays`}
            />
          );
        })}
      </div>
      <div style={{
        display: "grid", gridTemplateColumns: "repeat(7, 1fr)",
        gap: 6, marginTop: 6, fontSize: 10, color: "var(--text-faint)",
        fontFamily: "var(--mono)", textAlign: "center",
      }}>
        {labels.map((l, i) => <span key={i}>{l}</span>)}
      </div>
    </div>
  );
}

function EmptyLibrary({ onChooseFolder }: { onChooseFolder: () => void }) {
  return (
    <div style={{
      display: "grid", placeItems: "center", padding: 40, color: "var(--text-dim)",
    }}>
      <div style={{ textAlign: "center", maxWidth: 480 }}>
        <div style={{ fontFamily: "var(--serif)", fontStyle: "italic", fontSize: 28, color: "var(--text)", marginBottom: 12 }}>
          Your library is empty
        </div>
        <p style={{ fontSize: 13, lineHeight: 1.6, marginBottom: 24 }}>
          Quartz reads FLAC, WAV, AIFF, OGG, MP3, and M4A. Point it at a folder and we'll
          walk the tree, read your tags, and build a searchable library.
        </p>
        <button
          onClick={onChooseFolder}
          style={{
            padding: "10px 22px", background: "var(--accent)", color: "var(--bg)",
            border: 0, borderRadius: 3, fontSize: 12, letterSpacing: "0.14em",
            textTransform: "uppercase", fontWeight: 500, cursor: "pointer",
            fontFamily: "var(--sans)",
          }}
        >
          Choose music folder
        </button>
      </div>
    </div>
  );
}

/// Phase 19: first-run welcome overlay. Rendered on top of the whole app
/// when the user has no library folders configured and no scan is active.
/// Disappears the moment a folder is chosen — `addFolder` updates
/// `trackedFolders`, which removes the rendering condition next tick.
function FirstRunWelcome({ onChooseFolder }: { onChooseFolder: () => void }) {
  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 9000,
      background: "var(--bg)",
      display: "grid", placeItems: "center", padding: 40,
    }}>
      {/* Decorative blurred art-circle accents — same vocabulary as the
          FullscreenPlayer backdrop so the welcome feels like part of the
          same app, not a generic "first-run wizard". */}
      <div style={{
        position: "absolute", top: "-20%", right: "-10%",
        width: 480, height: 480, borderRadius: "50%",
        background: "var(--accent)", opacity: 0.06,
        filter: "blur(60px)", pointerEvents: "none",
      }} />
      <div style={{
        position: "absolute", bottom: "-20%", left: "-10%",
        width: 380, height: 380, borderRadius: "50%",
        background: "var(--accent)", opacity: 0.04,
        filter: "blur(50px)", pointerEvents: "none",
      }} />

      <div style={{ textAlign: "center", maxWidth: 520, position: "relative" }}>
        <div className="micro" style={{ color: "var(--accent)", marginBottom: 18, letterSpacing: "0.2em" }}>
          Welcome
        </div>
        <h1 style={{
          margin: 0,
          fontFamily: "var(--serif)", fontStyle: "italic", fontWeight: 400,
          fontSize: 56, letterSpacing: "-0.01em", lineHeight: 1,
          color: "var(--text)", marginBottom: 20,
        }}>
          Quartz
        </h1>
        <p style={{
          fontSize: 14.5, lineHeight: 1.7, color: "var(--text-dim)",
          maxWidth: 440, margin: "0 auto 36px",
        }}>
          A bit-perfect Windows music player for your local library.
          Point Quartz at a folder of FLAC, WAV, AIFF, OGG, MP3, or M4A files
          and we'll read every tag, every embedded cover, and build a fully
          searchable library — no cloud, no telemetry, no accounts.
        </p>

        <button
          onClick={onChooseFolder}
          style={{
            padding: "14px 32px",
            background: "var(--accent)", color: "var(--bg)",
            border: 0, borderRadius: 4,
            fontSize: 13, letterSpacing: "0.16em",
            textTransform: "uppercase", fontWeight: 500,
            cursor: "pointer", fontFamily: "var(--sans)",
            boxShadow: "0 8px 28px -8px var(--accent)",
            transition: "transform 120ms",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.transform = "translateY(-1px)")}
          onMouseLeave={(e) => (e.currentTarget.style.transform = "translateY(0)")}
        >
          Choose music folder
        </button>

        <div style={{
          marginTop: 48, paddingTop: 24, borderTop: "1px solid var(--line)",
          display: "flex", justifyContent: "center", gap: 32,
          fontSize: 11.5, color: "var(--text-faint)",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
              <circle cx="6" cy="6" r="5" stroke="var(--accent)" strokeWidth="1" />
              <path d="M3.5 6 L5 7.5 L8.5 4.5" stroke="var(--accent)" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
            </svg>
            WASAPI exclusive mode
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
              <circle cx="6" cy="6" r="5" stroke="var(--accent)" strokeWidth="1" />
              <path d="M3.5 6 L5 7.5 L8.5 4.5" stroke="var(--accent)" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
            </svg>
            Up to 32-bit / 384 kHz
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
              <circle cx="6" cy="6" r="5" stroke="var(--accent)" strokeWidth="1" />
              <path d="M3.5 6 L5 7.5 L8.5 4.5" stroke="var(--accent)" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
            </svg>
            Gapless + crossfade
          </div>
        </div>
      </div>
    </div>
  );
}

function ArtistFetchOverlay({ progress }: { progress: ArtistFetchProgress }) {
  const pct = progress.total > 0 ? Math.round((progress.processed / progress.total) * 100) : 0;
  return (
    <div style={{
      position: "absolute", inset: 0, background: "rgba(10,10,12,0.85)",
      backdropFilter: "blur(8px)", display: "grid", placeItems: "center", zIndex: 10,
    }}>
      <div style={{ textAlign: "center", minWidth: 380, padding: 32 }}>
        <div className="micro-strong" style={{ color: "var(--accent)", marginBottom: 12 }}>
          Fetching Artist Photos
        </div>
        <div style={{ fontFamily: "var(--serif)", fontStyle: "italic", fontSize: 22, marginBottom: 18 }}>
          {progress.total > 0 ? `${progress.processed} of ${progress.total}` : "Starting…"}
        </div>
        <div style={{
          height: 3, width: "100%", background: "var(--line-strong)",
          borderRadius: 2, overflow: "hidden", marginBottom: 14,
        }}>
          <div style={{
            height: "100%", width: `${pct}%`, background: "var(--accent)",
            transition: "width 0.2s linear",
          }} />
        </div>
        <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 4 }}>
          {progress.current_artist || "—"}
        </div>
        <div className="mono" style={{ fontSize: 10, color: "var(--text-faint)" }}>
          {progress.found} {progress.found === 1 ? "photo" : "photos"} found
        </div>
      </div>
    </div>
  );
}

function AlbumCoverOverlay({ progress }: { progress: AlbumCoverProgress }) {
  const pct = progress.total > 0 ? Math.round((progress.processed / progress.total) * 100) : 0;
  return (
    <div style={{
      position: "absolute", inset: 0, background: "rgba(10,10,12,0.85)",
      backdropFilter: "blur(8px)", display: "grid", placeItems: "center", zIndex: 10,
    }}>
      <div style={{ textAlign: "center", minWidth: 380, padding: 32 }}>
        <div className="micro-strong" style={{ color: "var(--accent)", marginBottom: 12 }}>
          Fetching Album Covers
        </div>
        <div style={{ fontFamily: "var(--serif)", fontStyle: "italic", fontSize: 22, marginBottom: 18 }}>
          {progress.total > 0 ? `${progress.processed} of ${progress.total}` : "Starting…"}
        </div>
        <div style={{
          height: 3, width: "100%", background: "var(--line-strong)",
          borderRadius: 2, overflow: "hidden", marginBottom: 14,
        }}>
          <div style={{
            height: "100%", width: `${pct}%`, background: "var(--accent)",
            transition: "width 0.2s linear",
          }} />
        </div>
        <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 4 }}>
          {progress.current_album || "—"}
        </div>
        <div className="mono" style={{ fontSize: 10, color: "var(--text-faint)" }}>
          {progress.found} {progress.found === 1 ? "cover" : "covers"} found
        </div>
      </div>
    </div>
  );
}

// ── Auto-updater prompt (Phase 27) ───────────────────────────────────
//
// Slim banner at the bottom-right of the window. Appears only when the
// updater plugin found a newer signed release. The user picks Install
// (download + install + relaunch) or Later (dismissed for this session).
//
// Lifecycle:
//   1. App mounts → wait 4 s so the initial render isn't competing for
//      the network or main thread with a startup check.
//   2. `check()` calls the configured GitHub Releases endpoint. Offline
//      or 404 → no-op, no UI; the next launch tries again.
//   3. If an update is found, banner appears. User clicks Install →
//      `downloadAndInstall()` streams the bytes with progress callbacks,
//      verifies the bundled signature against the public key, then
//      `relaunch()` swaps to the new binary.
//   4. Any error → swallow + log; the banner offers Retry instead of
//      Install. Worst case the user keeps the current version.

type UpdateState =
  | { kind: "idle" }
  | { kind: "available"; version: string; notes: string }
  | { kind: "downloading"; version: string; downloaded: number; total: number | null }
  | { kind: "installing"; version: string }
  | { kind: "error"; version: string; message: string };

function UpdaterPrompt() {
  const [state, setState] = useState<UpdateState>({ kind: "idle" });
  const dismissedRef = useRef(false);

  // Check on mount. We don't depend on anything; the closure intentionally
  // captures dismissedRef so a later "Later" click suppresses the prompt
  // even if the async chain completes after dismissal.
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      if (cancelled) return;
      try {
        const { check } = await import("@tauri-apps/plugin-updater");
        const u = await check();
        if (cancelled || dismissedRef.current) return;
        if (u && u.available) {
          setState({
            kind: "available",
            version: u.version,
            notes: (u.body || "").trim(),
          });
        }
      } catch (err) {
        // Network failure / endpoint unreachable / signature config
        // missing during dev — silent no-op. Logged for debugging.
        console.debug("[updater] check failed (this is fine):", err);
      }
    }, 4000);
    return () => { cancelled = true; clearTimeout(t); };
  }, []);

  const onInstall = async () => {
    if (state.kind !== "available" && state.kind !== "error") return;
    const version = state.version;
    setState({ kind: "downloading", version, downloaded: 0, total: null });
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const { relaunch } = await import("@tauri-apps/plugin-process");
      // Re-check so we operate on a fresh Update handle — the one from
      // the initial check could be stale if the user left the prompt
      // open for hours.
      const u = await check();
      if (!u || !u.available) {
        setState({ kind: "idle" });
        return;
      }
      let totalBytes: number | null = null;
      let downloaded = 0;
      await u.downloadAndInstall((event) => {
        // Tauri's updater emits Started / Progress / Finished events.
        if (event.event === "Started") {
          totalBytes = event.data.contentLength ?? null;
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          setState({ kind: "downloading", version, downloaded, total: totalBytes });
        } else if (event.event === "Finished") {
          setState({ kind: "installing", version });
        }
      });
      // After downloadAndInstall the installer has applied on disk —
      // we just need to relaunch into the new binary. On Windows the
      // current process exits cleanly and the new one starts.
      await relaunch();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[updater] install failed:", message);
      setState({ kind: "error", version, message });
    }
  };

  const onDismiss = () => {
    dismissedRef.current = true;
    setState({ kind: "idle" });
  };

  if (state.kind === "idle") return null;

  // Single banner with state-dependent content. Bottom-right, above the
  // NowPlayingBar but below modals. Width is content-driven; max-width
  // caps long release notes.
  return (
    <div style={{
      position: "fixed",
      bottom: 110,
      right: 18,
      zIndex: 9100,
      width: 340,
      background: "var(--bg-elev)",
      border: "1px solid var(--accent)",
      borderRadius: 5,
      boxShadow: "0 18px 40px -12px rgba(0,0,0,0.55)",
      padding: "14px 16px",
      fontFamily: "var(--sans)",
    }}>
      <div className="micro-strong" style={{ color: "var(--accent)", marginBottom: 8, letterSpacing: "0.16em" }}>
        {state.kind === "downloading" ? "Downloading update"
         : state.kind === "installing" ? "Installing"
         : state.kind === "error" ? "Update failed"
         : "Update available"}
      </div>

      <div style={{
        fontFamily: "var(--serif)", fontStyle: "italic", fontSize: 18,
        color: "var(--text)", lineHeight: 1.25, marginBottom: 6,
      }}>
        Quartz {state.version}
      </div>

      {state.kind === "available" && state.notes && (
        <div style={{
          fontSize: 11.5, color: "var(--text-dim)", lineHeight: 1.5,
          maxHeight: 90, overflowY: "auto",
          marginBottom: 12, whiteSpace: "pre-wrap",
        }}>{state.notes}</div>
      )}

      {state.kind === "downloading" && (
        <div style={{ margin: "8px 0 12px" }}>
          <div style={{ height: 3, background: "var(--line-strong)", borderRadius: 2, overflow: "hidden" }}>
            <div style={{
              height: "100%",
              width: state.total
                ? `${Math.min(100, Math.round((state.downloaded / state.total) * 100))}%`
                : "0%",
              background: "var(--accent)",
              transition: "width 0.2s linear",
            }} />
          </div>
          <div className="mono" style={{ fontSize: 10, color: "var(--text-faint)", marginTop: 6 }}>
            {state.total
              ? `${(state.downloaded / 1024 / 1024).toFixed(1)} of ${(state.total / 1024 / 1024).toFixed(1)} MB`
              : `${(state.downloaded / 1024 / 1024).toFixed(1)} MB`}
          </div>
        </div>
      )}

      {state.kind === "installing" && (
        <div style={{ fontSize: 11.5, color: "var(--text-dim)", marginBottom: 12 }}>
          Applying… the app will restart in a moment.
        </div>
      )}

      {state.kind === "error" && (
        <div style={{
          fontSize: 11.5, color: "var(--danger)", marginBottom: 12,
          lineHeight: 1.5, wordBreak: "break-word",
        }}>{state.message}</div>
      )}

      {(state.kind === "available" || state.kind === "error") && (
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={onInstall}
            style={{
              flex: 1,
              padding: "8px 14px",
              background: "var(--accent)",
              color: "var(--bg)",
              border: 0, borderRadius: 3,
              fontSize: 11, letterSpacing: "0.14em",
              textTransform: "uppercase", fontWeight: 500,
              fontFamily: "var(--sans)",
              cursor: "pointer",
            }}
          >{state.kind === "error" ? "Retry" : "Install"}</button>
          <button
            onClick={onDismiss}
            style={{
              padding: "8px 14px",
              background: "transparent",
              color: "var(--text-dim)",
              border: "1px solid var(--line-strong)",
              borderRadius: 3,
              fontSize: 11, letterSpacing: "0.14em",
              textTransform: "uppercase",
              fontFamily: "var(--sans)",
              cursor: "pointer",
            }}
          >Later</button>
        </div>
      )}
    </div>
  );
}

function ScanOverlay({ progress }: { progress: ScanProgress }) {
  const pct = progress.total > 0 ? Math.round((progress.scanned / progress.total) * 100) : 0;
  const fileName = progress.current_path.split(/[/\\]/).pop() ?? "";
  return (
    <div style={{
      position: "absolute", inset: 0, background: "rgba(10,10,12,0.85)",
      backdropFilter: "blur(8px)", display: "grid", placeItems: "center", zIndex: 10,
    }}>
      {/* Fixed width so the progress bar doesn't visually resize as the
          "Walking folders…" → "32738 of 32738 files" text changes length. */}
      <div style={{ textAlign: "center", width: 480, padding: 32 }}>
        <div className="micro-strong" style={{ color: "var(--accent)", marginBottom: 12 }}>Scanning Library</div>
        <div style={{ fontFamily: "var(--serif)", fontStyle: "italic", fontSize: 22, marginBottom: 18 }}>
          {progress.total > 0 ? `${progress.scanned} of ${progress.total} files` : "Walking folders…"}
        </div>
        <div style={{
          height: 3, width: "100%", background: "var(--line-strong)",
          borderRadius: 2, overflow: "hidden", marginBottom: 12,
        }}>
          <div style={{
            height: "100%", width: `${pct}%`, background: "var(--accent)",
            transition: "width 0.2s linear",
          }} />
        </div>
        <div className="mono" style={{
          fontSize: 10, color: "var(--text-faint)",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          maxWidth: "100%",
        }}>
          {fileName}
        </div>
      </div>
    </div>
  );
}

// ── Mini-player window ───────────────────────────────────────────────
// Renders when the app is opened with ?mini=1 (in its own Tauri window).
// Subscribes directly to Tauri events and commands — no props needed.
export function MiniPlayerApp() {
  // Read straight from the shared pb-state store — same single listener
  // pattern as the main window; no second `listen()` here.
  const pbState = usePbState();
  const [albums, setAlbums] = useState<LibraryAlbum[]>([]);
  const [trackMap, setTrackMap] = useState<Record<string, LibraryTrack>>({});

  useEffect(() => {
    // Seed the store immediately from the engine's current state so the
    // UI doesn't flash defaults before the first event arrives.
    invoke<PbState>("get_playback_state").then((s) => {
      pbSnapshot = s;
      pbSubscribers.forEach((fn) => fn());
    }).catch(() => {});
    invoke<LibraryAlbum[]>("list_albums").then(setAlbums).catch(() => {});
    // list_all_tracks is heavy — run in bg; trackMap populates once ready.
    invoke<LibraryTrack[]>("list_all_tracks")
      .then((ts) => {
        const m: Record<string, LibraryTrack> = {};
        ts.forEach((t) => { m[t.path] = t; });
        setTrackMap(m);
      })
      .catch(() => {});
  }, []);

  const albumMap = useMemo<Record<number, LibraryAlbum>>(() => {
    const m: Record<number, LibraryAlbum> = {};
    albums.forEach((a) => { m[a.id] = a; });
    return m;
  }, [albums]);

  const libTrack = pbState.track ? trackMap[pbState.track.path] : null;
  const album = libTrack ? albumMap[libTrack.album_id] : null;
  const artUrl = album?.cover_path ? fileSrc(album.cover_path) : null;

  // Dynamic accent for the mini player. The mini player is a separate
  // Tauri window — the main App's setProperty on documentElement doesn't
  // reach this window, and doing a per-track-change IPC roundtrip here
  // showed up as a visible flash of the default gold before the new color
  // arrived.
  //
  // Solution: the main App broadcasts the active accent on every change
  // via (1) localStorage (synchronous, used for initial paint when this
  // window mounts) and (2) a Tauri "accent-changed" event (used for
  // runtime updates while the mini player is open). This eliminates the
  // gold flash entirely — by the time the first paint runs, --accent is
  // already set, and subsequent track changes update it via the event
  // before the cover art crossfade animation even kicks in.
  useLayoutEffect(() => {
    const apply = (hex: string) => {
      document.documentElement.style.setProperty("--accent", hex);
      document.documentElement.style.setProperty("--accent-dim", mix(hex, "#000000", 0.35));
      document.documentElement.style.setProperty("--accent-soft", hexToRgba(hex, 0.12));
    };
    // Initial paint: read whatever the main App last broadcast.
    try {
      const stored = localStorage.getItem("quartz:activeAccent");
      if (stored) apply(stored);
    } catch {}
    // Runtime updates: re-paint on every broadcast.
    const u = listen<string>("accent-changed", (e) => apply(e.payload));
    return () => { u.then((f) => f()); };
  }, []);
  const trackTitle = libTrack?.title
    ?? (pbState.track?.path ? pbState.track.path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") ?? "—" : "—");
  const artist = libTrack?.artist ?? album?.artist ?? "";

  const totalSec = pbState.duration || 1;
  const progress = pbState.duration > 0 ? pbState.position / pbState.duration : 0;
  const fmtT = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s) % 60).padStart(2, "0")}`;
  const liveBit = pbState.track?.bits_per_sample ?? 16;
  const liveRate = pbState.track ? (pbState.track.sample_rate / 1000).toFixed(1) : "—";

  const togglePlay = () => {
    if (pbState.playing) invoke("pause_playback").catch(console.error);
    else invoke("resume_playback").catch(console.error);
  };

  const closeMini = async () => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      getCurrentWindow().close().catch(console.error);
    } catch { /* */ }
  };

  return (
    <div
      data-tauri-drag-region
      style={{
        width: "100vw", height: "100vh", overflow: "hidden",
        background: "var(--bg-elev)",
        borderTop: "2px solid var(--accent)",
        display: "flex", flexDirection: "column",
        fontFamily: "var(--sans)", color: "var(--text)",
        userSelect: "none", WebkitUserSelect: "none",
      }}
    >
      {/* Main row */}
      <div data-tauri-drag-region style={{ flex: 1, display: "flex", alignItems: "center", gap: 8, padding: "0 8px", minHeight: 0 }}>

        {/* Album art thumbnail */}
        <div data-tauri-drag-region="false" style={{ flexShrink: 0, width: 48, height: 48, borderRadius: 2, overflow: "hidden", boxShadow: "0 2px 8px rgba(0,0,0,0.4)" }}>
          {artUrl
            ? <img src={artUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            : <div style={{ width: "100%", height: "100%", background: "var(--panel)", display: "grid", placeItems: "center" }}>
                <LogoMark kind="prism" size={14} />
              </div>
          }
        </div>

        {/* Title + artist */}
        <div data-tauri-drag-region style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, color: "var(--text)", fontFamily: "var(--serif)", fontStyle: "italic", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{trackTitle}</div>
          <div style={{ fontSize: 10, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 2 }}>{artist}</div>
        </div>

        {/* Play / pause */}
        <button
          data-tauri-drag-region="false"
          onClick={togglePlay}
          style={{ flexShrink: 0, width: 32, height: 32, borderRadius: "50%", background: "var(--accent)", border: 0, cursor: "pointer", display: "grid", placeItems: "center" }}
        >
          {pbState.playing
            ? <svg width="10" height="10" viewBox="0 0 14 14"><rect x="3" y="2" width="3" height="10" fill="var(--bg)" /><rect x="8" y="2" width="3" height="10" fill="var(--bg)" /></svg>
            : <svg width="10" height="10" viewBox="0 0 14 14"><path d="M4 2 L12 7 L4 12 Z" fill="var(--bg)" /></svg>
          }
        </button>

        {/* Mini spectrum */}
        <div data-tauri-drag-region style={{ flexShrink: 0, display: "flex", alignItems: "center" }}>
          <SpectrumLive bars={14} height={28} />
        </div>

        {/* Close */}
        <button
          data-tauri-drag-region="false"
          onClick={closeMini}
          style={{ flexShrink: 0, background: "transparent", border: 0, color: "var(--text-faint)", cursor: "pointer", fontSize: 18, lineHeight: 1, padding: "2px 4px" }}
        >×</button>
      </div>

      {/* Scrubber */}
      <div
        data-tauri-drag-region="false"
        style={{ height: 4, background: "var(--line-strong)", cursor: "pointer", flexShrink: 0 }}
        onMouseDown={(e) => {
          const el = e.currentTarget;
          const seek = (x: number) => {
            const r = el.getBoundingClientRect();
            invoke("seek_to", { secs: Math.max(0, Math.min(1, (x - r.left) / r.width)) * totalSec }).catch(console.error);
          };
          seek(e.clientX);
          const onMove = (ev: MouseEvent) => seek(ev.clientX);
          const onUp = () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
          window.addEventListener("mousemove", onMove);
          window.addEventListener("mouseup", onUp);
        }}
      >
        <div style={{ height: "100%", width: `${progress * 100}%`, background: "var(--accent)", borderRadius: 2 }} />
      </div>

      {/* Format info bar */}
      <div style={{ flexShrink: 0, height: 18, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 8px", background: "var(--panel)" }}>
        <span className="mono" style={{ fontSize: 8, color: "var(--text-faint)", letterSpacing: "0.12em" }}>
          {pbState.track ? `${liveBit}-BIT · ${liveRate} kHz` : "—"}
        </span>
        <span className="mono" style={{ fontSize: 8, color: "var(--text-faint)", letterSpacing: "0.12em" }}>
          {fmtT(Math.floor(pbState.position))} / {fmtT(Math.floor(pbState.duration))}
        </span>
      </div>
    </div>
  );
}
