# Quartz

A bit-perfect Windows music player for your local library.

WASAPI exclusive mode, hi-res audio up to 32-bit / 384 kHz, gapless playback,
configurable crossfade, parametric EQ, ReplayGain, full-text search,
playlists, lyrics, listening stats, and **zero telemetry**.

![Quartz screenshot](docs/screenshot.png)

## Why another music player

Most desktop players compromise on at least one of:

- **Sound quality** — streaming-first players downmix, resample, or share the
  device with every other app on the machine.
- **Library feel** — open-source options either look like 2003 (foobar2000)
  or focus on streaming integrations you don't want.
- **Privacy** — almost everything phones home, scans your library to "improve
  recommendations," or requires an account.

Quartz tries to satisfy all three: it runs against the files on your disk,
talks to the audio stack in exclusive mode for bit-perfect output, and never
sends anything anywhere unless you explicitly ask it to.

## Features

### Playback
- **WASAPI exclusive mode** with MMCSS Pro Audio thread priority
- Bit-perfect output up to **32-bit / 384 kHz**, no resampling unless the device demands it
- **Gapless** between consecutive tracks in a queue
- **Configurable crossfade** with equal-power curves (shared mode only — exclusive mode stays bit-perfect)
- **Parametric EQ** — 10-band, RBJ biquad cookbook formulas, single-pass filter chain
- **ReplayGain** — full-library scan via EBU R128 / ITU-BS.1770; per-track gain applied on the fly
- **Auto-pause** sleep timer (preset minutes or "end of current track")

### Library
- Walks multiple **registered folders** and indexes FLAC / WAV / AIFF / OGG / MP3 / M4A
- **Parallel scanner** uses a worker pool — a 30k-track library scans in seconds
- **Delta scan** via (mtime, size) fingerprint — re-scans are instant for unchanged files
- **File-system watcher** rescans automatically when you drop in new music
- **Drag-and-drop** files or folders straight from Explorer
- **Tag editor** with re-import on save
- **Cover Art Archive fallback** for albums with no embedded art
- **fanart.tv + MusicBrainz + Wikidata** for artist photos

### Browsing
- Albums / Artists / Tracks / Favorites
- **Smart views**: Recently Added · Recently Played · Most Played · Never Played
- **Manual playlists** + **AI-generated playlists** (paste an Anthropic key in Settings)
- **M3U / M3U8** import and export
- Virtualized grids and lists — smooth on 30k+ track libraries
- `Ctrl+F` instant search across the library

### Audio extras
- **22-bar log-scale FFT visualizer**, dB-display
- **Waveform scrubber** with per-track peak normalization and a left-to-right wipe-in animation
- **System Media Transport Controls** — Windows lock-screen tile, taskbar mini-controls, hardware media keys, Bluetooth headphone buttons all drive Quartz
- **Lyrics**: embedded `USLT` / `LYRICS` tags + `.lrc` sidecar files with synced auto-scroll and click-to-seek

### Quality of life
- **First-run onboarding** — pick a folder, start playing
- **Listening stats** — total plays, time listened, top artists/albums, plays-per-day chart, by-hour and by-weekday histograms
- **Auto-update** — signed releases delivered from GitHub Releases; verified locally before install
- Themes: Dark · Sepia · Light · Rose
- Six accent colors per theme
- Keyboard shortcuts (Space, arrows, F, Ctrl+F, etc.)
- Mini player mode

## Install

### Recommended: download the installer

1. Grab `Quartz_0.1.0_x64-setup.exe` from [the latest release](https://github.com/hernan9915/quartz/releases/latest).
2. Run it. Windows SmartScreen may warn that the publisher isn't recognised — Quartz is currently unsigned at the OS level (a code-signing certificate is $100+/yr that I'd rather put into features). Click **More info → Run anyway**.
3. The installer needs ~50 MB of disk space and creates a Start menu shortcut. No admin / UAC required — it installs per-user under `%LOCALAPPDATA%\Programs\Quartz`.

### First run

The app opens with a welcome screen. Pick the folder containing your music
library. Quartz walks the tree, reads tags, extracts embedded cover art into
a thumbnail cache, and gets you to the album grid in seconds for typical
libraries.

### Updating

Quartz checks for new releases on each launch (a small background fetch
4 seconds after the window opens). When a newer signed build exists, a
prompt appears in the bottom-right corner; one click installs and
relaunches.

## Build from source

Requires:
- [Rust toolchain](https://rustup.rs/) (latest stable)
- [Node.js](https://nodejs.org/) 18 or newer
- WebView2 (included with Windows 11; auto-installed on Windows 10 by the installer or by [Microsoft's download](https://developer.microsoft.com/microsoft-edge/webview2/))

```powershell
git clone https://github.com/hernan9915/quartz.git
cd quartz
npm install
npm run tauri dev    # hot-reload dev mode
npm run tauri build  # production installer (requires signing keys, see RELEASING.md)
```

## Privacy

Quartz does not send any data to my servers (there are no servers). The only
network requests it makes:

- **Cover Art Archive + MusicBrainz** — when you explicitly trigger "Fetch missing covers" or "Fetch artist photos" in Settings. Used to look up album / artist art the scanner didn't find embedded. Send: the artist/album names from your tags. Receive: image URLs and image bytes.
- **fanart.tv** — same trigger, only if you've pasted an API key. Higher-quality artist photos.
- **Wikidata + Wikimedia Commons** — fallback for artist photos when fanart.tv has nothing.
- **Anthropic API** — only when you use the AI-playlist feature, and only with your own API key. Sends: a sampled CSV of your library (artist, title, album, genre, format) for Claude to pick from. Receives: a list of track IDs to put in a playlist.
- **GitHub Releases** — auto-updater pings `https://github.com/hernan9915/quartz/releases/latest/download/latest.json` once per launch to check for new versions.

That's the entire list. There is no analytics, no error reporting, no usage
tracking, no playback history sync — nothing in the app does anything else
behind the scenes. Right-clicking Settings can confirm: the only HTTP
endpoints are the five above.

## Acknowledgements

Quartz stands on the shoulders of:

- **[Tauri](https://tauri.app/)** — desktop runtime
- **[Symphonia](https://github.com/pdeljanov/Symphonia)** — pure-Rust audio decoding
- **[wasapi-rs](https://crates.io/crates/wasapi)** — Windows audio API bindings
- **[Lofty](https://github.com/Serial-ATA/lofty-rs)** — tag reading + writing
- **[rustfft](https://github.com/ejmahler/RustFFT)** — spectrum analyzer
- **[rusqlite](https://github.com/rusqlite/rusqlite)** — library database
- **[souvlaki](https://github.com/Sinono3/souvlaki)** — SMTC integration
- **[ebur128](https://github.com/sdroege/ebur128)** — ReplayGain loudness scanning
- **[notify](https://github.com/notify-rs/notify)** — file-system watcher
- **[React](https://react.dev/) + [Vite](https://vitejs.dev/)** — UI

Fonts: [Lora](https://fonts.google.com/specimen/Lora),
[Geist](https://vercel.com/font),
[JetBrains Mono](https://www.jetbrains.com/lp/mono/).
All under the SIL Open Font License.

## How Quartz was built

Honest disclosure: Quartz was vibe-coded with
[Claude](https://claude.com/) (Anthropic's AI) over a handful of long
sessions. I drove the product direction, design, architecture decisions,
and review; Claude did most of the actual typing under iteration. Every
commit carries a `Co-Authored-By: Claude` trailer so the credit trail is
fully visible in `git log`.

What that means for you, as a user:

- The code is real software — it compiles, it plays your music, the
  features work as described.
- The architecture decisions (WASAPI exclusive vs shared, dB-scale
  visualizer, single-pass EQ chain, dB compensation curves, delta scan,
  etc.) are deliberate and reviewed.
- I haven't independently rewritten every line — there's almost
  certainly code in here that an experienced Rust/React engineer would
  write differently. Bugs that AI-collaborated codebases tend to have
  (subtle edge cases, dead branches, inconsistent error handling) will
  show up over time.
- If you'd rather not run software built this way for any reason — that's
  legitimate, and the disclosure here is exactly so you can make that
  call with full information.

## Contributing

PRs welcome for bug fixes. For new features, please open an issue first so we
can talk through the design — Quartz aims to stay focused, and feature creep
is the surest way to ruin an audio app.

## License

[MIT](LICENSE) — do whatever you want with it. If you fork and ship a
"Quartz Pro" please change the name.
