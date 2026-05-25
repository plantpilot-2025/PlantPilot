export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export function num(v: unknown, fallback?: number): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback ?? null;
}

export function norm(s: string): string {
  return String(s || "").toLowerCase().trim().replace(/\s+/g, " ");
}

export function profileKey(profile: string): string {
  return norm(profile).replace(/[^a-z0-9]+/g, "");
}

/** Strip "1 gal" / "5 gal" to bundle key digit (matches media.ts). */
export function normalizeContainerGal(container?: string): string {
  const digits = String(container ?? "1").replace(/[^\d.]/g, "");
  const n = Math.round(Number(digits) || 1);
  return String(Math.max(1, Math.min(10, n)));
}

export function irrKey(phase: string, container: string, media: string, profile: string): string {
  const gal = normalizeContainerGal(container);
  return `${norm(phase)}|${gal}|${norm(media)}|${profileKey(profile)}`;
}

/** Map stage name to 1-based week index (13-week crop). */
export function weekIndexFromStage(stage: string, totalWeeks = 13): number {
  const s = norm(stage);
  const map: Record<string, number> = {
    "early veg": 1,
    "late veg": 4,
    "early bloom": 5,
    "mid bloom": 7,
    "late bloom": 10,
    flush: 13,
  };
  for (const [k, w] of Object.entries(map)) {
    if (s.includes(k)) return w;
  }
  return Math.ceil(totalWeeks / 2);
}

export const SOLVER_VERSION = "irr-physics-1.0.0";

export const POT_MEDIA_ML: Record<string, number> = {
  "1": 3785,
  "2": 7571,
  "3": 11356,
  "5": 18927,
  "7": 26498,
  "10": 37854,
};
