import type { DirtyField, IntakeIrr, SopBundle, SopIrrBaseline } from "./types.ts";

export function sopDefaults(sop: SopIrrBaseline, runoffPct: number): Partial<IntakeIrr> {
  return {
    p1Events: sop.p1_events,
    p1MlPerEvent: sop.p1_ml,
    p1Pct: sop.p1_pct,
    p2Events: sop.p2_events,
    p2MlPerEvent: sop.p2_ml,
    p2Pct: sop.p2_pct,
    runoffPct,
  };
}

/** Recompute dependent fields after solve given dirty set. */
export function applyReconciledFields(
  intake: IntakeIrr,
  dirty: DirtyField[] | undefined,
  p1RequiredDay: number,
  p2RequiredEventMl: number,
  p2Events: number
): Partial<IntakeIrr> {
  const d = new Set(dirty ?? []);
  const out: Partial<IntakeIrr> = { ...intake };

  const p1e = Math.max(1, num(intake.p1Events) ?? 1);
  const p2e = Math.max(0, num(intake.p2Events) ?? 0);

  if (!d.has("p1MlPerEvent") || d.has("p1Events") || d.has("p1Pct")) {
    out.p1MlPerEvent = Math.round(p1RequiredDay / p1e);
  }
  if (!d.has("p2MlPerEvent") || d.has("p2Events") || d.has("p2IntervalMin") || d.has("runoffPct") || d.has("p2Pct")) {
    out.p2MlPerEvent = p2e > 0 ? Math.round(p2RequiredEventMl) : 0;
  }
  if (d.has("p1Events") && !d.has("p1IntervalMin") && intake.p1IntervalMin != null) {
    out.p1IntervalMin = intake.p1IntervalMin;
  }
  if (d.has("p2IntervalMin") || d.has("runoffPct")) {
    out.p2IntervalMin = intake.p2IntervalMin;
  }
  if (d.has("runoffPct") && intake.runoffPct != null) {
    out.runoffPct = intake.runoffPct;
  }

  return out;
}

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
