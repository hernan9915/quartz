//! File-system watcher for live library updates.
//!
//! Watches every registered library folder for create / modify / remove
//! events. Bulk operations (copying an album = dozens of writes per second)
//! are coalesced through `notify-debouncer-mini` — we get one callback per
//! quiet window rather than per event. The callback re-runs a delta scan
//! over the affected folders, which is itself a no-op for files whose
//! `(mtime, size)` fingerprint is unchanged.
//!
//! All state changes go through the existing `scan_folder` path so we never
//! duplicate the "read tags / extract art / upsert" logic. The watcher only
//! decides *when* to scan; the scanner decides *what* to do.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify::RecursiveMode;
use notify_debouncer_mini::{new_debouncer, DebouncedEventKind, Debouncer};
use tauri::{AppHandle, Emitter};

use crate::library::{scan_folder, LibraryDb};

/// Quiet window before we fire a rescan. 1500 ms is enough to absorb a big
/// album copy (which typically generates events for 60+ seconds in a row
/// only if the source is slow — usually < 2 s) without making the user wait
/// noticeably long for a single drag-drop to show up.
const DEBOUNCE_MS: u64 = 1500;

/// Audio file extensions we care about. Any event whose path doesn't end in
/// one of these is ignored, so the watcher doesn't fire for stray
/// `.DS_Store` writes, lyric files, or thumbnail caches.
const AUDIO_EXTENSIONS: &[&str] = &["flac", "wav", "aiff", "aif", "ogg", "mp3", "m4a"];

/// Owns the underlying notify-debouncer instance. Drop = unwatch everything.
pub struct LibraryWatcher {
    debouncer: Debouncer<notify::RecommendedWatcher>,
    /// Folders currently registered. Used to detect "already watching" and
    /// to issue per-folder removals when the user deletes a folder.
    watched: Arc<Mutex<HashSet<PathBuf>>>,
}

impl LibraryWatcher {
    /// Wire up a watcher whose callback rescans changed folders. The handler
    /// runs on the debouncer's worker thread; the rescan itself is dispatched
    /// onto tokio's blocking pool so the watcher thread is never blocked by
    /// a long scan (which could miss subsequent events).
    pub fn new(
        db: Arc<LibraryDb>,
        artwork_dir: PathBuf,
        app: AppHandle,
    ) -> Result<Self, String> {
        let watched: Arc<Mutex<HashSet<PathBuf>>> = Arc::new(Mutex::new(HashSet::new()));
        let watched_for_cb = Arc::clone(&watched);

        let debouncer = new_debouncer(
            Duration::from_millis(DEBOUNCE_MS),
            move |res: notify_debouncer_mini::DebounceEventResult| {
                let events = match res {
                    Ok(evs) => evs,
                    Err(e) => {
                        log::warn!("[watcher] debounce error: {e:?}");
                        return;
                    }
                };

                // Filter to audio-file events only. Then map each path to
                // its registered root folder so we know what to rescan.
                let roots = match watched_for_cb.lock() {
                    Ok(g) => g.clone(),
                    Err(_) => return,
                };
                let mut affected_roots: HashSet<PathBuf> = HashSet::new();
                for ev in events {
                    if !matches!(ev.kind, DebouncedEventKind::Any | DebouncedEventKind::AnyContinuous) {
                        continue;
                    }
                    if !is_audio_path(&ev.path) {
                        continue;
                    }
                    if let Some(root) = roots.iter().find(|r| ev.path.starts_with(r)) {
                        affected_roots.insert(root.clone());
                    }
                }

                if affected_roots.is_empty() {
                    return;
                }

                // Dispatch one delta-scan per affected root on the blocking
                // tokio pool. scan_folder is internally parallel; running
                // multiple in sequence on one thread is fine for typical
                // small bursts.
                let db = Arc::clone(&db);
                let artwork_dir = artwork_dir.clone();
                let app = app.clone();
                tokio::task::spawn_blocking(move || {
                    for root in affected_roots {
                        if let Err(e) = scan_folder(&db, &root, &artwork_dir, &app) {
                            log::warn!("[watcher] rescan of {} failed: {e}", root.display());
                        }
                    }
                    // Tell the UI to refresh album/artist lists.
                    let _ = app.emit("library-updated", ());
                });
            },
        )
        .map_err(|e| format!("watcher init: {e:?}"))?;

        Ok(LibraryWatcher { debouncer, watched })
    }

    /// Start watching `folder` recursively. Idempotent — adding an already-
    /// watched folder is a no-op.
    pub fn watch(&mut self, folder: &Path) -> Result<(), String> {
        let canonical = folder.to_path_buf();
        {
            let mut g = self.watched.lock().map_err(|_| "watcher state poisoned".to_string())?;
            if g.contains(&canonical) {
                return Ok(());
            }
            g.insert(canonical.clone());
        }
        self.debouncer
            .watcher()
            .watch(&canonical, RecursiveMode::Recursive)
            .map_err(|e| format!("watch {}: {e:?}", canonical.display()))
    }

    /// Stop watching `folder`. Best-effort — silently succeeds if the folder
    /// wasn't being watched.
    pub fn unwatch(&mut self, folder: &Path) -> Result<(), String> {
        let canonical = folder.to_path_buf();
        let was_watching = {
            let mut g = self.watched.lock().map_err(|_| "watcher state poisoned".to_string())?;
            g.remove(&canonical)
        };
        if !was_watching {
            return Ok(());
        }
        // notify returns an error if the path isn't watched — we already
        // checked, so this should succeed. Log if it surprises us.
        if let Err(e) = self.debouncer.watcher().unwatch(&canonical) {
            log::warn!("[watcher] unwatch {} failed: {e:?}", canonical.display());
        }
        Ok(())
    }
}

fn is_audio_path(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| AUDIO_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}
