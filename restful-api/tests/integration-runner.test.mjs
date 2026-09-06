import { expect, test } from "bun:test";
import { runIntegration } from "../scripts/test-integration.mjs";

test("integration runner cleans up after every failed stage and reports cleanup failure", () => {
  for (let failure = 0; failure < 4; failure++) {
    const calls = [];
    const status = runIntegration((_command, args) => {
      calls.push(args);
      return calls.length - 1 === failure ? 1 : 0;
    });
    expect(status).toBe(1);
    expect(calls.at(-1)[0]).toEndWith("test-db-down.mjs");
    expect(calls.length).toBe(Math.min(failure + 2, 4));
  }
});
