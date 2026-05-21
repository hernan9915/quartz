use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::thread;
use std::time::{Instant, UNIX_EPOCH};

use crossbeam_channel::{bounded, unbounded};
use lofty::file::{AudioFile, TaggedFileExt};
use lofty::picture::Picture;
use lofty::probe::Probe;
use lofty::tag::{Accessor, ItemKey, Tag};
use rusqlite::Transaction;
use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;

use super::db::{
    LibraryDb, album_has_cover_tx, set_album_cover_tx, upsert_album_tx, upsert_track_tx,
};

const AUDIO_EXTENSIONS: &[&str] = &["flac", "wav", "aiff", "aif", "ogg", "mp3", "m4a"];

/// Max edge length for the on-disk thumbnail. 512 px covers the AlbumGrid
/// (168 px column × 2 for retina = 336) and the AlbumDetail hero (240 px × 2
/// = 480). Anything larger is wasted GPU memory on low-end hardware.
const THUMB_MAX: u32 = 512;

#[derive(serde::Serialize, Clone)]
pub struct ScanProgress {
    pub scanned: usize,
    pub total: usize,
    pub current_path: String,
}

/// Tag/header data extracted by a worker. Picture bytes are stripped into
/// `picture` so the main thread doesn't need to re-open the file to save
/// the cover (it just dumps the bytes to disk after the DB upsert).
struct ImportItem {
    path: PathBuf,
    file_mtime: i64,
    file_size: i64,
    duration: f64,
    sample_rate: Option<i32>,
    bits_per_sample: Option<i32>,
    title: String,
    artist: String,
    album_title: String,
    album_artist: String,
    track_no: Option<i32>,
    disc_no: Option<i32>,
    year: Option<i32>,
    genre: Option<String>,
    picture: Option<PictureData>,
}

struct PictureData {
    /// Already-decoded + re-encoded as JPEG. The worker thread handles the
    /// resize so the main thread only does the disk write.
    jpeg_bytes: Vec<u8>,
}

pub fn scan_folder(
    db: &Arc<LibraryDb>,
    folder: &Path,
    artwork_dir: &Path,
    app: &AppHandle,
) -> Result<usize, String> {
    let start = Instant::now();
    std::fs::create_dir_all(artwork_dir).map_err(|e| e.to_string())?;

    // Walk the tree first (cheap, single-threaded — just metadata).
    let files: Vec<PathBuf> = WalkDir::new(folder)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter(|e| {
            e.path()
                .extension()
                .and_then(|x| x.to_str())
                .map(|x| AUDIO_EXTENSIONS.contains(&x.to_ascii_lowercase().as_str()))
                .unwrap_or(false)
        })
        .map(|e| e.into_path())
        .collect();

    let total = files.len();
    eprintln!("[scan] found {} audio files under {}", total, folder.display());

    // Delta-scan fingerprints: pull `path → (mtime, size)` for every track
    // already in the DB. Any walked file whose (mtime, size) matches the DB
    // is skipped entirely — no tag read, no DB write, no thumbnail decode.
    // Re-scans drop from minutes to seconds for an unchanged library.
    let fingerprints = db.fingerprint_map().unwrap_or_default();
    eprintln!("[scan] {} tracks already indexed (delta-scan candidates)", fingerprints.len());

    // Stat each file once on the main thread and split into two sets:
    //   skipped — fingerprint matches DB, nothing to do
    //   to_read — needs full tag read (new file or modified)
    let mut to_read: Vec<(usize, PathBuf, i64, i64)> = Vec::with_capacity(total);
    let mut skipped = 0usize;
    for (i, p) in files.iter().enumerate() {
        let meta = match std::fs::metadata(p) {
            Ok(m) => m,
            Err(_) => continue, // file disappeared between walk and stat
        };
        let size = meta.len() as i64;
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let path_str = p.display().to_string();
        if let Some(&(old_mt, old_sz)) = fingerprints.get(&path_str) {
            if old_mt == mtime && old_sz == size {
                skipped += 1;
                continue;
            }
        }
        to_read.push((i, p.clone(), mtime, size));
    }
    eprintln!(
        "[scan] delta-scan: skipping {} unchanged, reading {}",
        skipped,
        to_read.len()
    );

    // Parallel tag reading. Worker pool extracts (tags + 512-px thumbnail
    // bytes) for each file. The main thread sees ordered results and writes
    // them to the DB in a single transaction.
    //
    // On low-end hardware the win is big: tag parsing + JPEG decode/encode
    // is CPU-bound, and the workers overlap nicely with the main thread's
    // serial DB writes.
    let n_workers = thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .min(8)
        .max(2);
    eprintln!("[scan] using {} worker threads", n_workers);

    let (work_tx, work_rx) = bounded::<(usize, PathBuf, i64, i64)>(n_workers * 4);
    let (result_tx, result_rx) = unbounded::<(usize, Result<ImportItem, String>)>();

    let mut worker_handles = Vec::with_capacity(n_workers);
    for _ in 0..n_workers {
        let work_rx = work_rx.clone();
        let result_tx = result_tx.clone();
        worker_handles.push(thread::spawn(move || {
            while let Ok((idx, path, mtime, size)) = work_rx.recv() {
                let r = read_one_file(&path, mtime, size);
                if result_tx.send((idx, r)).is_err() {
                    break;
                }
            }
        }));
    }
    drop(work_rx);
    drop(result_tx);

    let to_read_for_feeder = to_read.clone();
    let feeder = thread::spawn(move || {
        for (idx, path, mtime, size) in to_read_for_feeder {
            if work_tx.send((idx, path, mtime, size)).is_err() {
                break;
            }
        }
        drop(work_tx);
    });

    let mut conn = db.lock();
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    let mut imported = skipped; // skipped tracks count as "imported" (still in DB)
    let mut last_emit = Instant::now();
    let mut covers_seen: HashSet<i64> = HashSet::new();

    // Map original walk-index → result so we can write in walk order (keeps
    // cover-art "first-wins" deterministic).
    let mut pending: HashMap<usize, Result<ImportItem, String>> = HashMap::new();
    let mut received_in_set = 0usize;
    let to_read_set: HashMap<usize, ()> = to_read.iter().map(|(i, _, _, _)| (*i, ())).collect();
    let to_read_total = to_read.len();
    let mut next_walk_idx = 0usize;

    while received_in_set < to_read_total {
        let (idx, r) = match result_rx.recv() {
            Ok(v) => v,
            Err(_) => break,
        };
        pending.insert(idx, r);
        received_in_set += 1;

        // Drain in walk order. For each walk index `next_walk_idx`, either:
        //   - It was skipped (delta match) → nothing to do
        //   - It was queued and has now arrived → process and remove
        //   - It was queued but hasn't arrived yet → stop draining
        while next_walk_idx < total {
            let path = &files[next_walk_idx];
            if !to_read_set.contains_key(&next_walk_idx) {
                // Skipped file — already counted in `imported`, just advance.
                next_walk_idx += 1;
                continue;
            }
            let Some(slot) = pending.remove(&next_walk_idx) else { break; };
            match slot {
                Ok(item) => {
                    if let Err(e) = write_item(&tx, item, artwork_dir, &mut covers_seen) {
                        eprintln!("[scan] skip {} — {}", path.display(), e);
                    } else {
                        imported += 1;
                    }
                }
                Err(e) => eprintln!("[scan] skip {} — {}", path.display(), e),
            }
            next_walk_idx += 1;

            if last_emit.elapsed().as_millis() >= 100 || next_walk_idx == total {
                let _ = app.emit(
                    "library-scan-progress",
                    ScanProgress {
                        scanned: next_walk_idx,
                        total,
                        current_path: path.display().to_string(),
                    },
                );
                last_emit = Instant::now();
            }
        }
    }

    // Flush trailing skipped files (anything after the last queued read).
    while next_walk_idx < total {
        next_walk_idx += 1;
        if last_emit.elapsed().as_millis() >= 100 || next_walk_idx == total {
            let _ = app.emit(
                "library-scan-progress",
                ScanProgress {
                    scanned: next_walk_idx,
                    total,
                    current_path: String::new(),
                },
            );
            last_emit = Instant::now();
        }
    }

    tx.commit().map_err(|e| e.to_string())?;

    let _ = feeder.join();
    for h in worker_handles {
        let _ = h.join();
    }

    eprintln!(
        "[scan] imported {}/{} ({} skipped) in {:.1}s",
        imported,
        total,
        skipped,
        start.elapsed().as_secs_f32()
    );
    Ok(imported)
}

/// Re-import a single file into the library — used after a tag edit so
/// the DB row and any album-row reassignment (e.g. when the user changes
/// the track's album) stay in sync with what's on disk.
///
/// Re-uses the exact same code path as the bulk scanner so behaviour is
/// guaranteed identical: re-read tags, re-decode + write the cover
/// thumbnail if the new album doesn't have one yet, upsert album + track.
pub fn reimport_file(
    db: &Arc<LibraryDb>,
    path: &Path,
    artwork_dir: &Path,
) -> Result<(), String> {
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let size = meta.len() as i64;

    let item = read_one_file(path, mtime, size)?;

    let mut conn = db.lock();
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut covers_seen: HashSet<i64> = HashSet::new();
    write_item(&tx, item, artwork_dir, &mut covers_seen)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Worker function: open one file, extract everything we need (tags +
/// downscaled-thumbnail bytes). Runs on worker threads — never touches the DB.
fn read_one_file(path: &Path, file_mtime: i64, file_size: i64) -> Result<ImportItem, String> {
    let tagged = Probe::open(path)
        .map_err(|e| e.to_string())?
        .read()
        .map_err(|e| e.to_string())?;

    let props = tagged.properties();
    let duration = props.duration().as_secs_f64();
    let sample_rate = props.sample_rate().map(|x| x as i32);
    let bits_per_sample = props.bit_depth().map(|x| x as i32);

    let tag = tagged.primary_tag().or_else(|| tagged.first_tag());

    let (title, artist, album_title, album_artist, track_no, disc_no, year, genre, picture) =
        match tag {
            Some(t) => extract_tag_fields(t),
            None => (None, None, None, None, None, None, None, None, None),
        };

    let fallback_title = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Unknown")
        .to_string();
    let fallback_album = path
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|s| s.to_str())
        .unwrap_or("Unknown Album")
        .to_string();
    let fallback_artist = path
        .parent()
        .and_then(|p| p.parent())
        .and_then(|p| p.file_name())
        .and_then(|s| s.to_str())
        .unwrap_or("Unknown Artist")
        .to_string();

    let title = title.unwrap_or(fallback_title);
    let artist = artist.unwrap_or_else(|| fallback_artist.clone());
    let album_title = album_title.unwrap_or(fallback_album);
    let album_artist = album_artist.unwrap_or_else(|| artist.clone());

    Ok(ImportItem {
        path: path.to_path_buf(),
        file_mtime,
        file_size,
        duration,
        sample_rate,
        bits_per_sample,
        title,
        artist,
        album_title,
        album_artist,
        track_no,
        disc_no,
        year,
        genre,
        picture,
    })
}

/// Main thread: take a worker's ImportItem and commit it to the DB.
fn write_item(
    tx: &Transaction,
    item: ImportItem,
    artwork_dir: &Path,
    covers_seen: &mut HashSet<i64>,
) -> Result<(), String> {
    let album_id = upsert_album_tx(
        tx,
        &item.album_title,
        &item.album_artist,
        item.year,
        item.genre.as_deref(),
    )?;

    if !covers_seen.contains(&album_id) {
        covers_seen.insert(album_id);
        if let Some(pic) = item.picture {
            if !album_has_cover_tx(tx, album_id).unwrap_or(false) {
                // Workers have already resized to 512 px and re-encoded as JPEG,
                // so this is just a single small file write.
                let out = artwork_dir.join(format!("album-{}.jpg", album_id));
                if std::fs::write(&out, &pic.jpeg_bytes).is_ok() {
                    let _ = set_album_cover_tx(tx, album_id, &out.display().to_string());
                }
            }
        }
    }

    upsert_track_tx(
        tx,
        album_id,
        &item.path.display().to_string(),
        &item.title,
        &item.artist,
        item.track_no,
        item.disc_no,
        Some(item.duration),
        item.sample_rate,
        item.bits_per_sample,
        Some(item.file_mtime),
        Some(item.file_size),
    )?;

    Ok(())
}

fn extract_tag_fields(
    t: &Tag,
) -> (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<i32>,
    Option<i32>,
    Option<i32>,
    Option<String>,
    Option<PictureData>,
) {
    let pic = t.pictures().first().and_then(picture_to_thumbnail);
    (
        t.title().map(|c| c.to_string()),
        t.artist().map(|c| c.to_string()),
        t.album().map(|c| c.to_string()),
        t.get_string(&ItemKey::AlbumArtist).map(|s| s.to_string()),
        t.track().map(|n| n as i32),
        t.disk().map(|n| n as i32),
        t.year().map(|y| y as i32),
        t.genre().map(|c| c.to_string()),
        pic,
    )
}

/// Decode the embedded artwork and resize it to fit within
/// `THUMB_MAX × THUMB_MAX`, then re-encode as JPEG quality ~85. Returns
/// `None` if decode fails (e.g. a corrupt or unsupported PNG variant), in
/// which case the album simply ends up without a cover — better than crashing
/// the scan or saving multi-megabyte originals.
///
/// Why this matters on low-end hardware: embedded art is often 1000–3000 px
/// JPEG (~0.5–2 MB). Even with `loading="lazy"`, decoding 50+ of those into
/// the AlbumGrid viewport spikes the GPU. 512-px thumbs decode ~25× faster
/// and use proportionally less GPU memory.
fn picture_to_thumbnail(pic: &Picture) -> Option<PictureData> {
    let img = image::load_from_memory(pic.data()).ok()?;
    let (w, h) = (img.width(), img.height());
    // image::thumbnail preserves aspect ratio and uses a fast nearest-neighbour
    // pre-pass for huge inputs, so a 3000-px source thumbs in ~10 ms.
    let resized = if w.max(h) > THUMB_MAX {
        img.thumbnail(THUMB_MAX, THUMB_MAX)
    } else {
        img
    };
    // RGB8: strips any alpha channel (JPEG doesn't support it) and matches what
    // the embedded art usually is. This avoids an extra colour-space conversion.
    let rgb = resized.to_rgb8();
    let mut out: Vec<u8> = Vec::with_capacity(64 * 1024);
    let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 85);
    enc.encode(&rgb, rgb.width(), rgb.height(), image::ExtendedColorType::Rgb8)
        .ok()?;
    Some(PictureData { jpeg_bytes: out })
}
