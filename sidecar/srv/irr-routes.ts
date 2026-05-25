import type { Express, Request, Response } from "express";
import {
  solveIrr,
  buildRealityDelta,
  flattenSolvePlan,
  loadSopBundle,
  SOLVER_VERSION,
  normalizeContainerGal,
  type IntakeIrr,
  type DirtyField,
} from "../packages/irr-physics/src/index.ts";

let lastSolveBody: { intake: IntakeIrr; plan: ReturnType<typeof solveIrr> } | null = null;

function mapDraftToIntake(body: Record<string, unknown>): IntakeIrr {
  return {
    stage: String(body.stage ?? body.stagePhase ?? "mid bloom"),
    medium: String(body.medium ?? "coco"),
    container: normalizeContainerGal(
      String(body.container ?? body.containerSize ?? "1"),
    ),
    profile: String(body.profile ?? "Athena Pro"),
    mode: body.mode != null ? String(body.mode) : undefined,
    photoperiodH: num(body.photoperiodH),
    tempC: num(body.tempC),
    vpdKpa: num(body.vpdKpa ?? body.vpd),
    dliMol: num(body.dliMol ?? body.dli),
    co2: num(body.co2),
    co2Mode: body.co2Mode != null ? String(body.co2Mode) : undefined,
    runoffPct: num(body.runoffPct),
    drybackPct24h: num(body.drybackPct24h),
    targetAtFirst: num(body.targetAtFirst),
    vwcAtLastIrr: num(body.vwcAtLastIrr),
    p1Events: num(body.p1Events),
    p1IntervalMin: num(body.p1IntervalMin),
    p1Pct: num(body.p1Pct),
    p1MlPerEvent: num(body.p1MlPerEvent),
    p2Events: num(body.p2Events),
    p2IntervalMin: num(body.p2IntervalMin),
    p2Pct: num(body.p2Pct),
    p2MlPerEvent: num(body.p2MlPerEvent),
    weekIndex: num(body.weekIndex),
  };
}

function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function resolveBundle(intake: IntakeIrr) {
  const bundle = loadSopBundle(intake.profile || "Athena Pro");
  if (!bundle) {
    return {
      ok: false as const,
      error: `SOP bundle not found for profile: ${intake.profile}`,
    };
  }
  return { ok: true as const, bundle };
}

export function registerIrrRoutes(app: Express) {
  app.get("/__version", (_req, res) => {
    res.json({ version: `v6.0.0-unified-${SOLVER_VERSION}` });
  });

  app.post("/sheet/irr/solveDraft", (req: Request, res: Response) => {
    const t0 = Date.now();
    try {
      const body = (req.body || {}) as Record<string, unknown>;
      const intake: IntakeIrr =
        body.intake && typeof body.intake === "object"
          ? mapDraftToIntake(body.intake as Record<string, unknown>)
          : mapDraftToIntake(body);
      const dirty = Array.isArray(body.dirty) ? (body.dirty as DirtyField[]) : undefined;

      const resolved = resolveBundle(intake);
      if (!resolved.ok) {
        res.status(422).json(resolved);
        return;
      }

      const plan = solveIrr({ intake, sopBundle: resolved.bundle, dirty });
      lastSolveBody = { intake, plan };

      res.set("Cache-Control", "no-store");
      res.set("X-Timing", String(Date.now() - t0));
      res.set("X-Sidecar-Version", SOLVER_VERSION);
      res.json(flattenSolvePlan(plan));
    } catch (e: unknown) {
      res.status(500).json({ ok: false, error: String((e as Error)?.message || e) });
    }
  });

  app.post("/sheet/reality-delta", (req: Request, res: Response) => {
    handleRealityDelta(req, res);
  });

  app.get("/sheet/reality-delta", (req: Request, res: Response) => {
    handleRealityDelta(req, res);
  });

  app.post("/sheet/irr/apply", (req: Request, res: Response) => {
    try {
      const body = (req.body || {}) as Record<string, unknown>;
      const intake = mapDraftToIntake(body);
      const dirty = Array.isArray(body.dirty) ? (body.dirty as DirtyField[]) : undefined;
      const resolved = resolveBundle(intake);
      if (!resolved.ok) {
        res.status(422).json(resolved);
        return;
      }
      const plan = solveIrr({ intake, sopBundle: resolved.bundle, dirty });
      res.json({
        ok: true,
        applied: true,
        ...flattenSolvePlan(plan),
        intake: plan.actions.applyReconciled,
      });
    } catch (e: unknown) {
      res.status(500).json({ ok: false, error: String((e as Error)?.message || e) });
    }
  });
}

function handleRealityDelta(req: Request, res: Response) {
  const t0 = Date.now();
  try {
    let intake: IntakeIrr | null = null;
    const body = req.body as Record<string, unknown> | undefined;
    if (body?.intake && typeof body.intake === "object") {
      intake = body.intake as IntakeIrr;
    } else if (body && Object.keys(body).length) {
      intake = mapDraftToIntake(body);
    } else if (lastSolveBody) {
      intake = lastSolveBody.intake;
    }

    if (!intake) {
      res.status(400).json({ ok: false, error: "intake required in body or solve first" });
      return;
    }

    const resolved = resolveBundle(intake);
    if (!resolved.ok) {
      res.status(422).json(resolved);
      return;
    }

    const plan = solveIrr({ intake, sopBundle: resolved.bundle });
    const delta = buildRealityDelta(plan);

    res.set("Cache-Control", "no-store");
    res.set("X-Timing", String(Date.now() - t0));
    res.set("X-Sidecar-Version", SOLVER_VERSION);
    res.json(delta);
  } catch (e: unknown) {
    res.status(500).json({ ok: false, error: String((e as Error)?.message || e) });
  }
}
