import type { Express, Request, Response } from "express";
import { getRun, listRecent, saveRun } from "./runs-store.ts";

export function registerRunsRoutes(app: Express) {
  app.post("/v1/runs", (req: Request, res: Response) => {
    try {
      const record = saveRun((req.body || {}) as Record<string, unknown>);
      res.status(201).json({ ok: true, id: record.id, run: record });
    } catch (e: unknown) {
      res.status(500).json({ ok: false, error: String((e as Error)?.message || e) });
    }
  });

  app.get("/v1/runs/recent", (req: Request, res: Response) => {
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    res.json({ ok: true, runs: listRecent(limit) });
  });

  app.get("/v1/runs/:id", (req: Request, res: Response) => {
    const run = getRun(String(req.params.id));
    if (!run) {
      res.status(404).json({ ok: false, error: "run not found" });
      return;
    }
    res.json({ ok: true, run });
  });

  app.get("/v1/runs", (_req: Request, res: Response) => {
    res.json({ ok: true, runs: listRecent(50) });
  });
}
