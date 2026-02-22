import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";

const app = Fastify({ logger: true });
const port = Number(process.env.PORT || 8789);
const intakeDataFile = resolve(
  process.cwd(),
  process.env.INTAKE_DATA_FILE || ".data/intake-records.json"
);
const chatDataFile = resolve(
  process.cwd(),
  process.env.CHAT_DATA_FILE || ".data/chat-records.json"
);
const sopDataFile = resolve(
  process.cwd(),
  process.env.SOP_DATA_FILE || ".data/sop-records.json"
);
const sopEntitlementDataFile = resolve(
  process.cwd(),
  process.env.SOP_ENTITLEMENT_DATA_FILE || ".data/sop-entitlements.json"
);
const sopRoyaltyLedgerDataFile = resolve(
  process.cwd(),
  process.env.SOP_ROYALTY_LEDGER_FILE || ".data/sop-royalty-ledger.json"
);

app.get("/healthz", async () => ({ ok: true, service: "plantpilot-api" }));

const intakeSchema = z.object({
  plantName: z.string().min(1),
  roomName: z.string().optional().default(""),
  targetPpm: z.string().optional().default(""),
  targetPh: z.string().optional().default(""),
  notes: z.string().optional().default(""),
  queuedAt: z.string().optional().default(""),
});

type IntakePayload = z.infer<typeof intakeSchema>;
type IntakeRecord = IntakePayload & {
  id: string;
  receivedAt: string;
};

const chatRequestSchema = z.object({
  message: z.string().min(1).max(2000),
  context: z
    .object({
      plantName: z.string().optional(),
      roomName: z.string().optional(),
      targetPpm: z.string().optional(),
      targetPh: z.string().optional(),
    })
    .optional(),
});

type ChatRecord = {
  id: string;
  message: string;
  response: string;
  createdAt: string;
};

const sopStatusSchema = z.enum(["private", "submitted", "approved", "rejected"]);

const sopCreateSchema = z.object({
  name: z.string().min(2).max(120),
  stage: z.string().min(2).max(120),
  notes: z.string().max(4000).optional().default(""),
});

type SopRecord = {
  id: string;
  ownerId: string;
  name: string;
  stage: string;
  notes: string;
  status: z.infer<typeof sopStatusSchema>;
  createdAt: string;
  updatedAt: string;
  submittedAt?: string;
  approvedAt?: string;
};

type SopEntitlementRecord = {
  id: string;
  userId: string;
  productId: string;
  transactionId: string;
  source: "apple_iap";
  purchasedAt: string;
};

type SopRoyaltyLedgerRecord = {
  id: string;
  productId: string;
  creatorId: string;
  transactionId: string;
  netRevenueCents: number;
  royaltyPercent: number;
  royaltyAmountCents: number;
  createdAt: string;
};

type StoreListing = {
  id: string;
  title: string;
  description: string;
  priceDisplay: string;
  currency: "USD";
  appleProductId: string;
  royaltyPercent: number;
  creatorId: string;
  active: boolean;
};

const STORE_LISTINGS: StoreListing[] = [
  {
    id: "sop_athena_pro_fade",
    title: "Athena Pro - Fade Performance",
    description: "Balanced bloom SOP tuned for stable output and fade control.",
    priceDisplay: "$29.99",
    currency: "USD",
    appleProductId: "com.growroom.sop.athena_pro_fade",
    royaltyPercent: 30,
    creatorId: "creator_sharkmouse",
    active: true,
  },
  {
    id: "sop_sharkmouse_core",
    title: "SharkMouse Core SOP",
    description: "General-purpose production SOP for predictable harvest cycles.",
    priceDisplay: "$24.99",
    currency: "USD",
    appleProductId: "com.growroom.sop.sharkmouse_core",
    royaltyPercent: 30,
    creatorId: "creator_sharkmouse",
    active: true,
  },
];

const iapVerifySchema = z.object({
  productId: z.string().min(3),
  transactionId: z.string().min(3),
  netRevenueCents: z.number().int().min(0).optional().default(0),
});

const intakeRecords: IntakeRecord[] = [];
const chatRecords: ChatRecord[] = [];
const sopRecords: SopRecord[] = [];
const sopEntitlements: SopEntitlementRecord[] = [];
const sopRoyaltyLedger: SopRoyaltyLedgerRecord[] = [];
let intakeWriteChain: Promise<void> = Promise.resolve();
let chatWriteChain: Promise<void> = Promise.resolve();
let sopWriteChain: Promise<void> = Promise.resolve();
let sopEntitlementWriteChain: Promise<void> = Promise.resolve();
let sopRoyaltyLedgerWriteChain: Promise<void> = Promise.resolve();

async function loadIntakeRecords() {
  try {
    const raw = await readFile(intakeDataFile, "utf8");
    const parsed = z.array(
      z.object({
        id: z.string(),
        receivedAt: z.string(),
        plantName: z.string(),
        roomName: z.string(),
        targetPpm: z.string(),
        targetPh: z.string(),
        notes: z.string(),
        queuedAt: z.string(),
      })
    ).parse(JSON.parse(raw));

    intakeRecords.splice(0, intakeRecords.length, ...parsed.slice(0, 200));
    app.log.info(
      { count: intakeRecords.length, intakeDataFile },
      "Loaded intake records from disk"
    );
  } catch {
    app.log.info({ intakeDataFile }, "No intake data file yet");
  }
}

function persistIntakeRecords() {
  const snapshot = JSON.stringify(intakeRecords, null, 2);
  intakeWriteChain = intakeWriteChain
    .then(async () => {
      await mkdir(dirname(intakeDataFile), { recursive: true });
      await writeFile(intakeDataFile, snapshot, "utf8");
    })
    .catch((err) => {
      app.log.error({ err }, "Failed writing intake records");
    });
  return intakeWriteChain;
}

async function loadChatRecords() {
  try {
    const raw = await readFile(chatDataFile, "utf8");
    const parsed = z.array(
      z.object({
        id: z.string(),
        message: z.string(),
        response: z.string(),
        createdAt: z.string(),
      })
    ).parse(JSON.parse(raw));

    chatRecords.splice(0, chatRecords.length, ...parsed.slice(0, 200));
    app.log.info(
      { count: chatRecords.length, chatDataFile },
      "Loaded chat records from disk"
    );
  } catch {
    app.log.info({ chatDataFile }, "No chat data file yet");
  }
}

function persistChatRecords() {
  const snapshot = JSON.stringify(chatRecords, null, 2);
  chatWriteChain = chatWriteChain
    .then(async () => {
      await mkdir(dirname(chatDataFile), { recursive: true });
      await writeFile(chatDataFile, snapshot, "utf8");
    })
    .catch((err) => {
      app.log.error({ err }, "Failed writing chat records");
    });
  return chatWriteChain;
}

async function loadSopRecords() {
  try {
    const raw = await readFile(sopDataFile, "utf8");
    const parsed = z
      .array(
        z.object({
          id: z.string(),
          ownerId: z.string(),
          name: z.string(),
          stage: z.string(),
          notes: z.string(),
          status: sopStatusSchema,
          createdAt: z.string(),
          updatedAt: z.string(),
          submittedAt: z.string().optional(),
          approvedAt: z.string().optional(),
        })
      )
      .parse(JSON.parse(raw));
    sopRecords.splice(0, sopRecords.length, ...parsed.slice(0, 500));
    app.log.info({ count: sopRecords.length, sopDataFile }, "Loaded SOP records from disk");
  } catch {
    app.log.info({ sopDataFile }, "No SOP data file yet");
  }
}

function persistSopRecords() {
  const snapshot = JSON.stringify(sopRecords, null, 2);
  sopWriteChain = sopWriteChain
    .then(async () => {
      await mkdir(dirname(sopDataFile), { recursive: true });
      await writeFile(sopDataFile, snapshot, "utf8");
    })
    .catch((err) => {
      app.log.error({ err }, "Failed writing SOP records");
    });
  return sopWriteChain;
}

async function loadSopEntitlements() {
  try {
    const raw = await readFile(sopEntitlementDataFile, "utf8");
    const parsed = z
      .array(
        z.object({
          id: z.string(),
          userId: z.string(),
          productId: z.string(),
          transactionId: z.string(),
          source: z.literal("apple_iap"),
          purchasedAt: z.string(),
        })
      )
      .parse(JSON.parse(raw));
    sopEntitlements.splice(0, sopEntitlements.length, ...parsed.slice(0, 1000));
    app.log.info(
      { count: sopEntitlements.length, sopEntitlementDataFile },
      "Loaded SOP entitlements from disk"
    );
  } catch {
    app.log.info({ sopEntitlementDataFile }, "No SOP entitlement data file yet");
  }
}

function persistSopEntitlements() {
  const snapshot = JSON.stringify(sopEntitlements, null, 2);
  sopEntitlementWriteChain = sopEntitlementWriteChain
    .then(async () => {
      await mkdir(dirname(sopEntitlementDataFile), { recursive: true });
      await writeFile(sopEntitlementDataFile, snapshot, "utf8");
    })
    .catch((err) => {
      app.log.error({ err }, "Failed writing SOP entitlements");
    });
  return sopEntitlementWriteChain;
}

async function loadSopRoyaltyLedger() {
  try {
    const raw = await readFile(sopRoyaltyLedgerDataFile, "utf8");
    const parsed = z
      .array(
        z.object({
          id: z.string(),
          productId: z.string(),
          creatorId: z.string(),
          transactionId: z.string(),
          netRevenueCents: z.number().int(),
          royaltyPercent: z.number(),
          royaltyAmountCents: z.number().int(),
          createdAt: z.string(),
        })
      )
      .parse(JSON.parse(raw));
    sopRoyaltyLedger.splice(0, sopRoyaltyLedger.length, ...parsed.slice(0, 5000));
    app.log.info(
      { count: sopRoyaltyLedger.length, sopRoyaltyLedgerDataFile },
      "Loaded SOP royalty ledger from disk"
    );
  } catch {
    app.log.info({ sopRoyaltyLedgerDataFile }, "No SOP royalty ledger file yet");
  }
}

function persistSopRoyaltyLedger() {
  const snapshot = JSON.stringify(sopRoyaltyLedger, null, 2);
  sopRoyaltyLedgerWriteChain = sopRoyaltyLedgerWriteChain
    .then(async () => {
      await mkdir(dirname(sopRoyaltyLedgerDataFile), { recursive: true });
      await writeFile(sopRoyaltyLedgerDataFile, snapshot, "utf8");
    })
    .catch((err) => {
      app.log.error({ err }, "Failed writing SOP royalty ledger");
    });
  return sopRoyaltyLedgerWriteChain;
}

function getUserIdFromHeaders(headers: Record<string, string | string[] | undefined>) {
  const raw = headers["x-growroom-user-id"];
  if (Array.isArray(raw)) return raw[0] || "anon_user";
  if (!raw) return "anon_user";
  return String(raw).trim() || "anon_user";
}

function buildChatResponse(input: z.infer<typeof chatRequestSchema>) {
  const message = input.message.toLowerCase();
  const targetPpm = input.context?.targetPpm || "your target";
  const targetPh = input.context?.targetPh || "your target";
  const plantName = input.context?.plantName || "your plant";

  if (message.includes("ppm")) {
    return `For ${plantName}, start by stabilizing near ${targetPpm} ppm, then adjust in small increments based on new growth response over 24-48h.`;
  }
  if (message.includes("ph")) {
    return `Keep pH close to ${targetPh}. If readings drift, correct gradually rather than in one large correction to avoid plant stress.`;
  }
  if (message.includes("flush")) {
    return "If a flush is needed, run clean water until runoff EC/PPM drops significantly, then reintroduce nutrients at a lighter strength.";
  }

  return "Current recommendation: verify environment stability first (temp, RH, EC/PPM, pH), then change only one variable at a time and monitor for 24-48h.";
}

app.post("/v1/intake", async (request, reply) => {
  const parsed = intakeSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({
      ok: false,
      error: "Invalid intake payload",
      details: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }

  const record: IntakeRecord = {
    id: `intake_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    receivedAt: new Date().toISOString(),
    ...parsed.data,
  };

  intakeRecords.unshift(record);
  if (intakeRecords.length > 200) intakeRecords.length = 200;
  void persistIntakeRecords();
  app.log.info(
    { id: record.id, plantName: record.plantName, roomName: record.roomName },
    "Intake received"
  );

  return { ok: true, id: record.id, stored: "memory" };
});

app.get("/v1/intake/recent", async (request) => {
  const limitRaw = (request.query as { limit?: string })?.limit;
  const parsedLimit = Number(limitRaw);
  const limit =
    Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.min(parsedLimit, 50)
      : 20;
  return { ok: true, count: intakeRecords.length, items: intakeRecords.slice(0, limit) };
});

app.post("/v1/chat", async (request, reply) => {
  const parsed = chatRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({
      ok: false,
      error: "Invalid chat payload",
      details: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }

  const response = buildChatResponse(parsed.data);
  const record: ChatRecord = {
    id: `chat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    message: parsed.data.message,
    response,
    createdAt: new Date().toISOString(),
  };
  chatRecords.unshift(record);
  if (chatRecords.length > 200) chatRecords.length = 200;
  void persistChatRecords();

  return { ok: true, ...record };
});

app.get("/v1/chat/recent", async (request) => {
  const limitRaw = (request.query as { limit?: string })?.limit;
  const parsedLimit = Number(limitRaw);
  const limit =
    Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.min(parsedLimit, 50)
      : 20;
  return { ok: true, count: chatRecords.length, items: chatRecords.slice(0, limit) };
});

app.get("/v1/sops/store", async (request) => {
  const userId = getUserIdFromHeaders(request.headers);
  const ownedProductIds = new Set(
    sopEntitlements.filter((entry) => entry.userId === userId).map((entry) => entry.productId)
  );
  return {
    ok: true,
    count: STORE_LISTINGS.length,
    items: STORE_LISTINGS.filter((item) => item.active).map((item) => ({
      ...item,
      status: ownedProductIds.has(item.id) ? "owned" : "locked",
    })),
  };
});

app.get("/v1/sops/my", async (request) => {
  const userId = getUserIdFromHeaders(request.headers);
  const items = sopRecords
    .filter((record) => record.ownerId === userId)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .slice(0, 100);
  return { ok: true, count: items.length, items };
});

app.post("/v1/sops/my", async (request, reply) => {
  const parsed = sopCreateSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({
      ok: false,
      error: "Invalid SOP payload",
      details: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }

  const userId = getUserIdFromHeaders(request.headers);
  const now = new Date().toISOString();
  const record: SopRecord = {
    id: `sop_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    ownerId: userId,
    name: parsed.data.name,
    stage: parsed.data.stage,
    notes: parsed.data.notes,
    status: "private",
    createdAt: now,
    updatedAt: now,
  };
  sopRecords.unshift(record);
  if (sopRecords.length > 1000) sopRecords.length = 1000;
  void persistSopRecords();
  return { ok: true, item: record };
});

app.post("/v1/sops/:id/submit", async (request, reply) => {
  const id = (request.params as { id?: string })?.id;
  if (!id) {
    return reply.status(400).send({ ok: false, error: "Missing SOP id" });
  }
  const userId = getUserIdFromHeaders(request.headers);
  const existing = sopRecords.find((record) => record.id === id && record.ownerId === userId);
  if (!existing) {
    return reply.status(404).send({ ok: false, error: "SOP not found" });
  }
  existing.status = "submitted";
  existing.submittedAt = new Date().toISOString();
  existing.updatedAt = existing.submittedAt;
  void persistSopRecords();
  return { ok: true, item: existing };
});

app.get("/v1/sops/entitlements", async (request) => {
  const userId = getUserIdFromHeaders(request.headers);
  const items = sopEntitlements
    .filter((entry) => entry.userId === userId)
    .sort((a, b) => (a.purchasedAt < b.purchasedAt ? 1 : -1))
    .slice(0, 200);
  return { ok: true, count: items.length, items };
});

app.post("/v1/sops/iap/verify", async (request, reply) => {
  const parsed = iapVerifySchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({
      ok: false,
      error: "Invalid IAP payload",
      details: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }

  const listing = STORE_LISTINGS.find((item) => item.id === parsed.data.productId && item.active);
  if (!listing) {
    return reply.status(404).send({ ok: false, error: "Store product not found" });
  }

  const userId = getUserIdFromHeaders(request.headers);
  const existing = sopEntitlements.find(
    (entry) =>
      entry.userId === userId &&
      entry.productId === parsed.data.productId &&
      entry.transactionId === parsed.data.transactionId
  );
  if (existing) {
    return { ok: true, alreadyOwned: true, entitlement: existing };
  }

  const now = new Date().toISOString();
  const entitlement: SopEntitlementRecord = {
    id: `ent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    userId,
    productId: parsed.data.productId,
    transactionId: parsed.data.transactionId,
    source: "apple_iap",
    purchasedAt: now,
  };
  sopEntitlements.unshift(entitlement);
  if (sopEntitlements.length > 5000) sopEntitlements.length = 5000;
  void persistSopEntitlements();

  const netRevenueCents = parsed.data.netRevenueCents;
  if (netRevenueCents > 0) {
    const royaltyAmountCents = Math.round((netRevenueCents * listing.royaltyPercent) / 100);
    const royaltyEntry: SopRoyaltyLedgerRecord = {
      id: `roy_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      productId: listing.id,
      creatorId: listing.creatorId,
      transactionId: parsed.data.transactionId,
      netRevenueCents,
      royaltyPercent: listing.royaltyPercent,
      royaltyAmountCents,
      createdAt: now,
    };
    sopRoyaltyLedger.unshift(royaltyEntry);
    if (sopRoyaltyLedger.length > 5000) sopRoyaltyLedger.length = 5000;
    void persistSopRoyaltyLedger();
  }

  return {
    ok: true,
    entitlement,
    royaltyPercent: listing.royaltyPercent,
    message: "Purchase verified and entitlement granted.",
  };
});

const deletionRequestSchema = z.object({
  email: z.string().email().optional(),
  reason: z.string().min(3).max(500).optional(),
});

app.post("/v1/account/deletion-request", async (request, reply) => {
  const parsed = deletionRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({
      ok: false,
      error: "Invalid request body",
      details: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }

  // For now this is intentionally lightweight; replace with DB persistence.
  const ticketId = `del_${Date.now()}`;
  app.log.info({ ticketId, ...parsed.data }, "Deletion request received");

  return {
    ok: true,
    ticketId,
    message:
      "Deletion request received. Our team will process your request within 30 days.",
  };
});

function resolveCorsOrigins() {
  const configuredOrigins = process.env.CORS_ORIGIN?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (!configuredOrigins?.length) return true;
  return configuredOrigins;
}

async function start() {
  await loadIntakeRecords();
  await loadChatRecords();
  await loadSopRecords();
  await loadSopEntitlements();
  await loadSopRoyaltyLedger();
  await app.register(rateLimit, {
    global: true,
    max: 120,
    timeWindow: "1 minute",
  });
  await app.register(cors, { origin: resolveCorsOrigins() });
  await app.listen({ port, host: "0.0.0.0" });
}

start().catch((err) => {
  app.log.error(err);
  process.exit(1);
});
