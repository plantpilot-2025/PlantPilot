import { norm } from "./util.ts";
import type { IntakeIrr, IrrSolvePlan, SopBundle, SopIrrBaseline } from "./types.ts";

export function buildWarnings(
  intake: IntakeIrr,
  plan: Omit<IrrSolvePlan, "warnings" | "coherence" | "actions">,
  bundle: SopBundle,
  sop: SopIrrBaseline | null
): { warnings: string[]; coherence: string[] } {
  const warnings: string[] = [];
  const coherence: string[] = [];
  const tol = bundle.tolerances ?? {};
  const p1Ok = tol.p1_ok_ml_day ?? 100;
  const p2Ok = tol.p2_ok_ml_day ?? 100;
  const warnThr = tol.warn_threshold_ml_day ?? 300;

  const p1d = plan.p1.delta_day_ml;
  const p2d = plan.p2.delta_day_ml;

  const handwater = norm(intake.mode || "") === "handwater";

  if (p1d < -p1Ok) warnings.push(`P1 refill short: submitted P1 total cannot reach FC (short by ${Math.round(-p1d)} ml/day).`);
  else if (p1d > p1Ok) warnings.push(`P1 overfill: submitted P1 exceeds refill budget by ${Math.round(p1d)} ml/day.`);

  if (!handwater) {
    if (p2d < -p2Ok) warnings.push(`P2 short: submitted P2 total cannot maintain dryback + runoff target (short by ${Math.round(-p2d)} ml/day).`);
    else if (p2d > p2Ok) warnings.push(`P2 over: submitted P2 is heavy by ${Math.round(p2d)} ml/day.`);
  }

  if (plan.p2.events_user === 0 && plan.p2.user_day_ml > 0) {
    warnings.push("Flush mode: P2 events are 0 but P2 ml/event is set; P2 volume is ignored.");
  }

  if (handwater && Math.abs(p2d) > p2Ok) {
    coherence.push("Handwater mode: P2 automation checks are informational only.");
  }

  if (plan.p2.runoff_delta_frac < -0.02) {
    warnings.push(`Runoff missed: estimated runoff ${(plan.p2.estimated_runoff_frac * 100).toFixed(0)}%, target ${(plan.p2.runoff_target_frac * 100).toFixed(0)}%.`);
  } else if (plan.p2.runoff_delta_frac > 0.05) {
    warnings.push(`Runoff high: estimated runoff ${(plan.p2.estimated_runoff_frac * 100).toFixed(0)}% exceeds target ${(plan.p2.runoff_target_frac * 100).toFixed(0)}%.`);
  }

  const minInt = bundle.min_p2_interval_min ?? 15;
  if ((intake.p2IntervalMin ?? 60) < minInt) {
    warnings.push(`P2 interval may be too short (${intake.p2IntervalMin} min) for pump/absorption.`);
  }

  const pumpMin = bundle.pump_min_ml ?? 20;
  const pumpMax = bundle.pump_max_ml ?? 1500;
  if (plan.p2.ml_event_user < pumpMin) warnings.push(`P2 event volume (${plan.p2.ml_event_user} ml) may be below pump minimum (${pumpMin} ml).`);
  if (plan.p2.ml_event_user > pumpMax) warnings.push(`P2 event volume (${plan.p2.ml_event_user} ml) may risk saturation/PWEC shock.`);

  if (sop) {
    const sopP1Day = sop.p1_events * sop.p1_ml;
    const sopP2Day = sop.p2_events * sop.p2_ml;
    const userP1 = plan.p1.user_day_ml;
    const userP2 = plan.p2.user_day_ml;
    if (Math.abs(userP1 - sopP1Day) > warnThr || Math.abs(userP2 - sopP2Day) > warnThr) {
      warnings.push("Daily irrigation changed significantly from SOP baseline; watch EC/PWEC stability.");
    }
  }

  const cap = plan.media.whc_ml * 1.2;
  if (plan.total_required_day_ml > cap) {
    warnings.push("Required daily irrigation may exceed practical container water capacity.");
  }

  if (intake.targetAtFirst == null) {
    warnings.push("Missing Target at first event (VWC start); solver used fallback.");
  }

  if (intake.drybackPct24h != null && intake.targetAtFirst != null) {
    const expected = plan.media.fc_vwc - intake.targetAtFirst;
    if (Math.abs(expected - intake.drybackPct24h) > 2) {
      coherence.push(
        `Dryback mismatch: FC(${plan.media.fc_vwc.toFixed(1)}) - FirstEvent(${intake.targetAtFirst}) = ${expected.toFixed(1)} VWC points, but Overnight dryback target = ${intake.drybackPct24h}.`
      );
    }
  }

  const whcEffPct = plan.media.whc_ml > 0 ? (plan.total_required_day_ml / plan.media.whc_ml) * 100 : 0;
  if (whcEffPct > 120) {
    coherence.push(
      `WHC_eff mismatch: required daily volume (${Math.round(plan.total_required_day_ml)} ml) exceeds ~120% of WHC (${Math.round(plan.media.whc_ml)} ml).`
    );
  }

  if (Math.abs(p1d) <= p1Ok && Math.abs(p2d) <= p2Ok && plan.p2.runoff_delta_frac >= -0.02) {
    if (intake.p1Events !== sop?.p1_events) {
      coherence.push("Custom P1 event count still satisfies refill daily budget.");
    }
  }

  return { warnings, coherence };
}
