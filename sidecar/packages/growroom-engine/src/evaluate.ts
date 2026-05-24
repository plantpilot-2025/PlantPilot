import { buildObserved, stageTargetsFromProfile } from "./observed.ts";

export type ConditionRule = {
  condition: string;
  gate: string | null;
  message: string | null;
};

export type GrowroomRules = {
  metrics: Array<{
    metric: string;
    min: number | null;
    max: number | null;
    gate: string | null;
  }>;
  conditions?: ConditionRule[];
  stageProfiles: Array<{
    key?: string;
    phase?: string;
    lightcycle?: string;
    tair_c?: number;
    rh_percent?: number;
    vpd_air_kpa?: number;
    ppfd_umol?: number;
    co2_ppm?: number;
  }>;
};

export type IntakePayload = {
  tempC?: number;
  rh?: number;
  vpdKpa?: number;
  ppfd?: number;
  dliMol?: number;
  co2?: number;
  reservoirEc?: number;
  reservoirPh?: number;
  runoffPh?: number;
  runoffEc?: number;
  runoffPct?: number;
  reservoirTempC?: number;
  pwec?: number;
  vwcAtLastIrr?: number;
  drybackPct24h?: number;
  targetAtFirst?: number;
  p1Events?: number;
  p2Events?: number;
  p1IntervalMin?: number;
  p2IntervalMin?: number;
  stagePhase?: string;
  stage?: string;
  medium?: string;
  profile?: string;
  lightcycle?: string;
  photoperiodH?: number;
  co2Mode?: string;
};

export type Top3Row = [string, string, number];
export type ObservedResult = {
  level: "NONE" | "PARTIAL" | "FULL";
  count: number;
  drivers: Record<string, boolean>;
  notes: string[];
};

export type EngineEvaluateResult = {
  ok: boolean;
  version: string;
  gatePct: Array<{ gate: string; pct: number }>;
  top3ByGate: { ENV: Top3Row[]; ROOT: Top3Row[]; IRR: Top3Row[] };
  scores: { env: number; root: number; irr: number };
  gateStatus: Array<{ gate: string; status: string }>;
  observed: ObservedResult;
  conditionMatches: Array<{ condition: string; gate: string; message: string }>;
};

function normalizeLabel(label: string): string {
  return label.toLowerCase().replace(/\(.*?\)/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

function scoreToSeverity(score: number): "high" | "medium" | "low" {
  if (score >= 0.66) return "high";
  if (score >= 0.33) return "medium";
  return "low";
}

function findStageProfile(
  rules: GrowroomRules,
  stage?: string,
  sop?: string,
  lc?: string
): GrowroomRules["stageProfiles"][0] | null {
  if (!stage) return null;
  const phase = stage.toLowerCase();
  const sopN = (sop || "sharkmousefarms").toLowerCase();
  const lcN = (lc || "day").toLowerCase();
  for (const p of rules.stageProfiles) {
    if (
      p.phase?.toLowerCase() === phase &&
      p.key?.toLowerCase().includes(sopN) &&
      p.lightcycle?.toLowerCase() === lcN
    )
      return p;
  }
  for (const p of rules.stageProfiles) {
    if (p.phase?.toLowerCase() === phase && p.key?.toLowerCase().includes(sopN)) return p;
  }
  return null;
}

function gateFlagsFor(
  rules: GrowroomRules,
  gate: string,
  intake: IntakePayload
): Top3Row[] {
  const gateMetricMap: Record<string, Record<string, number | undefined>> = {
    ENV: {
      "canopy temp": intake.tempC,
      rh: intake.rh,
      vpd: intake.vpdKpa,
      ppfd: intake.ppfd,
      dli: intake.dliMol,
      co2: intake.co2,
    },
    ROOT: {
      "reservoir temp": intake.reservoirTempC,
      vwc: intake.vwcAtLastIrr,
      pwec: intake.pwec,
      "runoff ec": intake.runoffEc,
      "runoff ph": intake.runoffPh,
    },
    IRR: {
      "reservoir ec": intake.reservoirEc,
      "feed ec": intake.reservoirEc,
      "reservoir ph": intake.reservoirPh,
      "feed ph": intake.reservoirPh,
      "overnight dryback": intake.drybackPct24h,
      dryback: intake.drybackPct24h,
    },
  };

  const fields = gateMetricMap[gate] ?? {};
  const profile = findStageProfile(
    rules,
    intake.stagePhase ?? intake.stage,
    intake.profile,
    intake.lightcycle
  );
  const TOL = 0.1;
  const profileTargets: Record<string, number | null> = profile
    ? {
        tempC: profile.tair_c ?? null,
        rh: profile.rh_percent ?? null,
        vpdKpa: profile.vpd_air_kpa ?? null,
        ppfd: profile.ppfd_umol ?? null,
        co2: profile.co2_ppm ?? null,
      }
    : {};

  const gateFlags: Top3Row[] = [];
  for (const rule of rules.metrics.filter((m) => m.gate?.toUpperCase() === gate)) {
    const normName = normalizeLabel(rule.metric);
    const value = fields[normName];
    if (value == null || !Number.isFinite(value)) continue;

    let min = rule.min;
    let max = rule.max;
    const metricKeyMap: Record<string, string> = {
      "canopy temp": "tempC",
      rh: "rh",
      vpd: "vpdKpa",
      ppfd: "ppfd",
      co2: "co2",
    };
    const pKey = metricKeyMap[normName];
    if (pKey && profileTargets[pKey] != null) {
      const t = profileTargets[pKey]!;
      min = t * (1 - TOL);
      max = t * (1 + TOL);
    }

    if (min == null || max == null) continue;
    if (value < min || value > max) {
      const deviation = value < min ? min - value : value - max;
      const range = max - min || 1;
      const score = Math.min(1, deviation / range);
      const direction = value < min ? "low" : "high";
      const reason = `${rule.metric} is ${direction} (${value} vs ${min.toFixed?.(1) ?? min}–${max.toFixed?.(1) ?? max})`;
      gateFlags.push([rule.metric, reason, score]);
    }
  }
  gateFlags.sort((a, b) => b[2] - a[2]);
  return gateFlags.slice(0, 3);
}

function matchConditions(rules: GrowroomRules, intake: IntakePayload) {
  const out: Array<{ condition: string; gate: string; message: string }> = [];
  for (const c of rules.conditions ?? []) {
    if (!c.message) continue;
    const gate = (c.gate || "ENV").toUpperCase();
    const msg = c.message.toLowerCase();
    if (msg.includes("vpd") && intake.vpdKpa != null && intake.vpdKpa > 1.5) {
      out.push({ condition: c.condition, gate, message: c.message });
    }
    if (msg.includes("dryback") && intake.drybackPct24h != null && intake.drybackPct24h > 25) {
      out.push({ condition: c.condition, gate, message: c.message });
    }
  }
  return out.slice(0, 5);
}

export function evaluateGrowroom(
  rules: GrowroomRules,
  intake: IntakePayload,
  version = "growroom-engine-v1"
): EngineEvaluateResult {
  const env = gateFlagsFor(rules, "ENV", intake);
  const root = gateFlagsFor(rules, "ROOT", intake);
  const irr = gateFlagsFor(rules, "IRR", intake);

  const maxScore = (rows: Top3Row[]) => (rows.length ? rows[0][2] : 0);
  const envS = maxScore(env);
  const rootS = maxScore(root);
  const irrS = maxScore(irr);

  const gatePct = [
    { gate: "ENV", pct: envS },
    { gate: "ROOT", pct: rootS },
    { gate: "IRR", pct: irrS },
  ];

  const gateStatus = (["ENV", "ROOT", "IRR"] as const).map((g) => {
    const rows = g === "ENV" ? env : g === "ROOT" ? root : irr;
    const status =
      rows.length === 0 ? "ok" : scoreToSeverity(rows[0][2]) === "high" ? "alert" : "warn";
    return { gate: g, status };
  });

  const targets = stageTargetsFromProfile(rules, intake);
  const observed = buildObserved(intake, targets);
  const conditionMatches = matchConditions(rules, intake);

  return {
    ok: true,
    version,
    gatePct,
    top3ByGate: { ENV: env, ROOT: root, IRR: irr },
    scores: { env: envS, root: rootS, irr: irrS },
    gateStatus,
    observed,
    conditionMatches,
  };
}
