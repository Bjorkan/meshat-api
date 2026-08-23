import { afterAll, describe, it } from "vitest";
import { join } from "node:path";
import { RuleTester } from "@typescript-eslint/rule-tester";
import { rule } from "../../eslint-rules/no-unsafe-sql-interpolation.mjs";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

// Fixtures must live inside the tsconfig project for type-aware linting.
const fixtureFile = join(import.meta.dirname, "fixture.ts");
function fixture(code: string): { code: string; filename: string };
function fixture(
  code: string,
  errors: Array<{
    messageId: "unsafeInterpolation" | "unsafeConcatenation";
    data?: { text?: string };
  }>,
): {
  code: string;
  filename: string;
  errors: Array<{
    messageId: "unsafeInterpolation" | "unsafeConcatenation";
    data?: { text?: string };
  }>;
};
function fixture(
  code: string,
  errors?: Array<{
    messageId: "unsafeInterpolation" | "unsafeConcatenation";
    data?: { text?: string };
  }>,
) {
  return { code, filename: fixtureFile, ...(errors ? { errors } : {}) };
}

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
    // placeholder() results are branded SqlParam values.
    fixture(
      `import { placeholder } from "../../src/sql.js";
       declare const db: { query(text: string): Promise<unknown> };
       declare const limit: number;
       const cursor = placeholder(3);
       db.query(\`SELECT * FROM nodes LIMIT \${cursor}\`);`,
    ),
    // The sql composer produces branded fragments.
    fixture(
      `import { sql } from "../../src/sql.js";
       declare const db: { query(text: string): Promise<unknown> };
       const select = sql\`public_key, latest_name\`;
       db.query(\`SELECT \${select} FROM meshcore_public.nodes\`);`,
    ),
    // sqlDirection wraps untrusted strings in a runtime allowlist.
    fixture(
      `import { sqlDirection } from "../../src/sql.js";
       declare const db: { query(text: string): Promise<unknown> };
       declare const request: { query: { order?: string } };
       db.query(\`SELECT * FROM nodes ORDER BY last_seen \${sqlDirection(request.query.order ?? "asc")}\`);`,
    ),
    // joinSql composition stays branded.
    fixture(
      `import { joinSql, sql } from "../../src/sql.js";
       declare const db: { query(text: string): Promise<unknown> };
       const parts = [sql\`a = $1\`, sql\`b = $2\`];
       db.query(\`SELECT * FROM t WHERE \${joinSql(parts, " AND ")}\`);`,
    ),
    // AST-provable literals remain fine.
    fixture(
      `declare const db: { query(text: string): Promise<unknown> };
       declare const descending: boolean;
       db.query(\`SELECT * FROM nodes ORDER BY id \${descending ? "DESC" : "ASC"}\`);`,
    ),
    fixture(
      `type Row = Record<string, unknown>;
       declare const pool: { query<T extends Row>(text: string): Promise<{ rows: T[] }> };
       pool.query<Row>("SELECT schema_id FROM metadata WHERE singleton = $1");`,
    ),
  ],
  invalid: [
    fixture(
      `declare const db: { query(text: string): Promise<unknown> };
       declare const id: string;
       db.query(\`SELECT * FROM nodes WHERE id = \${id}\`);`,
      unsafe("id"),
    ),
    fixture(
      `declare const db: { query(text: string): Promise<unknown> };
       declare const sort: string;
       db.query(\`SELECT * FROM nodes ORDER BY \${sort}\`);`,
      unsafe("sort"),
    ),
    fixture(
      `declare const db: { query(text: string): Promise<unknown> };
       declare const name: string;
       db.query(\`DELETE FROM nodes WHERE name = '\${name}'\`);`,
      unsafe("name"),
    ),
    fixture(
      `declare function query(text: string): void;
       declare const request: { query: Record<string, string> };
       query(\`SELECT * FROM t WHERE x = '\${request.query.filter}'\`);`,
      unsafe("request.query.filter"),
    ),
    // An unbranded constant carrying dynamic content has plain string type
    // and is caught - there is no module-scope trust escape hatch.
    fixture(
      `declare function query(text: string): void;
       declare const userInput: string;
       const UNBRANDED = \`SELECT \${userInput}\`;
       query(\`\${UNBRANDED} FROM t\`);`,
      unsafe("UNBRANDED"),
    ),
    fixture(
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
    fixture(
      `class Repo {
         private readonly pool = { query(text: string) { return Promise.resolve({ rows: [] }); } };
         async bad(name: string) {
           await this.pool.query(\`SELECT * FROM nodes WHERE latest_name = '\${name}'\`);
         }
       }`,
      unsafe("name"),
    ),
    fixture(
      `declare function query(text: string): void;
       declare const payload: any;
       query(\`SELECT \${payload.column} FROM t\`);`,
      unsafe("payload.column"),
    ),
    // A cast can lie to the type system: literal unions alone are NOT a
    // trust boundary. This must be flagged even though the static type is
    // "asc" | "desc".
    fixture(
      `declare const db: { query(text: string): Promise<unknown> };
       declare const request: { query: { order?: string } };
       const order = request.query.order as "asc" | "desc";
       db.query(\`SELECT * FROM nodes ORDER BY x \${order}\`);`,
      unsafe("order"),
    ),
  ],
});
