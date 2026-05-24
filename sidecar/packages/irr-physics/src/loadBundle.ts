import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SopBundle } from "./types.ts";
import { profileKey } from "./util.ts";

const __dir = dirname(fileURLToPath(import.meta.url));

let cache: Record<string, SopBundle> = {};

export function loadSopBundle(profile: string, dataDir?: string): SopBundle | null {
  const pk = profileKey(profile);
  if (cache[pk]) return cache[pk]!;

  const cwdDir = join(process.cwd(), "data", "sop-bundles");
  const dir = dataDir ?? (existsSync(cwdDir) ? cwdDir : join(__dir, "../../../data/sop-bundles"));
  const candidates = [
    join(dir, `${pk}.json`),
    join(dir, `${profile}.json`),
    join(dir, "athena-pro.json"),
  ];

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as SopBundle;
      cache[pk] = raw;
      return raw;
    } catch {
      /* try next */
    }
  }
  return null;
}

export function clearBundleCache() {
  cache = {};
}
