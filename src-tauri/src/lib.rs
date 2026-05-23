mod audio;
mod library;
mod m3u;
mod smtc;
mod watcher;

use audio::{AudioDevice, AudioEngine, CrossfadeConfig, EqSettings, PlaybackState};
use library::{
    AiTrackRow, DbPlaylist, LibraryAlbum, LibraryArtist, LibraryDb, LibraryFolder, LibraryTrack,
    ListeningStats, MostPlayedTrack, fetch_album_covers, fetch_artist_images, reimport_file,
    scan_folder,
};
use serde::{Deserialize, Serialize};
use smtc::MediaSession;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use watcher::LibraryWatcher;

// ── App state ───────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReplayGainConfig {
    pub enabled: bool,
    /// Target integrated loudness in LUFS (default −14, the streaming standard).
    pub target_lufs: f32,
}

impl Default for ReplayGainConfig {
    fn default() -> Self {
        ReplayGainConfig { enabled: false, target_lufs: -14.0 }
    }
}

pub struct AppState {
    pub engine: Mutex<Option<AudioEngine>>,
    pub library: Arc<LibraryDb>,
    pub artwork_dir: PathBuf,
    pub artist_image_dir: PathBuf,
    /// Cached waveform peak files (`track-{id}-{n}.qwf`) — pre-computed
    /// scrubber bars so the UI doesn't decode an entire track every time
    /// the user changes track.
    pub waveform_dir: PathBuf,
    /// ReplayGain config, consulted on every Play command to compute per-track gain.
    pub rg_config: Mutex<ReplayGainConfig>,
    /// System Media Transport Controls (lock-screen tile, hardware media
    /// keys). Optional because some platforms / window-less startup paths
    /// don't support it — we just no-op the media controls in that case.
    pub media_session: Mutex<Option<MediaSession>>,
    /// Filesystem watcher for registered library folders. Wrapped in a
    /// Mutex<Option<_>> because it can't be constructed until after setup
    /// has the runtime handle, and we may need to swap it on reconfigure.
    pub watcher: Mutex<Option<LibraryWatcher>>,
}

// ── Audio commands ──────────────────────────────────────────────────

#[tauri::command]
fn get_devices() -> Result<Vec<AudioDevice>, String> {
    audio::list_devices()
}

#[tauri::command]
fn play_file(path: String, start_secs: Option<f64>, state: State<AppState>) -> Result<(), String> {
    // Compute and send ReplayGain before the Play command so the audio thread
    // sees the correct gain on the very first write (SetTrackGain is processed
    // in the idle loop before Play triggers play_file).
    let rg = state.rg_config.lock().unwrap().clone();
    if rg.enabled {
        let gain: Option<f32> = state.library
            .get_track_replaygain_by_path(&path)
            .ok()
            .flatten()
            .map(|lufs| {
                let db_diff = rg.target_lufs as f64 - lufs;
                (10.0_f64).powf(db_diff / 20.0) as f32
            });
        with_engine(&state, |e| e.set_track_gain(gain))?;
    } else {
        with_engine(&state, |e| e.set_track_gain(None))?;
    }
    with_engine(&state, |e| e.play(path.into(), start_secs))
}

#[tauri::command]
fn pause_playback(state: State<AppState>) -> Result<(), String> {
    with_engine(&state, |e| e.pause())
}

#[tauri::command]
fn resume_playback(state: State<AppState>) -> Result<(), String> {
    with_engine(&state, |e| e.resume())
}

#[tauri::command]
fn stop_playback(state: State<AppState>) -> Result<(), String> {
    with_engine(&state, |e| e.stop())
}

#[tauri::command]
fn seek_to(secs: f64, state: State<AppState>) -> Result<(), String> {
    with_engine(&state, |e| e.seek(secs))
}

#[tauri::command]
fn set_volume(v: f32, state: State<AppState>) -> Result<(), String> {
    with_engine(&state, |e| e.set_volume(v))
}

#[tauri::command]
fn set_device(id: String, state: State<AppState>) -> Result<(), String> {
    with_engine(&state, |e| e.set_device(id.clone()))
}

#[tauri::command]
fn set_exclusive_mode(enabled: bool, state: State<AppState>) -> Result<(), String> {
    with_engine(&state, |e| e.set_exclusive_mode(enabled))
}

#[tauri::command]
fn queue_next_track(path: String, state: State<AppState>) -> Result<(), String> {
    with_engine(&state, |e| e.queue_next(path.into()))
}

#[tauri::command]
fn get_playback_state(state: State<AppState>) -> PlaybackState {
    state.engine.lock().unwrap()
        .as_ref()
        .map(|e| e.state.lock().unwrap().clone())
        .unwrap_or_default()
}

fn with_engine<F>(state: &State<AppState>, f: F) -> Result<(), String>
where
    F: FnOnce(&AudioEngine) -> Result<(), String>,
{
    let guard = state.engine.lock().unwrap();
    match guard.as_ref() {
        Some(e) => f(e),
        None => Err("Audio engine not initialized".into()),
    }
}

// ── Library commands ────────────────────────────────────────────────

#[tauri::command]
async fn scan_library(folder: String, app: AppHandle, state: State<'_, AppState>) -> Result<usize, String> {
    // Move the blocking scan onto tokio's blocking thread pool so the main
    // thread stays free to service the UI. Without this, walking the file
    // tree and the per-track tag/artwork work freezes WebView2 entirely.
    let library = state.library.clone();
    let artwork_dir = state.artwork_dir.clone();
    let path = PathBuf::from(&folder);
    let app_handle = app.clone();
    let res = tokio::task::spawn_blocking(move || {
        scan_folder(&library, &path, &artwork_dir, &app_handle)
    })
    .await
    .map_err(|e| e.to_string())?;
    // Stamp last_scanned_at if this folder is registered. Silently no-op for
    // ad-hoc scans (Phase 16 keeps the legacy entry point usable).
    let _ = state.library.mark_folder_scanned(&folder);
    res
}

// ── Phase 16: library folder management ─────────────────────────────

#[tauri::command]
fn list_library_folders(state: State<AppState>) -> Result<Vec<LibraryFolder>, String> {
    state.library.list_library_folders()
}

/// Register a folder and start watching it. The folder is *not* scanned
/// immediately — callers usually want to invoke `scan_library` afterward,
/// which lets the UI animate progress.
#[tauri::command]
fn add_library_folder(path: String, state: State<AppState>) -> Result<bool, String> {
    let inserted = state.library.add_library_folder(&path)?;
    // Start watching even on duplicate-add (idempotent inside the watcher),
    // because a previous session may not have re-attached the watcher.
    if let Some(w) = state.watcher.lock().unwrap().as_mut() {
        let _ = w.watch(std::path::Path::new(&path));
    }
    Ok(inserted)
}

/// Unregister a folder and stop watching it. Existing indexed tracks stay
/// in the DB until the user runs a full wipe — that's intentional so a
/// temporary unmounted drive doesn't permanently lose its library entries.
#[tauri::command]
fn remove_library_folder(path: String, state: State<AppState>) -> Result<(), String> {
    state.library.remove_library_folder(&path)?;
    if let Some(w) = state.watcher.lock().unwrap().as_mut() {
        let _ = w.unwatch(std::path::Path::new(&path));
    }
    Ok(())
}

// ── Phase 15: System Media Transport Controls ───────────────────────

/// Push the now-playing metadata to the OS so it shows up in the lock-screen
/// tile, SoundFlyout, and Bluetooth headphone displays.
#[tauri::command]
fn set_media_metadata(
    title: String,
    artist: String,
    album: String,
    cover_url: Option<String>,
    duration: f64,
    state: State<AppState>,
) -> Result<(), String> {
    if let Some(s) = state.media_session.lock().unwrap().as_ref() {
        s.set_metadata(&title, &artist, &album, cover_url.as_deref(), duration);
    }
    Ok(())
}

/// Tell the OS whether we're playing, paused, or stopped. Position is in
/// seconds. The SMTC tile keeps its progress estimate updated using the
/// last reported value plus elapsed time — re-call this on each play/pause/
/// seek so the tile doesn't drift.
#[tauri::command]
fn set_media_playback(
    playing: bool,
    stopped: bool,
    position: f64,
    state: State<AppState>,
) -> Result<(), String> {
    if let Some(s) = state.media_session.lock().unwrap().as_ref() {
        if stopped {
            s.set_stopped();
        } else if playing {
            s.set_playing(position);
        } else {
            s.set_paused(position);
        }
    }
    Ok(())
}

#[tauri::command]
fn list_albums(state: State<AppState>) -> Result<Vec<LibraryAlbum>, String> {
    state.library.list_albums()
}

#[tauri::command]
fn list_tracks(album_id: i64, state: State<AppState>) -> Result<Vec<LibraryTrack>, String> {
    state.library.list_tracks(album_id)
}

#[tauri::command]
fn list_artists(state: State<AppState>) -> Result<Vec<LibraryArtist>, String> {
    state.library.list_artists()
}

#[tauri::command]
fn list_albums_by_artist(artist: String, state: State<AppState>) -> Result<Vec<LibraryAlbum>, String> {
    state.library.list_albums_by_artist(&artist)
}

/// Look up (or compute + cache) the vibrant accent color for an album.
///
/// Behavior:
///   - If `albums.accent_color` is already populated, return it immediately
///     (cheap DB read).
///   - Otherwise look up the album's cover_path. If there's no cover, return
///     `None` — frontend falls back to the user's chosen accent.
///   - If there's a cover, run extraction on a blocking thread (image decode
///     + downscale + bucket pass; typically 5-15 ms on a modern machine).
///     Persist the result to the DB so subsequent plays hit the cache.
///
/// Returns `Option<String>` — `None` is a normal outcome (no cover, mono
/// art, or extraction filtered everything out), not an error.
#[tauri::command]
async fn get_album_accent_color(
    album_id: i64,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    // Fast path: already cached.
    if let Ok(Some(hex)) = state.library.get_album_accent(album_id) {
        return Ok(Some(hex));
    }
    // No cached value — need to extract. First grab the cover path.
    let cover = state.library.get_album_cover_path(album_id)?;
    let cover_path = match cover {
        Some(p) if !p.is_empty() => std::path::PathBuf::from(p),
        _ => return Ok(None),
    };
    let library = state.library.clone();
    let result = tokio::task::spawn_blocking(move || {
        let accent = library::extract_accent(&cover_path);
        if let Some(ref hex) = accent {
            let _ = library.set_album_accent(album_id, Some(hex));
        }
        accent
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(result)
}

#[tauri::command]
async fn list_all_tracks(state: State<'_, AppState>) -> Result<Vec<LibraryTrack>, String> {
    // 30k+ track libraries take ~hundreds of ms to read+serialize — push it
    // off the main thread so the UI stays responsive while the panel loads.
    let library = state.library.clone();
    tokio::task::spawn_blocking(move || library.list_all_tracks())
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn fetch_artist_photos(
    fanart_api_key: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<usize, String> {
    let library = state.library.clone();
    let artist_dir = state.artist_image_dir.clone();
    let app_handle = app.clone();
    // Treat blank strings as None so an empty Settings field doesn't blow up
    // fanart.tv with HTTP 401 on every artist.
    let key = fanart_api_key.and_then(|s| {
        let t = s.trim().to_string();
        if t.is_empty() { None } else { Some(t) }
    });
    tokio::task::spawn_blocking(move || {
        fetch_artist_images(&library, &artist_dir, &app_handle, key)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Phase 21: download missing album covers from Cover Art Archive (via
/// MusicBrainz release-group lookup). Albums that already have embedded
/// art are skipped. Emits `album-cover-progress` events.
#[tauri::command]
async fn fetch_album_covers_cmd(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<usize, String> {
    let library = state.library.clone();
    let artwork_dir = state.artwork_dir.clone();
    let app_handle = app.clone();
    tokio::task::spawn_blocking(move || {
        fetch_album_covers(&library, &artwork_dir, &app_handle)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── Phase 23: lyrics ─────────────────────────────────────────────────

/// A single synced lyric line: time in seconds + the text to display.
#[derive(Debug, Clone, Serialize)]
pub struct SyncedLyricLine {
    pub time: f64,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct TrackLyrics {
    /// Plain-text lyrics from the embedded tag (USLT / LYRICS). May span
    /// many lines. None when the tag is absent.
    pub unsynced: Option<String>,
    /// Parsed lines from a sibling `.lrc` file (same stem as the audio
    /// file). Empty when no .lrc exists or the file couldn't be parsed.
    pub synced: Vec<SyncedLyricLine>,
}

/// Read lyrics for a track. Two parallel sources:
///   - Embedded tag (`USLT` for ID3, `LYRICS` for Vorbis comments) via
///     lofty's `ItemKey::Lyrics`
///   - `.lrc` sidecar next to the audio file. We strip the audio
///     extension and try `.lrc` / `.LRC`. Synced format is widely supported
///     by music players and karaoke apps.
#[tauri::command]
fn get_track_lyrics(track_id: i64, state: State<AppState>) -> Result<TrackLyrics, String> {
    use lofty::file::TaggedFileExt;
    use lofty::tag::ItemKey;

    let path = state.library.get_track_path(track_id)?;
    let p = std::path::Path::new(&path);

    let unsynced = if p.exists() {
        match lofty::probe::Probe::open(p).and_then(|x| x.read()) {
            Ok(tagged) => {
                tagged
                    .tags()
                    .iter()
                    .find_map(|tag| tag.get_string(&ItemKey::Lyrics).map(String::from))
            }
            Err(_) => None,
        }
    } else {
        None
    };

    // .lrc sidecar — same stem, .lrc extension. Most players (Foobar2000,
    // MusicBee, etc.) drop these alongside the audio file.
    let mut synced: Vec<SyncedLyricLine> = Vec::new();
    let lrc_path = p.with_extension("lrc");
    let lrc_path = if lrc_path.exists() {
        Some(lrc_path)
    } else {
        // Try uppercase too — case-insensitive filesystems on Windows
        // make this redundant, but a user dragging across from a Linux
        // machine might end up with .LRC.
        let upper = p.with_extension("LRC");
        if upper.exists() { Some(upper) } else { None }
    };
    if let Some(lp) = lrc_path {
        if let Ok(text) = std::fs::read_to_string(&lp) {
            synced = parse_lrc(&text);
        }
    }

    Ok(TrackLyrics { unsynced, synced })
}

/// Parse the LRC format. Each line looks like `[mm:ss.xx] text` and may
/// have multiple timestamps grouped at the front for repeated choruses:
///   `[00:12.34][01:24.56] La la la`
/// Metadata lines like `[ti:Title]`, `[ar:Artist]`, `[length:3:21]` are
/// ignored. Out-of-order entries are sorted before returning so the UI
/// can advance through them in monotonic time.
fn parse_lrc(text: &str) -> Vec<SyncedLyricLine> {
    let mut lines: Vec<SyncedLyricLine> = Vec::new();
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        // Pull every [mm:ss.xx] prefix off the front of this line and
        // collect them as separate timestamps. Whatever's left after the
        // last bracket is the lyric text shared by all of them.
        let mut times: Vec<f64> = Vec::new();
        let mut rest = line;
        while let Some(stripped) = rest.strip_prefix('[') {
            let close = match stripped.find(']') {
                Some(i) => i,
                None => break,
            };
            let inside = &stripped[..close];
            rest = &stripped[close + 1..];
            if let Some(t) = parse_lrc_timestamp(inside) {
                times.push(t);
            } else {
                // Non-timestamp metadata line — skip the whole row.
                times.clear();
                break;
            }
        }
        if times.is_empty() {
            continue;
        }
        let text = rest.trim().to_string();
        for t in times {
            lines.push(SyncedLyricLine { time: t, text: text.clone() });
        }
    }
    lines.sort_by(|a, b| a.time.partial_cmp(&b.time).unwrap_or(std::cmp::Ordering::Equal));
    lines
}

/// Parse a single LRC timestamp `mm:ss.xx` or `mm:ss` → seconds.
fn parse_lrc_timestamp(s: &str) -> Option<f64> {
    let (m, sec) = s.split_once(':')?;
    let minutes: u32 = m.parse().ok()?;
    let seconds: f64 = sec.parse().ok()?;
    if !seconds.is_finite() || seconds < 0.0 {
        return None;
    }
    Some(minutes as f64 * 60.0 + seconds)
}

/// Phase 22: classify dropped paths (folders vs audio files) and turn
/// them into a deduped set of root folders to register + scan. Returns
/// the list of folders that were ultimately scanned, so the UI can
/// display them.
#[tauri::command]
async fn handle_dropped_paths(
    paths: Vec<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    const AUDIO_EXTS: &[&str] = &["flac", "wav", "aiff", "aif", "ogg", "mp3", "m4a"];
    use std::collections::HashSet;

    // First pass: resolve every dropped path to a "root folder to scan".
    // - Existing directory → use as-is
    // - Existing audio file → use its parent directory
    // - Anything else (nonexistent, non-audio file) → skip silently
    let mut roots: HashSet<PathBuf> = HashSet::new();
    for p in paths {
        let pb = PathBuf::from(&p);
        let meta = match std::fs::metadata(&pb) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.is_dir() {
            roots.insert(pb);
        } else if meta.is_file() {
            let is_audio = pb
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| AUDIO_EXTS.contains(&e.to_ascii_lowercase().as_str()))
                .unwrap_or(false);
            if !is_audio {
                continue;
            }
            if let Some(parent) = pb.parent() {
                roots.insert(parent.to_path_buf());
            }
        }
    }

    // Second pass: register each root with the library + watcher (idempotent
    // on duplicates) and run a scan. Return the roots we actually processed
    // so the UI can update its trackedFolders list.
    let library = state.library.clone();
    let artwork_dir = state.artwork_dir.clone();
    let mut processed: Vec<String> = Vec::new();
    for root in roots {
        let path_str = root.display().to_string();
        let _ = library.add_library_folder(&path_str);
        if let Some(w) = state.watcher.lock().unwrap().as_mut() {
            let _ = w.watch(&root);
        }
        let lib = Arc::clone(&library);
        let art = artwork_dir.clone();
        let app_h = app.clone();
        let root_for_thread = root.clone();
        let _ = tokio::task::spawn_blocking(move || {
            scan_folder(&lib, &root_for_thread, &art, &app_h)
        })
        .await
        .map_err(|e| e.to_string())?;
        let _ = library.mark_folder_scanned(&path_str);
        processed.push(path_str);
    }
    Ok(processed)
}

#[tauri::command]
fn wipe_artist_images(state: State<AppState>) -> Result<(), String> {
    state.library.wipe_artist_images()?;
    // Best-effort: also clear the cached image files on disk so the next
    // fetch writes fresh ones (otherwise old files with same sanitized names
    // would just get overwritten, but unrelated files would linger forever).
    if let Ok(entries) = std::fs::read_dir(&state.artist_image_dir) {
        for entry in entries.flatten() {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    Ok(())
}

#[tauri::command]
fn wipe_library(state: State<AppState>) -> Result<(), String> {
    state.library.wipe()?;
    // Best-effort: also clear cached artwork files so disk doesn't grow.
    if let Ok(entries) = std::fs::read_dir(&state.artwork_dir) {
        for entry in entries.flatten() {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    Ok(())
}

// ── Playlist commands ───────────────────────────────────────────────

#[tauri::command]
fn create_playlist(
    name: String,
    description: Option<String>,
    kind: i32,
    rules_json: Option<String>,
    state: State<AppState>,
) -> Result<i64, String> {
    state.library.create_playlist(&name, description.as_deref(), kind, rules_json.as_deref())
}

#[tauri::command]
fn delete_playlist(id: i64, state: State<AppState>) -> Result<(), String> {
    state.library.delete_playlist(id)
}

#[tauri::command]
fn rename_playlist(
    id: i64,
    name: String,
    description: Option<String>,
    state: State<AppState>,
) -> Result<(), String> {
    state.library.rename_playlist(id, &name, description.as_deref())
}

#[tauri::command]
fn list_playlists(state: State<AppState>) -> Result<Vec<DbPlaylist>, String> {
    state.library.list_playlists()
}

#[tauri::command]
fn get_playlist_tracks(playlist_id: i64, state: State<AppState>) -> Result<Vec<LibraryTrack>, String> {
    state.library.get_playlist_tracks(playlist_id)
}

#[tauri::command]
fn add_tracks_to_playlist(
    playlist_id: i64,
    track_ids: Vec<i64>,
    state: State<AppState>,
) -> Result<i32, String> {
    state.library.add_tracks_to_playlist(playlist_id, &track_ids)
}

#[tauri::command]
fn remove_track_from_playlist(
    playlist_id: i64,
    track_id: i64,
    state: State<AppState>,
) -> Result<(), String> {
    state.library.remove_track_from_playlist(playlist_id, track_id)
}

#[tauri::command]
fn reorder_playlist_tracks(
    playlist_id: i64,
    track_ids: Vec<i64>,
    state: State<AppState>,
) -> Result<(), String> {
    state.library.reorder_playlist_tracks(playlist_id, &track_ids)
}

#[tauri::command]
fn eval_smart_playlist(playlist_id: i64, state: State<AppState>) -> Result<Vec<LibraryTrack>, String> {
    let playlist = state.library.list_playlists()?
        .into_iter()
        .find(|p| p.id == playlist_id)
        .ok_or_else(|| format!("Playlist {playlist_id} not found"))?;
    let rules = playlist.rules_json
        .ok_or_else(|| "Playlist has no rules".to_string())?;
    state.library.eval_smart_playlist(&rules)
}

// ── Favorites commands ──────────────────────────────────────────────

#[tauri::command]
fn toggle_favorite_track(track_id: i64, state: State<AppState>) -> Result<bool, String> {
    state.library.toggle_favorite_track(track_id)
}

#[tauri::command]
fn get_favorite_track_ids(state: State<AppState>) -> Result<Vec<i64>, String> {
    state.library.get_favorite_track_ids()
}

#[tauri::command]
fn get_favorite_tracks(state: State<AppState>) -> Result<Vec<LibraryTrack>, String> {
    state.library.get_favorite_tracks()
}

// ── Play history commands ───────────────────────────────────────────

#[tauri::command]
fn log_play(track_id: i64, state: State<AppState>) -> Result<(), String> {
    state.library.log_play(track_id)
}

#[tauri::command]
fn get_most_played(limit: i64, state: State<AppState>) -> Result<Vec<MostPlayedTrack>, String> {
    state.library.get_most_played(limit)
}

#[tauri::command]
fn get_recently_played(limit: i64, state: State<AppState>) -> Result<Vec<LibraryTrack>, String> {
    state.library.get_recently_played(limit)
}

#[tauri::command]
fn get_recently_added(limit: i64, state: State<AppState>) -> Result<Vec<LibraryTrack>, String> {
    state.library.get_recently_added(limit)
}

#[tauri::command]
fn get_never_played(limit: i64, state: State<AppState>) -> Result<Vec<LibraryTrack>, String> {
    state.library.get_never_played(limit)
}

/// Phase 25: aggregated listening stats — one round-trip for the whole
/// Stats page rather than 8 separate commands.
#[tauri::command]
fn get_listening_stats(state: State<AppState>) -> Result<ListeningStats, String> {
    state.library.get_listening_stats()
}

// ── Phase 20: M3U import / export ───────────────────────────────────

#[tauri::command]
fn import_m3u_playlist(
    file_path: String,
    state: State<AppState>,
) -> Result<m3u::ImportResult, String> {
    m3u::import_m3u(std::path::Path::new(&file_path), &state.library)
}

#[tauri::command]
fn export_m3u_playlist(
    file_path: String,
    playlist_id: i64,
    state: State<AppState>,
) -> Result<(), String> {
    let tracks = state.library.get_playlist_tracks(playlist_id)?;
    m3u::export_m3u(std::path::Path::new(&file_path), &tracks)
}

// ── EQ commands ─────────────────────────────────────────────────────

#[tauri::command]
fn set_eq_settings(settings: EqSettings, state: State<AppState>) -> Result<(), String> {
    with_engine(&state, |e| e.set_eq(settings))
}

#[tauri::command]
fn set_crossfade(config: CrossfadeConfig, state: State<AppState>) -> Result<(), String> {
    with_engine(&state, |e| e.set_crossfade(config))
}

// ── ReplayGain commands ──────────────────────────────────────────────

#[tauri::command]
fn get_replaygain_settings(state: State<AppState>) -> ReplayGainConfig {
    state.rg_config.lock().unwrap().clone()
}

#[tauri::command]
fn set_replaygain_settings(config: ReplayGainConfig, state: State<AppState>) -> Result<(), String> {
    *state.rg_config.lock().unwrap() = config;
    Ok(())
}

#[tauri::command]
fn clear_replaygain(state: State<AppState>) -> Result<(), String> {
    state.library.clear_replaygain()
}

/// Scan every un-analysed track in the library, measure its integrated loudness
/// (EBU R128 / ITU-BS.1770), and store the result. Emits `rg-progress` events
/// so the UI can show a progress bar.
///
/// Returns the number of tracks successfully scanned.
#[tauri::command]
async fn scan_replaygain(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<usize, String> {
    let library = state.library.clone();
    tokio::task::spawn_blocking(move || {
        let pending = library.list_tracks_missing_replaygain()?;
        let total = pending.len();
        let mut done = 0usize;

        for (i, (_id, path)) in pending.iter().enumerate() {
            match scan_file_lufs(path) {
                Ok(lufs) => {
                    let _ = library.set_track_replaygain(path, lufs);
                    done += 1;
                }
                Err(e) => {
                    log::warn!("RG scan skipped {path}: {e}");
                }
            }
            // Emit progress every 10 tracks (or on the last one)
            if (i + 1) % 10 == 0 || i + 1 == total {
                let _ = app.emit("rg-progress", serde_json::json!({
                    "done": i + 1,
                    "total": total,
                    "scanned": done,
                }));
            }
        }
        Ok(done)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Measure the integrated loudness of a single audio file using EBU R128.
/// Returns the LUFS value or an error string.
fn scan_file_lufs(path: &str) -> Result<f64, String> {
    use symphonia::core::audio::SampleBuffer;
    use symphonia::core::codecs::DecoderOptions;
    use symphonia::core::formats::FormatOptions;
    use symphonia::core::io::MediaSourceStream;
    use symphonia::core::meta::MetadataOptions;
    use symphonia::core::probe::Hint;

    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mss  = MediaSourceStream::new(Box::new(file), Default::default());
    let path_buf = std::path::Path::new(path);
    let mut hint = Hint::new();
    if let Some(ext) = path_buf.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .map_err(|e| e.to_string())?;
    let mut fmt = probed.format;
    let track   = fmt.default_track().ok_or("no audio track")?.clone();
    let params  = track.codec_params.clone();
    let track_id = track.id;
    let channels = params.channels.map(|c| c.count()).unwrap_or(2);
    let rate     = params.sample_rate.unwrap_or(44100);

    let mut decoder = symphonia::default::get_codecs()
        .make(&params, &DecoderOptions::default())
        .map_err(|e| e.to_string())?;

    let mut meter = ebur128::EbuR128::new(channels as u32, rate, ebur128::Mode::I)
        .map_err(|e| e.to_string())?;

    let mut sbuf: Option<SampleBuffer<f32>> = None;

    loop {
        match fmt.next_packet() {
            Ok(packet) => {
                if packet.track_id() != track_id { continue; }
                match decoder.decode(&packet) {
                    Ok(decoded) => {
                        let spec = *decoded.spec();
                        let cap  = decoded.capacity() as u64;
                        let needs_new = sbuf.as_ref().map_or(true, |s| (s.capacity() as u64) < cap);
                        if needs_new { sbuf = Some(SampleBuffer::<f32>::new(cap, spec)); }
                        let s = sbuf.as_mut().unwrap();
                        s.copy_interleaved_ref(decoded);
                        let samples = s.samples();
                        // Feed raw interleaved samples to the meter.
                        meter.add_frames_f32(samples).map_err(|e| e.to_string())?;
                    }
                    Err(symphonia::core::errors::Error::DecodeError(_)) => continue,
                    Err(_) => break,
                }
            }
            Err(_) => break,
        }
    }

    meter.loudness_global().map_err(|e| e.to_string())
}

// ── Tag editor ──────────────────────────────────────────────────────

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TagEdit {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub album_artist: Option<String>,
    pub year: Option<i32>,
    pub genre: Option<String>,
    pub track_no: Option<i32>,
    pub disc_no: Option<i32>,
}

/// Open the file with lofty, set the requested tag fields on the primary
/// tag (creating one if the file has none), and save back to disk. Only
/// fields present in `edit` are touched; everything else stays as-is.
fn write_tags_to_file(path: &std::path::Path, edit: &TagEdit) -> Result<(), String> {
    use lofty::config::WriteOptions;
    use lofty::file::{AudioFile, TaggedFileExt};
    use lofty::tag::{Accessor, ItemKey, Tag};

    let mut tagged = lofty::probe::Probe::open(path)
        .map_err(|e| e.to_string())?
        .read()
        .map_err(|e| e.to_string())?;

    // Ensure there's a primary tag. If the file has none (rare — usually a
    // freshly-recorded WAV/FLAC with no metadata), create one of the format's
    // default tag type so the fields have somewhere to land.
    if tagged.primary_tag().is_none() {
        let tt = tagged.primary_tag_type();
        tagged.insert_tag(Tag::new(tt));
    }
    let tag = tagged.primary_tag_mut().ok_or("could not access tag")?;

    if let Some(s) = &edit.title       { tag.set_title(s.clone()); }
    if let Some(s) = &edit.artist      { tag.set_artist(s.clone()); }
    if let Some(s) = &edit.album       { tag.set_album(s.clone()); }
    if let Some(y) = edit.year         { tag.set_year(y.max(0) as u32); }
    if let Some(s) = &edit.genre       { tag.set_genre(s.clone()); }
    if let Some(n) = edit.track_no     { tag.set_track(n.max(0) as u32); }
    if let Some(n) = edit.disc_no      { tag.set_disk(n.max(0) as u32); }
    if let Some(s) = &edit.album_artist {
        tag.insert_text(ItemKey::AlbumArtist, s.clone());
    }

    tagged
        .save_to_path(path, WriteOptions::default())
        .map_err(|e| format!("save tag: {e}"))?;
    Ok(())
}

/// Update the on-disk file's tags and resync the library DB. Emits
/// `library-updated` so the frontend can refresh affected views.
#[tauri::command]
async fn edit_track_tags(
    track_id: i64,
    edit: TagEdit,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let library = state.library.clone();
    let artwork_dir = state.artwork_dir.clone();

    tokio::task::spawn_blocking(move || {
        let path_str = library.get_track_path(track_id)?;
        let path = std::path::PathBuf::from(&path_str);

        // Write the new tags to disk first; if that fails, abort with no
        // DB change so the user sees a clean error instead of a half-applied edit.
        write_tags_to_file(&path, &edit)?;

        // Re-import via the same code path as the bulk scanner so any
        // album-row reassignment (changed album / artist) is handled
        // correctly and uniformly.
        reimport_file(&library, &path, &artwork_dir)?;

        let _ = app.emit("library-updated", ());
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── Waveform peaks ──────────────────────────────────────────────────

/// Cache file format (little-endian):
///   "QWF1"      — 4-byte magic
///   u32         — number of peaks (N)
///   f32 × N     — peak amplitudes in [0, 1]
fn encode_waveform_cache(peaks: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(8 + peaks.len() * 4);
    out.extend_from_slice(b"QWF1");
    out.extend_from_slice(&(peaks.len() as u32).to_le_bytes());
    for &p in peaks {
        out.extend_from_slice(&p.to_le_bytes());
    }
    out
}

fn decode_waveform_cache(bytes: &[u8]) -> Option<Vec<f32>> {
    if bytes.len() < 8 || &bytes[0..4] != b"QWF1" {
        return None;
    }
    let n = u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]) as usize;
    if bytes.len() != 8 + n * 4 {
        return None;
    }
    let mut peaks = Vec::with_capacity(n);
    for i in 0..n {
        let off = 8 + i * 4;
        peaks.push(f32::from_le_bytes([
            bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3],
        ]));
    }
    Some(peaks)
}

/// Decode the full file via Symphonia and bin samples into `num_peaks`
/// equal-width windows, taking the max-absolute-amplitude in each window.
/// Memory-bounded: O(num_peaks) — we don't hold the full decoded audio.
///
/// Cost: roughly the same as a single FLAC playthrough, run as fast as the
/// CPU can decode (no I/O wait). On a slow CPU a 4-min FLAC takes ~500 ms;
/// on a modern CPU under 100 ms. Run via tokio::task::spawn_blocking so it
/// doesn't block the Tauri command dispatcher.
fn compute_waveform_peaks(path: &str, num_peaks: usize) -> Result<Vec<f32>, String> {
    use symphonia::core::audio::SampleBuffer;
    use symphonia::core::codecs::DecoderOptions;
    use symphonia::core::formats::FormatOptions;
    use symphonia::core::io::MediaSourceStream;
    use symphonia::core::meta::MetadataOptions;
    use symphonia::core::probe::Hint;

    if num_peaks == 0 {
        return Ok(Vec::new());
    }

    let path_buf = std::path::Path::new(path);
    let file = std::fs::File::open(path_buf).map_err(|e| e.to_string())?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path_buf.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .map_err(|e| e.to_string())?;
    let mut fmt = probed.format;
    let track = fmt.default_track().ok_or("no audio track")?.clone();
    let params = track.codec_params.clone();
    let track_id = track.id;
    let channels = params.channels.map(|c| c.count()).unwrap_or(2);

    // n_frames is provided by sized media (FLAC, WAV, MP3 w/ Xing, etc.).
    // Without it we can't map samples to bins on-the-fly. Symphonia falls
    // through to the duration field for some formats — keep that as a
    // fallback so e.g. tag-less WAV files still produce a usable waveform.
    let total_frames = match params.n_frames {
        Some(n) if n > 0 => n,
        _ => {
            let sample_rate = params.sample_rate.unwrap_or(44100) as u64;
            params
                .time_base
                .and_then(|tb| {
                    params.n_frames.map(|n| n.max(1))
                        .or_else(|| Some((tb.numer as u64).max(1)))
                })
                .unwrap_or(sample_rate * 60) // assume 60s; produces a sparse but valid waveform
        }
    };

    let mut decoder = symphonia::default::get_codecs()
        .make(&params, &DecoderOptions::default())
        .map_err(|e| e.to_string())?;

    let mut peaks = vec![0.0f32; num_peaks];
    let mut frame_pos: u64 = 0;
    let mut sbuf: Option<SampleBuffer<f32>> = None;
    let n_peaks_u64 = num_peaks as u64;
    let last_bin = num_peaks - 1;

    loop {
        match fmt.next_packet() {
            Ok(packet) => {
                if packet.track_id() != track_id {
                    continue;
                }
                match decoder.decode(&packet) {
                    Ok(decoded) => {
                        let spec = *decoded.spec();
                        let cap = decoded.capacity() as u64;
                        let needs_new = sbuf.as_ref().map_or(true, |s| (s.capacity() as u64) < cap);
                        if needs_new {
                            sbuf = Some(SampleBuffer::<f32>::new(cap, spec));
                        }
                        let s = sbuf.as_mut().unwrap();
                        s.copy_interleaved_ref(decoded);
                        let samples = s.samples();
                        let pkt_frames = samples.len() / channels;

                        // Inner loop: max-abs across channels per frame, then
                        // bucket into the correct bin. We unroll the channel
                        // pass to avoid an inner Vec iterator on the hot path.
                        for i in 0..pkt_frames {
                            let base = i * channels;
                            let mut amp: f32 = 0.0;
                            for c in 0..channels {
                                let v = samples[base + c].abs();
                                if v > amp {
                                    amp = v;
                                }
                            }
                            let bin = (((frame_pos + i as u64) * n_peaks_u64) / total_frames)
                                as usize;
                            let bin = bin.min(last_bin);
                            if amp > peaks[bin] {
                                peaks[bin] = amp;
                            }
                        }
                        frame_pos += pkt_frames as u64;
                    }
                    Err(symphonia::core::errors::Error::DecodeError(_)) => continue,
                    Err(_) => break,
                }
            }
            Err(_) => break,
        }
    }

    Ok(peaks)
}

/// Return cached peaks for `track_id`, computing + caching on miss.
#[tauri::command]
async fn get_waveform(
    track_id: i64,
    num_peaks: usize,
    state: State<'_, AppState>,
) -> Result<Vec<f32>, String> {
    // Clamp request — saner than letting a misbehaving frontend allocate
    // a million-peak Vec.
    let n = num_peaks.clamp(32, 4096);
    let library = state.library.clone();
    let waveform_dir = state.waveform_dir.clone();

    tokio::task::spawn_blocking(move || {
        let cache_path = waveform_dir.join(format!("track-{}-{}.qwf", track_id, n));

        // Cache hit
        if let Ok(bytes) = std::fs::read(&cache_path) {
            if let Some(peaks) = decode_waveform_cache(&bytes) {
                return Ok(peaks);
            }
        }

        // Cache miss → decode + compute + persist
        let track_path = library.get_track_path(track_id)?;
        let peaks = compute_waveform_peaks(&track_path, n)?;
        let bytes = encode_waveform_cache(&peaks);
        let _ = std::fs::create_dir_all(&waveform_dir);
        let _ = std::fs::write(&cache_path, &bytes);
        Ok(peaks)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Pre-compute waveforms for every track in the library. Skips any that
/// already have a cache file. Emits `waveform-scan-progress` events.
#[tauri::command]
async fn scan_waveforms(
    num_peaks: usize,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<usize, String> {
    let n = num_peaks.clamp(32, 4096);
    let library = state.library.clone();
    let waveform_dir = state.waveform_dir.clone();

    tokio::task::spawn_blocking(move || {
        std::fs::create_dir_all(&waveform_dir).map_err(|e| e.to_string())?;
        let tracks = library.list_all_tracks()?;
        let total = tracks.len();
        let mut done = 0usize;

        for (i, t) in tracks.iter().enumerate() {
            let cache_path = waveform_dir.join(format!("track-{}-{}.qwf", t.id, n));
            if cache_path.exists() {
                // Already cached; count toward progress but don't recompute.
            } else if let Ok(peaks) = compute_waveform_peaks(&t.path, n) {
                let bytes = encode_waveform_cache(&peaks);
                if std::fs::write(&cache_path, &bytes).is_ok() {
                    done += 1;
                }
            } else {
                log::warn!("waveform scan skipped {}", t.path);
            }

            if (i + 1) % 10 == 0 || i + 1 == total {
                let _ = app.emit(
                    "waveform-scan-progress",
                    serde_json::json!({
                        "done": i + 1,
                        "total": total,
                        "scanned": done,
                    }),
                );
            }
        }
        Ok(done)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Wipe all cached waveform files so the user can re-compute fresh
/// (e.g. after changing the source library).
#[tauri::command]
fn clear_waveforms(state: State<AppState>) -> Result<(), String> {
    if let Ok(entries) = std::fs::read_dir(&state.waveform_dir) {
        for entry in entries.flatten() {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    Ok(())
}

// ── AI playlist ─────────────────────────────────────────────────────

#[derive(Serialize)]
struct AiPlaylistResult {
    name: String,
    track_ids: Vec<i64>,
}

#[tauri::command]
async fn create_ai_playlist(
    prompt: String,
    api_key: String,
    state: State<'_, AppState>,
) -> Result<AiPlaylistResult, String> {
    let key = api_key.trim().to_string();
    if key.is_empty() {
        return Err("No Anthropic API key configured. Add it in Settings → Integrations.".into());
    }
    let library = state.library.clone();
    tokio::task::spawn_blocking(move || {
        let rows: Vec<AiTrackRow> = library.list_tracks_for_ai()?;
        if rows.is_empty() {
            return Err("Library is empty — scan a folder first.".into());
        }

        // Cap at MAX_PER_ARTIST tracks per artist so no single artist dominates
        // the sample Claude sees. list_tracks_for_ai returns ORDER BY RANDOM(),
        // so the first N we encounter for each artist are already a random pick.
        // 2 tracks per artist keeps the CSV well under 10k tokens even for large
        // libraries, staying clear of the 50k token/min rate limit.
        const MAX_PER_ARTIST: usize = 2;
        let mut artist_counts: std::collections::HashMap<String, usize> =
            std::collections::HashMap::new();
        let sample: Vec<&AiTrackRow> = rows.iter().filter(|r| {
            let n = artist_counts.entry(r.artist.clone()).or_default();
            if *n < MAX_PER_ARTIST { *n += 1; true } else { false }
        }).collect();

        // Build compact CSV to minimise token cost.
        // id,title,artist,album,genre,bits,rate_khz,dur_s
        let mut csv = String::from("id,title,artist,album,genre,bits,rate_khz,dur_s\n");
        let cap = sample.len().min(600);
        for row in &sample[..cap] {
            let clean = |s: &str, n: usize| {
                s.chars().take(n).collect::<String>().replace(',', ";")
            };
            let rate_khz = row.sample_rate.map(|r| r as f64 / 1000.0).unwrap_or(44.1);
            let dur_s    = row.duration.map(|d| d.round() as i64).unwrap_or(0);
            csv.push_str(&format!(
                "{},{},{},{},{},{},{:.1},{}\n",
                row.id,
                clean(&row.title,  50),
                clean(&row.artist, 40),
                clean(&row.album,  40),
                clean(row.genre.as_deref().unwrap_or(""), 20),
                row.bits_per_sample.unwrap_or(16),
                rate_khz,
                dur_s,
            ));
        }

        let system_prompt =
            "You are a music curation assistant for a personal audiophile music player. \
             Select tracks from the provided library that best match the user's description. \
             Respond with ONLY valid JSON — no explanation, no markdown — in exactly this format: \
             {\"name\": \"Short Playlist Name\", \"track_ids\": [1, 2, 3, ...]} \
             Select between 10 and 50 tracks. Use only IDs that appear in the library.";

        let user_msg = format!(
            "Create a playlist for: \"{prompt}\"\n\nLibrary:\n{csv}"
        );

        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| e.to_string())?;

        let resp = client
            .post("https://api.anthropic.com/v1/messages")
            .header("x-api-key", &key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&serde_json::json!({
                "model": "claude-haiku-4-5-20251001",
                "max_tokens": 1024,
                "system": system_prompt,
                "messages": [{"role": "user", "content": user_msg}]
            }))
            .send()
            .map_err(|e| format!("API request failed: {e}"))?;

        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let body = resp.text().unwrap_or_default();
            return Err(format!("Anthropic API error {status}: {body}"));
        }

        let body: serde_json::Value = resp.json()
            .map_err(|e| format!("Failed to parse API response: {e}"))?;
        let text = body["content"][0]["text"]
            .as_str()
            .ok_or("Unexpected API response structure")?;

        // Strip markdown code fences the model sometimes adds despite instructions.
        let clean = text.trim();
        let clean = clean.strip_prefix("```json").or_else(|| clean.strip_prefix("```")).unwrap_or(clean);
        let clean = clean.strip_suffix("```").unwrap_or(clean).trim();

        let result: serde_json::Value = serde_json::from_str(clean)
            .map_err(|e| format!("Claude returned invalid JSON: {e}\nGot: {}", &clean[..clean.len().min(300)]))?;

        let name = result["name"]
            .as_str()
            .unwrap_or("AI Playlist")
            .to_string();
        let track_ids: Vec<i64> = result["track_ids"]
            .as_array()
            .ok_or("Response missing track_ids array")?
            .iter()
            .filter_map(|v| v.as_i64())
            .collect();

        if track_ids.is_empty() {
            return Err("Claude returned no tracks — try a different description.".into());
        }

        Ok(AiPlaylistResult { name, track_ids })
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── Entry point ─────────────────────────────────────────────────────

/// Best-effort SMTC initialization. Pulls the HWND off the main webview,
/// constructs a MediaSession, returns None on any platform / window error
/// so the rest of the app can carry on without it.
fn build_media_session(app: &mut tauri::App) -> Option<MediaSession> {
    // The default webview window in a Tauri 2 app is the one named "main"
    // unless tauri.conf.json overrides it. get_webview_window returns
    // Option<_>, so a missing window degrades cleanly.
    let window = app.get_webview_window("main")?;
    // hwnd() is Windows-only; on other platforms souvlaki will still init
    // but ignore the handle. We only care about Windows for SMTC anyway.
    #[cfg(target_os = "windows")]
    let hwnd_isize: isize = {
        match window.hwnd() {
            Ok(h) => h.0 as isize,
            Err(e) => {
                log::warn!("[smtc] window.hwnd() failed: {e}");
                return None;
            }
        }
    };
    #[cfg(not(target_os = "windows"))]
    let hwnd_isize: isize = 0;

    match MediaSession::new(hwnd_isize, app.handle().clone()) {
        Ok(s) => Some(s),
        Err(e) => {
            log::warn!("[smtc] init failed: {e}");
            None
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // Phase 27: in-app self-updater. Checks the configured endpoint
        // (GitHub Releases latest.json) for a newer signed binary on
        // startup, prompts the user, and installs + restarts.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let engine = AudioEngine::new(app.handle().clone());

            // Library DB + artwork cache live in the user's app-data folder
            let data_dir = app.path().app_data_dir().expect("no app data dir");
            let db_path = data_dir.join("library.db");
            let artwork_dir = data_dir.join("artwork");
            let artist_image_dir = data_dir.join("artist-images");
            let waveform_dir = data_dir.join("waveforms");
            let library = Arc::new(LibraryDb::open(&db_path).expect("open library db"));

            // Phase 15: SMTC. Bind to the main window's HWND. If we can't
            // get a window or SMTC init fails (Wine, very old Windows, etc.),
            // we just skip it — the player still works fine, just without
            // the OS tile / hardware media keys.
            let media_session = build_media_session(app);

            // Phase 17: file watcher. Re-register every saved library_folder
            // so the user doesn't have to re-pick folders to get auto-rescan.
            let watcher = match LibraryWatcher::new(
                Arc::clone(&library),
                artwork_dir.clone(),
                app.handle().clone(),
            ) {
                Ok(mut w) => {
                    if let Ok(folders) = library.list_library_folders() {
                        for f in folders {
                            if let Err(e) = w.watch(std::path::Path::new(&f.path)) {
                                log::warn!("[watcher] failed to attach to {}: {e}", f.path);
                            }
                        }
                    }
                    Some(w)
                }
                Err(e) => {
                    log::warn!("[watcher] init failed: {e}");
                    None
                }
            };

            app.manage(AppState {
                engine: Mutex::new(Some(engine)),
                library,
                artwork_dir,
                artist_image_dir,
                waveform_dir,
                rg_config: Mutex::new(ReplayGainConfig::default()),
                media_session: Mutex::new(media_session),
                watcher: Mutex::new(watcher),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_devices,
            play_file,
            pause_playback,
            resume_playback,
            stop_playback,
            seek_to,
            set_volume,
            set_device,
            set_exclusive_mode,
            queue_next_track,
            get_playback_state,
            scan_library,
            list_albums,
            list_tracks,
            list_artists,
            list_albums_by_artist,
            list_all_tracks,
            fetch_artist_photos,
            wipe_artist_images,
            wipe_library,
            create_playlist,
            delete_playlist,
            rename_playlist,
            list_playlists,
            get_playlist_tracks,
            add_tracks_to_playlist,
            remove_track_from_playlist,
            reorder_playlist_tracks,
            eval_smart_playlist,
            toggle_favorite_track,
            get_favorite_track_ids,
            get_favorite_tracks,
            log_play,
            get_most_played,
            get_recently_played,
            create_ai_playlist,
            set_eq_settings,
            get_replaygain_settings,
            set_replaygain_settings,
            clear_replaygain,
            scan_replaygain,
            get_waveform,
            scan_waveforms,
            clear_waveforms,
            edit_track_tags,
            set_crossfade,
            // Phase 16: multi-folder library
            list_library_folders,
            add_library_folder,
            remove_library_folder,
            // Phase 15: SMTC
            set_media_metadata,
            set_media_playback,
            // Phase 18: smart playlists
            get_recently_added,
            get_never_played,
            // Phase 20: M3U import / export
            import_m3u_playlist,
            export_m3u_playlist,
            // Phase 21: Cover Art Archive fallback
            fetch_album_covers_cmd,
            // Phase 22: drag-and-drop from Explorer
            handle_dropped_paths,
            // Phase 23: lyrics
            get_track_lyrics,
            // Phase 25: listening stats
            get_listening_stats,
            // v0.2.0: dynamic accent color extracted from cover art
            get_album_accent_color,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
