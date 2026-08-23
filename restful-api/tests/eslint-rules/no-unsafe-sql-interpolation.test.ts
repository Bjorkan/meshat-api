import { afterAll, describe, it } from "vitest";
import { join } from "node:path";
import { RuleTester } from "@typescript-eslint/rule-tester";
import { rule } from "../../eslint-rules/no-unsafe-sql-interpolation.mjs";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

// Fixtures must live inside the tsconfig project for type-aware linting.
const fixtureFile = join(import.meta.dirname, "fixture.ts");
const fixture = (code: string) => ({ code, filename: fixtureFile });
const invalidFixture = (
  code: string,
  errors: Array<{
    messageId: "unsafeInterpolation" | "unsafeConcatenation";
    data?: { text?: string };
  }>,
) => ({ ...fixture(code), errors });

const unsafe = (text: string) => [{ messageId: "unsafeInterpolation" as const, data: { text } }];

const ruleTester = new RuleTester({
  languageOptions: {
    parserOptions: {
      projectService: true,
      tsconfigRootDir: join(import.meta.dirname, "../.."),
    },
  },
});

ruleTester.run("no-unsafe-sql-interpolation", rule, {
  valid: [
    fixture(
      `declare const db: { query(text: string, values?: unknown[]): Promise<unknown> };
       declare const id: string;
       db.query("SELECT * FROM nodes WHERE id = $1", [id]);`,
    ),
    fixture("db.query(`SELECT * FROM nodes WHERE active = TRUE`);"),
    fixture(
      `import type { SqlParam } from "../../src/sql.js";
       declare const db: { query(text: string): Promise<unknown> };
       declare function add(sql: unknown, value: unknown): SqlParam;
       declare const sql: unknown;
       declare const limit: number;
       db.query(\`SELECT * FROM nodes LIMIT \${add(sql, limit)}\`);`,
    ),
    fixture(
      `import type { SqlParam } from "../../src/sql.js";
       declare const db: { query(text: string): Promise<unknown> };
       declare function add(sql: unknown, value: unknown): SqlParam;
       declare const sql: unknown;
       const cursorLimit = add(sql, 11);
       db.query(\`SELECT * FROM nodes LIMIT \${cursorLimit}\`);`,
    ),
    fixture(
      `import { frag } from "../../src/sql.js";
       declare const db: { query(text: string): Promise<unknown> };
       const select = frag("public_key, latest_name");
       db.query(\`SELECT \${select} FROM meshcore_public.nodes\`);`,
    ),
    fixture(
      `declare const db: { query(text: string): Promise<unknown> };
       declare const order: "asc" | "desc";
       db.query(\`SELECT * FROM nodes ORDER BY last_seen \${order}\`);`,
    ),
    fixture(
      `import { frag } from "../../src/sql.js";
       declare const db: { query(text: string): Promise<unknown> };
       declare const withName: boolean;
       db.query(withName ? frag("SELECT 1 WHERE $1 IS NOT NULL") : frag("SELECT 1"));`,
    ),
    fixture(
      `type Row = Record<string, unknown>;
       declare const pool: { query<T extends Row>(text: string): Promise<{ rows: T[] }> };
       pool.query<Row>("SELECT schema_id FROM metadata WHERE singleton = $1");`,
    ),
  ],
  invalid: [
    invalidFixture(
      `declare const db: { query(text: string): Promise<unknown> };
       declare const id: string;
       db.query(\`SELECT * FROM nodes WHERE id = \${id}\`);`,
      unsafe("id"),
    ),
    invalidFixture(
      `declare const db: { query(text: string): Promise<unknown> };
       declare const sort: string;
       db.query(\`SELECT * FROM nodes ORDER BY \${sort}\`);`,
      unsafe("sort"),
    ),
    invalidFixture(
      `declare const db: { query(text: string): Promise<unknown> };
       declare const name: string;
       db.query(\`DELETE FROM nodes WHERE name = '\${name}'\`);`,
      unsafe("name"),
    ),
    invalidFixture(
      `declare function query(text: string): void;
       declare const request: { query: Record<string, string> };
       query(\`SELECT * FROM t WHERE x = '\${request.query.filter}'\`);`,
      unsafe("request.query.filter"),
    ),
    // An unbranded constant carrying dynamic content has plain string type
    // and is caught - there is no module-scope trust escape hatch.
    invalidFixture(
      `declare function query(text: string): void;
       declare const userInput: string;
       const UNBRANDED = \`SELECT \${userInput}\`;
       query(\`\${UNBRANDED} FROM t\`);`,
      unsafe("UNBRANDED"),
    ),
    invalidFixture(
      `declare function query(text: string): void;
       declare const userInput: string;
       query("SELECT * FROM t WHERE x = " + userInput);`,
      [
        {
          messageId: "unsafeConcatenation",
          data: { text: `"SELECT * FROM t WHERE x = " + userInput` },
        },
      ],
    ),
    invalidFixture(
      `class Repo {
         private readonly pool = { query(text: string) { return Promise.resolve({ rows: [] }); } };
         async bad(name: string) {
           await this.pool.query(\`SELECT * FROM nodes WHERE latest_name = '\${name}'\`);
         }
       }`,
      unsafe("name"),
    ),
    invalidFixture(
      `declare function query(text: string): void;
       declare const payload: any;
       query(\`SELECT \${payload.column} FROM t\`);`,
      unsafe("payload.column"),
    ),
  ],
});
