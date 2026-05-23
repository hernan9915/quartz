use rusqlite::{params, Connection, Transaction};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, MutexGuard};

pub struct LibraryDb {
    conn: Mutex<Connection>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LibraryAlbum {
    pub id: i64,
    pub title: String,
    pub artist: String,
    pub year: Option<i32>,
    pub genre: Option<String>,
    pub track_count: i32,
    pub sample_rate: Option<i32>,
    pub bits_per_sample: Option<i32>,
    pub cover_path: Option<String>,
    /// Vibrant color extracted from cover_path, stored as `#rrggbb`. Set
    /// lazily on first play (so we don't churn through 30k albums on
    /// scan); `None` until extracted. The frontend falls back to the
    /// user's chosen accent when this is missing.
    pub accent_color: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LibraryArtist {
    pub name: String,
    pub album_count: i32,
    pub track_count: i32,
    /// Up to 4 cover paths for the composite tile.
    pub cover_paths: Vec<String>,
    /// Fetched artist photo path (from MusicBrainz/Wikidata) if available.
    pub image_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DbPlaylist {
    pub id: i64,
    pub name: String,
    pub description: Option<String>,
    /// 0 = manual, 1 = smart, 2 = ai-generated
    pub kind: i32,
    pub rules_json: Option<String>,
    pub track_count: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct MostPlayedTrack {
    #[serde(flatten)]
    pub track: LibraryTrack,
    pub play_count: i64,
    pub last_played_at: i64,
}

/// Compact track row used only for building the AI-playlist prompt.
pub struct AiTrackRow {
    pub id: i64,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub genre: Option<String>,
    pub bits_per_sample: Option<i32>,
    pub sample_rate: Option<i32>,
    pub duration: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LibraryTrack {
    pub id: i64,
    pub album_id: i64,
    pub track_no: Option<i32>,
    pub disc_no: Option<i32>,
    pub title: String,
    pub artist: String,
    pub duration: Option<f64>,
    pub path: String,
    pub sample_rate: Option<i32>,
    pub bits_per_sample: Option<i32>,
}

impl LibraryDb {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        // WAL gives much better concurrency between scan + read paths.
        let _ = conn.pragma_update(None, "journal_mode", "WAL");
        let _ = conn.pragma_update(None, "synchronous", "NORMAL");
        // Enable FK enforcement so ON DELETE CASCADE works for playlist/favorite
        // cleanup when tracks are removed from the library.
        let _ = conn.pragma_update(None, "foreign_keys", true);
        // Performance pragmas for read-heavy workloads (library views). Default
        // SQLite settings are conservative — a 30k-track library benefits a lot
        // from a bigger page cache and memory-mapped reads.
        //   cache_size = -65536  → 64 MB page cache (negative = KiB)
        //   mmap_size  = 256 MB  → memory-map the DB file; reads avoid syscalls
        //   temp_store = MEMORY  → temp tables (sort scratch etc.) stay in RAM
        let _ = conn.pragma_update(None, "cache_size", -65536_i64);
        let _ = conn.pragma_update(None, "mmap_size", 268_435_456_i64);
        let _ = conn.pragma_update(None, "temp_store", "MEMORY");
        let db = LibraryDb { conn: Mutex::new(conn) };
        db.init_schema()?;
        Ok(db)
    }

    fn init_schema(&self) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS albums (
                id INTEGER PRIMARY KEY,
                title TEXT NOT NULL,
                artist TEXT NOT NULL,
                year INTEGER,
                genre TEXT,
                cover_path TEXT,
                /* Vibrant accent extracted from the cover, stored as #rrggbb.
                   Populated lazily on first play (avoids churning 30k+ rows
                   during initial scan). NULL means "not extracted yet". */
                accent_color TEXT,
                UNIQUE(title, artist)
            );

            CREATE TABLE IF NOT EXISTS tracks (
                id INTEGER PRIMARY KEY,
                album_id INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
                path TEXT NOT NULL UNIQUE,
                title TEXT NOT NULL,
                artist TEXT NOT NULL,
                track_no INTEGER,
                disc_no INTEGER,
                duration REAL,
                sample_rate INTEGER,
                bits_per_sample INTEGER,
                replaygain_lufs REAL,
                /* (mtime, size) fingerprint for delta scans: re-scans skip files
                   that match these values, turning a full rescan from minutes
                   into seconds for unchanged libraries. */
                file_mtime INTEGER,
                file_size INTEGER,
                /* Unix-secs timestamp of first import. Used by the "Recently Added"
                   smart view. Never overwritten on re-scan so the order remains
                   stable across library refreshes. */
                added_at INTEGER NOT NULL DEFAULT 0
            );

            CREATE INDEX IF NOT EXISTS idx_tracks_album ON tracks(album_id);
            -- Sort-key indexes for the two heaviest read queries:
            --   list_all_tracks  → ORDER BY t.artist COLLATE NOCASE, t.title COLLATE NOCASE
            --   list_albums      → ORDER BY a.artist COLLATE NOCASE, a.year, a.title COLLATE NOCASE
            --   list_albums_by_artist → WHERE a.artist = ?
            -- Without the NOCASE collation in the index, SQLite has to build a
            -- temp B-tree on every call. These indexes turn that into a pre-sorted scan.
            CREATE INDEX IF NOT EXISTS idx_tracks_artist_nocase
              ON tracks(artist COLLATE NOCASE, title COLLATE NOCASE);
            CREATE INDEX IF NOT EXISTS idx_albums_artist_nocase
              ON albums(artist COLLATE NOCASE, year, title COLLATE NOCASE);

            CREATE TABLE IF NOT EXISTS artist_images (
                name TEXT PRIMARY KEY,
                mb_id TEXT,
                image_path TEXT,
                fetched_at INTEGER
            );

            CREATE TABLE IF NOT EXISTS playlists (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                name        TEXT    NOT NULL,
                description TEXT,
                kind        INTEGER NOT NULL DEFAULT 0,
                rules_json  TEXT,
                created_at  INTEGER NOT NULL DEFAULT 0,
                updated_at  INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS playlist_tracks (
                playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
                track_id    INTEGER NOT NULL REFERENCES tracks(id)    ON DELETE CASCADE,
                position    INTEGER NOT NULL,
                added_at    INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (playlist_id, track_id)
            );

            CREATE INDEX IF NOT EXISTS idx_pl_tracks ON playlist_tracks(playlist_id, position);

            CREATE TABLE IF NOT EXISTS favorite_tracks (
                track_id    INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
                favorited_at INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS track_plays (
                id        INTEGER PRIMARY KEY AUTOINCREMENT,
                track_id  INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
                played_at INTEGER NOT NULL DEFAULT 0
            );

            CREATE INDEX IF NOT EXISTS idx_plays_track ON track_plays(track_id);
            CREATE INDEX IF NOT EXISTS idx_plays_time  ON track_plays(played_at);

            -- Registered library roots. Phase 16: multi-folder support.
            -- The actual scan logic doesn't care about this table — it just
            -- iterates over the rows on rescan-all and registers each path
            -- with the file watcher. Single-folder migrations from the old
            -- JS-side trackedFolders list happen lazily on first add_folder.
            CREATE TABLE IF NOT EXISTS library_folders (
                path TEXT PRIMARY KEY,
                added_at INTEGER NOT NULL DEFAULT 0,
                last_scanned_at INTEGER NOT NULL DEFAULT 0
            );
            "#,
        )
        .map_err(|e| e.to_string())?;

        // Migrations: add columns introduced after the initial schema shipped.
        // CREATE TABLE IF NOT EXISTS doesn't touch existing tables, so any
        // new column needs an explicit ALTER for users who scanned earlier.
        let has_cover_col = conn
            .prepare("SELECT cover_path FROM albums LIMIT 1")
            .is_ok();
        if !has_cover_col {
            conn.execute_batch("ALTER TABLE albums ADD COLUMN cover_path TEXT")
                .map_err(|e| e.to_string())?;
        }

        // Migration: accent_color column added in v0.2.0 for dynamic per-album
        // accents extracted from cover art. NULL is the "not extracted yet"
        // sentinel; populated lazily by extract_album_accent on first play.
        let has_accent_col = conn
            .prepare("SELECT accent_color FROM albums LIMIT 1")
            .is_ok();
        if !has_accent_col {
            conn.execute_batch("ALTER TABLE albums ADD COLUMN accent_color TEXT")
                .map_err(|e| e.to_string())?;
        }

        let has_rg_col = conn
            .prepare("SELECT replaygain_lufs FROM tracks LIMIT 1")
            .is_ok();
        if !has_rg_col {
            conn.execute_batch("ALTER TABLE tracks ADD COLUMN replaygain_lufs REAL")
                .map_err(|e| e.to_string())?;
        }

        let has_mtime_col = conn
            .prepare("SELECT file_mtime FROM tracks LIMIT 1")
            .is_ok();
        if !has_mtime_col {
            conn.execute_batch(
                "ALTER TABLE tracks ADD COLUMN file_mtime INTEGER;
                 ALTER TABLE tracks ADD COLUMN file_size INTEGER;",
            )
            .map_err(|e| e.to_string())?;
        }

        // Migration: added_at for the "Recently Added" smart view. Backfill
        // existing rows with file_mtime (the closest proxy we have) so the
        // first session after upgrade isn't a blank Recently-Added list.
        let has_added_col = conn
            .prepare("SELECT added_at FROM tracks LIMIT 1")
            .is_ok();
        if !has_added_col {
            conn.execute_batch(
                "ALTER TABLE tracks ADD COLUMN added_at INTEGER NOT NULL DEFAULT 0;
                 UPDATE tracks SET added_at = COALESCE(file_mtime, 0) WHERE added_at = 0;",
            )
            .map_err(|e| e.to_string())?;
        }

        // Helper index for the "Recently Added" view. Without this the query
        // does a full-table sort on big libraries.
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_tracks_added_at ON tracks(added_at DESC);",
        )
        .map_err(|e| e.to_string())?;

        // Refresh the query planner stats — cheap, runs in milliseconds, and
        // helps SQLite pick the right index after a new schema shape lands.
        let _ = conn.pragma_update(None, "optimize", 0x10002);

        Ok(())
    }

    /// Borrow the underlying connection for scan-path use.
    /// Caller is expected to wrap multiple writes in a transaction for speed.
    pub fn lock(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock().unwrap()
    }

    /// Wipe all library data. Leaves the schema in place so the next scan
    /// re-populates without needing migrations to run again.
    pub fn wipe(&self) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch(
            "DELETE FROM track_plays;
             DELETE FROM favorite_tracks;
             DELETE FROM playlist_tracks;
             DELETE FROM tracks;
             DELETE FROM albums;
             DELETE FROM artist_images;",
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Wipe just the artist photo cache (DB rows). The actual image files on
    /// disk are cleaned up separately by the caller. Used when the user wants
    /// to re-fetch all artist photos from a different source.
    pub fn wipe_artist_images(&self) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch("DELETE FROM artist_images;")
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn list_albums(&self) -> Result<Vec<LibraryAlbum>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT a.id, a.title, a.artist, a.year, a.genre, a.cover_path,
                        COUNT(t.id),
                        MAX(t.sample_rate), MAX(t.bits_per_sample),
                        a.accent_color
                 FROM albums a
                 LEFT JOIN tracks t ON t.album_id = a.id
                 GROUP BY a.id
                 ORDER BY a.artist COLLATE NOCASE, a.year, a.title COLLATE NOCASE",
            )
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map([], |row| {
                Ok(LibraryAlbum {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    artist: row.get(2)?,
                    year: row.get(3)?,
                    genre: row.get(4)?,
                    cover_path: row.get(5)?,
                    track_count: row.get(6)?,
                    sample_rate: row.get(7)?,
                    bits_per_sample: row.get(8)?,
                    accent_color: row.get(9)?,
                })
            })
            .map_err(|e| e.to_string())?;

        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    /// Read the cached extracted accent for an album. Returns None if the
    /// album doesn't exist OR if extraction hasn't run yet.
    pub fn get_album_accent(&self, album_id: i64) -> Result<Option<String>, String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT accent_color FROM albums WHERE id = ?1",
            params![album_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .map_err(|e| e.to_string())
    }

    /// Store the extracted accent hex (e.g. "#a78b3d") for an album. Pass
    /// None to clear it (e.g. when cover art changes and we want to re-extract).
    pub fn set_album_accent(&self, album_id: i64, accent: Option<&str>) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE albums SET accent_color = ?1 WHERE id = ?2",
            params![accent, album_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Look up the cover path for an album. Used by extract_album_accent
    /// to know which file to read for color extraction.
    pub fn get_album_cover_path(&self, album_id: i64) -> Result<Option<String>, String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT cover_path FROM albums WHERE id = ?1",
            params![album_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .map_err(|e| e.to_string())
    }

    pub fn list_artists(&self) -> Result<Vec<LibraryArtist>, String> {
        let conn = self.conn.lock().unwrap();

        // Album / cover info per artist
        let mut stmt = conn
            .prepare("SELECT artist, id, cover_path FROM albums ORDER BY artist COLLATE NOCASE, id")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?;

        use std::collections::HashMap;
        let mut by_artist: HashMap<String, (i32, Vec<String>)> = HashMap::new();
        for r in rows {
            let (artist, _id, cover) = r.map_err(|e| e.to_string())?;
            let entry = by_artist.entry(artist).or_insert((0, Vec::new()));
            entry.0 += 1;
            if let Some(c) = cover {
                if entry.1.len() < 4 {
                    entry.1.push(c);
                }
            }
        }

        // Track counts per artist
        let mut stmt2 = conn
            .prepare(
                "SELECT a.artist, COUNT(t.id)
                 FROM albums a
                 LEFT JOIN tracks t ON t.album_id = a.id
                 GROUP BY a.artist",
            )
            .map_err(|e| e.to_string())?;
        let track_counts: HashMap<String, i32> = stmt2
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i32>(1)?))
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        // Fetched artist images
        let mut stmt3 = conn
            .prepare("SELECT name, image_path FROM artist_images WHERE image_path IS NOT NULL")
            .map_err(|e| e.to_string())?;
        let images: HashMap<String, String> = stmt3
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        let mut artists: Vec<LibraryArtist> = by_artist
            .into_iter()
            .map(|(name, (album_count, cover_paths))| LibraryArtist {
                track_count: *track_counts.get(&name).unwrap_or(&0),
                image_path: images.get(&name).cloned(),
                name,
                album_count,
                cover_paths,
            })
            .collect();
        artists.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        Ok(artists)
    }

    /// All artists in the library that don't yet have an image saved.
    /// Albums whose `cover_path` is NULL — i.e. the scan didn't find any
     /// embedded art. Returned as (id, title, artist) tuples for the
     /// Cover Art Archive fetcher.
    pub fn list_albums_needing_cover(&self) -> Result<Vec<(i64, String, String)>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, title, artist FROM albums
                 WHERE cover_path IS NULL OR cover_path = ''",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            )))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    /// Set `cover_path` for an album. Used by the Cover Art Archive fetcher
    /// to fill in missing embedded art. Also clears `accent_color` because
    /// the previously extracted accent was based on the old cover (or no
    /// cover at all) and is now stale — next play will re-extract.
    pub fn set_album_cover(&self, album_id: i64, cover_path: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE albums SET cover_path = ?1, accent_color = NULL WHERE id = ?2",
            params![cover_path, album_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn list_artists_needing_image(&self) -> Result<Vec<String>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT DISTINCT a.artist
                 FROM albums a
                 LEFT JOIN artist_images ai ON ai.name = a.artist
                 WHERE ai.image_path IS NULL
                 ORDER BY a.artist COLLATE NOCASE",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn set_artist_image(&self, name: &str, mb_id: Option<&str>, image_path: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        conn.execute(
            "INSERT INTO artist_images (name, mb_id, image_path, fetched_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(name) DO UPDATE SET
                mb_id = COALESCE(?2, mb_id),
                image_path = ?3,
                fetched_at = ?4",
            params![name, mb_id, image_path, now],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn list_albums_by_artist(&self, artist: &str) -> Result<Vec<LibraryAlbum>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT a.id, a.title, a.artist, a.year, a.genre, a.cover_path,
                        COUNT(t.id),
                        MAX(t.sample_rate), MAX(t.bits_per_sample),
                        a.accent_color
                 FROM albums a
                 LEFT JOIN tracks t ON t.album_id = a.id
                 WHERE a.artist = ?1
                 GROUP BY a.id
                 ORDER BY a.year, a.title COLLATE NOCASE",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![artist], |row| {
                Ok(LibraryAlbum {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    artist: row.get(2)?,
                    year: row.get(3)?,
                    genre: row.get(4)?,
                    cover_path: row.get(5)?,
                    track_count: row.get(6)?,
                    sample_rate: row.get(7)?,
                    bits_per_sample: row.get(8)?,
                    accent_color: row.get(9)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn list_tracks(&self, album_id: i64) -> Result<Vec<LibraryTrack>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, album_id, track_no, disc_no, title, artist, duration, path, sample_rate, bits_per_sample
                 FROM tracks WHERE album_id = ?1
                 ORDER BY disc_no, track_no, title COLLATE NOCASE",
            )
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map(params![album_id], |row| {
                Ok(LibraryTrack {
                    id: row.get(0)?,
                    album_id: row.get(1)?,
                    track_no: row.get(2)?,
                    disc_no: row.get(3)?,
                    title: row.get(4)?,
                    artist: row.get(5)?,
                    duration: row.get(6)?,
                    path: row.get(7)?,
                    sample_rate: row.get(8)?,
                    bits_per_sample: row.get(9)?,
                })
            })
            .map_err(|e| e.to_string())?;

        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    /// Return every track in the library. For large libraries (30k+ rows)
    /// the frontend should virtualize the resulting list.
    pub fn list_all_tracks(&self) -> Result<Vec<LibraryTrack>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT t.id, t.album_id, t.track_no, t.disc_no, t.title, t.artist,
                        t.duration, t.path, t.sample_rate, t.bits_per_sample
                 FROM tracks t
                 ORDER BY t.artist COLLATE NOCASE, t.title COLLATE NOCASE",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(LibraryTrack {
                    id: row.get(0)?,
                    album_id: row.get(1)?,
                    track_no: row.get(2)?,
                    disc_no: row.get(3)?,
                    title: row.get(4)?,
                    artist: row.get(5)?,
                    duration: row.get(6)?,
                    path: row.get(7)?,
                    sample_rate: row.get(8)?,
                    bits_per_sample: row.get(9)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    // ── Playlists ────────────────────────────────────────────────────

    pub fn create_playlist(
        &self,
        name: &str,
        description: Option<&str>,
        kind: i32,
        rules_json: Option<&str>,
    ) -> Result<i64, String> {
        let conn = self.conn.lock().unwrap();
        let now = now_secs();
        conn.execute(
            "INSERT INTO playlists (name, description, kind, rules_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![name, description, kind, rules_json, now],
        )
        .map_err(|e| e.to_string())?;
        Ok(conn.last_insert_rowid())
    }

    pub fn delete_playlist(&self, id: i64) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM playlists WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn rename_playlist(
        &self,
        id: i64,
        name: &str,
        description: Option<&str>,
    ) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE playlists SET name = ?1, description = ?2, updated_at = ?3 WHERE id = ?4",
            params![name, description, now_secs(), id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn list_playlists(&self) -> Result<Vec<DbPlaylist>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT p.id, p.name, p.description, p.kind, p.rules_json,
                        p.created_at, p.updated_at,
                        COALESCE(COUNT(pt.track_id), 0) AS track_count
                 FROM playlists p
                 LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
                 GROUP BY p.id
                 ORDER BY p.updated_at DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(DbPlaylist {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    description: row.get(2)?,
                    kind: row.get(3)?,
                    rules_json: row.get(4)?,
                    created_at: row.get(5)?,
                    updated_at: row.get(6)?,
                    track_count: row.get(7)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn get_playlist_tracks(&self, playlist_id: i64) -> Result<Vec<LibraryTrack>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT t.id, t.album_id, t.track_no, t.disc_no, t.title, t.artist,
                        t.duration, t.path, t.sample_rate, t.bits_per_sample
                 FROM playlist_tracks pt
                 JOIN tracks t ON t.id = pt.track_id
                 WHERE pt.playlist_id = ?1
                 ORDER BY pt.position",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![playlist_id], |row| {
                Ok(LibraryTrack {
                    id: row.get(0)?,
                    album_id: row.get(1)?,
                    track_no: row.get(2)?,
                    disc_no: row.get(3)?,
                    title: row.get(4)?,
                    artist: row.get(5)?,
                    duration: row.get(6)?,
                    path: row.get(7)?,
                    sample_rate: row.get(8)?,
                    bits_per_sample: row.get(9)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    /// Appends tracks to a playlist, skipping any already present.
    /// Returns the number of tracks actually added.
    pub fn add_tracks_to_playlist(
        &self,
        playlist_id: i64,
        track_ids: &[i64],
    ) -> Result<i32, String> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let next_pos: i64 = tx
            .query_row(
                "SELECT COALESCE(MAX(position) + 1, 0) FROM playlist_tracks WHERE playlist_id = ?1",
                params![playlist_id],
                |row| row.get(0),
            )
            .unwrap_or(0);
        let now = now_secs();
        let mut added = 0i32;
        for (i, &tid) in track_ids.iter().enumerate() {
            let n = tx
                .execute(
                    "INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position, added_at)
                     VALUES (?1, ?2, ?3, ?4)",
                    params![playlist_id, tid, next_pos + i as i64, now],
                )
                .map_err(|e| e.to_string())?;
            added += n as i32;
        }
        tx.execute(
            "UPDATE playlists SET updated_at = ?1 WHERE id = ?2",
            params![now, playlist_id],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(added)
    }

    pub fn remove_track_from_playlist(
        &self,
        playlist_id: i64,
        track_id: i64,
    ) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM playlist_tracks WHERE playlist_id = ?1 AND track_id = ?2",
            params![playlist_id, track_id],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE playlists SET updated_at = ?1 WHERE id = ?2",
            params![now_secs(), playlist_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Re-number positions for a playlist to match the given track_id ordering.
    pub fn reorder_playlist_tracks(
        &self,
        playlist_id: i64,
        track_ids: &[i64],
    ) -> Result<(), String> {
        let mut conn = self.conn.lock().unwrap();

        // Read existing added_at timestamps before opening the write transaction.
        // Using explicit drop(stmt) because a ? at end-of-block creates a temporary
        // with extended lifetime that outlives the block, keeping the borrow alive.
        let mut stmt = conn
            .prepare("SELECT track_id, added_at FROM playlist_tracks WHERE playlist_id = ?1")
            .map_err(|e| e.to_string())?;
        let added_ats: HashMap<i64, i64> = stmt
            .query_map(params![playlist_id], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        drop(stmt); // release borrow on conn before mutable transaction() call

        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute(
            "DELETE FROM playlist_tracks WHERE playlist_id = ?1",
            params![playlist_id],
        )
        .map_err(|e| e.to_string())?;
        let now = now_secs();
        for (pos, &tid) in track_ids.iter().enumerate() {
            let added_at = added_ats.get(&tid).copied().unwrap_or(now);
            tx.execute(
                "INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position, added_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![playlist_id, tid, pos as i64, added_at],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.execute(
            "UPDATE playlists SET updated_at = ?1 WHERE id = ?2",
            params![now, playlist_id],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn eval_smart_playlist(&self, rules_json: &str) -> Result<Vec<LibraryTrack>, String> {
        let rules: SmartRules = serde_json::from_str(rules_json)
            .map_err(|e| format!("Invalid smart playlist rules: {e}"))?;
        let needs_plays = rules.conditions.iter().any(|c| c.field == "play_count");
        let mut sql = String::from(
            "SELECT t.id, t.album_id, t.track_no, t.disc_no, t.title, t.artist,
                    t.duration, t.path, t.sample_rate, t.bits_per_sample
             FROM tracks t
             LEFT JOIN albums a ON a.id = t.album_id",
        );
        if needs_plays {
            sql.push_str(
                " LEFT JOIN (SELECT track_id, COUNT(*) AS play_count \
                             FROM track_plays GROUP BY track_id) p ON p.track_id = t.id",
            );
        }
        let clauses: Vec<String> =
            rules.conditions.iter().filter_map(smart_cond_sql).collect();
        if !clauses.is_empty() {
            let join = if rules.match_mode == "any" { " OR " } else { " AND " };
            sql.push_str(" WHERE ");
            sql.push_str(&clauses.join(join));
        }
        match rules.sort.as_str() {
            "random"     => sql.push_str(" ORDER BY RANDOM()"),
            "title"      => sql.push_str(" ORDER BY t.title COLLATE NOCASE"),
            "year"       => sql.push_str(" ORDER BY a.year DESC"),
            "play_count" => sql.push_str(" ORDER BY COALESCE(p.play_count,0) DESC"),
            _            => sql.push_str(" ORDER BY t.artist COLLATE NOCASE, t.title COLLATE NOCASE"),
        }
        if let Some(lim) = rules.limit {
            sql.push_str(&format!(" LIMIT {lim}"));
        }
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(LibraryTrack {
                    id: row.get(0)?,
                    album_id: row.get(1)?,
                    track_no: row.get(2)?,
                    disc_no: row.get(3)?,
                    title: row.get(4)?,
                    artist: row.get(5)?,
                    duration: row.get(6)?,
                    path: row.get(7)?,
                    sample_rate: row.get(8)?,
                    bits_per_sample: row.get(9)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    // ── Favorites ────────────────────────────────────────────────────

    /// Toggles favorite status. Returns `true` if the track is now favorited.
    pub fn toggle_favorite_track(&self, track_id: i64) -> Result<bool, String> {
        let conn = self.conn.lock().unwrap();
        let exists: bool = conn
            .query_row(
                "SELECT 1 FROM favorite_tracks WHERE track_id = ?1",
                params![track_id],
                |_| Ok(true),
            )
            .unwrap_or(false);
        if exists {
            conn.execute(
                "DELETE FROM favorite_tracks WHERE track_id = ?1",
                params![track_id],
            )
            .map_err(|e| e.to_string())?;
            Ok(false)
        } else {
            conn.execute(
                "INSERT INTO favorite_tracks (track_id, favorited_at) VALUES (?1, ?2)",
                params![track_id, now_secs()],
            )
            .map_err(|e| e.to_string())?;
            Ok(true)
        }
    }

    pub fn get_favorite_track_ids(&self) -> Result<Vec<i64>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT track_id FROM favorite_tracks ORDER BY favorited_at DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<_, i64>(0))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn get_favorite_tracks(&self) -> Result<Vec<LibraryTrack>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT t.id, t.album_id, t.track_no, t.disc_no, t.title, t.artist,
                        t.duration, t.path, t.sample_rate, t.bits_per_sample
                 FROM favorite_tracks ft
                 JOIN tracks t ON t.id = ft.track_id
                 ORDER BY ft.favorited_at DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(LibraryTrack {
                    id: row.get(0)?,
                    album_id: row.get(1)?,
                    track_no: row.get(2)?,
                    disc_no: row.get(3)?,
                    title: row.get(4)?,
                    artist: row.get(5)?,
                    duration: row.get(6)?,
                    path: row.get(7)?,
                    sample_rate: row.get(8)?,
                    bits_per_sample: row.get(9)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    // ── Play history ─────────────────────────────────────────────────

    pub fn log_play(&self, track_id: i64) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO track_plays (track_id, played_at) VALUES (?1, ?2)",
            params![track_id, now_secs()],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_most_played(&self, limit: i64) -> Result<Vec<MostPlayedTrack>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT t.id, t.album_id, t.track_no, t.disc_no, t.title, t.artist,
                        t.duration, t.path, t.sample_rate, t.bits_per_sample,
                        COUNT(tp.id) AS play_count, MAX(tp.played_at) AS last_played_at
                 FROM tracks t
                 JOIN track_plays tp ON tp.track_id = t.id
                 GROUP BY t.id
                 ORDER BY play_count DESC, last_played_at DESC
                 LIMIT ?1",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![limit], |row| {
                Ok(MostPlayedTrack {
                    track: LibraryTrack {
                        id: row.get(0)?,
                        album_id: row.get(1)?,
                        track_no: row.get(2)?,
                        disc_no: row.get(3)?,
                        title: row.get(4)?,
                        artist: row.get(5)?,
                        duration: row.get(6)?,
                        path: row.get(7)?,
                        sample_rate: row.get(8)?,
                        bits_per_sample: row.get(9)?,
                    },
                    play_count: row.get(10)?,
                    last_played_at: row.get(11)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    // ── Phase 25: aggregated listening stats ──────────────────────────

    /// Composite stats query. Computes everything the Stats page needs in
    /// a single call — eight small SELECTs that all hit the
    /// `idx_plays_time` / `idx_plays_track` indexes, so a 50k-play library
    /// returns in well under 50 ms.
    pub fn get_listening_stats(&self) -> Result<ListeningStats, String> {
        let conn = self.conn.lock().unwrap();
        let now = now_secs();
        let week_ago  = now - 7  * 86400;
        let month_ago = now - 30 * 86400;

        // ── Hero counters ────────────────────────────────────────────
        let total_plays: i64 = conn
            .query_row("SELECT COUNT(*) FROM track_plays", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;

        // Sum duration × play count per track. SQLite handles the join in
        // one pass thanks to the foreign key index.
        let total_seconds: f64 = conn
            .query_row(
                "SELECT COALESCE(SUM(t.duration), 0)
                 FROM track_plays tp
                 JOIN tracks t ON t.id = tp.track_id",
                [],
                |r| r.get::<_, f64>(0),
            )
            .map_err(|e| e.to_string())?;

        let plays_last_7d: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM track_plays WHERE played_at >= ?1",
                params![week_ago],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        let plays_last_30d: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM track_plays WHERE played_at >= ?1",
                params![month_ago],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        let unique_tracks: i64 = conn
            .query_row(
                "SELECT COUNT(DISTINCT track_id) FROM track_plays",
                [],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        let unique_artists: i64 = conn
            .query_row(
                "SELECT COUNT(DISTINCT t.artist)
                 FROM track_plays tp JOIN tracks t ON t.id = tp.track_id",
                [],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;

        // ── Plays per day, last 30 days ──────────────────────────────
        // Bucket by UTC midnight. The UI labels them by date in JS so we
        // don't worry about local-time conversion here. Returns up to 30
        // rows; days with zero plays are missing — the UI fills them in.
        let mut plays_per_day: Vec<DayCount> = Vec::with_capacity(30);
        {
            let mut stmt = conn
                .prepare(
                    "SELECT (played_at / 86400) AS day, COUNT(*)
                     FROM track_plays
                     WHERE played_at >= ?1
                     GROUP BY day
                     ORDER BY day",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![month_ago], |r| {
                    Ok(DayCount {
                        day_epoch: r.get::<_, i64>(0)? * 86400,
                        count: r.get(1)?,
                    })
                })
                .map_err(|e| e.to_string())?;
            for r in rows {
                plays_per_day.push(r.map_err(|e| e.to_string())?);
            }
        }

        // ── By hour of day (UTC) — 24-bucket histogram ──────────────
        let mut by_hour = [0i64; 24];
        {
            let mut stmt = conn
                .prepare(
                    "SELECT ((played_at / 3600) % 24) AS hr, COUNT(*)
                     FROM track_plays GROUP BY hr",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))
                .map_err(|e| e.to_string())?;
            for r in rows {
                let (hr, c) = r.map_err(|e| e.to_string())?;
                if (0..24).contains(&hr) {
                    by_hour[hr as usize] = c;
                }
            }
        }

        // ── By weekday — 7-bucket histogram (0 = Thursday because the
        // Unix epoch starts on a Thursday; the UI re-labels). We use a
        // simple `(day_of_epoch + 4) % 7` to get Sunday-first. ────────
        let mut by_weekday = [0i64; 7];
        {
            let mut stmt = conn
                .prepare(
                    "SELECT (((played_at / 86400) + 4) % 7) AS wd, COUNT(*)
                     FROM track_plays GROUP BY wd",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))
                .map_err(|e| e.to_string())?;
            for r in rows {
                let (wd, c) = r.map_err(|e| e.to_string())?;
                if (0..7).contains(&wd) {
                    by_weekday[wd as usize] = c;
                }
            }
        }

        // ── Top 10 artists ──────────────────────────────────────────
        let mut top_artists: Vec<ArtistStat> = Vec::new();
        {
            let mut stmt = conn
                .prepare(
                    "SELECT t.artist, COUNT(*) AS plays
                     FROM track_plays tp JOIN tracks t ON t.id = tp.track_id
                     GROUP BY t.artist
                     ORDER BY plays DESC, t.artist COLLATE NOCASE
                     LIMIT 10",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |r| {
                    Ok(ArtistStat {
                        name: r.get(0)?,
                        play_count: r.get(1)?,
                    })
                })
                .map_err(|e| e.to_string())?;
            for r in rows {
                top_artists.push(r.map_err(|e| e.to_string())?);
            }
        }

        // ── Top 10 albums ───────────────────────────────────────────
        let mut top_albums: Vec<AlbumStat> = Vec::new();
        {
            let mut stmt = conn
                .prepare(
                    "SELECT a.id, a.title, a.artist, a.cover_path, COUNT(*) AS plays
                     FROM track_plays tp
                     JOIN tracks t ON t.id = tp.track_id
                     JOIN albums a ON a.id = t.album_id
                     GROUP BY a.id
                     ORDER BY plays DESC
                     LIMIT 10",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |r| {
                    Ok(AlbumStat {
                        id: r.get(0)?,
                        title: r.get(1)?,
                        artist: r.get(2)?,
                        cover_path: r.get(3)?,
                        play_count: r.get(4)?,
                    })
                })
                .map_err(|e| e.to_string())?;
            for r in rows {
                top_albums.push(r.map_err(|e| e.to_string())?);
            }
        }

        Ok(ListeningStats {
            total_plays,
            total_seconds,
            plays_last_7d,
            plays_last_30d,
            unique_tracks,
            unique_artists,
            plays_per_day,
            by_hour,
            by_weekday,
            top_artists,
            top_albums,
        })
    }

    pub fn get_recently_played(&self, limit: i64) -> Result<Vec<LibraryTrack>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT t.id, t.album_id, t.track_no, t.disc_no, t.title, t.artist,
                        t.duration, t.path, t.sample_rate, t.bits_per_sample
                 FROM tracks t
                 JOIN (SELECT track_id, MAX(played_at) AS last_play
                       FROM track_plays GROUP BY track_id) lp ON lp.track_id = t.id
                 ORDER BY lp.last_play DESC
                 LIMIT ?1",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![limit], |row| {
                Ok(LibraryTrack {
                    id: row.get(0)?,
                    album_id: row.get(1)?,
                    track_no: row.get(2)?,
                    disc_no: row.get(3)?,
                    title: row.get(4)?,
                    artist: row.get(5)?,
                    duration: row.get(6)?,
                    path: row.get(7)?,
                    sample_rate: row.get(8)?,
                    bits_per_sample: row.get(9)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    /// Smart view: tracks ordered by import time, newest first. Falls back
    /// to file_mtime for old rows that were imported before the added_at
    /// column existed (migration set that up).
    pub fn get_recently_added(&self, limit: i64) -> Result<Vec<LibraryTrack>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT t.id, t.album_id, t.track_no, t.disc_no, t.title, t.artist,
                        t.duration, t.path, t.sample_rate, t.bits_per_sample
                 FROM tracks t
                 WHERE t.added_at > 0
                 ORDER BY t.added_at DESC
                 LIMIT ?1",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![limit], |row| {
                Ok(LibraryTrack {
                    id: row.get(0)?,
                    album_id: row.get(1)?,
                    track_no: row.get(2)?,
                    disc_no: row.get(3)?,
                    title: row.get(4)?,
                    artist: row.get(5)?,
                    duration: row.get(6)?,
                    path: row.get(7)?,
                    sample_rate: row.get(8)?,
                    bits_per_sample: row.get(9)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    /// Smart view: tracks that have never been logged in track_plays.
    /// Sorted by artist + title for a stable browse order (random would
    /// jump around on every visit, which is annoying).
    pub fn get_never_played(&self, limit: i64) -> Result<Vec<LibraryTrack>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT t.id, t.album_id, t.track_no, t.disc_no, t.title, t.artist,
                        t.duration, t.path, t.sample_rate, t.bits_per_sample
                 FROM tracks t
                 LEFT JOIN track_plays tp ON tp.track_id = t.id
                 WHERE tp.id IS NULL
                 ORDER BY t.artist COLLATE NOCASE, t.title COLLATE NOCASE
                 LIMIT ?1",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![limit], |row| {
                Ok(LibraryTrack {
                    id: row.get(0)?,
                    album_id: row.get(1)?,
                    track_no: row.get(2)?,
                    disc_no: row.get(3)?,
                    title: row.get(4)?,
                    artist: row.get(5)?,
                    duration: row.get(6)?,
                    path: row.get(7)?,
                    sample_rate: row.get(8)?,
                    bits_per_sample: row.get(9)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    // ── Misc lookups ──────────────────────────────────────────────────

    /// Look up a track's file path by ID. Used by the waveform compute
    /// command to find the audio file for a given track row.
    pub fn get_track_path(&self, track_id: i64) -> Result<String, String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT path FROM tracks WHERE id = ?1",
            params![track_id],
            |row| row.get::<_, String>(0),
        )
        .map_err(|e| e.to_string())
    }

    // ── Delta-scan support ────────────────────────────────────────────

    /// Build `path → (mtime, size)` for every existing track. Used by the
    /// scanner to skip files whose fingerprint hasn't changed since the
    /// last scan — orders-of-magnitude faster re-scans on cold caches.
    pub fn fingerprint_map(&self) -> Result<HashMap<String, (i64, i64)>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT path, file_mtime, file_size FROM tracks")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                let path: String = row.get(0)?;
                let mtime: Option<i64> = row.get(1)?;
                let size: Option<i64> = row.get(2)?;
                Ok((path, mtime, size))
            })
            .map_err(|e| e.to_string())?;
        let mut out = HashMap::new();
        for r in rows {
            let (p, m, s) = r.map_err(|e| e.to_string())?;
            // Only include rows where both fields are populated. Pre-delta-scan
            // installs will have NULLs; treat them as "must rescan to backfill".
            if let (Some(mt), Some(sz)) = (m, s) {
                out.insert(p, (mt, sz));
            }
        }
        Ok(out)
    }

    // ── ReplayGain ────────────────────────────────────────────────────

    /// Store the measured integrated loudness (LUFS) for one track.
    pub fn set_track_replaygain(&self, path: &str, lufs: f64) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE tracks SET replaygain_lufs = ?1 WHERE path = ?2",
            params![lufs, path],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Look up the stored LUFS for a track by its file path.
    /// Returns `None` if the track is not in the library or hasn't been scanned.
    pub fn get_track_replaygain_by_path(&self, path: &str) -> Result<Option<f64>, String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT replaygain_lufs FROM tracks WHERE path = ?1",
            params![path],
            |row| row.get::<_, Option<f64>>(0),
        )
        .map_err(|e| e.to_string())
    }

    /// Return (id, path) for every track that has not yet been RG-scanned.
    pub fn list_tracks_missing_replaygain(&self) -> Result<Vec<(i64, String)>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT id, path FROM tracks WHERE replaygain_lufs IS NULL ORDER BY id")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    /// Clear stored LUFS from every track so the user can re-scan fresh.
    pub fn clear_replaygain(&self) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch("UPDATE tracks SET replaygain_lufs = NULL")
            .map_err(|e| e.to_string())
    }

    // ── AI playlist helper ───────────────────────────────────────────

    pub fn list_tracks_for_ai(&self) -> Result<Vec<AiTrackRow>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT t.id, t.title, t.artist, a.title, a.genre,
                        t.bits_per_sample, t.sample_rate, t.duration
                 FROM tracks t
                 JOIN albums a ON a.id = t.album_id
                 ORDER BY RANDOM()",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(AiTrackRow {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    artist: row.get(2)?,
                    album: row.get(3)?,
                    genre: row.get(4)?,
                    bits_per_sample: row.get(5)?,
                    sample_rate: row.get(6)?,
                    duration: row.get(7)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    // ── Library folder management (Phase 16) ───────────────────────────

    /// Return every registered library root, oldest first. The order matches
    /// added_at so the UI list is stable across sessions.
    pub fn list_library_folders(&self) -> Result<Vec<LibraryFolder>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT path, added_at, last_scanned_at FROM library_folders ORDER BY added_at")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(LibraryFolder {
                    path: row.get(0)?,
                    added_at: row.get(1)?,
                    last_scanned_at: row.get(2)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    /// Idempotently add a folder. Returns true if the row was inserted,
    /// false if a row with this path already existed.
    pub fn add_library_folder(&self, path: &str) -> Result<bool, String> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let conn = self.conn.lock().unwrap();
        let changed = conn
            .execute(
                "INSERT OR IGNORE INTO library_folders (path, added_at, last_scanned_at)
                 VALUES (?1, ?2, 0)",
                params![path, now],
            )
            .map_err(|e| e.to_string())?;
        Ok(changed > 0)
    }

    /// Remove a folder from the registered list. Indexed tracks under it
    /// stay in the DB — the user can run a wipe + rescan to evict them.
    pub fn remove_library_folder(&self, path: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM library_folders WHERE path = ?1", params![path])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Stamp last_scanned_at on a folder. Called after each successful scan
    /// so the UI can show "last scanned 2 minutes ago" per folder.
    pub fn mark_folder_scanned(&self, path: &str) -> Result<(), String> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE library_folders SET last_scanned_at = ?1 WHERE path = ?2",
            params![now, path],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }
}

/// One row of library_folders. Exposed to the UI for the folder-management
/// list in Settings.
#[derive(Debug, Clone, Serialize)]
pub struct LibraryFolder {
    pub path: String,
    pub added_at: i64,
    pub last_scanned_at: i64,
}

// ── Phase 25: listening-stats wire types ─────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct DayCount {
    /// Unix-seconds timestamp of the start of the day (UTC midnight).
    pub day_epoch: i64,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ArtistStat {
    pub name: String,
    pub play_count: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct AlbumStat {
    pub id: i64,
    pub title: String,
    pub artist: String,
    pub cover_path: Option<String>,
    pub play_count: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ListeningStats {
    pub total_plays: i64,
    pub total_seconds: f64,
    pub plays_last_7d: i64,
    pub plays_last_30d: i64,
    pub unique_tracks: i64,
    pub unique_artists: i64,
    pub plays_per_day: Vec<DayCount>,
    pub by_hour: [i64; 24],
    pub by_weekday: [i64; 7],
    pub top_artists: Vec<ArtistStat>,
    pub top_albums: Vec<AlbumStat>,
}

// ── Write helpers used by scan (operate on a Transaction) ───────────

pub fn upsert_album_tx(
    tx: &Transaction,
    title: &str,
    artist: &str,
    year: Option<i32>,
    genre: Option<&str>,
) -> Result<i64, String> {
    tx.execute(
        "INSERT INTO albums (title, artist, year, genre) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(title, artist) DO UPDATE SET
            year = COALESCE(?3, year),
            genre = COALESCE(?4, genre)",
        params![title, artist, year, genre],
    )
    .map_err(|e| e.to_string())?;

    tx.query_row(
        "SELECT id FROM albums WHERE title = ?1 AND artist = ?2",
        params![title, artist],
        |row| row.get::<_, i64>(0),
    )
    .map_err(|e| e.to_string())
}

pub fn set_album_cover_tx(tx: &Transaction, album_id: i64, cover_path: &str) -> Result<(), String> {
    tx.execute(
        "UPDATE albums SET cover_path = ?1 WHERE id = ?2 AND cover_path IS NULL",
        params![cover_path, album_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn album_has_cover_tx(tx: &Transaction, album_id: i64) -> Result<bool, String> {
    tx.query_row(
        "SELECT cover_path IS NOT NULL FROM albums WHERE id = ?1",
        params![album_id],
        |row| row.get::<_, bool>(0),
    )
    .map_err(|e| e.to_string())
}

pub fn upsert_track_tx(
    tx: &Transaction,
    album_id: i64,
    path: &str,
    title: &str,
    artist: &str,
    track_no: Option<i32>,
    disc_no: Option<i32>,
    duration: Option<f64>,
    sample_rate: Option<i32>,
    bits_per_sample: Option<i32>,
    file_mtime: Option<i64>,
    file_size: Option<i64>,
) -> Result<(), String> {
    // added_at is set on INSERT (now) and intentionally NOT touched on
    // ON CONFLICT — re-scanning the same file should not reset its "added"
    // timestamp, otherwise Recently Added would surface every track after
    // every rescan.
    let now = now_secs();
    tx.execute(
        "INSERT INTO tracks (album_id, path, title, artist, track_no, disc_no, duration,
                             sample_rate, bits_per_sample, file_mtime, file_size, added_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         ON CONFLICT(path) DO UPDATE SET
            album_id = ?1, title = ?3, artist = ?4,
            track_no = ?5, disc_no = ?6, duration = ?7,
            sample_rate = ?8, bits_per_sample = ?9,
            file_mtime = ?10, file_size = ?11",
        params![album_id, path, title, artist, track_no, disc_no, duration,
                sample_rate, bits_per_sample, file_mtime, file_size, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ── Shared helpers ──────────────────────────────────────────────────

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ── Smart playlist rule engine ──────────────────────────────────────

#[derive(Deserialize)]
struct SmartRules {
    #[serde(default = "smart_default_match")]
    match_mode: String,
    #[serde(default)]
    conditions: Vec<SmartCond>,
    limit: Option<i64>,
    #[serde(default = "smart_default_sort")]
    sort: String,
}

fn smart_default_match() -> String { "all".into() }
fn smart_default_sort() -> String { "artist".into() }

#[derive(Deserialize)]
struct SmartCond {
    field: String,
    op: String,
    value: serde_json::Value,
}

/// Converts a single smart-playlist condition to a SQL fragment.
/// Column names come from a fixed whitelist (no injection risk).
/// String values have single-quotes escaped.
fn smart_cond_sql(cond: &SmartCond) -> Option<String> {
    let col = match cond.field.as_str() {
        "bits_per_sample" => "t.bits_per_sample",
        "sample_rate"     => "t.sample_rate",
        "year"            => "a.year",
        "genre"           => "a.genre",
        "artist"          => "t.artist",
        "play_count"      => "COALESCE(p.play_count, 0)",
        _ => return None,
    };
    let sql_op = match cond.op.as_str() {
        "eq"           => "=",
        "neq"          => "!=",
        "gt"           => ">",
        "gte"          => ">=",
        "lt"           => "<",
        "lte"          => "<=",
        "contains"     => "LIKE",
        "not_contains" => "NOT LIKE",
        _ => return None,
    };
    let val = match &cond.value {
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::String(s) => {
            let escaped = s.replace('\'', "''");
            if cond.op == "contains" || cond.op == "not_contains" {
                format!("'%{escaped}%'")
            } else {
                format!("'{escaped}'")
            }
        }
        _ => return None,
    };
    Some(format!("{col} {sql_op} {val}"))
}
