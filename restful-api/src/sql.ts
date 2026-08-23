/**
 * Vetted SQL text primitives.
 *
 * PostgreSQL identifiers, sort expressions and other non-value SQL parts
 * cannot be sent as bound parameters. They must instead be built only from
 * reviewed static text plus `$N` placeholders. This module is the single
 * trust boundary for that construction:
 *
 * - `SqlParam` is a `$N` placeholder string produced only by
 *   `placeholder(index)`; the actual value travels in the query values
 *   array (normally via the `add(sql, value)` helper in src/repository.ts).
 * - `SqlFragment` is SQL text produced only by:
 *     - the `sql` tagged template (static text + SqlParam/SqlFragment slots),
 *     - `joinSql` (joining vetted fragments with a static separator),
 *     - `sqlDirection` (runtime-validated allowlist of "asc"/"desc").
 *
 * The brands are opaque: their marker symbols are not exported and plain
 * `string` is never assignable to either type, so arbitrary runtime values
 * cannot flow into SQL positions without a deliberate cast inside this
 * file. The ESLint rule meshat/no-unsafe-sql-interpolation enforces the
 * same boundary for template literals passed directly to query calls, and
 * meshat/no-sql-brand-casts rejects brand casts outside this module.
 *
 * Raw strings must never become SQL fragments. Dynamic identifiers and
 * sort directions may only pass through explicit allowlist helpers such as
 * `sqlDirection`.
 */

declare const sqlParamBrand: unique symbol;
declare const sqlFragmentBrand: unique symbol;

export type SqlParam = string & { readonly [sqlParamBrand]: true };
export type SqlFragment = string & { readonly [sqlFragmentBrand]: true };

/** Parts allowed inside `sql` template interpolation slots. */
export type SqlPart = SqlParam | SqlFragment;

/**
 * Bound-parameter placeholder for a 1-based positional index.
 *
 * Takes a number on purpose: placeholder text cannot smuggle values.
 */
export const placeholder = (index: number): SqlParam => `$${index}` as SqlParam;

/**
 * Typesafe SQL composer - the only way to build a fragment from parts.
 *
 * Static template text is compile-time visible; every interpolated slot
 * must already be a SqlParam or SqlFragment. Plain strings are rejected by
 * the type system:
 *
 *   const clause = sql`name = ${add(sql, name)}`;
 */
export function sql(strings: TemplateStringsArray, ...parts: SqlPart[]): SqlFragment {
  let out = "";
  for (const [index, text] of strings.entries()) {
    out += text;
    if (index < parts.length) out += parts[index];
  }
  return out as SqlFragment;
}

/** Join vetted fragments with a static separator (" AND ", " ", ...). */
export function joinSql(parts: readonly SqlFragment[], separator: string): SqlFragment {
  return parts.join(separator) as SqlFragment;
}

/** Runtime-validated allowlist for sort direction keywords. */
export function sqlDirection(direction: string): SqlFragment {
  if (direction !== "asc" && direction !== "desc")
    throw new Error(`Invalid sort direction: ${JSON.stringify(direction)}`);
  return direction as SqlFragment;
}
