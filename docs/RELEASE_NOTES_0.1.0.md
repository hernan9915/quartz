# Quartz 0.1.0 — Early access

First public release. **Treat this as an early-access / alpha build**:
it works end-to-end on my machine, but it's never been stress-tested on
anyone else's library, there's no automated test suite, and I'm sure
there are bugs waiting to be found by the people running it on real
30k-track collections.

> **Honest disclosure**: Quartz was vibe-coded with
> [Claude](https://claude.com/) (Anthropic's AI). I drove the
> architecture and product decisions; Claude did most of the
> implementation under review. Every commit carries a
> `Co-Authored-By: Claude` trailer so the trail is visible in `git log`.
> If that changes your decision to install, totally fair — better you
> know up front. See the
> [README's "How Quartz was built" section](https://github.com/hernan9915/quartz#how-quartz-was-built)
> for the full version.

If you try it and something breaks (or just feels off), I'd love an
issue with as much detail as you can give.

---

## What's in 0.1.0

A complete, usable audiophile music player for local libraries on Windows:

- **Bit-perfect playback** via WASAPI exclusive mode, up to 32-bit /
  384 kHz, with MMCSS Pro Audio thread priority
- **Library** — FLAC / WAV / AIFF / OGG / MP3 / M4A scanner, parallel
  workers, delta-scanned on re-runs, file-system watcher picks up new
  files automatically
- **Browse + search** across Albums / Artists / Tracks / Favorites, plus
  smart views (Recently Added, Recently Played, Most Played, Never
  Played)
- **Playlists** — manual, drag-reorder, AI-generated via Claude (bring
  your own Anthropic API key — hidden if not set), M3U / M3U8 import +
  export
- **Sound shaping** — 10-band parametric EQ, ReplayGain (EBU R128),
  configurable equal-power crossfade, sleep timer
- **Lyrics** — embedded `USLT` / `LYRICS` tags plus `.lrc` sidecar files
  with synced auto-scroll and click-to-seek
- **Listening stats** — total plays, time listened, top artists/albums,
  plays-per-day chart, by-hour and by-weekday histograms
- **Windows integration** — System Media Transport Controls (lock-screen
  tile, taskbar mini-controls, hardware media keys, Bluetooth headphone
  buttons)
- **Self-update** — signed releases verified against a baked-in public
  key before install
- **Themes** — Dark, Sepia, Light, Rose × six accent colors
- **Zero telemetry** — see [the README's Privacy section][privacy] for
  the complete list of every network call Quartz makes

[privacy]: https://github.com/hernan9915/quartz#privacy

---

## Known caveats

- **Windows-only.** The audio engine is WASAPI-specific. macOS / Linux
  ports are not on the roadmap right now.
- **Not OS-signed.** Windows SmartScreen will warn that the publisher
  isn't recognised — click **More info → Run anyway**. A code-signing
  cert is $100+/yr that I'd rather put into features for v0.1.0.
- **No automated test suite yet.** Issues will likely be found by users
  on real libraries. Please report them.
- **Large libraries (>50k tracks)** haven't been stress-tested. Should
  work, but expect rough edges.
- **Hi-res DSD** decoding is not implemented (only PCM via Symphonia).
  DSD-as-DoP is a possible v0.2.0 item if there's demand.

---

## Install

1. Download **`Quartz_0.1.0_x64-setup.exe`** from the Assets section below
2. Run it. SmartScreen pops up → **More info → Run anyway**
3. Installer is per-user (~50 MB, `%LOCALAPPDATA%\Programs\Quartz`),
   no admin / UAC required
4. App opens with a welcome screen — pick a folder, let it scan, play

Updates will arrive automatically from this point on: each launch
checks the GitHub Releases endpoint, and a prompt appears bottom-right
when a newer version is available.

---

## Reporting bugs

[Open an issue](https://github.com/hernan9915/quartz/issues/new) with:

- What you were doing
- What happened (vs what you expected)
- Screenshots if it's a UI thing
- Your Windows version (`winver`)
- Your audio device + whether you're in exclusive or shared mode

---

## Verifying the download

If you want to verify the installer hasn't been tampered with on the
wire, you can check the signature against the bundled public key in
`tauri.conf.json`. The matching `.sig` file is attached as an asset.
Same verification the auto-updater does on its own before installing.

---

## Acknowledgements

Quartz stands on the shoulders of a lot of brilliant open-source work
— see the [README's Acknowledgements section][ack] for the complete
list and the bundled `THIRD_PARTY_LICENSES.html` for the legal details.

[ack]: https://github.com/hernan9915/quartz#acknowledgements

If Quartz earns a place in your daily listening, let me know — that's
the best signal that v0.2.0 is worth my evenings.
