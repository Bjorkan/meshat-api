import { setTimeout as delay } from "node:timers/promises";

// Retry only the initial, read-only probe. Never replay provisioning DDL or
// fixture ingestion, and fail immediately for authentication/configuration errors.
export async function waitForDatabase(sql, { attempts = 8, sleep = delay } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      await sql`SELECT 1`;
      return;
    } catch (error) {
      if (
        ![
          "57P03",
          "ECONNREFUSED",
          "CONNECTION_CLOSED",
          "ERR_POSTGRES_CONNECTION_CLOSED",
          "ERR_POSTGRES_CONNECTION_REFUSED",
        ].includes(error?.errno ?? error?.code) ||
        attempt + 1 >= attempts
      )
        throw error;
      await sleep(Math.min(250 * 2 ** attempt, 2000));
    }
  }
}
