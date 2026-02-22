import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";

const app = Fastify({ logger: true });
const port = Number(process.env.PORT || 8789);

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

const intakeRecords: IntakeRecord[] = [];

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
