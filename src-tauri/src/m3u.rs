//! M3U / M3U8 playlist import and export.
//!
//! Export writes a UTF-8 (no BOM) `.m3u8` with `#EXTINF` metadata and
//! absolute paths. Absolute paths are more portable across machines than
//! relative ones for our case: the same library mounted at a different
//! path is rare; sharing a playlist file between two installs that both
//! see `D:\Music\…` is the common case.
//!
//! Import reads either `.m3u` (Latin-1 historically; we read as UTF-8 and
//! fall back to lossy decode on invalid bytes) or `.m3u8` (UTF-8). Each
//! file entry is resolved in this order:
//!   1. Path is absolute and exists → use as-is
//!   2. Path is relative → join to playlist parent, check exists
//!   3. Case-insensitive comparison on Windows (NTFS preserves but ignores case)
//!   4. Tag-fuzzy fallback — match `#EXTINF: artist - title` against the
//!      library by normalised string comparison
//!
//! Entries that don't resolve are returned with `track_id = None` so the
//! caller can either skip them or display them with a "missing" badge.

use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::library::{LibraryDb, LibraryTrack};

/// One row of an imported playlist. `track_id` is None when the entry
/// couldn't be matched to anything in the library — the UI displays
/// these with the original line text so the user can fix them manually.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ImportedEntry {
    pub track_id: Option<i64>,
    /// The path or display string from the M3U file, for debugging /
    /// "this entry didn't match" UI.
    pub source: String,
}

/// Result of an import: the resolved playlist name (from filename, sans
/// extension) and the ordered entries.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ImportResult {
    pub name: String,
    pub entries: Vec<ImportedEntry>,
}

/// Parse an .m3u / .m3u8 file and resolve each entry against the library.
pub fn import_m3u(file_path: &Path, db: &LibraryDb) -> Result<ImportResult, String> {
    let bytes = fs::read(file_path).map_err(|e| format!("read {}: {e}", file_path.display()))?;
    // Try UTF-8 first; fall back to lossy. We don't bother with Latin-1
    // detection because the lossy decode of Latin-1 produces readable text
    // for ASCII paths and just garbles a few accented characters — which
    // wouldn't have matched anyway without proper transcoding.
    let text = match std::str::from_utf8(&bytes) {
        Ok(s) => s.to_string(),
        Err(_) => String::from_utf8_lossy(&bytes).into_owned(),
    };

    let playlist_dir = file_path
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(PathBuf::new);

    // Build the fallback lookup table once. For huge libraries (>30k
    // tracks) this allocates ~2 MB, but it's cheap compared to N separate
    // queries against the DB.
    let all_tracks = db.list_all_tracks()?;
    let path_index: HashMap<String, i64> = all_tracks
        .iter()
        .map(|t| (norm_path(&t.path), t.id))
        .collect();
    let tag_index: HashMap<String, i64> = all_tracks
        .iter()
        .map(|t| (tag_key(&t.artist, &t.title), t.id))
        .collect();

    // We carry the last #EXTINF line forward as the tag-fallback hint for
    // the immediately-following file entry. The M3U format puts the metadata
    // line right before the file path, so this is the spec-compliant way to
    // pair them.
    let mut last_extinf: Option<String> = None;
    let mut entries: Vec<ImportedEntry> = Vec::new();

    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        // Pre-parse the EXTINF that immediately precedes a file line.
        if let Some(rest) = line.strip_prefix("#EXTINF:") {
            // Format: #EXTINF:<seconds>,Artist - Title
            // We only care about the part after the first comma.
            last_extinf = rest.split_once(',').map(|(_, t)| t.to_string());
            continue;
        }
        // Other # comments are ignored. The spec only defines a handful
        // (#EXTM3U at the top, #EXT-X-* for HLS) and none of them carry
        // info we need for a local-file playlist.
        if line.starts_with('#') {
            continue;
        }

        let source = line.to_string();
        let resolved = resolve_entry(
            line,
            &playlist_dir,
            &path_index,
            &tag_index,
            last_extinf.as_deref(),
        );
        entries.push(ImportedEntry { track_id: resolved, source });
        last_extinf = None;
    }

    let name = file_path
        .file_stem()
        .and_then(|s| s.to_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| "Imported playlist".to_string());

    Ok(ImportResult { name, entries })
}

/// Write a playlist as `.m3u8` with `#EXTINF` metadata. Absolute paths
/// (no relative-to-file dance) keep the file portable across user folders.
pub fn export_m3u(file_path: &Path, tracks: &[LibraryTrack]) -> Result<(), String> {
    let mut file = fs::File::create(file_path)
        .map_err(|e| format!("create {}: {e}", file_path.display()))?;

    writeln!(file, "#EXTM3U").map_err(|e| e.to_string())?;
    for t in tracks {
        let dur = t.duration.map(|d| d.round() as i64).unwrap_or(-1);
        // Strip any newlines from tag fields — extremely rare but a single
        // bad track tag could corrupt the playlist syntax.
        let artist = t.artist.replace(['\n', '\r'], " ");
        let title = t.title.replace(['\n', '\r'], " ");
        writeln!(file, "#EXTINF:{dur},{artist} - {title}").map_err(|e| e.to_string())?;
        writeln!(file, "{}", t.path).map_err(|e| e.to_string())?;
    }

    Ok(())
}

/// Try to resolve one M3U entry to a track id. Returns None if no match.
fn resolve_entry(
    raw: &str,
    playlist_dir: &Path,
    path_index: &HashMap<String, i64>,
    tag_index: &HashMap<String, i64>,
    extinf: Option<&str>,
) -> Option<i64> {
    // Strip the `file://` scheme some apps emit. Windows file URIs look
    // like `file:///C:/Music/...` so we also drop the leading slash on
    // Windows-style paths.
    let cleaned = raw
        .strip_prefix("file:///")
        .map(|s| s.to_string())
        .or_else(|| raw.strip_prefix("file://").map(|s| s.to_string()))
        .unwrap_or_else(|| raw.to_string());

    // 1. Absolute / direct path
    let direct = PathBuf::from(&cleaned);
    if direct.is_absolute() {
        if let Some(id) = path_index.get(&norm_path(&cleaned)) {
            return Some(*id);
        }
        // Try Windows backslash <-> forward-slash flip
        if let Some(id) = path_index.get(&norm_path(&cleaned.replace('/', "\\"))) {
            return Some(*id);
        }
    }

    // 2. Relative path → join to playlist directory
    if !direct.is_absolute() {
        let joined = playlist_dir.join(&cleaned);
        let key = norm_path(joined.to_string_lossy().as_ref());
        if let Some(id) = path_index.get(&key) {
            return Some(*id);
        }
    }

    // 3. Tag-fuzzy fallback using the immediately-preceding #EXTINF
    if let Some(info) = extinf {
        // EXTINF format: "Artist - Title"
        if let Some((artist, title)) = info.split_once(" - ") {
            let key = tag_key(artist.trim(), title.trim());
            if let Some(id) = tag_index.get(&key) {
                return Some(*id);
            }
        }
    }

    None
}

/// Normalise a filesystem path for comparison: lowercase + forward slashes.
/// Matches the case-insensitive behavior of NTFS without being expensive.
fn norm_path(p: &str) -> String {
    p.replace('\\', "/").to_ascii_lowercase()
}

/// Lookup key for tag-fuzzy matching. Lowercased + whitespace-collapsed so
/// "Pink Floyd   -   Time" matches "pink floyd - time".
fn tag_key(artist: &str, title: &str) -> String {
    let combined = format!("{} - {}", artist.trim(), title.trim());
    combined
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}
