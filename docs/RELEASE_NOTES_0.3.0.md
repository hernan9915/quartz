# Quartz 0.3.0 — The player release

This one's about the playback surfaces themselves: the hi-res gapless
engine, shuffle, the mini player, and the waveform. A lot of it came out
of running v0.2.0 on a real 40k-track library and finding the rough
edges.

> Upgrading from v0.1.0 / v0.2.0 is automatic — existing installs see the
> prompt on next launch.

---

## The big fix: hi-res gapless stutter

If you played 24/96 or 24/192 tracks back-to-back and heard a stutter at
each transition, that's gone.

The next track was being opened (disk read + FLAC-header parse + decoder
allocation + a prefill decode) **synchronously on the real-time audio
thread, at the exact moment the previous track's buffer had drained to
just the hardware tail**. At 192 kHz that tail is ~10 ms and the open
overran it — and the in-memory decode queue can't help, because queued
audio can't reach the DAC while the thread is blocked in file I/O.

Now the next track is opened on a dedicated helper thread, ahead of the
boundary, and swapped in as a near-instant move. No file I/O ever runs on
the audio thread anymore. The same change fixed the post-seek stutter on
hi-res too.

---

## Shuffle, redone

Shuffle now does what you'd expect: turning it on **physically reorders
the upcoming queue**, so the Up Next panel, drag-reorder, and prev/next
all show and follow the real play order — no hidden "what plays next"
state. Turning it off restores album order from wherever you are.

(The previous build picked the next track from an invisible bag, so the
queue panel kept showing album order even while playback jumped around.)

---

## Mini player, leveled up

- **Blurred cover-art backdrop + dynamic accent**, matching the
  full-screen player — the two now feel like the same player at different
  sizes instead of two different UIs.
- **Prev / next buttons** (it only had play/pause before), routed through
  the main window's queue.
- **Cover crossfade** on track change.

---

## Waveform scrubber

- **Real dynamics.** Bins are now RMS energy instead of peak amplitude,
  so a waveform actually looks like the music instead of a solid brick
  (modern masters peg every peak at the ceiling).
- **Side-by-side layout** — transport on the left, waveform filling the
  rest — at the same height as the flat-bar mode.

---

## Smaller things

- **Cover crossfades** in the full-screen player (art + backdrop) too.
- **Clickable artist / album** in the now-playing bar.
- **Click the time label** to toggle remaining ↔ total duration.
- **Scroll-wheel over the volume knob** adjusts volume.
- **`S` / `R` keyboard shortcuts** for shuffle and repeat.
- **OS window title** shows the playing track (taskbar / Alt-Tab).
- **Search filters the Artists view** now (it already did Albums and
  Tracks).
- Album info (artist / title / cover / accent) now updates correctly when
  auto-advance crosses an album boundary, and drag-reordering Up Next
  takes effect at the next track.

---

## Under the hood

A lot of the queue / shuffle / gapless logic in this release was checked
by multi-agent adversarial review before landing — several real
edge-case bugs (orphaned shuffle picks on manual skip, stale pre-queue
state after reorder, a waveform-collapse bug for files without a frame
count) were caught and fixed that way.

---

## Install

1. Download **`Quartz_0.3.0_x64-setup.exe`** from the Assets below.
2. Run it. SmartScreen → **More info → Run anyway**.
3. Per-user install (~50 MB, `%LOCALAPPDATA%\Programs\Quartz`), no admin.

Existing installs update themselves via the built-in updater.

---

## Reporting bugs

[Open an issue](https://github.com/hernan9915/quartz/issues/new) with what
you were doing, what happened vs expected, your Windows version
(`winver`), and your audio device + exclusive/shared mode.
