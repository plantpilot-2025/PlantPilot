import type { Express, Request, Response } from "express";
import { evaluateGrowroom, labelsToIntake, type GrowroomRules } from "../packages/growroom-engine/src/index.ts";

const ENGINE_VERSION = "growroom-engine-v1";

export function registerEvalRoutes(app: Express, rules: GrowroomRules) {
  function handleEvaluate(req: Request, res: Response) {
    try {
      let intake: Record<string, number | string> = {};
      const q = req.query as Record<string, string | undefined>;
      if (q.labels) {
        try {
          const labels = JSON.parse(decodeURIComponent(String(q.labels))) as Record<string, string | number>;
          intake = labelsToIntake(labels);
        } catch {
          res.status(400).json({ ok: false, error: "invalid labels JSON" });
          return;
        }
      } else if (req.body && typeof req.body === "object") {
        const body = req.body as Record<string, unknown>;
        if (body.intake && typeof body.intake === "object") {
          intake = body.intake as Record<string, number | string>;
        } else if (body.labels && typeof body.labels === "object") {
          intake = labelsToIntake(body.labels as Record<string, string | number>);
        } else {
          intake = labelsToIntake(body as Record<string, string | number>);
        }
      }

      const result = evaluateGrowroom(rules, intake as any, ENGINE_VERSION);
      res.set("Cache-Control", "no-store");
      res.json({
        ...result,
        summary: { applied: [], skipped: [] },
      });
    } catch (e: unknown) {
      res.status(500).json({ ok: false, error: String((e as Error)?.message || e) });
    }
  }

  app.get("/v1/evaluate", handleEvaluate);
  app.post("/v1/evaluate", handleEvaluate);

  app.get("/gas", (req: Request, res: Response, next) => {
    const mode = String(req.query.mode || "").toLowerCase();
    if (mode === "ping") {
      res.json({ ok: true, version: ENGINE_VERSION });
      return;
    }
    if (mode === "evaluate") {
      handleEvaluate(req, res);
      return;
    }
    next();
  });

  app.post("/gas", (req: Request, res: Response, next) => {
    const mode = String(req.query.mode || req.body?.mode || "").toLowerCase();
    if (mode === "evaluate") {
      handleEvaluate(req, res);
      return;
    }
    next();
  });
}
