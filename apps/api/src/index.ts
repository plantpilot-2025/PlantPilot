import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";

const app = Fastify({ logger: true });
const port = Number(process.env.PORT || 8789);

app.get("/healthz", async () => ({ ok: true, service: "plantpilot-api" }));

async function start() {
  await app.register(cors, { origin: true });
  await app.listen({ port, host: "0.0.0.0" });
}

start().catch((err) => {
  app.log.error(err);
  process.exit(1);
});
