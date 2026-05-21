//! Cover Art Archive fallback for albums whose embedded art was missing.
//!
//! Flow per album:
//!   1. Query MusicBrainz `/release-group/?query=…` for the album by
//!      `artist:"…" AND releasegroup:"…"` → first MBID
//!   2. GET `https://coverartarchive.org/release-group/{mbid}/front-500`
//!      → JPEG bytes (CAA redirects to the actual archive URL)
//!   3. Resize to 512 px square thumbnail, save to `artwork_dir/album-{id}.jpg`
//!   4. UPDATE albums SET cover_path = …
//!
//! Why release-group instead of release? A release-group covers every
//! pressing / re-issue / region of an album. Most user libraries don't
//! tag specific releases, so matching by release-group catches the album
//! art for the canonical 2007 reissue when their FLACs are from the 1999
//! one. CAA serves the same thumbnail for the whole group.
//!
//! Rate limiting: MusicBrainz asks for ≤1 req/sec from non-commercial
//! clients. CAA itself has no documented limit but be polite. We pace
//! MB calls at 1100 ms apart and let CAA calls fire as fast as the
//! network allows in between.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use reqwest::blocking::Client;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use super::db::LibraryDb;

const USER_AGENT: &str = "Quartz/0.1 ( quartz-music-player on GitHub )";
const MB_RATE_LIMIT: Duration = Duration::from_millis(1100);
/// Square thumbnail edge. Matches the scanner's THUMB_MAX so the gallery
/// rendering pipeline doesn't have to deal with two different sizes.
const THUMB_MAX: u32 = 512;

#[derive(Serialize, Clone)]
pub struct AlbumCoverProgress {
    pub processed: usize,
    pub total: usize,
    pub current_album: String,
    pub found: usize,
}

pub fn fetch_album_covers(
    db: &Arc<LibraryDb>,
    artwork_dir: &Path,
    app: &AppHandle,
) -> Result<usize, String> {
    std::fs::create_dir_all(artwork_dir).map_err(|e| e.to_string())?;

    let albums = db.list_albums_needing_cover()?;
    let total = albums.len();
    eprintln!("[caa] {} albums need covers", total);

    let client = Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;

    let mut found = 0usize;
    let mut last_mb_call = Instant::now() - MB_RATE_LIMIT;

    for (i, (album_id, title, artist)) in albums.iter().enumerate() {
        let display_name = format!("{artist} — {title}");
        let _ = app.emit(
            "album-cover-progress",
            AlbumCoverProgress {
                processed: i,
                total,
                current_album: display_name.clone(),
                found,
            },
        );

        // Pace MB query
        let elapsed = last_mb_call.elapsed();
        if elapsed < MB_RATE_LIMIT {
            thread::sleep(MB_RATE_LIMIT - elapsed);
        }
        last_mb_call = Instant::now();

        let mbid = match search_release_group(&client, artist, title) {
            Ok(Some(id)) => id,
            Ok(None) => {
                eprintln!("[caa] no MB match: {display_name}");
                continue;
            }
            Err(e) => {
                eprintln!("[caa] MB search error for {display_name}: {e}");
                continue;
            }
        };

        // CAA front-500 endpoint. 404 from CAA is the "no art" signal —
        // not an error; just skip and move on.
        let url = format!("https://coverartarchive.org/release-group/{mbid}/front-500");
        let resp = match client.get(&url).send() {
            Ok(r) => r,
            Err(e) => {
                eprintln!("[caa] download {url}: {e}");
                continue;
            }
        };
        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            continue;
        }
        if !resp.status().is_success() {
            eprintln!("[caa] HTTP {} for {display_name}", resp.status());
            continue;
        }
        let bytes = match resp.bytes() {
            Ok(b) => b,
            Err(e) => {
                eprintln!("[caa] read body: {e}");
                continue;
            }
        };

        let out: PathBuf = artwork_dir.join(format!("album-{}.jpg", album_id));
        if let Err(e) = write_thumbnail(&bytes, &out) {
            eprintln!("[caa] write {}: {e}", out.display());
            continue;
        }
        if let Err(e) = db.set_album_cover(*album_id, &out.display().to_string()) {
            eprintln!("[caa] db update {album_id}: {e}");
            continue;
        }
        found += 1;
    }

    let _ = app.emit(
        "album-cover-progress",
        AlbumCoverProgress {
            processed: total,
            total,
            current_album: String::new(),
            found,
        },
    );
    eprintln!("[caa] fetched covers for {} of {} albums", found, total);
    Ok(found)
}

/// Query MusicBrainz for the album's release-group MBID. We search by
/// quoted artist + release-group; the first result is by far the most
/// common match for typical library tags. Returns None if MB has nothing
/// or the response is malformed.
fn search_release_group(
    client: &Client,
    artist: &str,
    title: &str,
) -> Result<Option<String>, String> {
    let query = format!(
        "artist:\"{}\" AND releasegroup:\"{}\"",
        escape_lucene(artist),
        escape_lucene(title),
    );
    let resp: serde_json::Value = client
        .get("https://musicbrainz.org/ws/2/release-group")
        .query(&[("query", query), ("fmt", "json".into()), ("limit", "1".into())])
        .send()
        .map_err(|e| e.to_string())?
        .json()
        .map_err(|e| e.to_string())?;
    Ok(resp["release-groups"][0]["id"].as_str().map(String::from))
}

/// Decode + resize bytes to a 512-px-max JPEG thumbnail. Mirrors the
/// helper in artist_fetch.rs — kept duplicated here so the two modules
/// stay self-contained and we don't have a tangle of `pub(super) fn`.
fn write_thumbnail(bytes: &[u8], out: &Path) -> Result<(), String> {
    match image::load_from_memory(bytes) {
        Ok(img) => {
            let resized = if img.width().max(img.height()) > THUMB_MAX {
                img.thumbnail(THUMB_MAX, THUMB_MAX)
            } else {
                img
            };
            let rgb = resized.to_rgb8();
            let mut jpeg: Vec<u8> = Vec::with_capacity(64 * 1024);
            let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 85);
            if enc
                .encode(&rgb, rgb.width(), rgb.height(), image::ExtendedColorType::Rgb8)
                .is_ok()
            {
                return std::fs::write(out, &jpeg).map_err(|e| e.to_string());
            }
        }
        Err(_) => {}
    }
    std::fs::write(out, bytes).map_err(|e| e.to_string())
}

/// Escape Lucene-special characters in a user-supplied tag value so the
/// MB search isn't broken by titles containing `:`, `(`, `[`, `/`, etc.
/// MB uses Lucene query syntax; reserved chars need backslash escape.
fn escape_lucene(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 4);
    for c in s.chars() {
        match c {
            '+' | '-' | '&' | '|' | '!' | '(' | ')' | '{' | '}' | '[' | ']'
            | '^' | '"' | '~' | '*' | '?' | ':' | '\\' | '/' => {
                out.push('\\');
                out.push(c);
            }
            _ => out.push(c),
        }
    }
    out
}
