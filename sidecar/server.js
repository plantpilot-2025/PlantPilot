import cors from "cors";
import express from "express";

const PORT = Number(process.env.PORT || 8789);
const GAS_URL = process.env.GAS_DIAG_URL || "";
const GAS_METHOD = (process.env.GAS_METHOD || "POST").toUpperCase();

function withTimeout(ms, fn) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return Promise.resolve(fn(controller.signal)).finally(() => clearTimeout(timer));
}

function scoreToSeverity(score) {
  if (score >= 0.66) return "high";
  if (score >= 0.33) return "medium";
  return "low";
}

function buildFallbackSummary(flags) {
  if (!flags.length) {
    return "No critical rule violations detected from the latest sheet diagnostics. Keep collecting routine readings and monitor trend movement across environment and root-zone metrics.";
  }
  const top = flags.slice(0, 3);
  const opening = `Top risks were detected in ${top.map((flag) => flag.label).join(", ")}.`;
  const detail = top
    .map((flag, index) => `${index + 1}) ${flag.label}: ${flag.reason || "Out-of-range condition detected."}`)
    .join(" ");
  const actions =
    "Recommended next steps: stabilize root-zone chemistry first, then correct climate and light pressure, and re-check runoff responses within the next irrigation cycle.";
  return `${opening} ${detail} ${actions}`;
}

async function pullGas(signal) {
  if (!GAS_URL) throw new Error("GAS_DIAG_URL missing");
  const headers = {
    Accept: "application/json",
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

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`GAS HTTP ${response.status}${text ? `: ${text}` : ""}`);
  }

  const payload = await response.json();
  const env = Array.isArray(payload?.top3ByGate?.ENV) ? payload.top3ByGate.ENV : [];
  const root = Array.isArray(payload?.top3ByGate?.ROOT) ? payload.top3ByGate.ROOT : [];
  const irr = Array.isArray(payload?.top3ByGate?.IRR) ? payload.top3ByGate.IRR : [];

  const rows = [
    ...env.map((row) => ({ gate: "ENV", row })),
    ...root.map((row) => ({ gate: "ROOT", row })),
    ...irr.map((row) => ({ gate: "IRR", row })),
  ];

  const flags = rows
    .map(({ gate, row }) => ({
      label: String(row?.[0] || "").trim(),
      reason: row?.[1] ? String(row[1]) : undefined,
      score: Number(row?.[2] ?? 0) || 0,
      severity: scoreToSeverity(Number(row?.[2] ?? 0) || 0),
      gate,
    }))
    .filter((item) => item.label)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  return {
    flags,
    summary: buildFallbackSummary(flags),
    stage: String(payload?.stage ?? "unspecified"),
    timestamp: new Date().toISOString(),
  };
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/healthz", (_req, res) => res.send("ok"));

app.get("/whoami", (_req, res) => {
  res.json({
    gasUrlConfigured: Boolean(GAS_URL),
    gasMethod: GAS_METHOD,
    summaryMode: "deterministic_local_fallback",
    openAiDisabled: true,
  });
});

app.get("/sheet/explain/humanized", async (_req, res) => {
  try {
    const result = await withTimeout(15000, (signal) => pullGas(signal));
    res.set("Cache-Control", "no-store");
    res.json({
      humanized_text: result.summary,
      text: result.summary,
      flags: result.flags,
      stage: result.stage,
      timestamp: result.timestamp,
      generator: "rules-fallback-no-openai",
    });
  } catch (error) {
    res.status(502).json({ error: String(error?.message || error) });
  }
});

app.get("/sheet/explain/expanded", async (_req, res) => {
  try {
    const result = await withTimeout(15000, (signal) => pullGas(signal));
    res.set("Cache-Control", "no-store");
    res.json({
      expanded_text: result.summary,
      text: result.summary,
      bullets: result.flags.map((flag) => `${flag.label}: ${flag.reason || "No reason returned"}`),
      steps: [
        "Correct root-zone pH/EC first to recover nutrient transport.",
        "Rebalance climate (temperature/RH) before increasing light load.",
        "Capture fresh readings next cycle to verify trend direction.",
      ],
      generator: "rules-fallback-no-openai",
    });
  } catch (error) {
    res.status(502).json({ error: String(error?.message || error) });
  }
});

app.listen(PORT, () => {
  console.log(`[openai-root] listening on http://127.0.0.1:${PORT}`);
});
