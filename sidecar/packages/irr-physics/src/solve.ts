import { baseDrybackPctHr, demandLabel, whcPct } from "./curves.ts";
import { resolveMedia } from "./media.ts";
import { applyReconciledFields, sopDefaults } from "./reconcile.ts";
import {
  clamp,
  irrKey,
  norm,
  num,
  profileKey,
  SOLVER_VERSION,
  weekIndexFromStage,
} from "./util.ts";
import { buildWarnings } from "./warnings.ts";
import type { IntakeIrr, IrrSolvePlan, SolveInput, SopIrrBaseline } from "./types.ts";

function demandScalars(intake: IntakeIrr, bundle: { sop_temp_c?: number }) {
  const tempC = num(intake.tempC, 24) ?? 24;
  const sopT = bundle.sop_temp_c ?? 24;
  const tempFactor = clamp(Math.pow(2, (tempC - sopT) / 10), 0.6, 1.8);

  const vpd = num(intake.vpdKpa, 1.2) ?? 1.2;
  const vpdFactor = clamp(Math.pow(vpd / 1.2, 0.6), 0.75, 1.35);

  const dli = num(intake.dliMol, 35) ?? 35;
  const dliFactor = clamp(Math.pow(dli / 35, 0.5), 0.7, 1.4);

  let co2Factor = 1.0;
  const co2 = num(intake.co2, 450) ?? 450;
  if (norm(intake.co2Mode || "") === "co2") {
    co2Factor = clamp(1 + 0.1 * ((co2 - 450) / 750), 1, 1.1);
  }

  const dryback_pct_hr =
    baseDrybackPctHr(weekIndexFromStage(intake.stage || "", bundle.total_weeks ?? 13), bundle as any) *
    tempFactor *
    vpdFactor *
    dliFactor *
    co2Factor;

  const demand_index = clamp((tempFactor - 0.6) / (1.8 - 0.6) * 0.4 + (vpdFactor - 0.75) / 0.6 * 0.3 + (dliFactor - 0.7) / 0.7 * 0.3, 0, 1);

  return { dryback_pct_hr, demand_index, tempC, vpd, dli, co2, tempFactor, vpdFactor, dliFactor, co2Factor };
}

export function solveIrr(input: SolveInput): IrrSolvePlan {
  const { intake, sopBundle, dirty } = input;
  const bundle = sopBundle;

  const phase = intake.stage || "mid bloom";
  const media = intake.medium || "coco";
  const container = intake.container || "1";
  const profile = intake.profile || "Athena Pro";
  const key = irrKey(phase, container, media, profile);
  const sop: SopIrrBaseline | null = bundle.irr[key] ?? null;

  if (!sop) {
    return {
      ok: false,
      error: `No SOP irrigation baseline for ${key}`,
      solver_version: SOLVER_VERSION,
      media: { media_ml: 0, whc_pct: 0, fc_vwc: 0, vwc_start: 0, whc_ml: 0 },
      demand: { demand_index: 0, demand_label: "LOW", dryback_pct_hr: 0, dbPct_interval: 0 },
      p1: emptyP1(),
      p2: emptyP2(),
      p1_required_day_ml: 0,
      p2_required_day_ml: 0,
      total_required_day_ml: 0,
      warnings: [],
      coherence: [],
      actions: { resetToSop: {}, keepUser: {}, applyReconciled: {} },
    };
  }

  const weekIdx = intake.weekIndex ?? weekIndexFromStage(phase, bundle.total_weeks ?? 13);
  const whc = whcPct(weekIdx, bundle);
  const fc_vwc = whc;
  const { mediaMl, potGal } = resolveMedia(intake, bundle, fc_vwc);
  const vwc_start = num(intake.targetAtFirst, fc_vwc - 15) ?? fc_vwc - 15;

  const handwater = norm(intake.mode || "") === "handwater";
  const p1Events = Math.max(1, Math.round(num(intake.p1Events, sop.p1_events) ?? sop.p1_events));
  const p2Events = handwater ? 0 : Math.max(0, Math.round(num(intake.p2Events, sop.p2_events) ?? sop.p2_events));
  const p1Interval = Math.max(1, num(intake.p1IntervalMin, 30) ?? 30);
  const p2Interval = Math.max(1, num(intake.p2IntervalMin, 60) ?? 60);
  const p1Ml = Math.max(0, num(intake.p1MlPerEvent, sop.p1_ml) ?? sop.p1_ml);
  const p2Ml = Math.max(0, num(intake.p2MlPerEvent, sop.p2_ml) ?? sop.p2_ml);
  const runoffPct = num(intake.runoffPct, sop.runoffPct) ?? sop.runoffPct;
  const runoffFrac = clamp(runoffPct / 100, 0, 0.5);

  const { dryback_pct_hr, demand_index, tempC, vpd, dli, co2 } = demandScalars(intake, bundle);
  const dbPct_interval = dryback_pct_hr * (p2Interval / 60);

  const refill_gap_pct = Math.max(0, fc_vwc - vwc_start);
  const w_refill_ml = mediaMl * (refill_gap_pct / 100);
  const p1_duration_hr = clamp(((Math.max(1, p1Events) - 1) * p1Interval) / 60, 0, 24);
  const p1_dryback_during_refill_ml = mediaMl * (dryback_pct_hr / 100) * p1_duration_hr;
  const p1_required_day_ml = w_refill_ml + p1_dryback_during_refill_ml;

  const w_maint_event_ml = mediaMl * (dbPct_interval / 100);
  const p2_required_event_ml = p2Events > 0 && runoffFrac < 1 ? w_maint_event_ml / (1 - runoffFrac) : 0;
  const p2_required_day_ml = p2Events * p2_required_event_ml;

  const p1_user_day_ml = p1Events * p1Ml;
  const p2_user_day_ml = p2Events * p2Ml;
  const p1_delta_day_ml = p1_user_day_ml - p1_required_day_ml;
  const p2_delta_day_ml = p2_user_day_ml - p2_required_day_ml;

  let estimated_runoff_frac = 0;
  if (p2Ml > w_maint_event_ml && p2Ml > 0) {
    estimated_runoff_frac = (p2Ml - w_maint_event_ml) / p2Ml;
  }
  const runoff_delta_frac = estimated_runoff_frac - runoffFrac;

  const p1_ml_recon = Math.round(p1_required_day_ml / p1Events);
  const p2_ml_recon = Math.round(p2_required_event_ml);

  const basePlan = {
    ok: true as const,
    base_key_effective: `${norm(phase)}|${num(intake.photoperiodH, 12)}|day|co2`,
    cfg_key_effective: key,
    sop_bundle_version: bundle.version,
    solver_version: SOLVER_VERSION,
    media: {
      pot_gal: potGal,
      media_ml: mediaMl,
      whc_pct: whc,
      fc_vwc,
      vwc_start,
      whc_ml: mediaMl * (whc / 100),
    },
    demand: {
      tempC: tempC ?? undefined,
      vpdKpa: vpd ?? undefined,
      dliMol: dli ?? undefined,
      co2: co2 ?? undefined,
      demand_index,
      demand_label: demandLabel(demand_index),
      dryback_pct_hr,
      dbPct_interval,
    },
    p1: {
      events_user: p1Events,
      interval_min_user: p1Interval,
      ml_event_user: p1Ml,
      user_day_ml: p1_user_day_ml,
      required_day_ml: p1_required_day_ml,
      delta_day_ml: p1_delta_day_ml,
      events_reconciled: p1Events,
      ml_event_reconciled: p1_ml_recon,
      fc_vwc,
      vwc_start,
      w_refill_ml,
    },
    p2: {
      events_user: p2Events,
      interval_min_user: p2Interval,
      ml_event_user: p2Ml,
      user_day_ml: p2_user_day_ml,
      maintenance_event_ml: w_maint_event_ml,
      runoff_target_frac: runoffFrac,
      required_event_ml: p2_required_event_ml,
      required_day_ml: p2_required_day_ml,
      delta_day_ml: p2_delta_day_ml,
      estimated_runoff_frac,
      runoff_delta_frac,
      events_reconciled: p2Events,
      ml_event_reconciled: p2_ml_recon,
    },
    p1_required_day_ml,
    p2_required_day_ml,
    total_required_day_ml: p1_required_day_ml + p2_required_day_ml,
    warnings: [] as string[],
    coherence: [] as string[],
    actions: {
      resetToSop: sopDefaults(sop, runoffPct),
      keepUser: { ...pickIrr(intake) },
      applyReconciled: applyReconciledFields(
        intake,
        dirty,
        p1_required_day_ml,
        p2_required_event_ml,
        p2Events
      ),
    },
  };

  const { warnings, coherence } = buildWarnings(intake, basePlan, bundle, sop);
  return { ...basePlan, warnings, coherence };
}

function pickIrr(i: IntakeIrr): Partial<IntakeIrr> {
  return {
    p1Events: i.p1Events,
    p1IntervalMin: i.p1IntervalMin,
    p1MlPerEvent: i.p1MlPerEvent,
    p1Pct: i.p1Pct,
    p2Events: i.p2Events,
    p2IntervalMin: i.p2IntervalMin,
    p2MlPerEvent: i.p2MlPerEvent,
    p2Pct: i.p2Pct,
    runoffPct: i.runoffPct,
  };
}

function emptyP1() {
  return {
    events_user: 0,
    ml_event_user: 0,
    user_day_ml: 0,
    required_day_ml: 0,
    delta_day_ml: 0,
    events_reconciled: 0,
    ml_event_reconciled: 0,
    fc_vwc: 0,
    vwc_start: 0,
    w_refill_ml: 0,
  };
}

function emptyP2() {
  return {
    events_user: 0,
    interval_min_user: 60,
    ml_event_user: 0,
    user_day_ml: 0,
    maintenance_event_ml: 0,
    runoff_target_frac: 0,
    required_event_ml: 0,
    required_day_ml: 0,
    delta_day_ml: 0,
    estimated_runoff_frac: 0,
    runoff_delta_frac: 0,
    events_reconciled: 0,
    ml_event_reconciled: 0,
  };
}

/** Cockpit reality-delta view (daily budgets). */
export function buildRealityDelta(plan: IrrSolvePlan) {
  if (!plan.ok) return { ok: false, error: plan.error };
  return {
    ok: true,
    base_key_effective: plan.base_key_effective,
    cfg_key_effective: plan.cfg_key_effective,
    sop_bundle_version: plan.sop_bundle_version,
    solver_version: plan.solver_version,
    demand_index: plan.demand.demand_index,
    demand_label: plan.demand.demand_label,
    dbPct_interval: plan.demand.dbPct_interval,
    w_maint_event_ml: plan.p2.maintenance_event_ml,
    p2_runoff_frac: plan.p2.runoff_target_frac,
    fc_vwc: plan.media.fc_vwc,
    vwc_start: plan.media.vwc_start,
    w_refill_ml: plan.p1.w_refill_ml,
    v_media_ml: plan.media.media_ml,
    w_maint_day_ml: plan.p2.events_reconciled * plan.p2.maintenance_event_ml,
    p1_required_day_ml: plan.p1_required_day_ml,
    p2_required_day_ml: plan.p2_required_day_ml,
    total_required_day_ml: plan.total_required_day_ml,
    p1: plan.p1,
    p2: plan.p2,
    delta: {
      user: {
        p1_user_day_ml: plan.p1.user_day_ml,
        p1_required_day_ml: plan.p1.required_day_ml,
        p1_delta_day_ml: plan.p1.delta_day_ml,
        p1_status: statusFromDelta(plan.p1.delta_day_ml, 100),
        p2_user_day_ml: plan.p2.user_day_ml,
        p2_required_day_ml: plan.p2.required_day_ml,
        p2_delta_day_ml: plan.p2.delta_day_ml,
        p2_status: statusFromDelta(plan.p2.delta_day_ml, 100),
        estimated_runoff_frac: plan.p2.estimated_runoff_frac,
        runoff_target_frac: plan.p2.runoff_target_frac,
        runoff_delta_frac: plan.p2.runoff_delta_frac,
      },
    },
    warnings: plan.warnings,
    coherence: plan.coherence,
  };
}

function statusFromDelta(d: number, tol: number): "ON" | "SHORT" | "OVER" {
  if (Math.abs(d) <= tol) return "ON";
  return d < 0 ? "SHORT" : "OVER";
}
