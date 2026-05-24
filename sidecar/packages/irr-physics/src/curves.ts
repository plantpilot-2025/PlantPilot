import { clamp } from "./util.ts";
import type { SopBundle } from "./types.ts";

export function whcPct(weekIndex: number, bundle: SopBundle): number {
  const total = bundle.total_weeks ?? 13;
  const start = bundle.whc_start ?? 60;
  const end = bundle.whc_end ?? 40;
  const k = bundle.whc_k ?? 1.5;
  const x = clamp((weekIndex - 1) / Math.max(1, total - 1), 0, 1);
  const expK = Math.exp(-k);
  const t = (Math.exp(-k * x) - expK) / (1 - expK);
  return end + (start - end) * t;
}

export function baseDrybackPctHr(weekIndex: number, bundle: SopBundle): number {
  const table = bundle.dryback_table_pct_hr;
  if (table?.length) {
    const i = clamp(weekIndex - 1, 0, table.length - 1);
    return table[i]!;
  }
  const total = bundle.total_weeks ?? 13;
  const min = bundle.min_db_pct_hr ?? 0.2;
  const max = bundle.max_db_pct_hr ?? 5.0;
  const x = clamp((weekIndex - 1) / Math.max(1, total - 1), 0, 1);
  return min * Math.pow(max / min, x);
}

export function demandLabel(index: number): "LOW" | "MED" | "HIGH" {
  if (index < 0.33) return "LOW";
  if (index < 0.66) return "MED";
  return "HIGH";
}
