import cors from "cors";
import { createRequire } from "module";
const _require = createRequire(import.meta.url);
const express = _require("express") as typeof import("express");
import type { Request, Response } from "express";

let edgeTts: ((opts: { text: string; voice: string; rate: string; volume: string }) => AsyncIterable<{ type: string; data?: Uint8Array }>) | null = null;
let googleTTSApi: any = null;

try {
  const mod = await import("edge-tts");
  edgeTts = (mod as any).tts ?? (mod as any).default?.tts ?? null;
} catch {}

try {
  googleTTSApi = (await import("google-tts-api")).default;
} catch {}

const VERSION = "v5.0.0-unified";

const PORT = Number(process.env.PORT || 8789);
const GAS_URL = (process.env.GAS_DIAG_URL || "").trim();
const GAS_METHOD = (process.env.GAS_METHOD || "POST").toUpperCase();
const GAS_TIMEOUT_MS = Number(process.env.GAS_TIMEOUT_MS || 60000);

const LLM_BASE = ((process.env.LLM_API_URL || "https://api.openai.com").trim()).replace(/\/+$/, "");
const LLM_MODEL = (process.env.LLM_MODEL || "gpt-4o").trim();
const LLM_FALLBACK_MODEL = (process.env.LLM_FALLBACK_MODEL || "gpt-4o").trim();
const LLM_KEY = (process.env.LLM_API_KEY || "").trim();
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 180000);
const LLM_MAXTOK = Number(process.env.LLM_MAX_TOKENS || 3000);
const REASON_BUDGET = Number(process.env.REASON_BUDGET_TOKENS || 2000);
const HUMANIZED_MIN_CHARS = Number(process.env.HUMANIZED_MIN_CHARS || 600);

const PROJ = (process.env.OPENAI_PROJECT || process.env.LLM_PROJECT_ID || "").trim();
const ORG = (process.env.OPENAI_ORG || process.env.OPENAI_ORGANIZATION || "").trim();

const LLM_ENABLED = /^sk-.{20,}$/.test(LLM_KEY);

const TTS_PROVIDER = (process.env.TTS_PROVIDER || "edge").toLowerCase();
const EDGE_VOICE = process.env.EDGE_VOICE || "en-US-AriaNeural";
const EDGE_RATE = process.env.EDGE_RATE || "+0%";
const EDGE_VOLUME = process.env.EDGE_VOLUME || "+0%";

const OPENAI_TTS_MODEL = process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts";
const OPENAI_TTS_VOICE = process.env.OPENAI_TTS_VOICE || "alloy";
const OPENAI_TTS_FORMAT = (process.env.OPENAI_TTS_FORMAT || "mp3").toLowerCase();

const CORS_ORIGIN = process.env.CORS_ORIGIN || "";

if (!GAS_URL) console.warn(`[sidecar] GAS_DIAG_URL not set – rules-only fallback active.`);
if (!LLM_ENABLED) console.warn(`[sidecar] LLM_API_KEY not set or invalid – coach mode disabled, using deterministic summaries.`);

/* ==================== Utilities ==================== */

function withTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fn(controller.signal).finally(() => clearTimeout(timer));
}

function toNumber(input: unknown, fallback: number) {
  const n = Number(input);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

function num(v: unknown, def: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : def;
}

function scoreToSeverity(score: number): "high" | "medium" | "low" {
  if (score >= 0.66) return "high";
  if (score >= 0.33) return "medium";
  return "low";
}

function hash32(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/* ==================== TTL Cache ==================== */

type CacheEntry = { value: any; exp: number };
const cache = new Map<string, CacheEntry>();
function cacheGet<T>(k: string): T | undefined {
  const v = cache.get(k);
  if (!v) return;
  if (Date.now() > v.exp) { cache.delete(k); return; }
  return v.value as T;
}
function cachePut(k: string, value: any, ttlMs: number) {
  cache.set(k, { value, exp: Date.now() + ttlMs });
}

/* ==================== Types ==================== */

type GasFlagRow = [string, string | undefined, number | null, string | undefined];
type GasFlag = { label: string; reason?: string; score: number; severity: "high" | "medium" | "low"; gate: string };

type IrrSolveResponse = {
  ok: boolean;
  base_key_effective: string;
  cfg_key_effective: string;
  p1: { events: number; pct_whc_ideal: number; ml_event_ideal: number };
  p2: { events: number; pct_whc_ideal: number; ml_event_ideal: number };
  demand_index: number;
  dbPct_interval: number;
  coherence: string[];
  observed: { level: "NONE" | "PARTIAL" | "FULL"; count: number; notes: string[] };
};

/* ==================== Deterministic Summary ==================== */

function buildFallbackSummary(flags: GasFlag[]) {
  if (!flags.length) {
    return "No critical rule violations detected from the latest sheet diagnostics. Keep collecting routine readings and monitor trend movement across environment and root-zone metrics.";
  }
  const top = flags.slice(0, 3);
  const opening = `Top risks were detected in ${top.map((f) => f.label).join(", ")}.`;
  const detail = top
    .map((f, i) => `${i + 1}) ${f.label}: ${f.reason || "Out-of-range condition detected."}`)
    .join(" ");
  return `${opening} ${detail} Recommended next steps: stabilize root-zone chemistry first, then correct climate and light pressure, and re-check runoff responses within the next irrigation cycle.`;
}

/* ==================== LLM Prompt Builders ==================== */

const MECH_PRIMER = [
  "REFERENCE:",
  "- Mid‑bloom canopy 25–26 °C; VPD 1.1–1.3 kPa; RH 55–60 %; airflow strong, non‑buffeting.",
  "- Coco/hydro pH 5.8–6.0; peat/soil pH 6.3–6.6.",
  "- Feed EC moderate: coco/hydro 1.6–1.8 mS/cm; daily runoff 10–15 %.",
  "- Salt reset: leach 1.0–1.5× container volume using 0.8–1.0 mS/cm at target pH.",
  "- Mg bump: 25–40 ppm Mg (≈ 0.25–0.40 g/L MgSO4·7H2O) for 2–3 irrigations.",
  ""
].join("\n");

const PHRASE_BANS = [
  "Environment, root zone, and irrigation interact",
  "Environment, root chemistry, and irrigation interact",
  "Keep VPD appropriate for stage",
  "Align VPD to stage",
  "Normalize VPD to mid-band",
  "Normalize VPD to mid band",
  "Keep VPD midrange",
  "Keep VPD mid‑range",
  "Fix interval/shot",
  "Correct irrigation interval/shot",
  "Set feed pH/EC to target",
  "Adjust feed pH/EC to target",
  "balance EC to support water potential",
  "keep EC in range to support water movement",
  "Signals tie environment"
];

const BANNED_PATTERNS: RegExp[] = [
  /Environment, root (zone|chemistry),? and irrigation (interact|are linked)\./i,
  /Keep VPD appropriate for stage/i,
  /Align VPD to stage/i,
  /Normalize VPD to mid[- ]band/i,
  /Fix interval\/shot|Correct irrigation interval\/shot/i,
  /Set feed pH\/EC to target|Adjust feed pH\/EC to target/i,
  /balance EC to support water potential|keep EC in range to support water movement/i,
  /Signals tie environment.*timing\./i
];

function hasBanned(s: string): boolean { return BANNED_PATTERNS.some((re) => re.test(s)); }

function rewriteWithSalt(s: string, salt: string): string {
  const v = (hash32(salt || "") % 3);
  type RW = [RegExp, string[]];
  const REWRITES: RW[] = [
    [/Environment, root (zone|chemistry),? and irrigation .*?\./gi, [
      "Canopy demand, root chemistry, and irrigation co‑determine uptake.",
      "Heat load, root conditions, and irrigation pattern shape transport.",
      "Environment, roots, and irrigation pull on the same physiology."
    ]],
    [/(Align VPD to stage|Keep VPD appropriate for stage)/gi, [
      "Set VPD for this phase",
      "Hold VPD in the safe band for the current stage",
      "Use a phase‑appropriate VPD window"
    ]],
    [/(Normalize VPD to mid[- ]band|Keep VPD mid(range|‑range))/gi, [
      "Target a steady mid‑band VPD",
      "Keep VPD centered in the band",
      "Hold a stable mid‑window VPD"
    ]],
    [/(Fix|Correct) irrigation interval\/shot/gi, [
      "Tune interval and shot volume",
      "Adjust timing and volume per event",
      "Tighten schedule and shot size"
    ]],
    [/(Set|Adjust) feed pH\/EC to target/gi, [
      "Bring feed pH and EC onto target",
      "Tune feed pH and EC to the setpoint",
      "Match feed pH and EC to the goal"
    ]],
    [/balance EC to support water potential|keep EC in range to support water movement/gi, [
      "keep EC steady so water potential remains favorable",
      "hold EC in band to keep transport workable",
      "maintain EC so the osmotic gradient stays sane"
    ]]
  ];
  let out = s;
  for (const [re, options] of REWRITES) out = out.replace(re, options[v]);
  return out;
}

function buildCoachPrompt(
  flagsAll: GasFlag[],
  symptoms: string[],
  targets: any,
  salt: string
) {
  const stage = (targets?.targets?.stage || targets?.targets?.Stage || "mid‑bloom").toString();
  const haveSymptoms = (symptoms?.length ?? 0) > 0;
  const data = {
    stage,
    flags_all: flagsAll.map(f => ({ gate: f.gate, label: f.label, reason: f.reason ?? "" })),
    symptoms_selected: symptoms
  };

  const rules = [
    "LANGUAGE: English (US). Plain text. No bullets. No numbered lists. No [Lever]/[Effect]/[Verify].",
    "VOICE: SharkMouse — direct, witty, grower-to-grower coach. Talk to ONE person: use 'you' and 'your'.",
    "TONE: Hobbyist-friendly. Explain why each flag matters at the plant-level. Avoid lab jargon.",
    "STRUCTURE (use these exact headers):",
    "What I'm seeing:",
    "Why this happens:",
    "Do this next:",
    "What to watch:",
    "MANDATES:",
    "- Mention EVERY item in DATA.flags_all exactly once by name in either 'What I'm seeing' or 'Why this happens'.",
    "- If symptoms are present, mention EACH symptom by name and tie at least one to a physiological reason.",
    "- Include the plant stage once and connect the fixes to stage-relevant outcomes.",
    "- Include concrete numbers with UNITS where relevant (°C, %, kPa, mS/cm, ppm, L, m/s).",
    "- Keep it TTS-friendly: flowing sentences, short clauses, natural rhythm.",
    "- LENGTH: 180–280 words minimum.",
    "- Never use these exact strings: " + PHRASE_BANS.map(s => `"${s}"`).join(", ") + ".",
    "BANNED: square-bracket tags, bullets, step numbers."
  ];

  const symptomHints: string[] = [];
  if (symptoms.map(s => s.toLowerCase()).includes("interveinal chlorosis")) {
    symptomHints.push("- Note: If 'Interveinal chlorosis' appears, mention Mg mobility and K/Mg antagonism briefly.");
  }

  return [
    rules.join("\n"),
    symptomHints.join("\n"),
    "",
    `DATA(JSON): ${JSON.stringify(data)}`,
    "",
    MECH_PRIMER,
    `STYLE_SALT: ${salt || "none"}`,
    "",
    `Start with this exact header line: Live symptoms: ${haveSymptoms ? symptoms.join(", ") : "none"}.`,
    "Then write the four sections with their headers exactly as specified."
  ].join("\n");
}

function buildExpandedPrompt(
  flags: GasFlag[],
  symptoms: string[],
  targets: any,
  salt: string
) {
  const haveSymptoms = (symptoms?.length ?? 0) > 0;
  const data = {
    flags: flags.slice(0, 3).map(f => ({ label: f.label, gate: f.gate, reason: f.reason ?? "" })),
    symptoms_selected: symptoms,
    targets: targets?.targets ?? {}
  };

  return [
    "LANGUAGE: English (US). Plain text.",
    "GOAL: Executable diagnosis integrating live symptoms with ENV/ROOT/IRR into a single plan.",
    `DATA(JSON): ${JSON.stringify(data)}`,
    "",
    MECH_PRIMER,
    `STYLE_SALT: ${salt || "none"}`,
    "",
    `- Start with EXACT line: Live symptoms: ${haveSymptoms ? symptoms.join(", ") : "none"}.`,
    "- Tie symptoms to ENV/ROOT/IRR mechanisms (conductance, water potential, pH→availability, photoinhibition).",
    "- Actions (3–5). For EACH action include:",
    "  [Lever] specific change with magnitude,",
    "  [Effect] physiological change AND the gate altered (ENV/ROOT/IRR), citing ONE named symptom when relevant,",
    "  [Verify] measurable check with numeric target/range WITH UNIT; prefer DATA.targets.",
    "- Order by leverage and safety. No markdown. No JSON.",
    "- 220–320 words."
  ].join("\n");
}

/* ==================== Quality Checks ==================== */

function normalize(s: string): string {
  return String(s || "").toLowerCase()
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[^a-z0-9 %°/.\-]+/g, " ")
    .replace(/\s+/g, " ").trim();
}

function missingCoverage(text: string, labels: string[]): string[] {
  const t = normalize(text);
  return labels.filter(lab => !t.includes(normalize(lab)));
}

function ensureSectionHeaders(text: string): string[] {
  const req = ["What I'm seeing:", "Why this happens:", "Do this next:", "What to watch:"];
  return req.filter(h => !text.includes(h));
}

/* ==================== OpenAI Callers ==================== */

function buildHeaders(): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${LLM_KEY}`,
  };
  if (PROJ) h["OpenAI-Project"] = PROJ;
  if (ORG) h["OpenAI-Organization"] = ORG;
  return h;
}

async function callOpenAI_TEXT_chat(
  prompt: string,
  signal?: AbortSignal,
  opts?: { maxTokens?: number; system?: string; model?: string }
): Promise<string> {
  const url = `${LLM_BASE}/v1/chat/completions`;
  const tok = opts?.maxTokens ?? LLM_MAXTOK;
  const model = opts?.model ?? LLM_MODEL;
  const messages = [
    { role: "system", content: opts?.system ?? "Write in English (US). Plain text. No markdown." },
    { role: "user", content: prompt }
  ];

  const body: any = { model, messages, max_completion_tokens: tok };
  const r = await fetch(url, { method: "POST", headers: buildHeaders(), body: JSON.stringify(body), signal });
  if (!r.ok) {
    const raw = await r.text().catch(() => "");
    if (/unsupported_parameter/i.test(raw) && /max_completion_tokens/i.test(raw)) {
      const body2: any = { model, messages, max_tokens: tok };
      const r2 = await fetch(url, { method: "POST", headers: buildHeaders(), body: JSON.stringify(body2), signal });
      if (!r2.ok) throw new Error(`LLM fallback HTTP ${r2.status}`);
      const j2 = await r2.json();
      return String(j2?.choices?.[0]?.message?.content ?? "").trim();
    }
    throw new Error(`LLM HTTP ${r.status}: ${raw}`);
  }
  const j = await r.json();
  return String(j?.choices?.[0]?.message?.content ?? "").trim();
}

async function callOpenAI_TEXT_responses(
  prompt: string,
  signal?: AbortSignal,
  opts?: { maxTokens?: number; system?: string }
): Promise<string> {
  const url = `${LLM_BASE}/v1/responses`;
  const body: any = {
    model: LLM_MODEL,
    input: [
      { role: "system", content: opts?.system ?? "Write in English (US) only. Plain text. No bullet lists. No JSON." },
      { role: "user", content: prompt }
    ],
    text: { format: { type: "text" } },
    max_output_tokens: opts?.maxTokens ?? LLM_MAXTOK
  };

  if (REASON_BUDGET > 0) {
    body.reasoning = { effort: "low", budget_tokens: REASON_BUDGET };
  }

  const r = await fetch(url, { method: "POST", headers: buildHeaders(), body: JSON.stringify(body), signal });
  if (!r.ok) {
    const errBody = await r.text().catch(() => "");
    if (/unsupported_parameter/i.test(errBody) && /reasoning|budget_tokens/i.test(errBody)) {
      delete body.reasoning;
      const r2 = await fetch(url, { method: "POST", headers: buildHeaders(), body: JSON.stringify(body), signal });
      if (!r2.ok) throw new Error(`OpenAI HTTP ${r2.status}`);
      const j2 = await r2.json();
      if (typeof j2?.output_text === "string" && j2.output_text.trim()) return j2.output_text.trim();
      return "";
    }
    throw new Error(`OpenAI HTTP ${r.status}`);
  }
  const j = await r.json();

  if (typeof j?.output_text === "string" && j.output_text.trim()) return j.output_text.trim();
  const segs = j?.output?.[0]?.content ?? [];
  const parts: string[] = [];
  for (const seg of segs) {
    if (typeof seg?.text === "string" && seg.text.trim()) parts.push(seg.text.trim());
  }
  return parts.join("").trim();
}

async function callLLM(prompt: string, signal?: AbortSignal, opts?: { maxTokens?: number }): Promise<string> {
  try {
    const text = await callOpenAI_TEXT_responses(prompt, signal, opts);
    if (text) return text;
  } catch (e) { console.warn("[llm] responses API failed, trying chat:", (e as any)?.message); }
  try {
    return await callOpenAI_TEXT_chat(prompt, signal, opts);
  } catch (e) {
    if (LLM_FALLBACK_MODEL !== LLM_MODEL) {
      console.warn("[llm] chat failed with primary model, trying fallback:", (e as any)?.message);
      return await callOpenAI_TEXT_chat(prompt, signal, { ...opts, model: LLM_FALLBACK_MODEL });
    }
    throw e;
  }
}

/* ==================== GAS Integration ==================== */

let lastGas: { flags: GasFlag[]; summary: string; stage: string; timestamp: string; targets: any } | null = null;
let lastSymptoms: string[] = [];

async function pullGas(signal?: AbortSignal) {
  if (!GAS_URL) {
    const flags: GasFlag[] = [];
    return {
      flags,
      summary: buildFallbackSummary(flags),
      stage: "local-fallback",
      timestamp: new Date().toISOString(),
      targets: { targets: {} },
    };
  }

  const cached = cacheGet<typeof lastGas>("gas:full");
  if (cached) return cached;

  const headers: Record<string, string> = {
    "Accept": "application/json",
    "Content-Type": "application/json",
  };
  const body = GAS_METHOD === "POST" ? JSON.stringify({ apply: 0 }) : undefined;
  const response = await fetch(GAS_URL, {
    method: GAS_METHOD,
    headers,
    body,
    signal,
    redirect: "follow",
  });

  if (response.status === 429) {
    console.warn("[sidecar] GAS 429, using cached snapshot");
    if (lastGas) return lastGas;
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`GAS HTTP ${response.status}${text ? `: ${text}` : ""}`);
  }

  const payload: any = await response.json();
  const env: GasFlagRow[] = Array.isArray(payload?.top3ByGate?.ENV) ? payload.top3ByGate.ENV : [];
  const root: GasFlagRow[] = Array.isArray(payload?.top3ByGate?.ROOT) ? payload.top3ByGate.ROOT : [];
  const irr: GasFlagRow[] = Array.isArray(payload?.top3ByGate?.IRR) ? payload.top3ByGate.IRR : [];

  const rows = [
    ...env.map((row) => ({ gate: "ENV", row })),
    ...root.map((row) => ({ gate: "ROOT", row })),
    ...irr.map((row) => ({ gate: "IRR", row })),
  ];

  const flags: GasFlag[] = rows
    .map(({ gate, row }) => ({
      label: String(row?.[0] || "").trim(),
      reason: row?.[1] ? String(row[1]) : undefined,
      score: Number(row?.[2] ?? 0) || 0,
      severity: scoreToSeverity(Number(row?.[2] ?? 0) || 0),
      gate,
    }))
    .filter((f) => f.label)
    .sort((a, b) => b.score - a.score);

  const targets = payload?.targets ?? payload?.summary?.targets ?? { targets: {} };

  const result = {
    flags,
    summary: buildFallbackSummary(flags),
    stage: String(payload?.stage ?? "unspecified"),
    timestamp: new Date().toISOString(),
    targets,
  };

  cachePut("gas:full", result, 15_000);
  lastGas = result;
  return result;
}

async function pullSymptoms(signal?: AbortSignal): Promise<string[]> {
  if (!GAS_URL) return [];
  try {
    const url = new URL(GAS_URL);
    url.searchParams.set("mode", "nrs");
    url.searchParams.set("names", "INTAKE_SYM_FLAGS");
    const r = await fetch(url.toString(), { method: "GET", signal, redirect: "follow" });
    if (!r.ok) return lastSymptoms;
    const j: any = await r.json();
    const flags = j?.INTAKE_SYM_FLAGS ?? j?.ranges?.INTAKE_SYM_FLAGS ?? [];
    const selected = (Array.isArray(flags) ? flags : [])
      .filter((v: any) => typeof v === "string" && v.trim())
      .map((v: string) => v.trim());
    lastSymptoms = selected;
    return selected;
  } catch {
    return lastSymptoms;
  }
}

/* ==================== Coach Generator ==================== */

async function generateCoachReport(
  opts: { maxTokens?: number; salt?: string; llm_ms?: number }
): Promise<{ prose: string; quality: any; generator: string }> {
  const [gasResult, symptomsResult] = await Promise.allSettled([
    withTimeout(GAS_TIMEOUT_MS, (s) => pullGas(s)),
    withTimeout(GAS_TIMEOUT_MS, (s) => pullSymptoms(s)),
  ]);
  if (gasResult.status === "rejected") throw gasResult.reason;
  const gas = gasResult.value;
  const symptoms: string[] = symptomsResult.status === "fulfilled" ? symptomsResult.value : [];
  if (symptomsResult.status === "rejected") console.warn("[coach] symptom fetch failed:", symptomsResult.reason?.message);

  if (!LLM_ENABLED) {
    return {
      prose: gas.summary,
      quality: { length: gas.summary.length, flagsCoveredMissing: [], generator: "rules-fallback" },
      generator: "rules-fallback-no-openai"
    };
  }

  const prompt = buildCoachPrompt(gas.flags, symptoms, gas.targets, opts.salt || "");
  let prose = "";

  try {
    prose = (await withTimeout(opts.llm_ms || LLM_TIMEOUT_MS, (s) => callLLM(prompt, s, { maxTokens: opts.maxTokens || LLM_MAXTOK }))).trim();
  } catch (e) {
    console.warn("[coach] LLM generation failed, using deterministic fallback:", (e as any)?.message);
    prose = "";
  }

  if (!prose) {
    prose = buildDeterministicFallback(gas.flags, symptoms, gas.targets);
  }

  const flagLabels = gas.flags.map(f => f.label).filter(Boolean);
  const requiredNames = [...flagLabels, ...symptoms];
  let miss = missingCoverage(prose, requiredNames);
  let headersMissing = ensureSectionHeaders(prose);
  const tooShort = prose.length < HUMANIZED_MIN_CHARS;

  if (LLM_ENABLED && (hasBanned(prose) || miss.length || headersMissing.length || tooShort)) {
    const rev = [
      prompt, "", "REVISION:",
      miss.length ? `- You omitted these items: ${miss.join(", ")}.` : "",
      headersMissing.length ? `- Add missing headers: ${headersMissing.join(" | ")}.` : "",
      tooShort ? `- Expand to at least ${Math.max(HUMANIZED_MIN_CHARS, 900)} characters.` : "",
      "- Keep the same voice. No bullets. No numbered steps. Keep units."
    ].join("\n");
    try {
      const revised = await callLLM(rev, undefined, { maxTokens: opts.maxTokens || LLM_MAXTOK });
      if (revised?.trim()) prose = revised.trim();
    } catch (e) { console.warn("[coach] revision pass failed:", (e as any)?.message); }
  }

  if (hasBanned(prose)) prose = rewriteWithSalt(prose, opts.salt || "");

  return {
    prose,
    quality: {
      minChars: HUMANIZED_MIN_CHARS,
      length: prose.length,
      flagsCoveredMissing: missingCoverage(prose, flagLabels),
      symptomsCoveredMissing: missingCoverage(prose, symptoms),
      headersMissing: ensureSectionHeaders(prose),
    },
    generator: LLM_ENABLED ? "llm-coach" : "rules-fallback-no-openai"
  };
}

function buildDeterministicFallback(flags: GasFlag[], symptoms: string[], targets: any): string {
  const symLine = symptoms.length ? symptoms.join(", ") : "none";
  const flagLine = flags.length ? flags.map(f => f.label).join(", ") : "stable conditions";
  const stage = (targets?.targets?.stage || targets?.targets?.Stage || "mid‑bloom").toString();

  return [
    `Live symptoms: ${symLine}.`,
    "",
    "What I'm seeing:",
    `${flagLine}. You're in ${stage}. The canopy is signaling transport drift.`,
    "",
    "Why this happens:",
    "Climate pulls demand, roots set chemistry, irrigation moves it. Hot/dry air with swinging media stacks salts and drifts pH. Mg goes mobile, so interveinal fade shows; clawing is leaf water tension with stomata shutting.",
    "",
    "Do this next:",
    "Hold canopy 25–26 °C, RH 55–60 %, VPD 1.1–1.3 kPa, airflow ~0.3–0.6 m/s. Irrigate to saturation with ~10–15 % runoff, then tighten daytime intervals so VWC stays steady. Feed 1.6–1.8 mS/cm at pH 5.8–6.0 (coco/hydro) or 6.3–6.6 (peat/soil). If Mg implicated, add 25–40 ppm Mg for 2–3 irrigations.",
    "",
    "What to watch:",
    "New growth holds color first, runoff EC/pH stabilize, and leaf–air ΔT sits near 0–1 °C. In bloom, steadier transport stacks buds instead of feeding stress."
  ].join("\n");
}

async function generateExpandedReport(
  opts: { maxTokens?: number; salt?: string; llm_ms?: number }
): Promise<{ text: string; generator: string }> {
  const [gasResult, symptomsResult] = await Promise.allSettled([
    withTimeout(GAS_TIMEOUT_MS, (s) => pullGas(s)),
    withTimeout(GAS_TIMEOUT_MS, (s) => pullSymptoms(s)),
  ]);
  if (gasResult.status === "rejected") throw gasResult.reason;
  const gas = gasResult.value;
  const symptoms: string[] = symptomsResult.status === "fulfilled" ? symptomsResult.value : [];
  if (symptomsResult.status === "rejected") console.warn("[expanded] symptom fetch failed:", symptomsResult.reason?.message);

  if (!LLM_ENABLED) {
    return {
      text: gas.summary,
      generator: "rules-fallback-no-openai"
    };
  }

  const prompt = buildExpandedPrompt(gas.flags, symptoms, gas.targets, opts.salt || "");
  try {
    const text = await withTimeout(opts.llm_ms || LLM_TIMEOUT_MS, (s) => callLLM(prompt, s, { maxTokens: opts.maxTokens || LLM_MAXTOK }));
    if (text?.trim()) return { text: text.trim(), generator: "llm-expanded" };
  } catch {}

  const fallback = await generateCoachReport(opts);
  return { text: fallback.prose, generator: fallback.generator };
}

/* ==================== Irrigation Solver ==================== */

let lastSolve: IrrSolveResponse | null = null;

function solveIrrDraft(payload: Record<string, unknown>): IrrSolveResponse {
  const photoperiodH = toNumber(payload.photoperiodH, 18);
  const vpdKpa = toNumber(payload.vpdKpa, toNumber(payload.vpd, 1.2));
  const dli = toNumber(payload.dli, toNumber(payload.ppfd, 600) * photoperiodH * 0.0036);
  const eventsPerDay = clamp(Math.round(toNumber(payload.eventsPerDay, 6)), 1, 24);
  const mlPerEvent = clamp(toNumber(payload.mlPerEvent, 150), 10, 5000);
  const runoffPct = clamp(toNumber(payload.runoffPct, 12), 0, 50);
  const drybackPct24h = clamp(toNumber(payload.drybackPct24h, 18), 0, 60);
  const co2ppm = toNumber(payload.co2, toNumber(payload.co2ppm, 900));

  const vpdFactor = clamp(Math.pow(vpdKpa / 1.2, 0.6), 0.75, 1.35);
  const dliFactor = clamp(Math.pow(Math.max(1, dli) / 35, 0.5), 0.7, 1.4);
  const co2Factor = clamp(1 + 0.1 * ((co2ppm - 450) / 750), 1, 1.1);
  const demandIndex = clamp((vpdFactor + dliFactor + co2Factor) / 3, 0.4, 1.4);

  const etBaseMlDay = 1500;
  const etPredMlDay = etBaseMlDay * demandIndex;
  const p1Events = Math.max(1, Math.round(eventsPerDay * 0.45));
  const p2Events = Math.max(1, eventsPerDay - p1Events);
  const p1Total = etPredMlDay * 0.55;
  const p2TotalRaw = etPredMlDay * 0.45;
  const p2Total = p2TotalRaw / Math.max(0.3, 1 - runoffPct / 100);
  const p1MlIdeal = clamp(p1Total / p1Events, 20, 1500);
  const p2MlIdeal = clamp(p2Total / p2Events, 20, 1500);

  const dbPctInterval = clamp(drybackPct24h / Math.max(1, p2Events), 0.5, 20);
  const coherence: string[] = [];
  if (runoffPct < 8) coherence.push("Runoff appears low relative to demand. Consider slightly higher P2 volume.");
  if (drybackPct24h > 30) coherence.push("Dryback appears high. Increase event frequency or per-event volume.");
  if (drybackPct24h < 8) coherence.push("Dryback appears low. Slightly reduce watering density.");

  return {
    ok: true,
    base_key_effective: "phase|container|media|sop_profile",
    cfg_key_effective: "phase|photoperiod|day|co2_mode",
    p1: { events: p1Events, pct_whc_ideal: Number((p1MlIdeal / 1000).toFixed(3)), ml_event_ideal: Number(p1MlIdeal.toFixed(1)) },
    p2: { events: p2Events, pct_whc_ideal: Number((p2MlIdeal / 1000).toFixed(3)), ml_event_ideal: Number(p2MlIdeal.toFixed(1)) },
    demand_index: Number(demandIndex.toFixed(3)),
    dbPct_interval: Number(dbPctInterval.toFixed(2)),
    coherence,
    observed: { level: coherence.length ? "PARTIAL" : "NONE", count: coherence.length, notes: coherence },
  };
}

/* ==================== TTS Providers ==================== */

async function speakWithEdgeTts(text: string, res: Response) {
  if (!edgeTts) {
    if (LLM_KEY) return await speakWithOpenAITts(text, res);
    throw new Error("edge-tts unavailable (ships TypeScript, not bundled) and no LLM key for OpenAI TTS fallback");
  }
  const it = await edgeTts({ text, voice: EDGE_VOICE, rate: EDGE_RATE, volume: EDGE_VOLUME });
  const chunks: Buffer[] = [];
  for await (const part of it) if (part && part.type === "audio" && part.data) chunks.push(Buffer.from(part.data));
  const buf = Buffer.concat(chunks);
  if (!buf.length) throw new Error("Edge TTS produced no audio");
  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Cache-Control", "no-store");
  res.end(buf);
}

async function speakWithAzureTts(text: string, res: Response) {
  const key = process.env.AZURE_TTS_KEY;
  const region = process.env.AZURE_TTS_REGION ?? "eastus";
  const voice = process.env.AZURE_TTS_VOICE ?? "en-US-OnyxMultilingualNeural";
  const rate = process.env.AZURE_TTS_RATE ?? "+15%";
  const pitch = process.env.AZURE_TTS_PITCH ?? "0%";
  const volume = process.env.AZURE_TTS_VOLUME ?? "0%";
  if (!key) throw new Error("AZURE_TTS_KEY not configured");

  const ssml =
    `<speak version="1.0" xml:lang="en-US">` +
    `<voice name="${voice}"><prosody rate="${rate}" pitch="${pitch}" volume="${volume}">${text}</prosody></voice>` +
    `</speak>`;

  const url = `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": key,
      "Content-Type": "application/ssml+xml",
      "X-Microsoft-OutputFormat": "audio-16khz-128kbitrate-mono-mp3",
      "User-Agent": "plantpilot-sidecar",
    },
    body: ssml,
  });
  if (!r.ok) {
    const err = await r.text().catch(() => "");
    throw new Error(`Azure TTS ${r.status}${err ? `: ${err}` : ""}`);
  }
  const ab = await r.arrayBuffer();
  const buf = Buffer.from(ab);
  if (!buf.length) throw new Error("Azure TTS returned empty audio");
  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Cache-Control", "no-store");
  res.end(buf);
}

async function speakWithOpenAITts(text: string, res: Response) {
  if (!LLM_KEY) throw new Error("LLM_API_KEY required for OpenAI TTS");
  const url = `${LLM_BASE}/v1/audio/speech`;
  const body = { model: OPENAI_TTS_MODEL, voice: OPENAI_TTS_VOICE, input: text, format: OPENAI_TTS_FORMAT };
  const r = await fetch(url, {
    method: "POST",
    headers: { ...buildHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const err = await r.text().catch(() => "");
    throw new Error(`OpenAI TTS ${r.status}${err ? `: ${err}` : ""}`);
  }
  const ab = await r.arrayBuffer();
  const buf = Buffer.from(ab);
  if (!buf.length) throw new Error("OpenAI TTS returned empty audio");
  const ct = OPENAI_TTS_FORMAT === "wav" ? "audio/wav" : "audio/mpeg";
  res.setHeader("Content-Type", ct);
  res.setHeader("Cache-Control", "no-store");
  res.end(buf);
}

async function speakWithGoogleTts(text: string, res: Response) {
  if (!googleTTSApi) throw new Error("google-tts-api not available");
  const MAX = 180;
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += MAX) chunks.push(text.slice(i, i + MAX));
  const bufs: Buffer[] = [];
  for (const c of chunks) {
    const arr = await (googleTTSApi as any).getAllAudioBase64(c, { lang: "en", slow: false });
    for (const p of (arr || [])) if (p?.base64) bufs.push(Buffer.from(String(p.base64), "base64"));
  }
  const buf = Buffer.concat(bufs);
  if (!buf.length) throw new Error("Google TTS returned empty audio");
  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Cache-Control", "no-store");
  res.end(buf);
}

/* ==================== Express App ==================== */

const app = express();

const corsOptions = CORS_ORIGIN
  ? { origin: CORS_ORIGIN.split(",").map(s => s.trim()), credentials: true }
  : { origin: true };
app.use(cors(corsOptions));
app.use(express.json({ limit: "2mb" }));

/* --- Health & Info --- */

app.get("/healthz", (_req: Request, res: Response) => {
  res.send("ok");
});

app.get("/whoami", (_req: Request, res: Response) => {
  res.json({
    version: VERSION,
    gasUrlConfigured: Boolean(GAS_URL),
    gasMethod: GAS_METHOD,
    llmEnabled: LLM_ENABLED,
    ttsProvider: TTS_PROVIDER,
    summaryMode: LLM_ENABLED ? "llm-coach" : "deterministic_local_fallback",
  });
});

/* --- Explain Routes --- */

app.get("/sheet/explain/humanized", async (req: Request, res: Response) => {
  try {
    const salt = typeof req.query.salt === "string" ? req.query.salt : "";
    const maxTokens = num(req.query.max, LLM_MAXTOK);
    const llm_ms = num(req.query.llm_ms, LLM_TIMEOUT_MS);

    const report = await generateCoachReport({ maxTokens, salt, llm_ms });
    res.set("Cache-Control", "no-store");
    res.json({
      humanized_text: report.prose,
      text: report.prose,
      flags: lastGas?.flags ?? [],
      stage: lastGas?.stage ?? "unspecified",
      timestamp: new Date().toISOString(),
      generator: report.generator,
      quality: report.quality,
    });
  } catch (error: any) {
    res.status(502).json({ error: String(error?.message || error) });
  }
});

app.get("/sheet/explain/expanded", async (req: Request, res: Response) => {
  try {
    const salt = typeof req.query.salt === "string" ? req.query.salt : "";
    const maxTokens = num(req.query.max, LLM_MAXTOK);
    const llm_ms = num(req.query.llm_ms, LLM_TIMEOUT_MS);

    const report = await generateExpandedReport({ maxTokens, salt, llm_ms });
    const gas = lastGas;
    res.set("Cache-Control", "no-store");
    res.json({
      expanded_text: report.text,
      text: report.text,
      bullets: (gas?.flags ?? []).map((f) => `${f.label}: ${f.reason || "No reason returned"}`),
      steps: [
        "Correct root-zone pH/EC first to recover nutrient transport.",
        "Rebalance climate (temperature/RH) before increasing light load.",
        "Capture fresh readings next cycle to verify trend direction.",
      ],
      generator: report.generator,
    });
  } catch (error: any) {
    res.status(502).json({ error: String(error?.message || error) });
  }
});

app.get("/explain/humanized", (req: Request, res: Response) => {
  res.redirect(307, `/sheet/explain/humanized?${new URLSearchParams(req.query as any).toString()}`);
});
app.get("/explain/expanded", (req: Request, res: Response) => {
  res.redirect(307, `/sheet/explain/expanded?${new URLSearchParams(req.query as any).toString()}`);
});

/* --- Irrigation Routes --- */

app.post("/sheet/irr/solveDraft", async (req: Request, res: Response) => {
  try {
    const body = (req.body || {}) as Record<string, unknown>;
    const solved = solveIrrDraft(body);
    lastSolve = solved;
    res.set("Cache-Control", "no-store");
    res.json(solved);
  } catch (error: any) {
    res.status(400).json({ error: String(error?.message || error) });
  }
});

app.post("/sheet/irr/apply", async (req: Request, res: Response) => {
  try {
    const body = (req.body || {}) as Record<string, unknown>;
    const solved = solveIrrDraft(body);
    lastSolve = solved;

    if (GAS_URL) {
      try {
        await fetch(GAS_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...body, apply: 1 }),
          redirect: "follow",
        });
      } catch {}
    }

    res.set("Cache-Control", "no-store");
    res.json({ ok: true, applied: true, ...solved });
  } catch (error: any) {
    res.status(400).json({ error: String(error?.message || error) });
  }
});

app.get("/sheet/reality-delta", async (_req: Request, res: Response) => {
  try {
    const solved = lastSolve || solveIrrDraft({});
    res.set("Cache-Control", "no-store");
    res.json({
      ok: true,
      base_key_effective: solved.base_key_effective,
      cfg_key_effective: solved.cfg_key_effective,
      coherence: solved.coherence,
      observed: solved.observed,
      p1: solved.p1,
      p2: solved.p2,
      demand_index: solved.demand_index,
      dbPct_interval: solved.dbPct_interval,
      delta: { user: { delta_p1_ml: 0, delta_p2_ml: 0 } },
    });
  } catch (error: any) {
    res.status(400).json({ error: String(error?.message || error) });
  }
});

/* --- TTS Route --- */

app.post("/speak", async (req: Request, res: Response) => {
  try {
    const text = String(req.body?.text ?? "").trim();
    if (!text) return res.status(400).json({ error: "text required" });

    const provider = String((req.body?.provider || TTS_PROVIDER) ?? "edge").toLowerCase();

    if (provider === "azure") return await speakWithAzureTts(text, res);
    if (provider === "openai") return await speakWithOpenAITts(text, res);
    if (provider === "edge") return await speakWithEdgeTts(text, res);

    try { return await speakWithGoogleTts(text, res); }
    catch (e) {
      console.warn("[tts] google failed, falling back to edge:", (e as any)?.message);
      return await speakWithEdgeTts(text, res);
    }
  } catch (e: any) {
    if (!res.headersSent) {
      res.status(500).json({ error: String(e?.message ?? e) });
    }
  }
});

/* --- GAS Proxy --- */

app.get("/gas", async (req: Request, res: Response) => {
  try {
    if (!GAS_URL) return res.status(400).json({ error: "GAS_DIAG_URL missing" });
    const url = new URL(GAS_URL);
    Object.entries(req.query).forEach(([key, value]) => url.searchParams.append(key, String(value)));
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), GAS_TIMEOUT_MS);
    try {
      const response = await fetch(url.toString(), { method: "GET", redirect: "follow", signal: controller.signal });
      const text = await response.text();
      res.type(response.headers.get("content-type") || "application/json").status(response.status).send(text);
    } finally { clearTimeout(t); }
  } catch (error: any) {
    res.status(502).json({ error: String(error?.message || error) });
  }
});

app.post("/gas", async (req: Request, res: Response) => {
  try {
    if (!GAS_URL) return res.status(400).json({ error: "GAS_DIAG_URL missing" });
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), GAS_TIMEOUT_MS);
    try {
      const response = await fetch(GAS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req.body),
        redirect: "follow",
        signal: controller.signal,
      });
      const text = await response.text();
      res.type(response.headers.get("content-type") || "application/json").status(response.status).send(text);
    } finally { clearTimeout(t); }
  } catch (error: any) {
    res.status(502).json({ error: String(error?.message || error) });
  }
});

/* --- Start --- */

app.listen(PORT, () => {
  console.log(`[sidecar ${VERSION}] listening on http://127.0.0.1:${PORT}`);
  console.log(`[sidecar] GAS: ${GAS_URL ? "configured" : "NOT SET"} | LLM: ${LLM_ENABLED ? "enabled" : "disabled"} | TTS: ${TTS_PROVIDER}`);
});
