//! System Media Transport Controls integration.
//!
//! On Windows this hooks the player into:
//!   - the lock-screen / Action-Center "now playing" tile
//!   - the SoundFlyout media tile that pops up when the user presses the
//!     volume keys
//!   - hardware media keys on most keyboards
//!   - Bluetooth headphone play / pause / next / prev buttons
//!   - the Xbox Game Bar widget
//!
//! `souvlaki` is a thin cross-platform wrapper — the Linux and macOS
//! backends compile but are inert (we never ship those targets right now,
//! but it keeps `cargo check` honest on non-Windows hosts).
//!
//! Architecture: the UI is the source of truth for what's currently
//! "playing" (track title / artist / album / cover URL), so the JS side
//! pushes metadata via the `set_media_metadata` Tauri command after every
//! track change. Playback state (play / pause / stop) and seeks are pushed
//! via `set_media_playback`. Button presses come in via souvlaki's attach
//! callback and are re-emitted as the `media-button` event for the JS layer
//! to route into the existing play / pause / next / prev handlers.

use souvlaki::{
    MediaControlEvent, MediaControls, MediaMetadata, MediaPlayback, MediaPosition, PlatformConfig,
};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub struct MediaSession {
    /// souvlaki::MediaControls is `!Sync` on some platforms; wrap it in a
    /// Mutex so we can hand it out as `&MediaSession` through AppState.
    /// All operations are low-frequency (track change, play/pause, seek),
    /// so the lock contention is negligible.
    controls: Mutex<MediaControls>,
}

impl MediaSession {
    /// Create the SMTC instance bound to the given window handle and wire
    /// up the button-event callback. `hwnd` must be the HWND of a valid
    /// top-level window; SMTC is per-window on Windows.
    pub fn new(hwnd: isize, app: AppHandle) -> Result<Self, String> {
        let config = PlatformConfig {
            // dbus_name only matters on Linux/MPRIS; harmless on Windows.
            dbus_name: "quartz",
            display_name: "Quartz",
            // souvlaki wants a *mut c_void on Windows. We get an isize from
            // Tauri's window.hwnd() and cast — pointer provenance doesn't
            // matter, the Windows SMTC API only treats it as an opaque handle.
            hwnd: Some(hwnd as *mut std::ffi::c_void),
        };

        let mut controls = MediaControls::new(config)
            .map_err(|e| format!("smtc init failed: {e:?}"))?;

        // The callback runs on souvlaki's worker thread. Forward to the JS
        // layer via Tauri events so the existing keyboard-shortcut handlers
        // are the single source of truth for what each button means.
        let app_cb = app.clone();
        controls
            .attach(move |event: MediaControlEvent| {
                match event {
                    MediaControlEvent::Play => {
                        let _ = app_cb.emit("media-button", "play");
                    }
                    MediaControlEvent::Pause => {
                        let _ = app_cb.emit("media-button", "pause");
                    }
                    MediaControlEvent::Toggle => {
                        let _ = app_cb.emit("media-button", "toggle");
                    }
                    MediaControlEvent::Next => {
                        let _ = app_cb.emit("media-button", "next");
                    }
                    MediaControlEvent::Previous => {
                        let _ = app_cb.emit("media-button", "prev");
                    }
                    MediaControlEvent::Stop => {
                        let _ = app_cb.emit("media-button", "stop");
                    }
                    MediaControlEvent::SetPosition(MediaPosition(d)) => {
                        let _ = app_cb.emit("media-seek", d.as_secs_f64());
                    }
                    // Volume / raise / quit / etc. are out of scope for now.
                    _ => {}
                }
            })
            .map_err(|e| format!("smtc attach failed: {e:?}"))?;

        Ok(MediaSession {
            controls: Mutex::new(controls),
        })
    }

    /// Push the now-playing metadata to the OS. `cover_url` should be a
    /// `file:///` or `http://asset.localhost/...` URL — Windows SMTC accepts
    /// both. Pass an empty string to clear an existing thumbnail.
    pub fn set_metadata(
        &self,
        title: &str,
        artist: &str,
        album: &str,
        cover_url: Option<&str>,
        duration_secs: f64,
    ) {
        let Ok(mut c) = self.controls.lock() else {
            return;
        };
        let dur = if duration_secs > 0.0 && duration_secs.is_finite() {
            Some(Duration::from_secs_f64(duration_secs))
        } else {
            None
        };
        let _ = c.set_metadata(MediaMetadata {
            title: Some(title),
            artist: Some(artist),
            album: Some(album),
            cover_url,
            duration: dur,
        });
    }

    /// Mark the OS tile as playing at the given position.
    pub fn set_playing(&self, position_secs: f64) {
        let Ok(mut c) = self.controls.lock() else {
            return;
        };
        let progress = if position_secs >= 0.0 && position_secs.is_finite() {
            Some(MediaPosition(Duration::from_secs_f64(position_secs)))
        } else {
            None
        };
        let _ = c.set_playback(MediaPlayback::Playing { progress });
    }

    /// Mark the OS tile as paused at the given position. Windows keeps the
    /// thumbnail visible and pauses the displayed timeline.
    pub fn set_paused(&self, position_secs: f64) {
        let Ok(mut c) = self.controls.lock() else {
            return;
        };
        let progress = if position_secs >= 0.0 && position_secs.is_finite() {
            Some(MediaPosition(Duration::from_secs_f64(position_secs)))
        } else {
            None
        };
        let _ = c.set_playback(MediaPlayback::Paused { progress });
    }

    /// Mark the OS tile as stopped. The thumbnail disappears from the
    /// lock-screen / SoundFlyout after a short fade.
    pub fn set_stopped(&self) {
        let Ok(mut c) = self.controls.lock() else {
            return;
        };
        let _ = c.set_playback(MediaPlayback::Stopped);
    }
}
