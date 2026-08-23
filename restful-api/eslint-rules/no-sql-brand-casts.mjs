/**
 * meshat/no-sql-brand-casts
 *
 * Casts to the opaque SQL brands (SqlFragment / SqlParam) are only allowed
 * inside src/sql.ts, the single trust boundary that owns the unexported
 * brand symbols. Everywhere else a cast would be an unverified promise
 * ("I promise this string is safe"), so it is rejected:
 *
 *   const f = userInput as SqlFragment;          // flagged
 *   const p = text as unknown as SqlParam;       // flagged
 *   const g = <SqlFragment>text;                 // flagged
 *
 * Build fragments with the `sql` tagged template, joinSql() or
 * sqlDirection(), and placeholders with placeholder(index), instead.
 */

import { ESLintUtils } from "@typescript-eslint/utils";
import ts from "typescript";

const createRule = ESLintUtils.RuleCreator((name) => `eslint-rules/${name}.mjs`);

const BRAND_NAMES = new Set(["SqlFragment", "SqlParam"]);
// Symbol declaration names of the opaque brands; TypeScript can mangle
// symbol-keyed property names, hence substring matching.
const BRAND_SYMBOL_SUBSTRINGS = ["sqlFragmentBrand", "sqlParamBrand"];
const TRUSTED_FILE_SUFFIX = `${"src/"}sql.ts`;

function flattenParts(type, into = []) {
  if (!type) return into;
  if (typeof type.isUnion === "function" && type.isUnion()) {
    for (const part of type.types) flattenParts(part, into);
  } else if (typeof type.isIntersection === "function" && type.isIntersection()) {
    for (const part of type.types) flattenParts(part, into);
  } else {
    into.push(type);
  }
  return into;
}

function typeName(context, checker, node) {
  if (checker && node) {
    try {
      const type = checker.getTypeFromTypeNode(node);
      if (type.aliasSymbol && BRAND_NAMES.has(type.aliasSymbol.name)) {
        return type.aliasSymbol.name;
      }
      // Inline import types and inference can drop alias info while the
      // structural brand member remains detectable on constituents.
      const parts = [type, ...flattenParts(type)];
      for (const part of parts) {
        const props = checker.getPropertiesOfType(part);
        const branded = props.some((prop) =>
          [...BRAND_SYMBOL_SUBSTRINGS, ...BRAND_NAMES].some((marker) => prop.name.includes(marker)),
        );
        if (!branded) continue;
        const aliasName = part.aliasSymbol?.name ?? "";
        if (BRAND_NAMES.has(aliasName)) return aliasName;
        return (
          [...BRAND_NAMES].find((name) => props.some((prop) => prop.name.includes(name))) ??
          "SqlFragment"
        );
      }
    } catch {
      // fall through to textual matching below
    }
  }
  // Textual fallback: exact name or dotted member ending in a brand name.
  const text = context.sourceCode.getText(node ?? "").trim();
  const match = text.match(/(?:^|\.)\s*(SqlFragment|SqlParam)$/u);
  return match ? match[1] : null;
}

export const rule = createRule({
  name: "no-sql-brand-casts",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow casting values to the branded SqlFragment/SqlParam types outside src/sql.ts; use the vetted composer helpers instead.",
    },
    messages: {
      noSqlBrandCast:
        "Do not cast to '{{name}}' outside src/sql.ts. Build SQL with the `sql` tagged template / joinSql() / sqlDirection() and placeholders with placeholder(index).",
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    // The brand owner is the only file allowed to construct the types.
    const filename = context.filename.replaceAll("\\", "/");
    if (filename.endsWith(TRUSTED_FILE_SUFFIX)) return {};

    let checker = null;
    try {
      const services = ESLintUtils.getParserServices(context, true);
      checker = services.program?.getTypeChecker() ?? null;
    } catch {
      checker = null;
    }

    const checkAssertion = (node) => {
      const name = typeName(context, checker, node.typeAnnotation);
      if (name) {
        context.report({ node, messageId: "noSqlBrandCast", data: { name } });
      }
    };

    return {
      TSAsExpression: checkAssertion,
      TSSatisfiesExpression: checkAssertion,
      TSTypeAssertion: checkAssertion,
    };
  },
});

// Referenced so linters of this file do not flag the import as unused when
// only the fallback path runs in non-type-aware contexts.
void ts;

export default rule;
