// MusicBrainz + fanart.tv + Wikidata artist photo fetcher.
//
// Flow per artist:
//   1. Search MusicBrainz for the artist by name → MBID
//   2. If we have a fanart.tv API key, query fanart.tv with the MBID
//      → if it returns an artistthumb, download it and we're done.
//      fanart.tv is curated specifically for music apps (same source Plex /
//      Kodi use) so images are higher quality / more consistent than Commons.
//   3. Fallback: fetch the artist's url-relations on MB → find the Wikidata
//      Q-id → hit Wikidata's EntityData endpoint → get the P18 filename →
//      download via commons.wikimedia.org/Special:FilePath.
//
// MusicBrainz asks for ~1 request/sec from non-commercial clients; we honour
// that with a 1100ms gate between calls. fanart.tv has no documented rate
// limit but be polite. Wikidata has no documented rate limit but be polite.

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

#[derive(Serialize, Clone)]
pub struct ArtistFetchProgress {
    pub processed: usize,
    pub total: usize,
    pub current_artist: String,
    pub found: usize,
}

pub fn fetch_artist_images(
    db: &Arc<LibraryDb>,
    artist_dir: &Path,
    app: &AppHandle,
    fanart_api_key: Option<String>,
) -> Result<usize, String> {
    std::fs::create_dir_all(artist_dir).map_err(|e| e.to_string())?;

    let artists = db.list_artists_needing_image()?;
    let total = artists.len();
    eprintln!("[mb] {} artists need images", total);

    let client = Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;

    let mut found = 0usize;
    // Schedule the first call immediately by pretending the last one was
    // long enough ago.
    let mut last_mb_call = Instant::now() - MB_RATE_LIMIT;

    for (i, artist_name) in artists.iter().enumerate() {
        let _ = app.emit(
            "artist-fetch-progress",
            ArtistFetchProgress {
                processed: i,
                total,
                current_artist: artist_name.clone(),
                found,
            },
        );

        // Pace MB queries
        let elapsed = last_mb_call.elapsed();
        if elapsed < MB_RATE_LIMIT {
            thread::sleep(MB_RATE_LIMIT - elapsed);
        }
        last_mb_call = Instant::now();

        let mbid = match search_mb_artist(&client, artist_name) {
            Ok(Some(id)) => id,
            Ok(None) => {
                eprintln!("[mb] no match: {}", artist_name);
                continue;
            }
            Err(e) => {
                eprintln!("[mb] search error for {}: {}", artist_name, e);
                continue;
            }
        };

        let safe = sanitize_filename(artist_name);

        // ── Tier 1: fanart.tv (if API key configured) ───────────────────
        // Curated thumbnails, better quality than Wikimedia Commons photos
        // for typical music-app use. If it has nothing for this artist we
        // fall through to the Wikidata path.
        if let Some(key) = &fanart_api_key {
            match get_fanart_artist_image(&client, &mbid, key) {
                Ok(Some(url)) => {
                    let ext = url_extension(&url).unwrap_or_else(|| "jpg".into());
                    let out: PathBuf = artist_dir.join(format!("{}.{}", safe, ext));
                    match download_url_to_file(&client, &url, &out) {
                        Ok(()) => {
                            if let Err(e) = db.set_artist_image(
                                artist_name,
                                Some(&mbid),
                                &out.display().to_string(),
                            ) {
                                eprintln!("[fanart] db update failed for {}: {}", artist_name, e);
                            } else {
                                found += 1;
                            }
                            // Got a fanart image — done with this artist.
                            continue;
                        }
                        Err(e) => {
                            eprintln!("[fanart] download failed for {}: {} (falling back to Wikidata)", artist_name, e);
                            // Fall through to Wikidata.
                        }
                    }
                }
                Ok(None) => {
                    // No fanart image — fall through to Wikidata.
                }
                Err(e) => {
                    eprintln!("[fanart] api error for {}: {} (falling back to Wikidata)", artist_name, e);
                }
            }
        }

        // ── Tier 2: Wikidata → Wikimedia Commons ────────────────────────
        // Second MB call
        thread::sleep(MB_RATE_LIMIT);
        last_mb_call = Instant::now();

        let qid = match get_wikidata_qid(&client, &mbid) {
            Ok(Some(q)) => q,
            _ => continue,
        };

        let image_filename = match get_wikidata_image(&client, &qid) {
            Ok(Some(f)) => f,
            _ => continue,
        };

        let ext = image_filename
            .rsplit('.')
            .next()
            .map(|s| s.to_ascii_lowercase())
            .filter(|s| matches!(s.as_str(), "jpg" | "jpeg" | "png" | "webp"))
            .unwrap_or_else(|| "jpg".to_string());
        let out: PathBuf = artist_dir.join(format!("{}.{}", safe, ext));

        match download_image(&client, &image_filename, &out) {
            Ok(()) => {
                if let Err(e) =
                    db.set_artist_image(artist_name, Some(&mbid), &out.display().to_string())
                {
                    eprintln!("[mb] db update failed for {}: {}", artist_name, e);
                } else {
                    found += 1;
                }
            }
            Err(e) => eprintln!("[mb] download failed for {}: {}", artist_name, e),
        }
    }

    let _ = app.emit(
        "artist-fetch-progress",
        ArtistFetchProgress {
            processed: total,
            total,
            current_artist: String::new(),
            found,
        },
    );
    eprintln!("[mb] fetched {} of {} artists", found, total);
    Ok(found)
}

fn search_mb_artist(client: &Client, name: &str) -> Result<Option<String>, String> {
    let resp: serde_json::Value = client
        .get("https://musicbrainz.org/ws/2/artist")
        .query(&[
            ("query", format!("artist:\"{}\"", name)),
            ("fmt", "json".into()),
            ("limit", "1".into()),
        ])
        .send()
        .map_err(|e| e.to_string())?
        .json()
        .map_err(|e| e.to_string())?;
    Ok(resp["artists"][0]["id"].as_str().map(String::from))
}

fn get_wikidata_qid(client: &Client, mbid: &str) -> Result<Option<String>, String> {
    let url = format!("https://musicbrainz.org/ws/2/artist/{}", mbid);
    let resp: serde_json::Value = client
        .get(&url)
        .query(&[("inc", "url-rels"), ("fmt", "json")])
        .send()
        .map_err(|e| e.to_string())?
        .json()
        .map_err(|e| e.to_string())?;
    if let Some(relations) = resp["relations"].as_array() {
        for rel in relations {
            if rel["type"] == "wikidata" {
                if let Some(url) = rel["url"]["resource"].as_str() {
                    if let Some(qid) = url.rsplit('/').next() {
                        return Ok(Some(qid.to_string()));
                    }
                }
            }
        }
    }
    Ok(None)
}

fn get_wikidata_image(client: &Client, qid: &str) -> Result<Option<String>, String> {
    let url = format!("https://www.wikidata.org/wiki/Special:EntityData/{}.json", qid);
    let resp: serde_json::Value = client
        .get(&url)
        .send()
        .map_err(|e| e.to_string())?
        .json()
        .map_err(|e| e.to_string())?;
    let filename = resp["entities"][qid]["claims"]["P18"][0]["mainsnak"]["datavalue"]["value"]
        .as_str()
        .map(String::from);
    Ok(filename)
}

// fanart.tv: query /v3/music/{mbid}?api_key={key}. Returns the first
// artistthumb URL if any, else None. 404 from fanart.tv just means "no images
// for this artist" (very common for indie / obscure artists), not an error.
fn get_fanart_artist_image(client: &Client, mbid: &str, api_key: &str) -> Result<Option<String>, String> {
    let url = format!("https://webservice.fanart.tv/v3/music/{}", mbid);
    let resp = client
        .get(&url)
        .query(&[("api_key", api_key)])
        .send()
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !status.is_success() {
        return Err(format!("HTTP {}", status));
    }
    let json: serde_json::Value = resp.json().map_err(|e| e.to_string())?;
    // Prefer the first artistthumb (square ~1000×1000 portrait). If none,
    // fall back to the first artistbackground (wider landscape).
    let url = json["artistthumb"][0]["url"]
        .as_str()
        .or_else(|| json["artistbackground"][0]["url"].as_str())
        .map(String::from);
    Ok(url)
}

// Generic: GET url, downscale to ≤512 px, save as JPEG. Used for fanart.tv
// URLs (direct CDN links to JPG/PNG/WebP) and any other source where we want
// to bound the on-disk and GPU-decode cost. fanart.tv artist thumbs can be
// 1000+ px which is wasteful for a 168-px tile — resize cuts decode cost
// ~25× on low-end hardware.
fn download_url_to_file(client: &Client, url: &str, out: &Path) -> Result<(), String> {
    let bytes = client
        .get(url)
        .send()
        .map_err(|e| e.to_string())?
        .bytes()
        .map_err(|e| e.to_string())?;
    write_thumbnail(&bytes, out)
}

/// Decode `bytes`, resize to fit 512×512 preserving aspect ratio, re-encode
/// as JPEG q=85. On decode failure (unsupported format / corrupt), fall back
/// to dumping the original bytes — better to have a slightly wasteful image
/// than no image at all.
fn write_thumbnail(bytes: &[u8], out: &Path) -> Result<(), String> {
    const THUMB_MAX: u32 = 512;
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
    // Fallback: write the raw bytes.
    std::fs::write(out, bytes).map_err(|e| e.to_string())
}

// Pull a sane file extension out of a URL like
// "https://assets.fanart.tv/.../foo.jpg" — strip query string, lowercase.
fn url_extension(url: &str) -> Option<String> {
    let path = url.split('?').next().unwrap_or(url);
    let ext = path.rsplit('.').next()?.to_ascii_lowercase();
    if matches!(ext.as_str(), "jpg" | "jpeg" | "png" | "webp") { Some(ext) } else { None }
}

fn download_image(client: &Client, filename: &str, out: &Path) -> Result<(), String> {
    // Special:FilePath redirects to the actual file URL on Commons.
    // ?width=512 asks Commons to serve a thumbnail; we still re-encode below
    // to enforce a consistent format and quality across all sources.
    let url = format!(
        "https://commons.wikimedia.org/wiki/Special:FilePath/{}",
        urlencode_path(filename)
    );
    let bytes = client
        .get(&url)
        .query(&[("width", "512")])
        .send()
        .map_err(|e| e.to_string())?
        .bytes()
        .map_err(|e| e.to_string())?;
    write_thumbnail(&bytes, out)
}

fn sanitize_filename(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == ' ' || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = s.trim();
    if trimmed.is_empty() {
        "artist".to_string()
    } else {
        // Cap length so Windows MAX_PATH stays OK.
        trimmed.chars().take(80).collect()
    }
}

// Minimal percent-encoding for path components.
fn urlencode_path(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => {
                out.push_str(&format!("%{:02X}", b));
            }
        }
    }
    out
}
