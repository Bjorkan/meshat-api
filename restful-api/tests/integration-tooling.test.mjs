import { expect, test } from "bun:test";
import { waitForDatabase } from "../scripts/integration-ready.mjs";

test("initial database probe retries transient startup errors with bounded backoff", async () => {
  let calls = 0;
  const waits = [];
  await waitForDatabase(
    async () => {
      if (++calls < 4)
        throw Object.assign(new Error("starting"), {
          code: "ERR_POSTGRES_SERVER_ERROR",
          errno: "57P03",
        });
    },
    {
      sleep: async (ms) => {
        waits.push(ms);
      },
    },
  );
  expect(calls).toBe(4);
  expect(waits).toEqual([250, 500, 1000]);
});

test("database probe stops on permanent errors and after the attempt budget", async () => {
  for (const code of ["28P01", "57P03"]) {
    let calls = 0;
    const error = Object.assign(new Error("probe failed"), { code });
    await expect(
      waitForDatabase(
        async () => {
          calls++;
          throw error;
        },
        {
          attempts: 3,
          sleep: async () => {},
        },
      ),
    ).rejects.toBe(error);
    expect(calls).toBe(code === "57P03" ? 3 : 1);
  }
});
