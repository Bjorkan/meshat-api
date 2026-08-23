import { buildServer } from "./server.js";

const app = buildServer();
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "Shutting down");
  try {
    await app.close();
  } catch (error) {
    app.log.error(error, "Shutdown failed");
    process.exitCode = 1;
  }
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

try {
  await app.listen({
    host: process.env.MCP_HOST ?? "0.0.0.0",
    port: Number(process.env.MCP_PORT ?? 3001),
  });
} catch (error) {
  app.log.error(error, "Unable to start Meshat.se MCP-V2");
  process.exitCode = 1;
}
