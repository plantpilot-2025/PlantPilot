"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const fastify_1 = __importDefault(require("fastify"));
const cors_1 = __importDefault(require("@fastify/cors"));
const rate_limit_1 = __importDefault(require("@fastify/rate-limit"));
const zod_1 = require("zod");
const app = (0, fastify_1.default)({ logger: true });
const port = Number(process.env.PORT || 8789);
app.get("/healthz", async () => ({ ok: true, service: "plantpilot-api" }));
const intakeSchema = zod_1.z.object({
    plantName: zod_1.z.string().min(1),
    roomName: zod_1.z.string().optional().default(""),
    targetPpm: zod_1.z.string().optional().default(""),
    targetPh: zod_1.z.string().optional().default(""),
    notes: zod_1.z.string().optional().default(""),
    queuedAt: zod_1.z.string().optional().default(""),
});
const intakeRecords = [];
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
    const record = {
        id: `intake_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        receivedAt: new Date().toISOString(),
        ...parsed.data,
    };
    intakeRecords.unshift(record);
    if (intakeRecords.length > 200)
        intakeRecords.length = 200;
    app.log.info({ id: record.id, plantName: record.plantName, roomName: record.roomName }, "Intake received");
    return { ok: true, id: record.id, stored: "memory" };
});
app.get("/v1/intake/recent", async (request) => {
    const limitRaw = request.query?.limit;
    const parsedLimit = Number(limitRaw);
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0
        ? Math.min(parsedLimit, 50)
        : 20;
    return { ok: true, count: intakeRecords.length, items: intakeRecords.slice(0, limit) };
});
const deletionRequestSchema = zod_1.z.object({
    email: zod_1.z.string().email().optional(),
    reason: zod_1.z.string().min(3).max(500).optional(),
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
        message: "Deletion request received. Our team will process your request within 30 days.",
    };
});
function resolveCorsOrigins() {
    const configuredOrigins = process.env.CORS_ORIGIN?.split(",")
        .map((origin) => origin.trim())
        .filter(Boolean);
    if (!configuredOrigins?.length)
        return true;
    return configuredOrigins;
}
async function start() {
    await app.register(rate_limit_1.default, {
        global: true,
        max: 120,
        timeWindow: "1 minute",
    });
    await app.register(cors_1.default, { origin: resolveCorsOrigins() });
    await app.listen({ port, host: "0.0.0.0" });
}
start().catch((err) => {
    app.log.error(err);
    process.exit(1);
});
