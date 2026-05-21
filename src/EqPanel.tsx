// Parametric EQ panel — split into its own module so the bundler can
// emit it as a separate chunk. The user doesn't see this UI on cold
// start, so deferring its JS keeps the initial parse+execute path on
// low-end CPUs as small as possible.

import type { EqBand, EqFilterType, EqSettings } from "./eqTypes";
import { DEFAULT_EQ_BANDS } from "./eqTypes";

const FILTER_LABELS: Record<EqFilterType, string> = {
  peak: "Peak", low_shelf: "Low Shelf", high_shelf: "High Shelf",
  low_pass: "Low Pass", high_pass: "High Pass", notch: "Notch", allpass: "All Pass",
};

const FILTER_HAS_GAIN: Record<EqFilterType, boolean> = {
  peak: true, low_shelf: true, high_shelf: true,
  low_pass: false, high_pass: false, notch: false, allpass: false,
};

interface EqPanelProps {
  open: boolean;
  onClose: () => void;
  eq: EqSettings;
  onChange: (eq: EqSettings) => void;
}

export default function EqPanel({ open, onClose, eq, onChange }: EqPanelProps) {
  if (!open) return null;

  const setEnabled = (v: boolean) => onChange({ ...eq, enabled: v });
  const setPreamp  = (v: number)  => onChange({ ...eq, preamp_db: v });

  const setBand = (i: number, patch: Partial<EqBand>) =>
    onChange({ ...eq, bands: eq.bands.map((b, n) => n === i ? { ...b, ...patch } : b) });

  const numInput = (
    label: string, value: number, min: number, max: number, step: number,
    disabled: boolean, onVal: (v: number) => void
  ) => (
    <input
      type="number"
      min={min} max={max} step={step}
      value={value}
      disabled={disabled}
      onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v)) onVal(v); }}
      style={{
        width: "100%", background: disabled ? "transparent" : "var(--bg)",
        border: "1px solid var(--line-strong)", borderRadius: 2,
        color: disabled ? "var(--text-faint)" : "var(--text)",
        fontFamily: "var(--mono)", fontSize: 10,
        padding: "3px 5px", textAlign: "right", outline: "none",
        MozAppearance: "textfield",
      }}
      title={label}
    />
  );

  const col = (flex?: number | string, align?: string) => ({
    flex: flex ?? 1,
    display: "flex", alignItems: "center",
    justifyContent: align ?? "center",
    padding: "0 4px",
  });

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 300,
      display: "flex", alignItems: "flex-end", justifyContent: "center",
      pointerEvents: "none",
    }}>
      {/* Click-away overlay */}
      <div
        style={{ position: "absolute", inset: 0, pointerEvents: "all" }}
        onClick={onClose}
      />
      <div style={{
        position: "relative", pointerEvents: "all",
        width: "min(860px, 96vw)",
        background: "var(--bg-elev)",
        border: "1px solid var(--line-strong)",
        borderBottom: "none",
        borderRadius: "6px 6px 0 0",
        boxShadow: "0 -8px 40px rgba(0,0,0,0.4)",
        padding: "18px 20px 20px",
        marginBottom: "73px", // height of NowPlayingBar
      }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 16 }}>
          <div style={{ fontFamily: "var(--serif)", fontStyle: "italic", fontSize: 16, color: "var(--text)", flex: 1 }}>
            Parametric EQ
          </div>

          {/* Preamp */}
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--sans)", letterSpacing: "0.08em" }}>PREAMP</span>
            <input
              type="range" min={-12} max={12} step={0.5} value={eq.preamp_db}
              onChange={(e) => setPreamp(parseFloat(e.target.value))}
              style={{ width: 80 }}
            />
            <span style={{ fontSize: 10, color: "var(--text)", fontFamily: "var(--mono)", width: 36, textAlign: "right" }}>
              {eq.preamp_db > 0 ? "+" : ""}{eq.preamp_db.toFixed(1)} dB
            </span>
          </div>

          {/* Enable toggle */}
          <button
            onClick={() => setEnabled(!eq.enabled)}
            style={{
              padding: "5px 12px",
              background: eq.enabled ? "var(--accent)" : "transparent",
              color: eq.enabled ? "var(--bg)" : "var(--text-dim)",
              border: eq.enabled ? 0 : "1px solid var(--line-strong)",
              borderRadius: 3, cursor: "pointer",
              fontFamily: "var(--sans)", fontSize: 10, letterSpacing: "0.12em",
              textTransform: "uppercase", fontWeight: 500,
            }}
          >{eq.enabled ? "On" : "Off"}</button>

          {/* Close */}
          <button
            onClick={onClose}
            style={{
              background: "transparent", border: 0, padding: 4,
              cursor: "pointer", color: "var(--text-faint)",
              display: "grid", placeItems: "center",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text)")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-faint)")}
          >
            <svg width="12" height="12" viewBox="0 0 12 12">
              <line x1="1" y1="1" x2="11" y2="11" stroke="currentColor" strokeWidth="1.5" />
              <line x1="11" y1="1" x2="1" y2="11" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </button>
        </div>

        {/* Column headers */}
        <div style={{
          display: "flex", alignItems: "center",
          borderBottom: "1px solid var(--line)",
          paddingBottom: 4, marginBottom: 4,
          fontSize: 9, color: "var(--text-faint)", fontFamily: "var(--sans)",
          letterSpacing: "0.12em", textTransform: "uppercase",
        }}>
          <div style={{ ...col(0.5), justifyContent: "flex-start" }}>On</div>
          <div style={{ ...col(2), justifyContent: "flex-start" }}>Filter</div>
          <div style={col(1.2)}>Freq (Hz)</div>
          <div style={col(1)}>Gain (dB)</div>
          <div style={col(0.9)}>Q</div>
          <div style={col(0.5, "flex-end")}>Reset</div>
        </div>

        {/* Band rows */}
        {eq.bands.map((band, i) => {
          const hasGain = FILTER_HAS_GAIN[band.filter_type];
          const isActive = band.enabled && eq.enabled;
          return (
            <div key={i} style={{
              display: "flex", alignItems: "center",
              padding: "4px 0",
              borderBottom: "1px solid var(--line)",
              opacity: eq.enabled ? 1 : 0.5,
            }}>
              {/* Enabled toggle */}
              <div style={{ ...col(0.5), justifyContent: "flex-start" }}>
                <input
                  type="checkbox" checked={band.enabled}
                  onChange={(e) => setBand(i, { enabled: e.target.checked })}
                  style={{ accentColor: "var(--accent)", cursor: "pointer" }}
                />
              </div>

              {/* Filter type */}
              <div style={{ ...col(2), justifyContent: "flex-start" }}>
                <select
                  value={band.filter_type}
                  onChange={(e) => setBand(i, { filter_type: e.target.value as EqFilterType })}
                  style={{
                    width: "100%", background: "var(--bg)",
                    border: "1px solid var(--line-strong)", borderRadius: 2,
                    color: isActive ? "var(--text)" : "var(--text-dim)",
                    fontFamily: "var(--sans)", fontSize: 10,
                    padding: "3px 5px", outline: "none", cursor: "pointer",
                  }}
                >
                  {(Object.keys(FILTER_LABELS) as EqFilterType[]).map((ft) => (
                    <option key={ft} value={ft}>{FILTER_LABELS[ft]}</option>
                  ))}
                </select>
              </div>

              {/* Frequency */}
              <div style={col(1.2)}>
                {numInput("Frequency (Hz)", band.frequency, 20, 20000, 1, false,
                  (v) => setBand(i, { frequency: Math.round(v) }))}
              </div>

              {/* Gain */}
              <div style={col(1)}>
                {numInput("Gain (dB)", band.gain_db, -24, 24, 0.5, !hasGain,
                  (v) => setBand(i, { gain_db: v }))}
              </div>

              {/* Q */}
              <div style={col(0.9)}>
                {numInput("Q", band.q, 0.1, 20, 0.1, false,
                  (v) => setBand(i, { q: v }))}
              </div>

              {/* Reset band */}
              <div style={{ ...col(0.5), justifyContent: "flex-end" }}>
                <button
                  onClick={() => setBand(i, { gain_db: 0, q: 1.0, enabled: false })}
                  title="Reset band"
                  style={{
                    background: "transparent", border: 0, padding: "3px 5px",
                    cursor: "pointer", color: "var(--text-faint)",
                    fontFamily: "var(--mono)", fontSize: 9,
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text)")}
                  onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-faint)")}
                >↺</button>
              </div>
            </div>
          );
        })}

        {/* Footer: reset all */}
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
          <button
            onClick={() => onChange({ ...eq, preamp_db: 0, bands: DEFAULT_EQ_BANDS })}
            style={{
              background: "transparent", border: "1px solid var(--line-strong)",
              borderRadius: 3, color: "var(--text-dim)", cursor: "pointer",
              fontFamily: "var(--sans)", fontSize: 10, letterSpacing: "0.10em",
              textTransform: "uppercase", padding: "5px 12px",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "var(--text)")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "var(--text-dim)")}
          >Reset all</button>
        </div>
      </div>
    </div>
  );
}
