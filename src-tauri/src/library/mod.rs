mod album_art;
mod artist_fetch;
mod db;
mod scan;

pub use album_art::fetch_album_covers;
pub use artist_fetch::fetch_artist_images;
// Stats helper types (AlbumStat / ArtistStat / DayCount) are transitively
// serialized via ListeningStats, so they don't need a top-level re-export.
pub use db::{
    AiTrackRow, DbPlaylist, LibraryAlbum, LibraryArtist, LibraryDb, LibraryFolder, LibraryTrack,
    ListeningStats, MostPlayedTrack,
};
pub use scan::{reimport_file, scan_folder};
