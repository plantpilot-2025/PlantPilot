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

const intakeRecords: IntakeRecord[] = [];
const chatRecords: ChatRecord[] = [];
let intakeWriteChain: Promise<void> = Promise.resolve();
let chatWriteChain: Promise<void> = Promise.resolve();

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
