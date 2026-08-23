import { afterAll, describe, it } from "vitest";
import { join } from "node:path";
import { RuleTester } from "@typescript-eslint/rule-tester";
import { rule } from "../../eslint-rules/no-sql-brand-casts.mjs";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const fixtureFile = join(import.meta.dirname, "fixture.ts");
function fixture(code: string): { code: string; filename: string };
function fixture(
  code: string,
  errors: Array<{ messageId: "noSqlBrandCast"; data?: { name?: string } }>,
): {
  code: string;
  filename: string;
  errors: Array<{ messageId: "noSqlBrandCast"; data?: { name?: string } }>;
};
function fixture(
  code: string,
  errors?: Array<{ messageId: "noSqlBrandCast"; data?: { name?: string } }>,
) {
  return { code, filename: fixtureFile, ...(errors ? { errors } : {}) };
}
const brandCast = (name: string) => [{ messageId: "noSqlBrandCast" as const, data: { name } }];

const ruleTester = new RuleTester({
  languageOptions: {
    parserOptions: {
      projectService: true,
      tsconfigRootDir: join(import.meta.dirname, "../.."),
    },
  },
});

ruleTester.run("no-sql-brand-casts", rule, {
  valid: [
    // Unrelated casts are fine.
    fixture(
      `declare const value: unknown;
       const record = value as Record<string, unknown>;
       const text = String(value);`,
    ),
    // Importing the types without casting is fine.
    fixture(
      `import type { SqlFragment } from "../../src/sql.js";
       declare function make(): SqlFragment;
       const fragment = make();`,
    ),
  ],
  invalid: [
    fixture(
      `import type { SqlFragment } from "../../src/sql.js";
       declare const userInput: string;
       const fragment = userInput as SqlFragment;`,
      brandCast("SqlFragment"),
    ),
    fixture(
      `import type { SqlParam } from "../../src/sql.js";
       declare const text: string;
       const p = text as unknown as SqlParam;`,
      brandCast("SqlParam"),
    ),
    fixture(
      `import type { SqlFragment } from "../../src/sql.js";
       declare const userInput: string;
       const f = <SqlFragment>userInput;`,
      brandCast("SqlFragment"),
    ),
  ],
});
