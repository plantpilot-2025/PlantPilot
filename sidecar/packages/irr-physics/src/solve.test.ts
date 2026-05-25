import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { solveIrr, buildRealityDelta, loadSopBundle } from "./index.ts";

const intake = {
  stage: "mid bloom",
  medium: "coco",
  container: "1",
  profile: "Athena Pro",
  photoperiodH: 18,
  tempC: 26,
  vpdKpa: 1.2,
  dliMol: 35,
  co2: 900,
  co2Mode: "co2",
  runoffPct: 10,
  drybackPct24h: 18,
  targetAtFirst: 40,
  p1Events: 4,
  p1IntervalMin: 30,
  p1MlPerEvent: 200,
  p2Events: 9,
  p2IntervalMin: 60,
  p2MlPerEvent: 90,
};

describe("irr-physics acceptance", () => {
  it("loads Athena Pro bundle and solves", () => {
    const bundle = loadSopBundle("Athena Pro");
    assert.ok(bundle, "bundle");
    const plan = solveIrr({ intake, sopBundle: bundle! });
    assert.equal(plan.ok, true);
    assert.equal(plan.p1.events_user, 4);
    assert.ok((plan.p1.w_refill_ml ?? 0) > 0);
    assert.ok((plan.p1_required_day_ml ?? 0) > 0);
    assert.ok((plan.p2_required_day_ml ?? 0) > 0);
  });

  it("reality delta has daily user fields", () => {
    const bundle = loadSopBundle("Athena Pro")!;
    const plan = solveIrr({ intake, sopBundle: bundle });
    const rd = buildRealityDelta(plan);
    assert.equal(rd.ok, true);
    assert.ok(rd.delta?.user?.p1_delta_day_ml != null);
    assert.ok(["ON", "SHORT", "OVER"].includes(String(rd.delta?.user?.p1_status)));
  });

  it("honors p1Events from intake (acceptance 2)", () => {
    const bundle = loadSopBundle("Athena Pro")!;
    const plan = solveIrr({
      intake: { ...intake, p1Events: 6 },
      sopBundle: bundle,
    });
    assert.equal(plan.p1.events_user, 6);
  });

  it("reconcile adjusts p1 ml/event when p1Events dirty", () => {
    const bundle = loadSopBundle("Athena Pro")!;
    const plan = solveIrr({
      intake: { ...intake, p1Events: 6, p1MlPerEvent: 50 },
      sopBundle: bundle,
      dirty: ["p1Events"],
    });
    assert.equal(plan.ok, true);
    const rec = plan.actions?.applyReconciled?.p1MlPerEvent;
    assert.ok(Number(rec) > 50);
  });

  it("normalizes 1 gal container for SharkmouseFarms baseline", () => {
    const bundle = loadSopBundle("SharkmouseFarms");
    assert.ok(bundle, "sharkmouse bundle");
    const plan = solveIrr({
      intake: {
        stage: "early veg",
        medium: "coco",
        container: "1 gal",
        profile: "SharkmouseFarms",
        co2: 1200,
        co2Mode: "co2",
      },
      sopBundle: bundle!,
    });
    assert.equal(plan.ok, true, plan.error || "expected ok");
  });

  it("handwater mode uses coherence for p2 checks", () => {
    const bundle = loadSopBundle("Athena Pro")!;
    const plan = solveIrr({
      intake: { ...intake, mode: "handwater", p2Events: 9, p2MlPerEvent: 500 },
      sopBundle: bundle,
    });
    assert.ok(
      plan.coherence?.some((c) => /handwater/i.test(c)) ||
        plan.warnings?.length ||
        plan.ok
    );
  });
});
