# Quartz 0.2.0 — Visual refresh

The headline feature: **the UI now tints itself to match whatever you're
playing.** Play a sepia ambient record and the play button glows warm
gold; switch to a bright pop record and the spectrum bars shift to
crimson or teal. The color is extracted from the album cover, cached
per album, and morphs over ~400 ms when you skip tracks.

Plus a handful of bug fixes from real-world use of v0.1.0 — the most
important one being that the queue no longer dead-ends on broken or
unsupported tracks.

> If you're upgrading from v0.1.0, the auto-updater handles it. Existing
> installs will see the prompt on next launch.

---

## What's new

### Dynamic accent from cover art

- The play button, scrub fill, spectrum visualizer, exclusive pill, and
  every other accent surface now tint to match the dominant color of the
  playing album's cover.
- Extracted via a histogram-bucket-in-HSL algorithm on a 96×96
  downsample. Lightness clamped to a UI-friendly band so the accent
  always reads as a tint, never as pure black or wash.
- Cached in the DB on first play — your 30k-album library doesn't get
  re-churned. Subsequent plays of the same album are instant.
- **Off switch**: Settings → Appearance → "Match accent to cover art".
  Turn it off and you stay on whatever Brass / Verdant / Rose / etc.
  accent you picked.

### Smoother visual transitions

- `--accent` is now a typed CSS `@property`, which means the variable
  itself interpolates over 420 ms when the playing album changes —
  every accent-tinted element (including the canvas spectrum bars)
  fades in lockstep instead of snapping individually.
- Album covers in the NowPlayingBar **crossfade** between tracks rather
  than snap-cutting.
- Navigating between sections (Albums ↔ Artists ↔ Tracks ↔ Favorites ↔
  Settings) and opening detail views now plays a subtle 220 ms fade +
  rise animation.

### Smaller polish

- **Clickable artist + album names** in the Tracks tab (and Favorites,
  and the smart views). Click the artist name on any row → jumps to
  artist detail. Click the album name → jumps to album detail. Row
  click still plays the track.

---

## Bug fixes

### Auto-advance was occasionally getting stuck

Three latent bugs in the queue advancement chain, all fixed:

1. The frontend's `track-ended` handler updated `queueIndex` *inside*
   the play-file promise resolution, so a rapid second advance could
   read a stale ref and either replay the same track or fail to
   advance.
2. `quickPlayAlbum` (hover-play from the album grid) and
   `playTrackFromList` (Tracks tab) didn't pre-queue the next track for
   gapless playback. Worked fine on the first track but every advance
   had to go through the slower non-gapless fallback path.
3. When a track failed to play (corrupt file, file moved after the
   scan, unsupported sample rate, device rejected exclusive mode), the
   Rust engine emitted `playback-error` and **broke the session
   without emitting `track-ended`**. The frontend's error listener only
   logged to console, so the queue dead-ended at the bad track. Now
   the error listener runs the same skip-to-next logic.

If you ran into "playback just stops in the middle of an album", that
was this. Should be solid now.

### Other fixes

- **Artist → Album click in the artist detail view** wasn't actually
  opening the album detail (it kept showing the artist page). Fixed.
- **Full-screen player background bleed-through** when the album art was
  null / loading / 404 — the 38 %-opacity vignette was the only layer
  between you and the app underneath. Solid background added.
- **NPB / mini player / full-screen player** now correctly update artist
  + album + cover + accent when auto-advance crosses an album boundary
  (Tracks tab, smart playlists, mixed-album queues).
- **Mini player accent** no longer flashes the gold default on track
  change. Broadcast from the main app via localStorage (initial paint)
  + Tauri event (runtime updates) — instant, no IPC delay.

---

## Under the hood

- Added `albums.accent_color` column with a transparent migration. First
  launch on an existing library just notices the new column and creates
  it; nothing to re-scan.
- New `library/album_accent.rs` module with the extraction algorithm.
  Pure HSL histogram bucketing, ~5-15 ms per album on a modern machine.
- Set `[profile.dev.package."*"] opt-level = 3` so `tauri dev` no longer
  glitches on playback. Affects only the dev build path — the release
  binary was already fully optimized.

---

## Install

1. Download **`Quartz_0.2.0_x64-setup.exe`** from the Assets section below.
2. Run it. SmartScreen pops up → **More info → Run anyway**.
3. Per-user installer (~50 MB, `%LOCALAPPDATA%\Programs\Quartz`), no admin / UAC.

Existing v0.1.0 installs upgrade automatically via the built-in updater.

---

## Reporting bugs

[Open an issue](https://github.com/hernan9915/quartz/issues/new) with:

- What you were doing
- What happened (vs what you expected)
- Screenshots if it's a UI thing
- Your Windows version (`winver`)
- Your audio device + exclusive or shared mode
