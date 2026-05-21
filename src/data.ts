export type AlbumStyle = "ecm" | "bluenote" | "cartouche" | "minimal" | "impulsiv";

export interface Album {
  id: string;
  title: string;
  artist: string;
  sub?: string;
  year: number;
  genre: string;
  format: "FLAC" | "DSD";
  bit: number;
  rate: number;
  label: string;
  style: AlbumStyle;
  palette: [string, string, string];
  coverUrl?: string;
}

export interface QueueTrack {
  albumId: string;
  track: number;
  title: string;
  duration: string;
  current?: boolean;
}

export interface Device {
  id: string;
  name: string;
  driver: string;
  exclusive: boolean;
  current: boolean;
  formats: string;
}

export interface Playlist {
  id: string;
  name: string;
  count: number;
}

export const ALBUMS: Album[] = [
  { id: "a01", title: "Late Sonatas, Opp. 109–111", artist: "Helena Vasari", sub: "Beethoven · piano",
    year: 2019, genre: "classical", format: "FLAC", bit: 24, rate: 192, label: "Helikon",
    style: "cartouche", palette: ["#e8d57a", "#1a1611", "#5a4220"] },
  { id: "a02", title: "Quiet Country", artist: "Marcus Davies Quartet",
    year: 1984, genre: "jazz", format: "FLAC", bit: 24, rate: 96, label: "Northlight",
    style: "ecm", palette: ["#1c2024", "#7a8a92", "#c8c0a8"] },
  { id: "a03", title: "Aldebaran Variations", artist: "Itzhak Solberg", sub: "Bach · harpsichord",
    year: 2008, genre: "classical", format: "DSD", bit: 1, rate: 5644.8,
    label: "Astralis", style: "minimal", palette: ["#0e1014", "#c9a96e", "#c9a96e"] },
  { id: "a04", title: "Saxophone Titan", artist: "Sonny Wright",
    year: 1962, genre: "jazz", format: "FLAC", bit: 24, rate: 96, label: "Cobalt Note",
    style: "bluenote", palette: ["#c44a2a", "#0a0a0a", "#f5e6c8"] },
  { id: "a05", title: "Symphony No. 9", artist: "Berlin Festival Orch.", sub: "Mahler · Klauss Reiter, cond.",
    year: 1998, genre: "classical", format: "FLAC", bit: 24, rate: 192, label: "Helikon",
    style: "cartouche", palette: ["#e8d57a", "#0e0e0e", "#3a2a18"] },
  { id: "a06", title: "A Vow Eternal", artist: "John Calderon",
    year: 1965, genre: "jazz", format: "FLAC", bit: 24, rate: 192, label: "Impulsiv",
    style: "impulsiv", palette: ["#e8a020", "#1a0e0a", "#000000"] },
  { id: "a07", title: "Goldberg Reimagined", artist: "Helena Vasari", sub: "piano transcriptions",
    year: 2022, genre: "classical", format: "FLAC", bit: 24, rate: 96, label: "Helikon",
    style: "cartouche", palette: ["#e8d57a", "#1a1611", "#4a3c20"] },
  { id: "a08", title: "Bright Corners", artist: "Theo Hart Trio",
    year: 1956, genre: "jazz", format: "FLAC", bit: 24, rate: 96, label: "Cobalt Note",
    style: "bluenote", palette: ["#2a5a8a", "#0a0a0a", "#f5e6c8"] },
  { id: "a09", title: "Berlin Recital", artist: "Kjell Hammar",
    year: 1976, genre: "jazz", format: "FLAC", bit: 24, rate: 96, label: "Northlight",
    style: "ecm", palette: ["#2a2820", "#a89878", "#e8dec6"] },
  { id: "a10", title: "Cello Suites", artist: "Mireille Ostrava", sub: "J. S. Bach",
    year: 2011, genre: "classical", format: "FLAC", bit: 24, rate: 192, label: "Astralis",
    style: "minimal", palette: ["#161310", "#a89878", "#a89878"] },
  { id: "a11", title: "Nocturnes, Complete", artist: "Aleksei Vorbein", sub: "Chopin",
    year: 2003, genre: "classical", format: "FLAC", bit: 16, rate: 44.1, label: "Helikon",
    style: "cartouche", palette: ["#e8d57a", "#1a1611", "#5a3c20"] },
  { id: "a12", title: "Shade of Blue", artist: "Marcus Davies Quintet",
    year: 1959, genre: "jazz", format: "FLAC", bit: 24, rate: 192, label: "Cobalt Note",
    style: "bluenote", palette: ["#1a3a6a", "#0a0a0a", "#e8d8a8"] },
  { id: "a13", title: "String Quartets 12–15", artist: "Quatuor Lemaire", sub: "Beethoven",
    year: 2014, genre: "classical", format: "DSD", bit: 1, rate: 2822.4, label: "Astralis",
    style: "minimal", palette: ["#0c0c10", "#d4d0c0", "#d4d0c0"] },
  { id: "a14", title: "Standards, Vol. II", artist: "Eva Lindqvist",
    year: 2001, genre: "jazz", format: "FLAC", bit: 24, rate: 96, label: "Northlight",
    style: "ecm", palette: ["#2a3438", "#788890", "#c8c4b8"] },
  { id: "a15", title: "Préludes, Books I & II", artist: "Helena Vasari", sub: "Debussy",
    year: 2016, genre: "classical", format: "FLAC", bit: 24, rate: 192, label: "Helikon",
    style: "cartouche", palette: ["#e8d57a", "#10100c", "#3a3018"] },
  { id: "a16", title: "Hard Light", artist: "Curtis Mboya",
    year: 1968, genre: "jazz", format: "FLAC", bit: 24, rate: 96, label: "Impulsiv",
    style: "impulsiv", palette: ["#e84a20", "#1a0a0a", "#000000"] },
  { id: "a17", title: "Toccatas", artist: "Itzhak Solberg", sub: "Bach",
    year: 2017, genre: "classical", format: "FLAC", bit: 24, rate: 96, label: "Astralis",
    style: "minimal", palette: ["#0e0e10", "#c9a96e", "#c9a96e"] },
  { id: "a18", title: "Midnight Sessions", artist: "Theo Hart Trio",
    year: 1961, genre: "jazz", format: "FLAC", bit: 16, rate: 44.1, label: "Cobalt Note",
    style: "bluenote", palette: ["#1a1a1a", "#c9a96e", "#f5e6c8"] },
  { id: "a19", title: "Vespers", artist: "Studio Sacrum", sub: "Rachmaninoff",
    year: 2009, genre: "classical", format: "FLAC", bit: 24, rate: 96, label: "Helikon",
    style: "cartouche", palette: ["#e8d57a", "#0a0a0a", "#3a1818"] },
  { id: "a20", title: "Westerly", artist: "Hammar / Olsen Duo",
    year: 1989, genre: "jazz", format: "FLAC", bit: 24, rate: 96, label: "Northlight",
    style: "ecm", palette: ["#202830", "#506878", "#b8b8a8"] },
  { id: "a21", title: "Études, Op. 25", artist: "Aleksei Vorbein", sub: "Chopin",
    year: 2006, genre: "classical", format: "FLAC", bit: 24, rate: 192, label: "Astralis",
    style: "minimal", palette: ["#101014", "#a89878", "#a89878"] },
  { id: "a22", title: "Equinox Suite", artist: "John Calderon Quartet",
    year: 1964, genre: "jazz", format: "FLAC", bit: 24, rate: 96, label: "Impulsiv",
    style: "impulsiv", palette: ["#e87a20", "#0a0a08", "#000000"] },
  { id: "a23", title: "Mass in D minor", artist: "Cantorum Aurelius", sub: "Brahms",
    year: 2013, genre: "classical", format: "FLAC", bit: 24, rate: 192, label: "Helikon",
    style: "cartouche", palette: ["#e8d57a", "#0a0a0a", "#2a2018"] },
  { id: "a24", title: "Round About Now", artist: "Eva Lindqvist Trio",
    year: 1996, genre: "jazz", format: "FLAC", bit: 24, rate: 96, label: "Northlight",
    style: "ecm", palette: ["#2a2a30", "#807868", "#d8d0b8"] },
];

export const QUEUE: QueueTrack[] = [
  { albumId: "a01", track: 2, title: "Sonata No. 30, Op. 109 — I. Vivace ma non troppo", duration: "3:46", current: true },
  { albumId: "a01", track: 3, title: "Sonata No. 30, Op. 109 — II. Prestissimo", duration: "2:32" },
  { albumId: "a01", track: 4, title: "Sonata No. 30, Op. 109 — III. Gesangvoll", duration: "13:28" },
  { albumId: "a01", track: 5, title: "Sonata No. 31, Op. 110 — I. Moderato cantabile", duration: "6:51" },
  { albumId: "a01", track: 6, title: "Sonata No. 31, Op. 110 — II. Allegro molto", duration: "2:18" },
  { albumId: "a01", track: 7, title: "Sonata No. 31, Op. 110 — III. Adagio, ma non troppo", duration: "12:04" },
  { albumId: "a01", track: 8, title: "Sonata No. 32, Op. 111 — I. Maestoso", duration: "9:12" },
  { albumId: "a01", track: 9, title: "Sonata No. 32, Op. 111 — II. Arietta", duration: "17:42" },
];

export const DEVICES: Device[] = [
  { id: "d1", name: "Topping E70 Velvet", driver: "WASAPI", exclusive: true, current: true,
    formats: "32 bit / 768 kHz · DSD512" },
  { id: "d2", name: "RME ADI-2 DAC FS", driver: "WASAPI", exclusive: false, current: false,
    formats: "32 bit / 768 kHz · DSD256" },
  { id: "d3", name: "Realtek Speakers", driver: "WASAPI", exclusive: false, current: false,
    formats: "24 bit / 192 kHz" },
];

export const PLAYLISTS: Playlist[] = [
  { id: "p1", name: "Late Evenings", count: 87 },
  { id: "p2", name: "Solo Piano", count: 142 },
  { id: "p3", name: "Reference Tracks", count: 24 },
  { id: "p4", name: "Hi-Res Acquisitions", count: 318 },
  { id: "p5", name: "Saturday Morning", count: 56 },
];
