use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crossbeam_channel::{bounded, Sender, Receiver, TryRecvError};
use rustfft::{FftPlanner, num_complex::Complex};
use serde::{Deserialize, Serialize};
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use tauri::{AppHandle, Emitter};
use wasapi::{
    initialize_mta, get_default_device, Direction,
    SampleType, ShareMode, WaveFormat,
};

// ── Safe error formatter ────────────────────────────────────────────
// windows-core 0.51's Display/Debug for Error call FormatMessageW, which
// crashes with a null-pointer slice when no message string is registered
// for the HRESULT. Extract just the HRESULT code in that case.
fn fmt_err(e: &(dyn std::error::Error + 'static)) -> String {
    if let Some(w) = e.downcast_ref::<windows::core::Error>() {
        format!("HRESULT {:#010x}", w.code().0 as u32)
    } else {
        e.to_string()
    }
}

// ── Output sample formats ───────────────────────────────────────────
// What the negotiated WASAPI stream wants on the wire. We always decode
// to 32-bit float internally; convert_to_bytes() emits whichever layout
// the DAC accepts in exclusive mode (or float for shared+convert).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SampleFormat {
    /// 32-bit float. Pro audio cards and a few USB DACs accept this.
    F32,
    /// 24-bit signed int, packed into 3 bytes per sample (no padding). What
    /// AudioQuest Dragonfly and many older USB Class 1 DACs expose.
    S24Packed,
    /// 32-bit container, 24 valid bits left-justified into the high 24.
    /// Common for newer USB DACs (Schiit, Topping, RME…).
    S24In32,
    /// 32-bit signed int, all 32 bits valid. Rare.
    S32,
    /// 16-bit signed int. Universal fallback — every DAC supports this.
    S16,
}

// ── Public types ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct TrackInfo {
    pub path: String,
    pub duration: f64,
    pub sample_rate: u32,
    pub channels: u32,
    pub bits_per_sample: u32,
    pub codec: String,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct PlaybackState {
    pub playing: bool,
    pub position: f64,
    pub duration: f64,
    pub exclusive: bool,
    pub track: Option<TrackInfo>,
}

// ── Parametric EQ types ─────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EqFilterType {
    Peak,
    LowShelf,
    HighShelf,
    LowPass,
    HighPass,
    Notch,
    Allpass,
}

impl Default for EqFilterType {
    fn default() -> Self { EqFilterType::Peak }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EqBand {
    pub enabled: bool,
    pub filter_type: EqFilterType,
    /// Center / corner frequency in Hz.
    pub frequency: f64,
    /// Gain in dB — used by Peak, LowShelf, HighShelf; ignored by filter-only types.
    pub gain_db: f64,
    /// Quality factor (bandwidth). 1.0 ≈ 1 octave; higher = narrower.
    pub q: f64,
}

impl Default for EqBand {
    fn default() -> Self {
        EqBand {
            enabled: false,
            filter_type: EqFilterType::Peak,
            frequency: 1000.0,
            gain_db: 0.0,
            q: 1.0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct EqSettings {
    pub enabled: bool,
    /// Pre-gain applied before the biquad chain, in dB.
    /// Reduce this to compensate for headroom lost from boosting bands and
    /// prevent inter-sample peaks from exceeding 0 dBFS.
    pub preamp_db: f64,
    pub bands: Vec<EqBand>,
}

// ── Crossfade config ────────────────────────────────────────────────

/// Crossfade applies only in shared mode (in exclusive mode the WASAPI
/// path is bit-perfect — there's no mixer to merge two streams). It also
/// requires the next track's sample rate to match the current track's;
/// otherwise we fall back to the normal end-of-track switch.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrossfadeConfig {
    pub enabled: bool,
    /// Crossfade duration in seconds. Clamped 0.5..8 at apply time.
    pub duration_secs: f64,
}

impl Default for CrossfadeConfig {
    fn default() -> Self {
        CrossfadeConfig { enabled: false, duration_secs: 4.0 }
    }
}

// ── Biquad filter DSP (RBJ Audio EQ Cookbook) ───────────────────────

/// Normalised second-order IIR coefficients (a0 normalised to 1).
#[derive(Debug, Clone, Copy)]
struct BiquadCoeffs {
    b0: f64, b1: f64, b2: f64,
    a1: f64, a2: f64,
}

/// Per-channel Direct Form I delay state.
#[derive(Debug, Clone, Copy, Default)]
struct BiquadState {
    x1: f64, x2: f64,
    y1: f64, y2: f64,
}

impl BiquadState {
    #[inline(always)]
    fn process(&mut self, x: f64, c: &BiquadCoeffs) -> f64 {
        let y = c.b0 * x + c.b1 * self.x1 + c.b2 * self.x2
              - c.a1 * self.y1 - c.a2 * self.y2;
        self.x2 = self.x1; self.x1 = x;
        self.y2 = self.y1; self.y1 = y;
        y
    }
}

/// One enabled EQ band: coefficients + per-channel delay states.
struct BiquadBand {
    coeffs: BiquadCoeffs,
    states: Vec<BiquadState>, // one per output channel
}

impl BiquadBand {
    fn new(coeffs: BiquadCoeffs, channels: usize) -> Self {
        BiquadBand { coeffs, states: vec![BiquadState::default(); channels] }
    }

    fn reset(&mut self) {
        for s in &mut self.states { *s = BiquadState::default(); }
    }
}

/// Full parametric EQ processor: optional preamp + ordered biquad chain.
struct EqProcessor {
    /// Linear amplitude from `preamp_db` — applied before the biquad chain.
    preamp_gain: f32,
    bands: Vec<BiquadBand>,
}

impl EqProcessor {
    /// Build from settings for a given sample rate and channel count.
    fn from_settings(settings: &EqSettings, sample_rate: u32, channels: usize) -> Self {
        let preamp_gain = (10.0_f64).powf(settings.preamp_db / 20.0) as f32;
        let bands = settings.bands.iter()
            .filter(|b| b.enabled)
            .map(|b| BiquadBand::new(compute_biquad_coeffs(b, sample_rate), channels))
            .collect();
        EqProcessor { preamp_gain, bands }
    }

    /// Process interleaved samples in-place.
    ///
    /// Layout: per-frame → per-channel → preamp → each band in chain.
    /// This single-pass layout keeps each sample in CPU registers / L1 cache
    /// for the entire filter chain, costing one read+write to the sample
    /// buffer instead of one per-band-plus-preamp. Measured ~2–3× faster
    /// than the per-band-over-all-samples layout for 5+ active bands,
    /// which matters on low-end CPUs that can't afford repeated full
    /// passes over a multi-millisecond decode buffer at 192 kHz.
    fn process(&mut self, samples: &mut [f32], channels: usize) {
        let preamp = self.preamp_gain as f64;
        let preamp_active = (self.preamp_gain - 1.0).abs() > 1e-6;
        if self.bands.is_empty() && !preamp_active {
            return;
        }
        for frame in samples.chunks_exact_mut(channels) {
            for (ch, s_ref) in frame.iter_mut().enumerate() {
                let mut x = *s_ref as f64;
                if preamp_active { x *= preamp; }
                // SAFETY: every BiquadBand was constructed with `channels`
                // states (see `BiquadBand::new`), and `ch < channels` by the
                // bounds of `chunks_exact_mut(channels).enumerate()`. Hoisting
                // the bounds check out of the hot per-sample loop measurably
                // helps the compiler keep the recurrence in registers.
                for band in self.bands.iter_mut() {
                    let st = unsafe { band.states.get_unchecked_mut(ch) };
                    x = st.process(x, &band.coeffs);
                }
                *s_ref = x as f32;
            }
        }
    }

    /// Reset all biquad delay states (call on seek / gapless switch to
    /// prevent filter transients at discontinuities).
    fn reset(&mut self) {
        for band in &mut self.bands { band.reset(); }
    }
}

/// Compute biquad coefficients for an `EqBand`.
/// All formulas from the RBJ Audio EQ Cookbook (Robert Bristow-Johnson, rev 2005).
fn compute_biquad_coeffs(band: &EqBand, sample_rate: u32) -> BiquadCoeffs {
    use std::f64::consts::PI;
    let fs   = sample_rate as f64;
    let f0   = band.frequency.max(1.0).min(fs * 0.499);
    let w0   = 2.0 * PI * f0 / fs;
    let q    = band.q.max(0.001);
    let sin0 = w0.sin();
    let cos0 = w0.cos();
    // α: universal expression valid for all filter types in the cookbook.
    let alpha = sin0 / (2.0 * q);
    // A = 10^(gain_dB / 40): linear amplitude factor for shelf/peak filters.
    let a = (10.0_f64).powf(band.gain_db / 40.0);
    let two_sqrt_a_alpha = 2.0 * a.sqrt() * alpha;

    let (b0, b1, b2, a0, a1, a2) = match band.filter_type {
        EqFilterType::Peak => {
            let alpha_a     = alpha * a;
            let alpha_div_a = alpha / a;
            (
                1.0 + alpha_a,     -2.0 * cos0, 1.0 - alpha_a,
                1.0 + alpha_div_a, -2.0 * cos0, 1.0 - alpha_div_a,
            )
        }
        EqFilterType::LowShelf => (
            a * ((a + 1.0) - (a - 1.0) * cos0 + two_sqrt_a_alpha),
            2.0 * a * ((a - 1.0) - (a + 1.0) * cos0),
            a * ((a + 1.0) - (a - 1.0) * cos0 - two_sqrt_a_alpha),
            (a + 1.0) + (a - 1.0) * cos0 + two_sqrt_a_alpha,
           -2.0 * ((a - 1.0) + (a + 1.0) * cos0),
            (a + 1.0) + (a - 1.0) * cos0 - two_sqrt_a_alpha,
        ),
        EqFilterType::HighShelf => (
            a * ((a + 1.0) + (a - 1.0) * cos0 + two_sqrt_a_alpha),
           -2.0 * a * ((a - 1.0) + (a + 1.0) * cos0),
            a * ((a + 1.0) + (a - 1.0) * cos0 - two_sqrt_a_alpha),
            (a + 1.0) - (a - 1.0) * cos0 + two_sqrt_a_alpha,
            2.0 * ((a - 1.0) - (a + 1.0) * cos0),
            (a + 1.0) - (a - 1.0) * cos0 - two_sqrt_a_alpha,
        ),
        EqFilterType::LowPass => (
            (1.0 - cos0) / 2.0,  1.0 - cos0,  (1.0 - cos0) / 2.0,
             1.0 + alpha,        -2.0 * cos0,   1.0 - alpha,
        ),
        EqFilterType::HighPass => (
             (1.0 + cos0) / 2.0, -(1.0 + cos0), (1.0 + cos0) / 2.0,
             1.0 + alpha,         -2.0 * cos0,   1.0 - alpha,
        ),
        EqFilterType::Notch => (
            1.0,  -2.0 * cos0,  1.0,
            1.0 + alpha,  -2.0 * cos0,  1.0 - alpha,
        ),
        EqFilterType::Allpass => (
            1.0 - alpha,  -2.0 * cos0,  1.0 + alpha,
            1.0 + alpha,  -2.0 * cos0,  1.0 - alpha,
        ),
    };

    let inv_a0 = 1.0 / a0;
    BiquadCoeffs {
        b0: b0 * inv_a0,
        b1: b1 * inv_a0,
        b2: b2 * inv_a0,
        a1: a1 * inv_a0,
        a2: a2 * inv_a0,
    }
}

// ── Internal commands ───────────────────────────────────────────────

pub enum AudioCommand {
    /// Path + optional start position in seconds (used to resume on launch)
    Play(PathBuf, Option<f64>),
    Pause,
    Resume,
    Stop,
    Seek(f64),
    Volume(f32),
    /// Switch the WASAPI render device. If we're playing, the current track
    /// is restarted on the new device from the same position; otherwise the
    /// new device is just remembered for the next play.
    SetDevice(String),
    /// Enable/disable exclusive-mode negotiation. When false the engine
    /// goes straight to shared+convert, leaving the DAC free for other apps.
    SetExclusiveMode(bool),
    /// Pre-queue the next path for gapless playback. The engine transitions
    /// seamlessly when the current track's sample queue is exhausted.
    QueueNext(PathBuf),
    /// Update parametric EQ settings. Takes effect on the next WASAPI write;
    /// the processor is rebuilt from the current sample_rate + channel count.
    SetEq(EqSettings),
    /// Per-track ReplayGain linear gain. `None` = unity gain (RG disabled for
    /// this track). Sent by the Tauri layer just before each Play command.
    SetTrackGain(Option<f32>),
    /// Update crossfade config (enabled flag + duration). Takes effect at the
    /// next track-end trigger, not retroactively to a fade already in flight.
    SetCrossfade(CrossfadeConfig),
    Quit,
}

/// Outcome of a single `play_file` invocation. Decides what the audio thread
/// does next: emit `track-ended` and auto-advance, sit idle, or hold a
/// paused-state while the WASAPI device is released for other apps.
enum PlayResult {
    /// Track finished decoding naturally → fire track-ended.
    Ended,
    /// User issued Stop, or something equivalent. No auto-advance.
    Stopped,
    /// User paused in exclusive mode; device has been released. Outer loop
    /// holds the path + position until Resume / Play / Stop arrives.
    Paused(PathBuf, f64),
    /// Switch to a different track (or same track after a device/mode change).
    /// Returned instead of recursing into play_file so that each play_file
    /// frame fully unwinds before the next one starts — prevents COM objects
    /// and large decode buffers from accumulating on the stack across tracks.
    Switch(PathBuf, Option<f64>),
}

// ── Engine handle ───────────────────────────────────────────────────

pub struct AudioEngine {
    cmd_tx: Sender<AudioCommand>,
    pub state: Arc<Mutex<PlaybackState>>,
}

impl AudioEngine {
    pub fn new(app: AppHandle) -> Self {
        let (tx, rx) = bounded::<AudioCommand>(32);
        let state = Arc::new(Mutex::new(PlaybackState::default()));
        let state2 = Arc::clone(&state);
        thread::spawn(move || audio_thread(rx, state2, app));
        Self { cmd_tx: tx, state }
    }

    pub fn play(&self, path: PathBuf, start_secs: Option<f64>) -> Result<(), String> {
        self.cmd_tx.send(AudioCommand::Play(path, start_secs)).map_err(|e| e.to_string())
    }
    pub fn pause(&self) -> Result<(), String> {
        self.cmd_tx.send(AudioCommand::Pause).map_err(|e| e.to_string())
    }
    pub fn resume(&self) -> Result<(), String> {
        self.cmd_tx.send(AudioCommand::Resume).map_err(|e| e.to_string())
    }
    pub fn stop(&self) -> Result<(), String> {
        self.cmd_tx.send(AudioCommand::Stop).map_err(|e| e.to_string())
    }
    pub fn seek(&self, secs: f64) -> Result<(), String> {
        self.cmd_tx.send(AudioCommand::Seek(secs)).map_err(|e| e.to_string())
    }
    pub fn set_volume(&self, v: f32) -> Result<(), String> {
        self.cmd_tx.send(AudioCommand::Volume(v.clamp(0.0, 1.0))).map_err(|e| e.to_string())
    }
    pub fn set_device(&self, id: String) -> Result<(), String> {
        self.cmd_tx.send(AudioCommand::SetDevice(id)).map_err(|e| e.to_string())
    }
    pub fn set_exclusive_mode(&self, enabled: bool) -> Result<(), String> {
        self.cmd_tx.send(AudioCommand::SetExclusiveMode(enabled)).map_err(|e| e.to_string())
    }
    pub fn queue_next(&self, path: PathBuf) -> Result<(), String> {
        self.cmd_tx.send(AudioCommand::QueueNext(path)).map_err(|e| e.to_string())
    }
    pub fn set_eq(&self, settings: EqSettings) -> Result<(), String> {
        self.cmd_tx.send(AudioCommand::SetEq(settings)).map_err(|e| e.to_string())
    }
    pub fn set_track_gain(&self, gain: Option<f32>) -> Result<(), String> {
        self.cmd_tx.send(AudioCommand::SetTrackGain(gain)).map_err(|e| e.to_string())
    }
    pub fn set_crossfade(&self, config: CrossfadeConfig) -> Result<(), String> {
        self.cmd_tx.send(AudioCommand::SetCrossfade(config)).map_err(|e| e.to_string())
    }
}

// ── Audio thread ────────────────────────────────────────────────────

fn audio_thread(rx: Receiver<AudioCommand>, state: Arc<Mutex<PlaybackState>>, app: AppHandle) {
    if let Err(e) = initialize_mta() {
        log::error!("COM init failed: {e}");
        return;
    }

    // Register with MMCSS (Multimedia Class Scheduler Service) as "Pro Audio"
    // so Windows gives this thread real-time-class priority and keeps it
    // unpreempted. Without this, normal CPU activity (UI rendering, GC,
    // scrolling a long playlist) can starve the audio loop and cause clicks.
    unsafe {
        use windows::Win32::System::Threading::AvSetMmThreadCharacteristicsW;
        use windows::core::PCWSTR;
        let task_name: Vec<u16> = "Pro Audio\0".encode_utf16().collect();
        let mut task_index: u32 = 0;
        match AvSetMmThreadCharacteristicsW(PCWSTR(task_name.as_ptr()), &mut task_index) {
            Ok(handle) if !handle.is_invalid() => {
                eprintln!("[audio] MMCSS Pro Audio registered (task index {})", task_index);
                // Handle deliberately not stored — the OS releases it on thread exit.
                let _ = handle;
            }
            Ok(_) => eprintln!("[audio] MMCSS returned invalid handle"),
            Err(e) => eprintln!("[audio] MMCSS registration failed: {:?}", e),
        }
    }

    // Engine-wide state carried across play_file invocations. Persisting
    // these here means volume / device choice / exclusive flag survive when a
    // track ends, when the user pauses in exclusive mode (which releases the
    // device entirely), and when the user toggles exclusive at runtime.
    let mut preferred_device_id: Option<String> = None;
    let mut exclusive_enabled = true;
    let mut volume: f32 = 1.0;
    // Index into the candidates[] array of the last successful exclusive format.
    // On the next track we try this index first; if it fails we fall back to the
    // full five-candidate probe. For consecutive tracks at the same sample rate
    // on the same device this skips 3-4 unnecessary COM round-trips.
    let mut last_fmt_idx: Option<usize> = None;
    // EQ and ReplayGain state, carried across all play_file invocations so
    // that settings set while idle are picked up when the next track starts.
    let mut eq_settings: EqSettings = EqSettings::default();
    let mut track_gain: f32 = 1.0; // linear; 1.0 = unity (RG disabled)
    let mut xf_config: CrossfadeConfig = CrossfadeConfig::default();

    loop {
        // Wait for an initial Play. Other commands keep updating engine state
        // while we sit idle.
        let (initial_path, initial_start) = loop {
            match rx.recv() {
                Ok(AudioCommand::Play(p, start)) => break (p, start),
                Ok(AudioCommand::SetDevice(id)) => { preferred_device_id = Some(id); continue; }
                Ok(AudioCommand::SetExclusiveMode(b)) => { exclusive_enabled = b; continue; }
                Ok(AudioCommand::Volume(v)) => { volume = v.clamp(0.0, 1.0); continue; }
                Ok(AudioCommand::SetEq(s)) => { eq_settings = s; continue; }
                Ok(AudioCommand::SetTrackGain(g)) => { track_gain = g.unwrap_or(1.0); continue; }
                Ok(AudioCommand::SetCrossfade(c)) => { xf_config = c; continue; }
                Ok(AudioCommand::Quit) | Err(_) => return,
                _ => continue,
            }
        };

        // "Track session" loop: play_file can return Paused mid-track in
        // exclusive mode, in which case we hold here, release the device,
        // and re-enter play_file when Resume arrives. PlayResult::Switch
        // loops immediately with a new path so that each play_file frame
        // fully unwinds before the next starts (no COM-object accumulation).
        let mut current_path = initial_path;
        let mut current_start = initial_start;

        'session: loop {
            let result = play_file(
                current_path.clone(),
                current_start,
                &mut preferred_device_id,
                &mut exclusive_enabled,
                &mut volume,
                &mut last_fmt_idx,
                &mut eq_settings,
                &mut track_gain,
                &mut xf_config,
                &rx,
                &state,
                &app,
            );

            match result {
                Ok(PlayResult::Switch(new_path, new_start)) => {
                    current_path = new_path;
                    current_start = new_start;
                    continue 'session;
                }
                Ok(PlayResult::Ended) => {
                    {
                        let mut s = state.lock().unwrap();
                        s.playing = false;
                        let _ = app.emit("playback-state", s.clone());
                    }
                    let _ = app.emit("track-ended", ());
                    break 'session;
                }
                Ok(PlayResult::Stopped) => {
                    let mut s = state.lock().unwrap();
                    s.playing = false;
                    let _ = app.emit("playback-state", s.clone());
                    break 'session;
                }
                Ok(PlayResult::Paused(paused_path, paused_pos)) => {
                    // Device released. Wait here until the user resumes,
                    // starts a different track, or stops.
                    let held_path = paused_path;
                    let mut held_pos = paused_pos;
                    let next: Option<(PathBuf, Option<f64>)> = loop {
                        match rx.recv() {
                            Ok(AudioCommand::Resume) => break Some((held_path.clone(), Some(held_pos))),
                            Ok(AudioCommand::Play(np, ns)) => break Some((np, ns)),
                            Ok(AudioCommand::Stop) => break None,
                            Ok(AudioCommand::Seek(s)) => {
                                // Update the position we'll resume from.
                                held_pos = s;
                                let mut st = state.lock().unwrap();
                                st.position = s;
                                let _ = app.emit("playback-state", st.clone());
                                continue;
                            }
                            Ok(AudioCommand::Volume(v)) => { volume = v.clamp(0.0, 1.0); continue; }
                            Ok(AudioCommand::SetDevice(id)) => { preferred_device_id = Some(id); continue; }
                            Ok(AudioCommand::SetExclusiveMode(b)) => { exclusive_enabled = b; continue; }
                            Ok(AudioCommand::SetEq(s)) => { eq_settings = s; continue; }
                            Ok(AudioCommand::SetTrackGain(g)) => { track_gain = g.unwrap_or(1.0); continue; }
                            Ok(AudioCommand::SetCrossfade(c)) => { xf_config = c; continue; }
                            Ok(AudioCommand::Pause) => continue, // already paused
                            Ok(AudioCommand::QueueNext(_)) => continue, // ignored while paused
                            Ok(AudioCommand::Quit) | Err(_) => return,
                        }
                    };
                    let _ = held_path; // silence unused-after-move lint if path was moved into Some(...)
                    match next {
                        Some((p, s)) => { current_path = p; current_start = s; continue 'session; }
                        None => {
                            // Stop while paused: emit playing=false and bail.
                            let mut s = state.lock().unwrap();
                            s.playing = false;
                            let _ = app.emit("playback-state", s.clone());
                            break 'session;
                        }
                    }
                }
                Err(e) => {
                    log::error!("Playback error: {e}");
                    let _ = app.emit("playback-error", e);
                    let mut s = state.lock().unwrap();
                    s.playing = false;
                    let _ = app.emit("playback-state", s.clone());
                    break 'session;
                }
            }
        }
    }
}

// ── Core playback ───────────────────────────────────────────────────

fn play_file(
    path: PathBuf,
    start_secs: Option<f64>,
    preferred_device_id: &mut Option<String>,
    exclusive_enabled: &mut bool,
    volume: &mut f32,
    last_fmt_idx: &mut Option<usize>,
    eq_settings: &mut EqSettings,
    track_gain: &mut f32,
    xf_config: &mut CrossfadeConfig,
    rx: &Receiver<AudioCommand>,
    state: &Arc<Mutex<PlaybackState>>,
    app: &AppHandle,
) -> Result<PlayResult, String> {
    // Hang on to the path so SetDevice (which restarts this function) can
    // re-enter with the same track even though the original `path` will
    // have been moved into TrackInfo below.
    let mut path_for_restart = path.clone();

    // ── Probe file ──────────────────────────────────────────────────
    let file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .map_err(|e| e.to_string())?;

    let mut format_reader = probed.format;
    let track = format_reader.default_track().ok_or("No audio track found")?.clone();
    let mut track_id = track.id;
    let params = track.codec_params.clone();

    let sample_rate = params.sample_rate.unwrap_or(44100);
    let mut src_channels = params.channels.map(|c| c.count()).unwrap_or(2);
    let mut bits = params.bits_per_sample.unwrap_or(24);
    let mut duration_secs = params.n_frames
        .map(|n| n as f64 / sample_rate as f64)
        .unwrap_or(0.0);

    // ── Open WASAPI ─────────────────────────────────────────────────
    // If the user picked a specific device, use it; otherwise track the
    // Windows default. If the preferred device is gone (unplugged etc.),
    // fall back to default rather than failing playback.
    let device = match preferred_device_id.as_deref() {
        Some(id) => match super::device::get_device_by_id(id) {
            Ok(d) => d,
            Err(e) => {
                eprintln!("[audio] preferred device {} unavailable ({}), falling back to default", id, e);
                get_default_device(&Direction::Render).map_err(|e| fmt_err(&*e))?
            }
        },
        None => get_default_device(&Direction::Render).map_err(|e| fmt_err(&*e))?,
    };
    let device_name = device.get_friendlyname().unwrap_or_else(|_| "(unknown)".into());
    eprintln!("[audio] render device: {}", device_name);
    let mut audio_client = device.get_iaudioclient().map_err(|e| fmt_err(&*e))?;

    // (The format-enumeration diagnostic that lived here during initial DAC
    // testing has been removed. If a new device has trouble negotiating
    // exclusive, re-add it temporarily — see git history.)

    // Try a priority list of exclusive-mode formats. Most consumer USB DACs
    // (Dragonfly Red/Black/Cobalt, Schiit, Topping…) only accept integer PCM
    // — 32-bit float is rare outside pro audio cards. Try float first for the
    // few that do, then 24-in-32 (the most common consumer DAC format), then
    // 32-int / 16-int as fallbacks. The first format the DAC accepts wins.
    // If none work in exclusive, we fall back to shared+convert (32-bit float
    // in, Windows mixer handles the rest).
    let out_channels = 2usize;
    let candidates = [
        (SampleFormat::F32,       WaveFormat::new(32, 32, &SampleType::Float, sample_rate as usize, out_channels, None)),
        (SampleFormat::S24Packed, WaveFormat::new(24, 24, &SampleType::Int,   sample_rate as usize, out_channels, None)),
        (SampleFormat::S24In32,   WaveFormat::new(32, 24, &SampleType::Int,   sample_rate as usize, out_channels, None)),
        (SampleFormat::S32,       WaveFormat::new(32, 32, &SampleType::Int,   sample_rate as usize, out_channels, None)),
        (SampleFormat::S16,       WaveFormat::new(16, 16, &SampleType::Int,   sample_rate as usize, out_channels, None)),
    ];

    // Use `is_supported_exclusive_with_quirks` because some USB DAC drivers
    // need WAVE_FORMAT_PCM (not EXTENSIBLE) or have validbits / bitspersample
    // quirks. The crate's quirks layer tries those variations for us. The
    // returned WaveFormat may be substituted, so we re-classify it from its
    // actual bit depth + sample type, not from what we asked for.
    let mut chosen: Option<(SampleFormat, WaveFormat)> = None;
    if *exclusive_enabled {
        // Try the last-successful candidate index first (fast path: 1 COM call
        // instead of up to 5). Fall back to the full probe only if it fails or
        // the sample rate changed since last time.
        let probe_order: Vec<usize> = match *last_fmt_idx {
            Some(cached) if cached < candidates.len() => {
                let mut order = vec![cached];
                order.extend((0..candidates.len()).filter(|&i| i != cached));
                order
            }
            _ => (0..candidates.len()).collect(),
        };

        for i in probe_order {
            let (_, wf) = &candidates[i];
            if let Ok(negotiated) = audio_client.is_supported_exclusive_with_quirks(wf) {
                let bits = negotiated.get_bitspersample();
                let valid = negotiated.get_validbitspersample();
                let subtype = negotiated.get_subformat().ok();
                if let Some(fmt) = classify_format(bits, valid, &subtype) {
                    chosen = Some((fmt, negotiated));
                    *last_fmt_idx = Some(i);
                    break;
                }
            }
        }
    } else {
        *last_fmt_idx = None;
    }

    let (output_fmt, wave_fmt, exclusive) = match chosen {
        Some((f, w)) => {
            eprintln!("[audio] EXCLUSIVE {:?} @ {} Hz", f, sample_rate);
            (f, w, true)
        }
        None => {
            if *exclusive_enabled {
                eprintln!("[audio] SHARED+convert @ {} Hz (no exclusive format)", sample_rate);
            } else {
                eprintln!("[audio] SHARED+convert @ {} Hz (exclusive disabled by user)", sample_rate);
            }
            (SampleFormat::F32, candidates[0].1.clone(), false)
        }
    };

    let out_rate = wave_fmt.get_samplespersec() as usize;
    let out_ch = wave_fmt.get_nchannels() as usize;
    let blockalign = wave_fmt.get_blockalign() as usize;

    let (def_period, min_period) = audio_client.get_periods().map_err(|e| fmt_err(&*e))?;
    let sharemode = if exclusive { ShareMode::Exclusive } else { ShareMode::Shared };
    let period = if exclusive {
        // Target ~10 ms (100_000 in 100-ns reftime units), or 2× device minimum
        // if that's larger. The previous 1.5× min_period was too aggressive —
        // any decode hiccup glitched the DAC. 10 ms is still imperceptible for
        // pause/seek latency but gives ample headroom for FLAC packet decode.
        let target = 100_000i64.max(2 * min_period);
        audio_client
            .calculate_aligned_period_near(target, Some(128), &wave_fmt)
            .map_err(|e| fmt_err(&*e))?
    } else {
        def_period
    };

    log::info!(
        "WASAPI: {} {}ch @ {}Hz  blockalign={}  period={}",
        if exclusive { "EXCLUSIVE" } else { "SHARED" },
        out_ch, out_rate, blockalign, period
    );

    // Shared mode: enable auto-convert so the mixer handles resampling.
    // Exclusive mode: convert MUST be false (driver gets raw samples).
    let convert = !exclusive;
    audio_client
        .initialize_client(&wave_fmt, period, &Direction::Render, &sharemode, convert)
        .map_err(|e| format!("initialize_client: {}", fmt_err(&*e)))?;

    let event = audio_client.set_get_eventhandle().map_err(|e| fmt_err(&*e))?;
    let render = audio_client.get_audiorenderclient().map_err(|e| fmt_err(&*e))?;

    // Optional resume seek before we emit the initial state. Done on the
    // format reader directly; the main loop's playback will pick up from
    // here without ever advertising position 0 to the UI.
    let mut initial_position_frames: u64 = 0;
    if let Some(secs) = start_secs {
        if secs > 0.0 && secs < duration_secs {
            use symphonia::core::formats::{SeekMode, SeekTo};
            use symphonia::core::units::Time;
            let _ = format_reader.seek(
                SeekMode::Accurate,
                SeekTo::Time { time: Time::from(secs), track_id: Some(track_id) },
            );
            initial_position_frames = (secs * out_rate as f64) as u64;
        }
    }
    let initial_position_secs = initial_position_frames as f64 / out_rate as f64;

    // Update state with track info
    {
        let mut s = state.lock().unwrap();
        s.track = Some(TrackInfo {
            path: path.display().to_string(),
            duration: duration_secs,
            sample_rate,
            channels: src_channels as u32,
            bits_per_sample: bits,
            codec: format!("{:?}", params.codec),
        });
        s.duration = duration_secs;
        s.position = initial_position_secs;
        s.playing = true;
        s.exclusive = exclusive;
    }
    let _ = app.emit("playback-state", state.lock().unwrap().clone());

    // ── Decoder ─────────────────────────────────────────────────────
    let mut decoder = symphonia::default::get_codecs()
        .make(&params, &DecoderOptions::default())
        .map_err(|e| e.to_string())?;

    let total_buf_frames = audio_client.get_bufferframecount().map_err(|e| fmt_err(&*e))?;

    // ── Buffers + timers ────────────────────────────────────────────
    let mut sample_queue: Vec<f32> = Vec::with_capacity(out_rate * out_ch);
    let mut position_frames: u64 = initial_position_frames;
    let mut paused = false;
    let mut eof = false;
    let mut queued_next: Option<PathBuf> = None;

    // Reusable buffers for the WASAPI hot path. Pre-sizing them here keeps the
    // write loop allocation-free — every `vec![]` or `convert_to_bytes` that
    // returned a fresh Vec was costing a malloc + memset 100× per second, and
    // those allocator spikes are exactly what causes audio-thread jitter and
    // the click-on-busy-system that we want to eliminate.
    let max_bytes = total_buf_frames as usize * blockalign;
    let mut wire_buf: Vec<u8> = Vec::with_capacity(max_bytes);
    let mut silence_buf: Vec<u8> = Vec::with_capacity(max_bytes);
    // SampleBuffer<f32> is heap-backed and sized per decoded packet — we hold
    // it across packets so the second-and-later packets reuse the same alloc.
    // Gapless track-switch resets this to None (spec may change).
    let mut sample_buf: Option<SampleBuffer<f32>> = None;

    let mut last_progress = Instant::now();
    let mut last_spectrum = Instant::now();
    let mut spectrum_accum: Vec<f32> = Vec::new();

    const FFT_SIZE: usize = 1024;
    const BINS: usize = 22;
    // Spectrum scratch buffers + precomputed Hann window + log bin indices
    // live in one struct owned by play_file. Without this, every 33 ms tick
    // allocated ~12 KB of Vecs and recomputed 1024 cosines + 22 exp calls.
    let mut spectrum = SpectrumComputer::new(FFT_SIZE, BINS);

    // Keep a generous backlog of decoded audio in the queue so we never
    // underrun even if a FLAC packet decode is briefly slow. Exclusive mode
    // is especially sensitive — we use the larger of 16× the WASAPI buffer
    // OR 500 ms of audio, whichever is bigger. Both numbers chosen to absorb
    // any reasonable decode hiccup.
    let queue_target = {
        let buf_x16 = (total_buf_frames as usize * out_ch).saturating_mul(16);
        let half_sec = (out_rate * out_ch) / 2;
        buf_x16.max(half_sec)
    };

    // Pre-fill JUST enough to cover the first WASAPI write (≈4 buffers worth).
    // The steady-state queue depth (queue_target) is much larger but doesn't
    // need to be filled before start_stream — the main loop tops it up as
    // playback progresses. Using the full queue_target for pre-fill made
    // hi-res tracks (192 kHz) wait ~500ms+ to start audio.
    let prefill_target = (total_buf_frames as usize * out_ch).saturating_mul(4);
    decode_into(&mut format_reader, &mut decoder, track_id, &mut sample_queue, &mut sample_buf, prefill_target, &mut eof, out_ch);

    audio_client.start_stream().map_err(|e| fmt_err(&*e))?;

    // App-level gain, applied per sample before WASAPI write. 1.0 = unity.
    // Read from the engine-wide volume (preserved across plays so a fresh
    // track doesn't blast at unity gain for the first 50 ms).
    let mut local_volume: f32 = *volume;

    // ReplayGain linear gain for this track. Computed from stored LUFS and
    // the user's target LUFS by the Tauri layer; sent as SetTrackGain just
    // before each Play command. Combined with volume at the wire conversion
    // step so the EQ stage sees unscaled samples.
    let mut local_rg_gain: f32 = *track_gain;

    // Parametric EQ processor — built from settings + current sample_rate.
    // None if EQ is disabled or there are no active bands.
    let mut eq_processor: Option<EqProcessor> = if eq_settings.enabled && !eq_settings.bands.is_empty() {
        Some(EqProcessor::from_settings(eq_settings, sample_rate, out_ch))
    } else {
        None
    };

    // Crossfade state — populated when the trigger fires; None otherwise.
    // `xf_skip_current_queued` is a one-shot latch that prevents retrying
    // the trigger every iteration if the queued-next track can't be
    // crossfaded (different sample rate, or open failure). Reset by
    // QueueNext so a new candidate gets a fresh chance.
    let mut crossfade: Option<CrossfadeState> = None;
    let mut xf_skip_current_queued = false;

    // ── Main loop ───────────────────────────────────────────────────
    loop {
        // Commands (non-blocking)
        loop {
            match rx.try_recv() {
                Ok(AudioCommand::Stop) => {
                    let _ = audio_client.stop_stream();
                    return Ok(PlayResult::Stopped);
                }
                Ok(AudioCommand::Pause) if !paused => {
                    if exclusive {
                        // Release the device entirely so other apps can use
                        // it while we're paused. Outer loop holds path + pos
                        // and re-enters play_file on Resume.
                        let _ = audio_client.stop_stream();
                        let pos = position_frames as f64 / out_rate as f64;
                        let mut s = state.lock().unwrap();
                        s.playing = false;
                        s.position = pos;
                        let _ = app.emit("playback-state", s.clone());
                        return Ok(PlayResult::Paused(path_for_restart.clone(), pos));
                    } else {
                        // Shared mode doesn't hold the device exclusively, so
                        // an in-place stream stop is enough — no need to tear
                        // down and rebuild on resume.
                        let _ = audio_client.stop_stream();
                        paused = true;
                        let mut s = state.lock().unwrap();
                        s.playing = false;
                        let _ = app.emit("playback-state", s.clone());
                    }
                }
                Ok(AudioCommand::Resume) if paused => {
                    let _ = audio_client.start_stream();
                    paused = false;
                    let mut s = state.lock().unwrap();
                    s.playing = true;
                    let _ = app.emit("playback-state", s.clone());
                }
                Ok(AudioCommand::Seek(secs)) => {
                    use symphonia::core::formats::{SeekMode, SeekTo};
                    use symphonia::core::units::Time;
                    let _ = format_reader.seek(
                        SeekMode::Accurate,
                        SeekTo::Time { time: Time::from(secs), track_id: Some(track_id) },
                    );
                    decoder.reset();
                    sample_queue.clear();
                    position_frames = (secs * out_rate as f64) as u64;
                    // Clear biquad history to avoid filter transients at the splice.
                    if let Some(ref mut proc) = eq_processor { proc.reset(); }
                }
                Ok(AudioCommand::Volume(v)) => {
                    local_volume = v.clamp(0.0, 1.0);
                    *volume = local_volume;
                }
                Ok(AudioCommand::SetEq(s)) => {
                    *eq_settings = s;
                    eq_processor = if eq_settings.enabled && !eq_settings.bands.is_empty() {
                        Some(EqProcessor::from_settings(eq_settings, sample_rate, out_ch))
                    } else {
                        None
                    };
                }
                Ok(AudioCommand::SetTrackGain(g)) => {
                    local_rg_gain = g.unwrap_or(1.0);
                    *track_gain = local_rg_gain;
                }
                Ok(AudioCommand::Play(new_path, new_start)) => {
                    let _ = audio_client.stop_stream();
                    return Ok(PlayResult::Switch(new_path, new_start));
                }
                Ok(AudioCommand::SetDevice(id)) => {
                    // Switch render device by restarting playback from the
                    // current position on the new device. Brief silence while
                    // the new WASAPI client initializes.
                    *preferred_device_id = Some(id);
                    let pos = state.lock().unwrap().position;
                    let _ = audio_client.stop_stream();
                    return Ok(PlayResult::Switch(path_for_restart.clone(), Some(pos)));
                }
                Ok(AudioCommand::SetExclusiveMode(b)) => {
                    if *exclusive_enabled != b {
                        *exclusive_enabled = b;
                        let pos = state.lock().unwrap().position;
                        let _ = audio_client.stop_stream();
                        return Ok(PlayResult::Switch(path_for_restart.clone(), Some(pos)));
                    }
                }
                Ok(AudioCommand::QueueNext(p)) => {
                    queued_next = Some(p);
                    // Re-arm the crossfade trigger for the new candidate.
                    xf_skip_current_queued = false;
                }
                Ok(AudioCommand::SetCrossfade(c)) => {
                    *xf_config = c;
                }
                Ok(AudioCommand::Quit) | Err(TryRecvError::Disconnected) => {
                    let _ = audio_client.stop_stream();
                    return Ok(PlayResult::Stopped);
                }
                Err(TryRecvError::Empty) | Ok(_) => break,
            }
        }

        if paused {
            thread::sleep(Duration::from_millis(10));
            continue;
        }

        // Ask WASAPI how much space is writable right now
        let writable_frames = audio_client
            .get_available_space_in_frames()
            .map_err(|e| fmt_err(&*e))? as usize;

        // Keep the decode queue topped up — well beyond what we're about to write
        decode_into(&mut format_reader, &mut decoder, track_id, &mut sample_queue, &mut sample_buf, queue_target, &mut eof, out_ch);

        // ── Crossfade trigger ───────────────────────────────────────
        // Shared mode only — exclusive WASAPI sends raw samples to the DAC and
        // can't mix two streams. If the trigger conditions are all met and the
        // queued-next track happens to share our sample rate, kick off the
        // crossfade by opening a second decoder and pre-filling its queue.
        if crossfade.is_none()
            && !exclusive
            && xf_config.enabled
            && xf_config.duration_secs > 0.0
            && queued_next.is_some()
            && !xf_skip_current_queued
            && !eof
        {
            let total_track_frames = (duration_secs * out_rate as f64) as u64;
            // Clamp the fade to ≤ half the track length so we never start
            // before the first half has played. Floor at 250 ms so an absurd
            // setting (≈0) still feels like a soft fade rather than a click.
            let xf_total = ((xf_config.duration_secs * out_rate as f64) as u64)
                .min((total_track_frames / 2).max(1))
                .max((out_rate as u64) / 4);
            let remaining = total_track_frames.saturating_sub(position_frames);
            if remaining <= xf_total {
                let candidate = queued_next.take().unwrap();
                match try_open_for_gapless(&candidate, sample_rate) {
                    Some(gt) => {
                        // Build the crossfade state and pre-fill enough of the
                        // next queue to cover the first few WASAPI writes —
                        // matches the prefill we do for the gapless path so the
                        // fade-in doesn't start with silence.
                        let mut xf_state = CrossfadeState {
                            format_reader: gt.format_reader,
                            decoder: gt.decoder,
                            track_id: gt.track_id,
                            sample_queue: Vec::with_capacity(out_rate * out_ch),
                            sample_buf: None,
                            eof: false,
                            duration_secs: gt.duration_secs,
                            src_channels: gt.src_channels,
                            bits: gt.bits,
                            codec: gt.codec,
                            next_path: candidate,
                            pos_frames: 0,
                            total_frames: xf_total,
                            emitted_changed: false,
                            mix_buf: Vec::new(),
                        };
                        let prefill = (total_buf_frames as usize * out_ch).saturating_mul(4);
                        decode_into(
                            &mut xf_state.format_reader,
                            &mut xf_state.decoder,
                            xf_state.track_id,
                            &mut xf_state.sample_queue,
                            &mut xf_state.sample_buf,
                            prefill,
                            &mut xf_state.eof,
                            out_ch,
                        );
                        crossfade = Some(xf_state);
                    }
                    None => {
                        // Sample rate mismatch or open failure. Put the path
                        // back so the normal end-of-track Switch handles it,
                        // and latch the skip so we don't retry every iteration.
                        queued_next = Some(candidate);
                        xf_skip_current_queued = true;
                    }
                }
            }
        }

        let frames_avail = sample_queue.len() / out_ch;
        let frames_to_write = frames_avail.min(writable_frames);

        // ── Crossfade mix path ──────────────────────────────────────
        // When a fade is active, we mix the two queues into `xf.mix_buf`
        // with equal-power cos/sin curves and write that. EQ, volume and
        // RG gain all apply to the mixed signal exactly as in the normal
        // path. The fade ends — and we swap "next" to "current" — once
        // pos_frames reaches the configured total.
        if crossfade.is_some() {
            // Refill the next-track queue alongside the current one.
            // (Borrowing dance: take the mut ref inside a scoped block.)
            {
                let xf = crossfade.as_mut().unwrap();
                decode_into(
                    &mut xf.format_reader,
                    &mut xf.decoder,
                    xf.track_id,
                    &mut xf.sample_queue,
                    &mut xf.sample_buf,
                    queue_target,
                    &mut xf.eof,
                    out_ch,
                );
            }

            // Snapshot the borrowed bits we need outside the mut block.
            let next_avail = crossfade.as_ref().unwrap().sample_queue.len() / out_ch;
            let xf_pos = crossfade.as_ref().unwrap().pos_frames;
            let xf_total = crossfade.as_ref().unwrap().total_frames;

            let frames_in_xf_remaining = xf_total.saturating_sub(xf_pos) as usize;
            // Mix up to whichever is smallest of:
            //  - WASAPI's writable budget
            //  - what's left of the fade window
            //  - the larger of the two source queues (at least one must
            //    have samples, otherwise we'd write silence)
            let frames_to_mix = writable_frames
                .min(frames_in_xf_remaining)
                .min(frames_avail.max(next_avail));

            if frames_to_mix == 0 {
                // Both queues are dry mid-fade. Write silence to avoid an
                // underrun click; the next iteration will have data.
                if writable_frames > 0 {
                    let need = writable_frames * blockalign;
                    if silence_buf.len() < need { silence_buf.resize(need, 0); }
                    let _ = render.write_to_device(writable_frames, blockalign, &silence_buf[..need], None);
                }
            } else {
                let samples_to_mix = frames_to_mix * out_ch;
                use std::f64::consts::FRAC_PI_2;
                // Borrow mutably to fill mix_buf, then drop the borrow.
                {
                    let xf = crossfade.as_mut().unwrap();
                    if xf.mix_buf.len() < samples_to_mix { xf.mix_buf.resize(samples_to_mix, 0.0); }
                    let xf_total_f = xf_total as f64;
                    // Pre-take what we need from each source before draining,
                    // so the index arithmetic stays simple and bounds-clear.
                    for f in 0..frames_to_mix {
                        let t = (xf.pos_frames + f as u64) as f64 / xf_total_f;
                        let cg = (t * FRAC_PI_2).cos() as f32;
                        let ng = (t * FRAC_PI_2).sin() as f32;
                        for c in 0..out_ch {
                            let cs = if f < frames_avail {
                                sample_queue[f * out_ch + c]
                            } else { 0.0 };
                            let ns = if f < next_avail {
                                xf.sample_queue[f * out_ch + c]
                            } else { 0.0 };
                            xf.mix_buf[f * out_ch + c] = cs * cg + ns * ng;
                        }
                    }
                    // EQ runs on the mixed signal — biquad state stays
                    // continuous across the swap-over because the audio
                    // is genuinely contiguous (no resampling at the seam).
                    if let Some(ref mut proc) = eq_processor {
                        proc.process(&mut xf.mix_buf[..samples_to_mix], out_ch);
                    }
                    let combined_gain = local_volume * local_rg_gain;
                    convert_to_bytes_into(
                        &xf.mix_buf[..samples_to_mix],
                        output_fmt,
                        combined_gain,
                        &mut wire_buf,
                    );
                }
                render
                    .write_to_device(frames_to_mix, blockalign, &wire_buf, None)
                    .map_err(|e| fmt_err(&*e))?;

                // Drain both queues by what we actually consumed (one of
                // them may have been short of frames_to_mix).
                let cur_drain = (frames_to_mix * out_ch).min(sample_queue.len());
                let xf_drain  = (frames_to_mix * out_ch).min(crossfade.as_ref().unwrap().sample_queue.len());
                // Spectrum accumulator before drain — mixed signal is what's audible.
                {
                    let xf = crossfade.as_ref().unwrap();
                    spectrum_accum.extend_from_slice(&xf.mix_buf[..samples_to_mix]);
                }
                sample_queue.drain(..cur_drain);
                crossfade.as_mut().unwrap().sample_queue.drain(..xf_drain);

                let xf = crossfade.as_mut().unwrap();
                xf.pos_frames += frames_to_mix as u64;
                position_frames += frames_to_mix as u64;

                // Emit track-changed at the gain crossover (≥50% through the
                // fade). That's when the new track becomes the dominant
                // signal, so the UI's "now playing" label tracks user perception.
                if !xf.emitted_changed && xf.pos_frames * 2 >= xf.total_frames {
                    xf.emitted_changed = true;
                    let mut s = state.lock().unwrap();
                    s.track = Some(TrackInfo {
                        path: xf.next_path.display().to_string(),
                        duration: xf.duration_secs,
                        sample_rate,
                        channels: xf.src_channels as u32,
                        bits_per_sample: xf.bits,
                        codec: xf.codec.clone(),
                    });
                    s.duration = xf.duration_secs;
                    s.position = 0.0;
                    let _ = app.emit("playback-state", s.clone());
                    let _ = app.emit("track-changed", ());
                }
            }

            // Swap-over: take ownership of the crossfade state and replace
            // the "current" decoder with it. Sample queue, format reader,
            // and sample_buf all move over so the post-fade hot path
            // continues with the new track at zero position.
            let needs_swap = crossfade
                .as_ref()
                .map(|xf| xf.pos_frames >= xf.total_frames)
                .unwrap_or(false);
            if needs_swap {
                let xf_owned = crossfade.take().unwrap();
                format_reader    = xf_owned.format_reader;
                decoder          = xf_owned.decoder;
                track_id         = xf_owned.track_id;
                duration_secs    = xf_owned.duration_secs;
                // Track-info locals carry over so that any subsequent
                // gapless/crossfade switch starts from the right metadata.
                // The current run reads them only via the midpoint emit
                // (which used `xf.bits` directly), so the compiler flags
                // these as dead — keep them written for future emits.
                #[allow(unused_assignments)] {
                    src_channels = xf_owned.src_channels;
                    bits         = xf_owned.bits;
                }
                path_for_restart = xf_owned.next_path;
                sample_queue     = xf_owned.sample_queue;
                sample_buf       = xf_owned.sample_buf;
                eof              = xf_owned.eof;
                position_frames  = 0;
                last_progress    = Instant::now();
                last_spectrum    = Instant::now();
                spectrum_accum.clear();
                if let Some(ref mut proc) = eq_processor { proc.reset(); }
                // Allow a fresh crossfade as soon as the frontend pre-queues
                // the next-next track.
                xf_skip_current_queued = false;
            }
        } else if frames_to_write == 0 {
            if eof && sample_queue.is_empty() {
                // All decoded audio for this track has been written to WASAPI.
                // The hardware buffer is still draining — don't stop the stream.
                if let Some(next_path) = queued_next.take() {
                    match try_open_for_gapless(&next_path, sample_rate) {
                        Some(gt) => {
                            // Same sample rate → swap decoders without stopping
                            // the stream. The WASAPI buffer still has the tail
                            // of the current track playing while we pre-fill
                            // from the next one — zero audible gap.
                            let gapless_codec = gt.codec; // extract String before partial moves
                            format_reader    = gt.format_reader;
                            decoder          = gt.decoder;
                            track_id         = gt.track_id;
                            duration_secs    = gt.duration_secs;
                            src_channels     = gt.src_channels;
                            bits             = gt.bits;
                            path_for_restart = next_path.clone();
                            eof = false;
                            position_frames = 0;
                            last_progress = Instant::now();
                            last_spectrum = Instant::now();
                            spectrum_accum.clear();
                            // Spec (channels / bit depth) may differ across tracks
                            // even at matching rate — discard the old SampleBuffer
                            // so decode_into rebuilds one with the new spec.
                            sample_buf = None;
                            // Reset biquad delay states to prevent filter transients
                            // at the track boundary.
                            if let Some(ref mut proc) = eq_processor { proc.reset(); }
                            // Pre-decode enough frames so the next write loop
                            // iteration has data ready immediately.
                            let prefill = (total_buf_frames as usize * out_ch).saturating_mul(4);
                            decode_into(&mut format_reader, &mut decoder, track_id,
                                        &mut sample_queue, &mut sample_buf, prefill, &mut eof, out_ch);
                            // Notify UI using the now-updated local variables.
                            {
                                let mut s = state.lock().unwrap();
                                s.track = Some(TrackInfo {
                                    path: next_path.display().to_string(),
                                    duration: duration_secs,
                                    sample_rate,
                                    channels: src_channels as u32,
                                    bits_per_sample: bits,
                                    codec: gapless_codec,
                                });
                                s.duration = duration_secs;
                                s.position = 0.0;
                                let _ = app.emit("playback-state", s.clone());
                            }
                            let _ = app.emit("track-changed", ());
                        }
                        None => {
                            // Different sample rate or unreadable file.
                            // Must reinit WASAPI — brief gap is unavoidable.
                            let _ = app.emit("track-changed", ());
                            let _ = audio_client.stop_stream();
                            return Ok(PlayResult::Switch(next_path, None));
                        }
                    }
                } else {
                    // Queue exhausted — normal end.
                    let _ = audio_client.stop_stream();
                    return Ok(PlayResult::Ended);
                }
            } else if !eof {
                // Decoder hiccup / queue momentarily dry — write silence to
                // prevent an underrun click rather than stalling. Reusable
                // silence_buf stays all-zero across calls (never overwritten)
                // so we only pay the zero-init memset once on first growth.
                if writable_frames > 0 {
                    let need = writable_frames * blockalign;
                    if silence_buf.len() < need {
                        silence_buf.resize(need, 0);
                    }
                    let _ = render.write_to_device(writable_frames, blockalign, &silence_buf[..need], None);
                }
            }
            // else: eof set but queue not yet drained (writable_frames was 0) — wait.
        } else {
            let samples_to_write = frames_to_write * out_ch;
            // EQ stage: apply preamp + biquad chain in-place before conversion.
            // Operates on the head of the decode queue directly to avoid an
            // extra copy; the slice is drained immediately after the write.
            if let Some(ref mut proc) = eq_processor {
                proc.process(&mut sample_queue[..samples_to_write], out_ch);
            }
            // Volume (user fader) × ReplayGain = combined wire gain.
            // Clipping is handled inside convert_to_bytes_into (values are
            // clamped to ±1 before scaling to the integer target range).
            let combined_gain = local_volume * local_rg_gain;
            convert_to_bytes_into(&sample_queue[..samples_to_write], output_fmt, combined_gain, &mut wire_buf);
            render.write_to_device(frames_to_write, blockalign, &wire_buf, None)
                .map_err(|e| fmt_err(&*e))?;

            // Spectrum accumulator (pre-fader for consistent visual)
            spectrum_accum.extend_from_slice(&sample_queue[..samples_to_write]);
            sample_queue.drain(..samples_to_write);
            position_frames += frames_to_write as u64;
        }

        // Wait for buffer to drain enough for next write
        if event.wait_for_event(1000).is_err() {
            eprintln!("[audio] event timeout");
            if eof && sample_queue.is_empty() {
                let _ = audio_client.stop_stream();
                return Ok(PlayResult::Ended);
            }
            continue;
        }

        // Progress event at 250 ms — the scrubber still feels smooth at 4 Hz
        // (250 ms is well within the CSS transition window), and dropping
        // from 10 Hz cuts React re-renders 2.5× during playback.
        if last_progress.elapsed() >= Duration::from_millis(250) {
            let pos = position_frames as f64 / out_rate as f64;
            let mut s = state.lock().unwrap();
            s.position = pos;
            let _ = app.emit("playback-state", s.clone());
            last_progress = Instant::now();
        }

        // Spectrum event at ~30 Hz. Feed exactly FFT_SIZE * out_ch interleaved
        // samples so that after downmix-to-mono we have FFT_SIZE samples matching
        // the FFT plan. SpectrumComputer keeps the FFT plan + Hann window +
        // scratch Vecs + bin indices around between calls — zero per-tick allocs.
        //
        // We emit a `Vec<u8>` (0..=255 quantised bar heights) rather than a
        // `Vec<f32>`. JSON-encoded the byte stream is roughly half the size
        // of the equivalent float array — and crucially the JS-side parse
        // cost drops in proportion. 8-bit precision is below visual threshold
        // for a 22-bar visualiser.
        let needed = FFT_SIZE * out_ch;
        if last_spectrum.elapsed() >= Duration::from_millis(33) && spectrum_accum.len() >= needed {
            let bins = spectrum.compute_u8(&spectrum_accum[..needed], out_ch).to_vec();
            let _ = app.emit("spectrum-bins", bins);
            spectrum_accum.clear();
            last_spectrum = Instant::now();
        }
    }

    // Unreachable: every loop exit returns explicitly. Compiler can't tell.
    #[allow(unreachable_code)]
    {
        let _ = audio_client.stop_stream();
        Ok(PlayResult::Stopped)
    }
}

// Helper: decode packets into the sample queue up to `target_samples`.
// `sample_buf` is a caller-owned scratch buffer reused across packets so we
// don't allocate a fresh SampleBuffer<f32> every ~10–20 ms. The first packet
// of a track lazily creates it; the gapless switch resets it to None.
fn decode_into(
    format_reader: &mut Box<dyn symphonia::core::formats::FormatReader>,
    decoder: &mut Box<dyn symphonia::core::codecs::Decoder>,
    track_id: u32,
    sample_queue: &mut Vec<f32>,
    sample_buf: &mut Option<SampleBuffer<f32>>,
    target_samples: usize,
    eof: &mut bool,
    out_ch: usize,
) {
    while !*eof && sample_queue.len() < target_samples {
        match format_reader.next_packet() {
            Ok(packet) => {
                if packet.track_id() != track_id { continue; }
                match decoder.decode(&packet) {
                    Ok(decoded) => {
                        let spec = *decoded.spec();
                        let cap = decoded.capacity() as u64;
                        // Lazily create on first packet of this track. Recreate
                        // only if the decoder ever returns a packet larger than
                        // the current capacity (rare; codec-dependent).
                        let needs_new = match sample_buf.as_ref() {
                            Some(sb) => (sb.capacity() as u64) < cap,
                            None => true,
                        };
                        if needs_new {
                            *sample_buf = Some(SampleBuffer::<f32>::new(cap, spec));
                        }
                        let sbuf = sample_buf.as_mut().unwrap();
                        sbuf.copy_interleaved_ref(decoded);
                        let src = sbuf.samples();
                        let sch = spec.channels.count();
                        if sch == out_ch {
                            sample_queue.extend_from_slice(src);
                        } else {
                            for frame in src.chunks(sch) {
                                let l = frame[0];
                                let r = if sch > 1 { frame[1] } else { l };
                                sample_queue.push(l);
                                sample_queue.push(r);
                            }
                        }
                    }
                    Err(symphonia::core::errors::Error::DecodeError(e)) => {
                        log::warn!("Decode skip: {e}");
                    }
                    Err(_) => { *eof = true; break; }
                }
            }
            Err(_) => { *eof = true; break; }
        }
    }
}

// ── Crossfade state ─────────────────────────────────────────────────
// Holds the secondary decoder + sample queue while a fade is in flight.
// Created when the trigger fires (current track within `duration_secs` of
// end + queued_next available + sample rates match + shared mode). Lives
// on the stack of play_file; swapped to "current" once the fade finishes.
struct CrossfadeState {
    format_reader: Box<dyn symphonia::core::formats::FormatReader>,
    decoder: Box<dyn symphonia::core::codecs::Decoder>,
    track_id: u32,
    sample_queue: Vec<f32>,
    sample_buf: Option<SampleBuffer<f32>>,
    eof: bool,
    duration_secs: f64,
    src_channels: usize,
    bits: u32,
    codec: String,
    next_path: PathBuf,
    /// Frames mixed so far in this fade. Used to drive the cos/sin curves.
    pos_frames: u64,
    /// Total frames covered by the fade (== duration_secs × out_rate, clamped).
    total_frames: u64,
    /// Whether we've already emitted the `track-changed` event for the
    /// fade-in track. We fire it at the midpoint (gain crossover) so the UI
    /// switches when the new track becomes the dominant signal.
    emitted_changed: bool,
    /// Reused scratch for the mixed output samples. Sized to writable_frames *
    /// out_ch and never shrinks — keeps the hot path allocation-free.
    mix_buf: Vec<f32>,
}

// ── Gapless: probe the next file without opening a new WASAPI client ─
struct GaplessTrack {
    format_reader: Box<dyn symphonia::core::formats::FormatReader>,
    decoder:       Box<dyn symphonia::core::codecs::Decoder>,
    track_id:      u32,
    duration_secs: f64,
    src_channels:  usize,
    bits:          u32,
    codec:         String,
}

/// Open `path` and verify it can be played on the already-running WASAPI
/// stream (i.e. same sample rate). Returns `None` if the file can't be
/// opened, decoded, or has a different sample rate.
fn try_open_for_gapless(path: &PathBuf, required_rate: u32) -> Option<GaplessTrack> {
    let file = std::fs::File::open(path).ok()?;
    let mss  = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .ok()?;
    let format_reader = probed.format;
    let track    = format_reader.default_track()?.clone();
    let track_id = track.id;
    let params   = track.codec_params.clone();
    let sample_rate = params.sample_rate.unwrap_or(44100);
    if sample_rate != required_rate {
        eprintln!(
            "[audio] gapless: {} Hz → {} Hz (rate change, WASAPI reinit needed)",
            required_rate, sample_rate
        );
        return None;
    }
    let src_channels  = params.channels.map(|c| c.count()).unwrap_or(2);
    let bits          = params.bits_per_sample.unwrap_or(24);
    let duration_secs = params.n_frames
        .map(|n| n as f64 / sample_rate as f64)
        .unwrap_or(0.0);
    let codec   = format!("{:?}", params.codec);
    let decoder = symphonia::default::get_codecs()
        .make(&params, &DecoderOptions::default())
        .ok()?;
    Some(GaplessTrack { format_reader, decoder, track_id, duration_secs, src_channels, bits, codec })
}

// ── Spectrum ────────────────────────────────────────────────────────
//
// Owns the FFT plan, a precomputed Hann window, and the mono+complex scratch
// buffers. Without this struct each spectrum tick (30 Hz) was allocating two
// fresh Vecs (~12 KB) and recomputing 1024 cosines — pure waste because none
// of those values change between calls.
struct SpectrumComputer {
    fft: Arc<dyn rustfft::Fft<f32>>,
    hann: Vec<f32>,
    mono: Vec<f32>,
    buf: Vec<Complex<f32>>,
    /// Pre-computed FFT-bin ranges `[lo, hi)` per visual bar.
    ///
    /// Earlier revisions stored a single index per bar and read just
    /// `buf[idx].norm()`. That's wrong for a log-spaced visualiser:
    /// at low frequencies each bar covers 1–2 FFT bins (so the chosen
    /// bin captures ~all the band's energy) but at high frequencies
    /// each bar covers 50+ FFT bins (so the chosen bin captures <2 %
    /// of the band). The visual outcome was a bass-heavy strip with
    /// the top end stuck near zero regardless of the actual content.
    ///
    /// Storing the full range lets us compute peak magnitude over the
    /// whole band, which is the standard music-visualiser convention
    /// and gives a balanced display across the spectrum.
    bin_ranges: Vec<(usize, usize)>,
    /// Per-bar additive lift in dB. Music's natural spectrum drops
    /// ~3 dB/octave at high frequencies (the "pink" roll-off); without
    /// compensation, the right side of the chart looks subdued even on
    /// content that *does* have real high-frequency information.
    /// We apply 0 dB at the lowest bar and +12 dB at the highest, linear
    /// across the bars. 12 dB sits at the "visible but not overdriven"
    /// sweet spot — bright EDM still has headroom; classical recordings
    /// finally show some sparkle.
    bar_lifts_db: Vec<f32>,
    /// Re-used output buffer. Was a fresh `Vec::with_capacity(num_bins)`
    /// every tick → 30 small allocations per second of playback. Now zero.
    out: Vec<f32>,
    /// Quantised mirror of `out`, [0..=255]. We emit this (not `out`) so the
    /// IPC payload is half the size of a JSON float array — at 30 Hz with
    /// 22 bars the wire savings are modest in absolute terms but cut the
    /// JS-side parse work in proportion. The visualiser doesn't notice
    /// 8-bit quantisation since each bar is at most ~50 px tall.
    out_u8: Vec<u8>,
    /// 1 / sqrt(size) — precomputed normaliser applied to each FFT magnitude.
    inv_norm: f32,
    size: usize,
}

impl SpectrumComputer {
    fn new(size: usize, num_bins: usize) -> Self {
        let fft = FftPlanner::<f32>::new().plan_fft_forward(size);
        // Hann window: identical for every frame — precompute once.
        let denom = (size - 1).max(1) as f32;
        let hann: Vec<f32> = (0..size)
            .map(|i| 0.5 * (1.0 - (2.0 * std::f32::consts::PI * i as f32 / denom).cos()))
            .collect();

        // Log-spaced bar ranges `[lo, hi)` so bar 0 covers the lowest
        // octave-ish slice and the last bar covers the highest. We
        // compute the starts first (same log curve as before) then pair
        // them up; the final bar's `hi` runs to Nyquist.
        let half = size / 2;
        let (bin_ranges, bar_lifts_db): (Vec<(usize, usize)>, Vec<f32>) =
            if half == 0 || num_bins == 0 {
                (Vec::new(), Vec::new())
            } else {
                let log_min = (2.0_f32).ln();
                let log_max = (half as f32).ln();
                let denom_bins = (num_bins - 1).max(1) as f32;
                let starts: Vec<usize> = (0..num_bins)
                    .map(|i| {
                        let t = i as f32 / denom_bins;
                        ((log_min + t * (log_max - log_min)).exp() as usize).min(half - 1)
                    })
                    .collect();

                let mut ranges: Vec<(usize, usize)> = Vec::with_capacity(num_bins);
                for i in 0..num_bins {
                    let lo = starts[i];
                    let hi = if i + 1 < num_bins {
                        starts[i + 1].max(lo + 1)
                    } else {
                        half
                    };
                    ranges.push((lo, hi));
                }

                // Pink-rolloff comp in dB. 0 → +12 dB across the bars.
                let lifts: Vec<f32> = (0..num_bins)
                    .map(|i| (i as f32 / denom_bins) * 12.0)
                    .collect();

                (ranges, lifts)
            };

        let inv_norm = 1.0 / (size as f32).sqrt().max(1.0);

        Self {
            fft,
            hann,
            mono: Vec::with_capacity(size),
            buf: Vec::with_capacity(size),
            bin_ranges,
            bar_lifts_db,
            out: Vec::with_capacity(num_bins),
            out_u8: Vec::with_capacity(num_bins),
            inv_norm,
            size,
        }
    }

    /// Compute one frame of `num_bins` bar heights and return a borrowed
    /// slice into the cached output buffer. The caller copies (or `.to_vec()`s)
    /// before the next tick if it needs to retain it.
    fn compute(&mut self, samples: &[f32], channels: usize) -> &[f32] {
        let n = self.size;
        let inv_ch = 1.0 / channels as f32;

        // Mono downmix into the reusable scratch — clear keeps capacity.
        self.mono.clear();
        for frame in samples.chunks(channels).take(n) {
            let sum: f32 = frame.iter().sum();
            self.mono.push(sum * inv_ch);
        }

        // Apply window + lift into complex domain. Reuse the same complex buf.
        let m = self.mono.len();
        self.buf.clear();
        for i in 0..m {
            self.buf.push(Complex {
                re: self.mono[i] * self.hann[i],
                im: 0.0,
            });
        }

        self.fft.process(&mut self.buf);

        // Peak-per-band, then convert to dB for display.
        //
        // Why dB: music's dynamic range across the audible spectrum is
        // huge — bass content typically peaks ~30 dB hotter than treble
        // (a 30× factor in linear amplitude). Linear-scale bars will
        // always read as left-heavy no matter what weight curve we
        // multiply by. Spectrum analyzers solve this by displaying
        // 20·log10(magnitude) so each octave occupies a comparable
        // chunk of visual height.
        //
        // We map [DB_FLOOR, 0] dB → [0, 1] visual height. Anything
        // quieter than DB_FLOOR is invisible (no bar). 54 dB of range
        // matches what most studio meters show before the floor is
        // visually noisy. The per-bar +0..+12 dB lift then balances
        // music's natural pink rolloff.
        const DB_FLOOR: f32 = -54.0;
        const DB_INV_RANGE: f32 = 1.0 / 54.0;

        self.out.clear();
        for (i, &(lo, hi)) in self.bin_ranges.iter().enumerate() {
            let mut peak: f32 = 0.0;
            for j in lo..hi {
                // SAFETY: bin_ranges is precomputed with hi ≤ size/2 ≤ size
                // and the FFT writes exactly `size` complex values into `buf`.
                // Bounds-check elision saves measurable cycles in the hot loop
                // (22 bars × up to ~60 bins per bar × 30 Hz).
                let mag = unsafe { self.buf.get_unchecked(j) }.norm();
                if mag > peak {
                    peak = mag;
                }
            }
            // Convert peak to dB; clamp the input to a tiny floor so
            // log10 of complete silence doesn't produce -∞.
            let normalized = peak * self.inv_norm;
            let peak_db = 20.0 * normalized.max(1e-6).log10();
            let lifted_db = peak_db + self.bar_lifts_db[i];
            let v = ((lifted_db - DB_FLOOR) * DB_INV_RANGE).clamp(0.0, 1.0);
            self.out.push(v);
        }
        &self.out
    }

    /// Same as `compute`, but quantises the bar heights to `u8` (0..=255)
    /// and returns a borrowed `&[u8]`. The caller `.to_vec()`s it for the
    /// IPC emit — that's the only allocation in the spectrum path.
    fn compute_u8(&mut self, samples: &[f32], channels: usize) -> &[u8] {
        let _ = self.compute(samples, channels);
        self.out_u8.clear();
        for &v in &self.out {
            // Round-to-nearest with implicit clamp via `clamp` above.
            self.out_u8.push((v * 255.0 + 0.5) as u8);
        }
        &self.out_u8
    }
}

// ── Classify a negotiated WaveFormat into one of our SampleFormats ──
// The DAC may accept a substituted format the quirks layer found, so we
// inspect what was actually returned rather than what we asked for.
fn classify_format(bits: u16, valid: u16, st: &Option<wasapi::SampleType>) -> Option<SampleFormat> {
    match (bits, valid, st) {
        (32, 32, Some(wasapi::SampleType::Float)) => Some(SampleFormat::F32),
        (24, 24, Some(wasapi::SampleType::Int))   => Some(SampleFormat::S24Packed),
        (32, 24, Some(wasapi::SampleType::Int))   => Some(SampleFormat::S24In32),
        (32, 32, Some(wasapi::SampleType::Int))   => Some(SampleFormat::S32),
        (16, 16, Some(wasapi::SampleType::Int))   => Some(SampleFormat::S16),
        _ => None,
    }
}

// ── Float-source → output-format little-endian bytes ────────────────
//
// Internal pipeline is always 32-bit float, range [-1.0, +1.0]. This
// applies app-level volume and emits the wire format the DAC negotiated.
// Writes into `out` in place — the caller owns the buffer and reuses it
// across writes, so we avoid a ~30 KB malloc+memset on every WASAPI write
// (~100/sec) that was driving allocator pressure on the audio thread.
//
// `out` is resized to the exact byte count for this batch. After the first
// few writes its capacity stabilizes at the max batch size and the resize
// becomes a free `set_len`.
//
// Note on bit-perfect: the FLAC decoder → f32 step costs ~1 ULP of
// precision for 24-bit sources (f32 has 23 bits of mantissa). For practical
// listening this is inaudible — full bit-perfect would require an i32
// internal path that bypasses f32 entirely (future work).
fn convert_to_bytes_into(samples: &[f32], fmt: SampleFormat, volume: f32, out: &mut Vec<u8>) {
    // chunks_exact_mut gives the compiler a fixed-stride iteration with no
    // aliasing — much easier to auto-vectorize than indexed `out[i*N..i*N+N]`,
    // and removes the bounds check on every store.
    match fmt {
        SampleFormat::F32 => {
            out.resize(samples.len() * 4, 0);
            for (chunk, &s) in out.chunks_exact_mut(4).zip(samples.iter()) {
                let v = s * volume;
                chunk.copy_from_slice(&v.to_le_bytes());
            }
        }
        SampleFormat::S24Packed => {
            // Packed 24-bit signed: 3 bytes per sample, little-endian.
            // No container padding. Range [-2^23, 2^23-1]. This is what the
            // Dragonfly Red (and many USB Class 1 DACs) exposes in exclusive
            // mode — they do NOT accept 24-in-32 at all.
            out.resize(samples.len() * 3, 0);
            for (chunk, &s) in out.chunks_exact_mut(3).zip(samples.iter()) {
                let v = (s * volume).clamp(-1.0, 1.0);
                let scaled = (v * 8388607.0).round() as i32; // 2^23 - 1
                chunk[0] =  (scaled        & 0xFF) as u8;
                chunk[1] = ((scaled >> 8)  & 0xFF) as u8;
                chunk[2] = ((scaled >> 16) & 0xFF) as u8;
            }
        }
        SampleFormat::S24In32 => {
            // 24-bit signed sample left-justified into a 32-bit container.
            // DAC reads the high 24 bits as the audio value; low 8 bits are
            // padding (zero). Standard WAVE_FORMAT_EXTENSIBLE layout for
            // 24-in-32 PCM and what most consumer USB DACs expose.
            out.resize(samples.len() * 4, 0);
            for (chunk, &s) in out.chunks_exact_mut(4).zip(samples.iter()) {
                let v = (s * volume).clamp(-1.0, 1.0);
                let scaled_24 = (v * 8388607.0).round() as i32; // 2^23 - 1
                let stored = scaled_24 << 8;
                chunk.copy_from_slice(&stored.to_le_bytes());
            }
        }
        SampleFormat::S32 => {
            out.resize(samples.len() * 4, 0);
            for (chunk, &s) in out.chunks_exact_mut(4).zip(samples.iter()) {
                let v = (s * volume).clamp(-1.0, 1.0);
                let scaled = (v * 2147483647.0).round() as i32; // 2^31 - 1
                chunk.copy_from_slice(&scaled.to_le_bytes());
            }
        }
        SampleFormat::S16 => {
            out.resize(samples.len() * 2, 0);
            for (chunk, &s) in out.chunks_exact_mut(2).zip(samples.iter()) {
                let v = (s * volume).clamp(-1.0, 1.0);
                let scaled = (v * 32767.0).round() as i16;
                chunk.copy_from_slice(&scaled.to_le_bytes());
            }
        }
    }
}
