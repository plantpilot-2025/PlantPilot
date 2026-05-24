export type DirtyField =
  | "p1Events"
  | "p1IntervalMin"
  | "p1MlPerEvent"
  | "p1Pct"
  | "p2Events"
  | "p2IntervalMin"
  | "p2MlPerEvent"
  | "p2Pct"
  | "runoffPct";

export type IntakeIrr = {
  stage?: string;
  medium?: string;
  container?: string;
  profile?: string;
  mode?: string;
  photoperiodH?: number;
  tempC?: number;
  vpdKpa?: number;
  dliMol?: number;
  co2?: number;
  co2Mode?: string;
  runoffPct?: number;
  drybackPct24h?: number;
  targetAtFirst?: number;
  vwcAtLastIrr?: number;
  p1Events?: number;
  p1IntervalMin?: number;
  p1Pct?: number;
  p1MlPerEvent?: number;
  p2Events?: number;
  p2IntervalMin?: number;
  p2Pct?: number;
  p2MlPerEvent?: number;
  weekIndex?: number;
};

export type SopIrrBaseline = {
  runoffPct: number;
  p1_events: number;
  p1_pct: number;
  p1_ml: number;
  p2_events: number;
  p2_pct: number;
  p2_ml: number;
  vwc_floor?: number;
};

export type SopBundle = {
  profile: string;
  version: string;
  media_fill_factor?: number;
  total_weeks?: number;
  whc_start?: number;
  whc_end?: number;
  whc_k?: number;
  min_db_pct_hr?: number;
  max_db_pct_hr?: number;
  dryback_table_pct_hr?: number[];
  sop_temp_c?: number;
  tolerances?: {
    p1_ok_ml_day?: number;
    p2_ok_ml_day?: number;
    warn_threshold_ml_day?: number;
  };
  pump_min_ml?: number;
  pump_max_ml?: number;
  min_p2_interval_min?: number;
  media?: Record<string, { v_media_ml?: number; fc_vwc?: number; vwc_floor?: number }>;
  irr: Record<string, SopIrrBaseline>;
};

export type IrrSolvePlan = {
  ok: boolean;
  error?: string;
  base_key_effective?: string;
  cfg_key_effective?: string;
  sop_bundle_version?: string;
  solver_version: string;
  media: {
    pot_gal?: number;
    media_ml: number;
    whc_pct: number;
    fc_vwc: number;
    vwc_start: number;
    whc_ml: number;
  };
  demand: {
    tempC?: number;
    vpdKpa?: number;
    dliMol?: number;
    co2?: number;
    demand_index: number;
    demand_label: "LOW" | "MED" | "HIGH";
    dryback_pct_hr: number;
    dbPct_interval: number;
  };
  p1: {
    events_user: number;
    interval_min_user?: number;
    ml_event_user: number;
    user_day_ml: number;
    required_day_ml: number;
    delta_day_ml: number;
    events_reconciled: number;
    ml_event_reconciled: number;
    fc_vwc: number;
    vwc_start: number;
    w_refill_ml: number;
  };
  p2: {
    events_user: number;
    interval_min_user: number;
    ml_event_user: number;
    user_day_ml: number;
    maintenance_event_ml: number;
    runoff_target_frac: number;
    required_event_ml: number;
    required_day_ml: number;
    delta_day_ml: number;
    estimated_runoff_frac: number;
    runoff_delta_frac: number;
    events_reconciled: number;
    ml_event_reconciled: number;
  };
  p1_required_day_ml: number;
  p2_required_day_ml: number;
  total_required_day_ml: number;
  warnings: string[];
  coherence: string[];
  actions: {
    resetToSop: Partial<IntakeIrr>;
    keepUser: Partial<IntakeIrr>;
    applyReconciled: Partial<IntakeIrr>;
  };
};

export type SolveInput = {
  intake: IntakeIrr;
  sopBundle: SopBundle;
  dirty?: DirtyField[];
};
