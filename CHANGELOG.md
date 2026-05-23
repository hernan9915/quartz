# Changelog

All notable changes to Quartz are documented here.

The format roughly follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/).

## [0.2.0] — 2026-05-22

### Added
- **Dynamic accent color from cover art.** The play button, scrub fill,
  spectrum bars, and other accent surfaces now tint to match the dominant
  color of whatever's playing. Extracted lazily on first play via a
  histogram-bucket-in-HSL algorithm and cached in the DB. Toggle in
  Settings → "Match accent to cover art" (defaults on).
- **Smooth accent transitions.** `--accent` is registered as a typed
  `@property` so the variable itself interpolates over 420 ms when the
  playing album changes. The spectrum canvas, play-button glow, exclusive
  pill, EQ chip, current-row highlight, and every other consumer fade in
  lockstep instead of snapping individually.
- **Cover art crossfade.** The NowPlayingBar cover crossfades over 320 ms
  on track change so album transitions feel continuous.
- **Screen transitions.** Sidebar navigation, opening a detail view, and
  entering Settings now play a 220 ms fade + rise animation.
- **Clickable artist + album names in Tracks tab.** Clicking the artist
  name in any track row (Tracks / Favorites / smart views) navigates to
  the artist detail; clicking the album name navigates to the album
  detail. Row click still plays the track.
- Spectrum visualizer now re-reads `--accent` per frame so theme + dynamic
  accent changes apply instantly without remount.

### Fixed
- **Auto-advance to next track.** Hardened against three latent bugs that
  could dead-end the queue: race in the `track-ended` handler that read a
  stale `queueIndexRef` on rapid advances; missing gapless pre-queue from
  `quickPlayAlbum` and `playTrackFromList`; the engine emitting
  `playback-error` (corrupt file / unsupported sample rate / missing file)
  without `track-ended`, leaving the queue stuck.
- **Artist → Album navigation.** Clicking an album from the artist detail
  view now actually opens the album detail (the conditional ladder
  rendered artist detail first because `openAlbum` didn't clear the artist
  state).
- **Full-screen player background bleed-through.** Outer container now has
  a solid background so the underlying app doesn't show through the
  38 %-opacity vignette while the blurred-art backdrop loads (or 404s).
- **Album info now updates on auto-advance.** When a queue crossed album
  boundaries (Tracks tab, smart playlists, mixed-album queues), the NPB /
  FullscreenPlayer / mini player kept showing the previous album's
  artist + title + cover. Now `currentLibAlbumId` updates on every
  advance path (gapless, non-gapless, error-skip, manual prev/next).
- **Mini player accent flash.** Mini player runs in a separate Tauri
  window and was painting the gold default for the 5-15 ms IPC roundtrip
  before applying the dynamic accent. Now broadcast via localStorage
  (initial paint) + Tauri event (runtime updates) — instant, no flash.

### Changed
- **Dev profile optimization.** Added
  `[profile.dev.package."*"] opt-level = 3` so Symphonia + image + rustfft
  compile fast even under `tauri dev`. Eliminates WASAPI buffer underruns
  caused by debug-mode decoder speed.

## [0.1.0] — 2026-05-21

Initial public release.

### Audio
- WASAPI exclusive mode with MMCSS Pro Audio thread priority
- Symphonia-based decoding for FLAC, WAV, AIFF, OGG, MP3, M4A
- Bit-perfect output up to 32-bit / 384 kHz
- Gapless playback between consecutive tracks
- Configurable crossfade (equal-power cos²/sin² curves, 1–8 s)
- 10-band parametric EQ with RBJ biquad cookbook formulas
- ReplayGain (EBU R128 / ITU-BS.1770) full-library scan + per-track gain
- Sleep timer (preset minutes or end-of-track)

### Library
- Multi-folder registration with per-folder last-scanned timestamp
- Parallel tag-reading worker pool (2–8 workers)
- Delta scan via (mtime, size) fingerprint
- File-system watcher with 1.5 s debounce
- Drag-and-drop folders or audio files from Explorer
- Embedded cover art extracted to 512 px JPEG thumbnails
- Tag editor with file re-import on save
- Cover Art Archive fallback for albums without embedded art
- fanart.tv / MusicBrainz / Wikidata artist-photo fetching

### Browsing & playlists
- Albums / Artists / Tracks / Favorites grid + list views
- Smart views: Recently Added, Recently Played, Most Played, Never Played
- Manual playlists with drag-reorder
- AI-generated playlists via Claude (bring your own Anthropic key)
- M3U / M3U8 import (with tag-fuzzy fallback) and export
- Virtualized rendering across all lists for 30k+ track libraries

### UI
- Four themes (Dark, Sepia, Light, Rose) × six accent colors
- First-run welcome overlay
- Mini player mode
- Fullscreen now-playing view with blurred-art backdrop
- Waveform scrubber (per-track peak normalize + accent wipe-in) or flat bar
- 22-bar log-scale spectrum visualizer in dB display
- Lyrics panel: embedded `USLT` / `LYRICS` + `.lrc` sidecar synced auto-scroll
- Listening stats page (totals, top artists/albums, plays-per-day, by-hour, by-weekday)
- Keyboard shortcuts (Space, arrows, F, Ctrl+F, ...)
- Subtle accent focus rings on keyboard navigation

### System integration
- Windows System Media Transport Controls — lock-screen tile, taskbar mini-controls, hardware media keys, Bluetooth headphone buttons
- Auto-update via signed GitHub Releases (`tauri-plugin-updater`)

### Performance
- SQLite WAL + 64 MB cache + memory-mapped reads + NOCASE collations
- Single-pass per-sample EQ chain with `get_unchecked_mut` bounds elision
- Pre-computed FFT bin ranges + Hann window + reused scratch buffers
- React 19 `useDeferredValue` for search; virtualized grids with ResizeObserver
- CSS containment + GPU layer promotion on virtualized scrollers
- Quantized u8 spectrum payload; coalesced playback-state subscribers
