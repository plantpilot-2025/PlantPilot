import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export type RunRecord = {
  id: string;
  createdAt: string;
  intake: Record<string, unknown>;
  evaluate?: unknown;
  irrPlan?: unknown;
  realityDelta?: unknown;
};

const RUNS_DIR = join(process.cwd(), "data", "runs");

function ensureDir() {
  if (!existsSync(RUNS_DIR)) mkdirSync(RUNS_DIR, { recursive: true });
}

export function saveRun(body: Record<string, unknown>): RunRecord {
  ensureDir();
  const id = randomUUID();
  const record: RunRecord = {
    id,
    createdAt: new Date().toISOString(),
    intake: (body.intake as Record<string, unknown>) || {},
    evaluate: body.evaluate,
    irrPlan: body.irrPlan,
    realityDelta: body.realityDelta,
  };
  writeFileSync(join(RUNS_DIR, `${id}.json`), JSON.stringify(record, null, 2), "utf8");
  return record;
}

export function getRun(id: string): RunRecord | null {
  const path = join(RUNS_DIR, `${id}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as RunRecord;
  } catch {
    return null;
  }
}

export function listRecent(limit = 20): RunRecord[] {
  ensureDir();
  const files = readdirSync(RUNS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        const rec = JSON.parse(readFileSync(join(RUNS_DIR, f), "utf8")) as RunRecord;
        return rec;
      } catch {
        return null;
      }
    })
    .filter((r): r is RunRecord => r != null);
  return files.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
}
