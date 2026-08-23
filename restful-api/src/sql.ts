/**
 * Vetted SQL text primitives.
 *
 * PostgreSQL identifiers, sort expressions and other non-value SQL parts
 * cannot be sent as bound parameters. They must instead be built only from
 * reviewed, static text plus `$N` placeholders produced by `add()`. These
 * branded types make that distinction explicit at the type level:
 *
 * - `SqlParam` is a `$N` placeholder string produced by the placeholder
 *   builder; the actual value travels in the query values array.
 * - `SqlFragment` is SQL text assembled from reviewed static parts and/or
 *   placeholders via the explicit helpers in this module and in
 *   src/repository.ts (`add`, `where`, `frag`, the select/sort constants).
 *
 * Plain `string` is deliberately NOT assignable to either type, so arbitrary
 * runtime values cannot flow into SQL positions. The ESLint rule
 * meshat/no-unsafe-sql-interpolation enforces the same boundary for template
 * literals passed directly to database query calls.
 *
 * Never construct these types from unvalidated input. The casts inside this
 * module are the single trusted boundary.
 */

export type SqlParam = string & { readonly __sqlParam: "SqlParam" };
export type SqlFragment = string & { readonly __sqlFragment: "SqlFragment" };

/** Mark reviewed, static SQL text as a vetted fragment. */
export const frag = (value: string): SqlFragment => value as SqlFragment;

/** Mark an already-produced `$N` placeholder string (internal use). */
export const param = (placeholder: string): SqlParam => placeholder as SqlParam;
