import type { IrrSolvePlan } from "./types.ts";

/** Flatten solver output for web UI and audit probes (backward-compatible keys). */
export function flattenSolvePlan(plan: IrrSolvePlan): Record<string, unknown> {
  if (!plan.ok) {
    return { ok: false, error: plan.error, solver_version: plan.solver_version };
  }

  const whcMl = plan.media.whc_ml || 0;
  const p1Pct =
    whcMl > 0 && plan.p1.ml_event_reconciled > 0
      ? Number(((plan.p1.ml_event_reconciled / whcMl) * 100).toFixed(3))
      : 0;
  const p2Pct =
    whcMl > 0 && plan.p2.ml_event_reconciled > 0
      ? Number(((plan.p2.ml_event_reconciled / whcMl) * 100).toFixed(3))
      : 0;

  return {
    ...plan,
    ok: true,
    base_key_effective: plan.cfg_key_effective ?? plan.base_key_effective,
    w_refill_ml: plan.p1.w_refill_ml,
    applied_req_ml_day: plan.p2_required_day_ml,
    et_base_ml_day: plan.total_required_day_ml,
    et_pred_ml_day: plan.total_required_day_ml,
    runoff_target_frac: plan.p2.runoff_target_frac,
    whc_eff_ml: whcMl,
    fc_vwc: plan.media.fc_vwc,
    vwc_start: plan.media.vwc_start,
    v_media_ml: plan.media.media_ml,
    demand_index: plan.demand.demand_index,
    dbPct_interval: plan.demand.dbPct_interval,
    w_maint_event_ml: plan.p2.maintenance_event_ml,
    p2_runoff_frac: plan.p2.runoff_target_frac,
    p1: {
      events: plan.p1.events_user,
      pct_whc_ideal: p1Pct,
      ml_event_ideal: plan.p1.ml_event_reconciled,
      ml_event_ideal_raw: plan.p1.ml_event_user,
      pct_whc_ideal_raw: p1Pct,
    },
    p2: {
      events: plan.p2.events_user,
      pct_whc_ideal: p2Pct,
      ml_event_ideal: plan.p2.ml_event_reconciled,
      ml_event_ideal_raw: plan.p2.ml_event_user,
      pct_whc_ideal_raw: p2Pct,
    },
    observed: {
      level: plan.coherence.length ? "PARTIAL" : "NONE",
      count: plan.coherence.length,
      notes: plan.coherence,
    },
  };
}
