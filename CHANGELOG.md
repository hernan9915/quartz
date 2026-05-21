# Changelog

All notable changes to Quartz are documented here.

The format roughly follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/).

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
