// Vibrant-color extraction from album cover art.
//
// Picks a single accent color per album for the dynamic-accent feature.
// Approach:
//   1. Decode the cover image (image crate, already a dep for thumbnailing).
//   2. Downscale to 96×96 nearest-neighbour. The original art is often 600+
//      pixels per side; we don't need that much fidelity for one color.
//      Nearest is fine here — bilinear would smear neighbouring colors
//      together and dull the result.
//   3. Convert each pixel to HSL, filter out muddy / too-dark / too-light
//      pixels so the result actually pops on a dark UI.
//   4. Bucket surviving pixels by hue (24 buckets, 15° each). Score each
//      bucket by (count × mean saturation) — a small but very saturated
//      patch beats a big muddy field, which is what you'd intuit when
//      eyeballing an album cover.
//   5. Take the winning bucket's weighted-mean HSL and clamp lightness
//      into a UI-friendly band before converting back to hex.
//
// We don't use a heavyweight quantizer (k-means, octree) because:
//   - This runs on the main thread during a play_file call and we want
//     it to be under ~20 ms even on a slow machine; histogram + filter
//     is O(n) over 9216 pixels which is trivial.
//   - The output is one color used as a UI tint, not a precise palette.
//     The k-means "centroid drift" doesn't buy us anything visible.
//
// If extraction fails (file missing, corrupt image, all pixels filtered
// out by the saturation gate), returns None and the frontend falls back
// to the user's chosen Settings accent.

use image::GenericImageView;
use std::path::Path;

/// Number of hue buckets. 24 = 15° each, a sweet spot between "every
/// magenta variation gets its own bin" (too granular, splits the vote)
/// and "warm vs cool only" (too coarse, picks bland averages).
const HUE_BUCKETS: usize = 24;

/// Saturation floor — below this the pixel is too gray to be an accent.
/// 0.22 lets in soft pastels (think Lorde's _Melodrama_ cover) but kills
/// noisy near-grayscale areas (vinyl groove patterns, foil embossing).
const MIN_SAT: f32 = 0.22;

/// Lightness band. Below MIN_L the pixel is essentially black; above
/// MAX_L it's too washed-out. Both extremes look terrible as accents.
const MIN_L: f32 = 0.18;
const MAX_L: f32 = 0.82;

/// Downscale target. 96×96 = 9216 pixels — enough to capture the dominant
/// hue zones of a typical album cover without spending real CPU.
const RESIZE_DIM: u32 = 96;

/// Output lightness clamp. Even if the source is very dark or very bright,
/// the returned accent sits in a band that reads as a tint on either a
/// dark or light UI background. Tuned by eyeballing ~40 album covers.
const OUT_L_MIN: f32 = 0.42;
const OUT_L_MAX: f32 = 0.68;

/// Extract the dominant vibrant color from an album cover at `cover_path`.
/// Returns `Some("#rrggbb")` on success, `None` if the file can't be read,
/// can't be decoded, or has no pixels that pass the saturation gate.
pub fn extract_accent(cover_path: &Path) -> Option<String> {
    let img = image::open(cover_path).ok()?;

    // Downscale before we touch individual pixels. Nearest because we want
    // to preserve the original color values; bilinear would average and
    // dull the result.
    let small = img.resize_exact(RESIZE_DIM, RESIZE_DIM, image::imageops::FilterType::Nearest);

    // Per-bucket accumulators: (count, sum_hue, sum_sat, sum_lit, sat_weight).
    // sat_weight is used to score buckets; we want highly saturated pixels
    // to count for more than barely-saturated ones in the SAME bucket.
    let mut buckets = vec![(0u32, 0.0f32, 0.0f32, 0.0f32, 0.0f32); HUE_BUCKETS];
    let mut admitted = 0u32;

    for (_x, _y, p) in small.pixels() {
        let [r, g, b, a] = p.0;
        // Skip fully-transparent pixels (rare in album art, but PNGs with
        // alpha channels do happen).
        if a < 32 { continue; }
        let (h, s, l) = rgb_to_hsl(r, g, b);
        if s < MIN_SAT { continue; }
        if l < MIN_L || l > MAX_L { continue; }
        admitted += 1;
        // Hue is 0..360; bucket by floor((h / 360) * HUE_BUCKETS).
        let bucket = ((h / 360.0) * HUE_BUCKETS as f32) as usize;
        let bucket = bucket.min(HUE_BUCKETS - 1);
        let acc = &mut buckets[bucket];
        acc.0 += 1;
        acc.1 += h;
        acc.2 += s;
        acc.3 += l;
        acc.4 += s; // double-count saturation: once into mean, once into score
    }

    if admitted == 0 { return None; }

    // Pick the bucket with the highest (count × mean_sat) score. Using mean
    // rather than sum prevents a giant low-saturation field from beating a
    // small but vibrant focal area.
    let (best_idx, _) = buckets
        .iter()
        .enumerate()
        .filter(|(_, acc)| acc.0 > 0)
        .map(|(i, acc)| {
            let mean_sat = acc.4 / acc.0 as f32;
            let score = acc.0 as f32 * mean_sat;
            (i, score)
        })
        .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))?;

    let acc = &buckets[best_idx];
    let count = acc.0 as f32;
    let mean_h = acc.1 / count;
    let mean_s = (acc.2 / count).min(1.0);
    let mean_l = (acc.3 / count).clamp(OUT_L_MIN, OUT_L_MAX);

    let (r, g, b) = hsl_to_rgb(mean_h, mean_s, mean_l);
    Some(format!("#{:02x}{:02x}{:02x}", r, g, b))
}

/// Standard RGB-to-HSL conversion. Inputs are 0..255 ints; output is
/// (hue 0..360, sat 0..1, lit 0..1).
fn rgb_to_hsl(r: u8, g: u8, b: u8) -> (f32, f32, f32) {
    let rf = r as f32 / 255.0;
    let gf = g as f32 / 255.0;
    let bf = b as f32 / 255.0;
    let max = rf.max(gf).max(bf);
    let min = rf.min(gf).min(bf);
    let l = (max + min) / 2.0;
    if (max - min).abs() < f32::EPSILON {
        return (0.0, 0.0, l); // gray
    }
    let d = max - min;
    let s = if l > 0.5 { d / (2.0 - max - min) } else { d / (max + min) };
    let h = if max == rf {
        ((gf - bf) / d) + if gf < bf { 6.0 } else { 0.0 }
    } else if max == gf {
        ((bf - rf) / d) + 2.0
    } else {
        ((rf - gf) / d) + 4.0
    };
    (h * 60.0, s, l)
}

/// Inverse of rgb_to_hsl. h in 0..360, s/l in 0..1; returns 0..255 ints.
fn hsl_to_rgb(h: f32, s: f32, l: f32) -> (u8, u8, u8) {
    if s.abs() < f32::EPSILON {
        let v = (l * 255.0).round() as u8;
        return (v, v, v);
    }
    let q = if l < 0.5 { l * (1.0 + s) } else { l + s - l * s };
    let p = 2.0 * l - q;
    let h_norm = (h / 360.0).rem_euclid(1.0);
    let r = hue_to_rgb(p, q, h_norm + 1.0 / 3.0);
    let g = hue_to_rgb(p, q, h_norm);
    let b = hue_to_rgb(p, q, h_norm - 1.0 / 3.0);
    (
        (r * 255.0).round().clamp(0.0, 255.0) as u8,
        (g * 255.0).round().clamp(0.0, 255.0) as u8,
        (b * 255.0).round().clamp(0.0, 255.0) as u8,
    )
}

fn hue_to_rgb(p: f32, q: f32, mut t: f32) -> f32 {
    if t < 0.0 { t += 1.0; }
    if t > 1.0 { t -= 1.0; }
    if t < 1.0 / 6.0 { return p + (q - p) * 6.0 * t; }
    if t < 1.0 / 2.0 { return q; }
    if t < 2.0 / 3.0 { return p + (q - p) * (2.0 / 3.0 - t) * 6.0; }
    p
}
