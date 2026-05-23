# Roadmap

Running list of things we've talked about but haven't built yet. Not a
commitment — just a memory aid so good ideas don't fall off the back of
the truck. Prioritize when starting a new milestone.

## Likely v0.3.0

Things explicitly deferred during the v0.1.0 → v0.2.0 cycle. These are
the "natural next moves" if we're picking up from where we left off.

### Visual / UX

- **Cover crossfade in FullscreenPlayer and MiniPlayer.** v0.2.0 only
  added it to NowPlayingBar. The big covers in the full-screen view and
  the tiny one in the mini player would also benefit from crossfading
  on track change instead of snap-cutting.
- **Page transitions with shared-element art.** When you open an album
  from the grid, the cover thumbnail should animate to its larger
  position in the detail view (and back on close). Same for opening
  full-screen player from NPB. Feels magical when it lands, finicky to
  build — probably wants Framer Motion or hand-rolled FLIP.
- **Album grid scroll reveals.** As the grid scrolls, cards fade/lift
  in from below (staggered). Needs IntersectionObserver + GPU
  transforms only so it stays smooth on 30k-album libraries.
- **Settings page screenshot for README.** Drop it into
  `docs/screenshots/settings.png` and re-add to the README layout.
  Trivial — just needs the shot.
- **In-app About dialog.** Currently no way to view license info from
  inside the app. Add a small "About" entry in Settings that links to
  the bundled `THIRD_PARTY_LICENSES.html` + shows app version, build
  date, copyright.

### Audio / engine

- **Hi-res DSD decoding** (was called out as a possible v0.2.0 item in
  the v0.1.0 release notes; deferred). Symphonia doesn't decode DSD
  natively — would need DSD-to-PCM conversion or DSD-as-DoP for DACs
  that support it. Niche but signals "real audiophile player".
- **Track-info richness via Rust.** `TrackInfo` currently only carries
  audio-format fields (path, sample rate, bits). Add title + artist +
  album_id so the mini player doesn't need its `trackMap` path lookup
  (currently fragile to path-normalization mismatches).
- **AudioCommand::Quit cleanup.** Dead-code warning since v0.1.0 — the
  variant exists but is never sent. Either wire up a shutdown path that
  uses it (graceful audio thread teardown on app close) or remove it.

### Library / browsing

- **Track navigation hover affordance for empty albums.** When a track
  in the Tracks tab has no album title, the cell is non-clickable but
  doesn't visually signal that. Minor polish.
- **Last.fm scrobbling.** Optional, off by default. The play-log already
  exists in the DB — just needs the network layer + user-token storage.
- **Audio search filters.** "format:flac sample_rate:>=96000" style
  query syntax for power users. The FTS index can support it; needs UI
  for the filter chips.

### Release / distribution

- **GitHub Actions release.yml.** Currently `build-release.ps1` runs on
  the user's machine; signing keys live in user env vars. Move to a CI
  workflow with the signing key in encrypted secrets — releases become
  one `gh workflow run release` away.
- **Winget submission.** Once we've shipped a few stable releases,
  submit Quartz to winget so users can `winget install Quartz`. Needs
  a manifest PR to microsoft/winget-pkgs.
- **Code-signing certificate.** $100+/yr — eliminates the SmartScreen
  "publisher not recognized" warning on first run. Worth it when
  download numbers justify the cost (or if donations cover it).

## Candidate ideas (not committed)

Smaller polish items worth considering when there's time:

- Better empty states (no library yet, no favorites, no playlists)
- Hotkey customization in Settings
- Smart playlists with user-defined rules (currently only the four
  built-in views: Recently Added / Played / Most / Never)
- Album-level favorites (not just tracks)
- Bulk tag editor (multi-select in Tracks tab)
- Custom theme creator (pick your own bg + accent + text colors)
- Export listening stats as CSV
- Sleep timer fade-out (gradually drop volume in the last 30 s instead
  of hard pause)
- Drag-to-queue from sidebar / search results
- Keyboard navigation indicators (arrow-key focus rings in grids)

## Deferred — possibly never

Big asks we've decided to wait on:

- **macOS port.** Audio engine is WASAPI-only. Porting needs CoreAudio
  exclusive mode (hog mode), a Mac to develop on, and Apple Developer
  membership for distribution. Estimated 2-4 weeks for a quality build
  + ongoing test burden. Wait until there's demand.
- **Linux port.** Same story with ALSA-direct / PipeWire. 2-3 weeks
  plus a much wider compatibility matrix to support. Wait for demand.
- **Mobile companion app.** Stream from desktop to phone over LAN /
  outside-home. Cool but a separate app's worth of work. Discussed in
  passing; not on a near-term roadmap.

## How this list got built

Most items here are things we explicitly punted during the v0.1.0 and
v0.2.0 cycles — they came up, we decided "later", and dropped a note
here so they wouldn't get forgotten. A few are smart-suggestion items
based on what's in the codebase or what's typical for a player at this
maturity level.

When starting v0.3.0, pick a coherent theme (e.g. "the polish release"
or "the audio depth release") and pull 4-6 items from the top section
that fit. Don't try to ship everything; pick a focused cut and leave the
rest here.
