/** Intake key ↔ sheet label (subset used by evaluate). */
export const key2label: Record<string, string> = {
  stage: "Stage",
  stagePhase: "Stage",
  medium: "Media",
  container: "Container_gal",
  containerSize: "Container_gal",
  co2Mode: "CO2 mode",
  lightcycle: "Lightcycle",
  photoperiodH: "Photoperiod (h)",
  mode: "Mode",
  profile: "SOP profile",
  tempC: "Canopy temp (°C)",
  rh: "RH (%)",
  vpdKpa: "VPD (kPa)",
  ppfd: "PPFD (µmol/m²/s)",
  dliMol: "DLI (mol/m²/d)",
  co2: "CO2 (ppm)",
  runoffPh: "Runoff pH",
  runoffPct: "Runoff %",
  reservoirEc: "Reservoir EC (mS/cm)",
  reservoirPh: "Reservoir pH",
  reservoirTempC: "Reservoir temp (°C)",
  pwec: "PWEC (mS/cm)",
  vwcAtLastIrr: "VWC% at last irrigation",
  runoffEc: "Runoff EC (mS/cm)",
  drybackPct24h: "Overnight dryback % target",
  targetAtFirst: "Target at first event",
  p1Events: "P1 events",
  p1IntervalMin: "P1 interval (min)",
  p1Pct: "P1 %",
  p1MlPerEvent: "ml per P1 event",
  p2Events: "P2 events",
  p2IntervalMin: "P2 interval (min)",
  p2Pct: "P2 %",
  p2MlPerEvent: "ml per P2 event",
};

export const label2key: Record<string, string> = Object.fromEntries(
  Object.entries(key2label).map(([k, v]) => [v, k])
);

export const labelAliases: Record<string, string> = {
  "Dryback last 24h (%)": "drybackPct24h",
};

export function labelToKey(label: string): string | undefined {
  return label2key[label] ?? labelAliases[label];
}

export function labelsToIntake(labels: Record<string, string | number>): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const [label, value] of Object.entries(labels || {})) {
    const key = labelToKey(label) ?? label;
    if (value === "" || value == null) continue;
    const n = Number(value);
    out[key] = Number.isFinite(n) && String(value).trim() !== "" ? n : String(value);
  }
  return out;
}
