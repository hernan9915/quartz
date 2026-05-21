// EQ types + default settings. Kept in a separate tiny module so App.tsx
// can statically import them without dragging in the EqPanel JSX module
// (which lives in ./EqPanel.tsx and is lazy-loaded). Without this split,
// Vite would emit a warning and bundle EqPanel.tsx back into the main
// chunk because of the static `import { DEFAULT_EQ }` from App.tsx.

export type EqFilterType =
  | "peak" | "low_shelf" | "high_shelf"
  | "low_pass" | "high_pass" | "notch" | "allpass";

export interface EqBand {
  enabled: boolean;
  filter_type: EqFilterType;
  frequency: number; // Hz
  gain_db: number;   // dB — only used by peak/shelf filters
  q: number;         // quality factor
}

export interface EqSettings {
  enabled: boolean;
  preamp_db: number;
  bands: EqBand[];
}

export const DEFAULT_EQ_BANDS: EqBand[] = [
  { enabled: false, filter_type: "high_pass",  frequency: 20,    gain_db: 0, q: 0.707 },
  { enabled: false, filter_type: "low_shelf",  frequency: 80,    gain_db: 0, q: 0.707 },
  { enabled: false, filter_type: "peak",       frequency: 200,   gain_db: 0, q: 1.0   },
  { enabled: false, filter_type: "peak",       frequency: 500,   gain_db: 0, q: 1.0   },
  { enabled: false, filter_type: "peak",       frequency: 1000,  gain_db: 0, q: 1.0   },
  { enabled: false, filter_type: "peak",       frequency: 2000,  gain_db: 0, q: 1.0   },
  { enabled: false, filter_type: "peak",       frequency: 4000,  gain_db: 0, q: 1.0   },
  { enabled: false, filter_type: "peak",       frequency: 8000,  gain_db: 0, q: 1.0   },
  { enabled: false, filter_type: "high_shelf", frequency: 12000, gain_db: 0, q: 0.707 },
  { enabled: false, filter_type: "low_pass",   frequency: 20000, gain_db: 0, q: 0.707 },
];

export const DEFAULT_EQ: EqSettings = { enabled: false, preamp_db: 0, bands: DEFAULT_EQ_BANDS };
