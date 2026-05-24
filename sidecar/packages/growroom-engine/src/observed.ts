import type { IntakePayload } from "./evaluate.ts";

export type ObservedResult = {
  level: "NONE" | "PARTIAL" | "FULL";
  count: number;
  drivers: Record<string, boolean>;
  notes: string[];
};

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Compare intake to stage-profile targets (simplified from d25eea3 observedFromIntakeAndTargets). */
export function buildObserved(
  intake: IntakePayload,
  targets: Record<string, number | null | undefined>
): ObservedResult {
  const eps = { vpd: 0.03, dli: 0.5, co2: 30, fc: 1, start: 1, runoff: 0.5, events: 0.5, minutes: 1 };

  const vpdNow = num(intake.vpdKpa);
  const dliNow = num(intake.dliMol);
  const co2Now = num(intake.co2);
  const fcNow = num(intake.vwcAtLastIrr);
  const stNow = num(intake.targetAtFirst);
  const roNow = num(intake.runoffPct);

  const vpdT = num(targets.vpdKpa);
  const dliT = num(targets.dliMol);
  const co2T = num(targets.co2);
  const fcT = num(targets.fc_vwc);
  const stT = num(targets.targetAtFirst);
  const roT = num(targets.runoffPct);

  const drivers: Record<string, boolean> = {
    vpd: vpdNow != null && vpdT != null && Math.abs(vpdNow - vpdT) > eps.vpd,
    dli: dliNow != null && dliT != null && Math.abs(dliNow - dliT) > eps.dli,
    co2: co2Now != null && co2T != null && Math.abs(co2Now - co2T) > eps.co2,
    fc: fcNow != null && fcT != null && Math.abs(fcNow - fcT) > eps.fc,
    start: stNow != null && stT != null && Math.abs(stNow - stT) > eps.start,
    runoff: roNow != null && roT != null && Math.abs(roNow - roT) > eps.runoff,
    schedule: false,
  };

  const p1eNow = num(intake.p1Events);
  const p2eNow = num(intake.p2Events);
  const p1iNow = num(intake.p1IntervalMin);
  const p2iNow = num(intake.p2IntervalMin);
  const p1eT = num(targets.p1Events);
  const p2eT = num(targets.p2Events);
  const p1iT = num(targets.p1IntervalMin);
  const p2iT = num(targets.p2IntervalMin);

  if (
    (p1eNow != null && p1eT != null && Math.abs(p1eNow - p1eT) > eps.events) ||
    (p2eNow != null && p2eT != null && Math.abs(p2eNow - p2eT) > eps.events) ||
    (p1iNow != null && p1iT != null && Math.abs(p1iNow - p1iT) > eps.minutes) ||
    (p2iNow != null && p2iT != null && Math.abs(p2iNow - p2iT) > eps.minutes)
  ) {
    drivers.schedule = true;
  }

  const count = Object.values(drivers).filter(Boolean).length;
  const coreTouched = drivers.vpd || drivers.dli || drivers.fc || drivers.start;
  const level = count === 0 ? "NONE" : coreTouched ? "FULL" : "PARTIAL";

  const notes: string[] = [];
  if (level === "NONE") notes.push("No inputs differ from SOP targets; drift cannot be inferred.");
  if (level === "PARTIAL") notes.push("Only schedule/runoff differs; core drivers still match SOP targets.");
  if (level === "FULL") notes.push("At least one core driver (VPD/DLI/FC/Start) differs from SOP targets.");

  return { level, count, drivers, notes };
}

export function stageTargetsFromProfile(
  rules: { stageProfiles: Array<Record<string, unknown>> },
  intake: IntakePayload
): Record<string, number | null> {
  const stage = (intake.stagePhase ?? intake.stage ?? "").toLowerCase();
  const sop = (intake.profile ?? "sharkmousefarms").toLowerCase();
  const lc = (intake.lightcycle ?? "day").toLowerCase();
  let profile: Record<string, unknown> | null = null;
  for (const p of rules.stageProfiles) {
    if (
      String(p.phase ?? "").toLowerCase() === stage &&
      String(p.key ?? "").toLowerCase().includes(sop) &&
      String(p.lightcycle ?? "").toLowerCase() === lc
    ) {
      profile = p;
      break;
    }
  }
  if (!profile) {
    for (const p of rules.stageProfiles) {
      if (String(p.phase ?? "").toLowerCase() === stage && String(p.key ?? "").toLowerCase().includes(sop)) {
        profile = p;
        break;
      }
    }
  }
  return {
    vpdKpa: num(profile?.vpd_air_kpa),
    dliMol: null,
    co2: num(profile?.co2_ppm),
    fc_vwc: null,
    targetAtFirst: null,
    runoffPct: null,
    p1Events: null,
    p2Events: null,
    p1IntervalMin: null,
    p2IntervalMin: null,
    tempC: num(profile?.tair_c),
    rh: num(profile?.rh_percent),
  };
}
