/**
 * meshat/no-unsafe-sql-interpolation
 *
 * Conservative by default: every `${...}` expression inside a template
 * literal passed directly as the first argument of a database query call
 * (default: any `*.query(...)` or `query(...)`) is forbidden, unless the
 * expression is provably safe:
 *
 *   1. Its TypeScript type is a branded `SqlParam` / `SqlFragment` from
 *      src/sql.ts - produced only by placeholder(), the `sql` composer,
 *      joinSql() or sqlDirection().
 *   2. It is a plain string literal, a conditional whose branches are both
 *      safe, or a nested template whose expressions are all safe: values
 *      the AST itself proves are compile-time constants.
 *
 * String literal UNION types are deliberately NOT accepted on type
 * information alone: any value can be lied into `"asc" | "desc"` with a
 * cast. Route such values through sqlDirection()/the branded helpers.
 *
 * There is deliberately NO structural escape hatch: no "module scope is
 * trusted" rule, no allowlist by function name, and no general frag(string)
 * constructor. Unbranded constants carrying dynamic content have plain
 * string type and are rejected like direct interpolation.
 *
 * Flagged examples:
 *   db.query(`SELECT * FROM nodes WHERE id = ${id}`);
 *   db.query(`SELECT * FROM nodes WHERE name = '${name}'`);
 *   db.query(`ORDER BY ${sort}`);
 *   db.query("SELECT * FROM t WHERE x = " + userInput);
 *   db.query(`... ORDER BY x ${request.query.order as "asc" | "desc"}`);
 *
 * Not flagged:
 *   db.query("SELECT * FROM nodes WHERE id = $1", [id]);
 *   db.query(`SELECT * FROM nodes`);
 */

import { ESLintUtils } from "@typescript-eslint/utils";

const createRule = ESLintUtils.RuleCreator((name) => `eslint-rules/${name}.mjs`);

const defaultOptions = [
  {
    methods: ["query"],
    fragmentMarkers: [
      // Type alias names of the opaque brands in src/sql.ts.
      "SqlParam",
      "SqlFragment",
      // Unexported unique symbol declaration names, as a fallback when
      // alias information is lost through inference.
      "sqlParamBrand",
      "sqlFragmentBrand",
    ],
  },
];

function calleeName(call) {
  const callee = call.callee;
  if (callee.type === "Identifier") return callee.name;
  if (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property.type === "Identifier"
  ) {
    return callee.property.name;
  }
  return null;
}

export const rule = createRule({
  name: "no-unsafe-sql-interpolation",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow interpolating values into SQL passed directly to database query calls unless the expression is a branded SqlParam/SqlFragment value or an AST-provable compile-time literal.",
    },
    messages: {
      unsafeInterpolation:
        "Unsafe SQL interpolation of '{{text}}'. Send values as bound parameters ($1, $2, ...) via add(sql, value), and build identifiers/sort columns only through the branded SqlFragment helpers (sql`...`, joinSql, sqlDirection).",
      unsafeConcatenation:
        "Unsafe SQL built by concatenation with '{{text}}'. Send values as bound parameters ($1, $2, ...) instead.",
    },
    schema: [
      {
        type: "object",
        properties: {
          methods: {
            type: "array",
            items: { type: "string" },
            description: "DB call method names inspected by the rule.",
          },
          fragmentMarkers: {
            type: "array",
            items: { type: "string" },
            description:
              "Type alias / symbol names identifying branded SqlParam or SqlFragment values.",
          },
        },
        additionalProperties: false,
      },
    ],
  },
  defaultOptions,
  create(context, [options]) {
    const { methods, fragmentMarkers } = options;
    const sourceCode = context.sourceCode;

    // Fail closed: without type information everything dynamic is unsafe.
    let checker = null;
    let nodeMap = null;
    try {
      const services = ESLintUtils.getParserServices(context, true);
      checker = services.program?.getTypeChecker() ?? null;
      nodeMap = services.esTreeNodeToTSNodeMap ?? null;
    } catch {
      checker = null;
    }

    const typeOfNode = (node) => {
      if (!checker || !nodeMap) return null;
      try {
        return checker.getTypeAtLocation(nodeMap.get(node));
      } catch {
        return null;
      }
    };

    const flattenParts = (type, into = []) => {
      if (!type) return into;
      if (typeof type.isUnion === "function" && type.isUnion()) {
        for (const part of type.types) flattenParts(part, into);
      } else if (typeof type.isIntersection === "function" && type.isIntersection()) {
        for (const part of type.types) flattenParts(part, into);
      } else {
        into.push(type);
      }
      return into;
    };

    /** Branded SqlParam/SqlFragment detection (opaque brands in src/sql.ts). */
    const hasMarker = (type) => {
      if (!checker || !type) return false;
      // Alias information lives on the whole type; the structural brand
      // member may live on intersection constituents (its symbol name can
      // be mangled by TypeScript, hence substring matching).
      const candidates = [type, ...flattenParts(type)];
      return candidates.some((part) => {
        if (part.aliasSymbol && fragmentMarkers.includes(part.aliasSymbol.name)) return true;
        return checker
          .getPropertiesOfType(part)
          .some((prop) => fragmentMarkers.some((marker) => prop.name.includes(marker)));
      });
    };

    const unwrap = (node) =>
      node &&
      (node.type === "TSAsExpression" ||
        node.type === "TSSatisfiesExpression" ||
        node.type === "TSNonNullExpression")
        ? node.expression
        : node;

    const isSafeExpression = (node, seen = new Set()) => {
      node = unwrap(node);
      if (!node || seen.has(node)) return false;
      seen.add(node);
      switch (node.type) {
        case "Literal":
          return typeof node.value === "string";
        case "TemplateLiteral":
          return node.expressions.every((expression) => isSafeExpression(expression, seen));
        case "ConditionalExpression":
          return isSafeExpression(node.consequent, seen) && isSafeExpression(node.alternate, seen);
        default:
          return hasMarker(typeOfNode(node));
      }
    };

    const isQueryCall = (call) => methods.includes(calleeName(call));

    return {
      CallExpression(node) {
        if (!isQueryCall(node)) return;
        const argument = node.arguments.filter((a) => a.type !== "SpreadElement")[0];
        if (!argument) return;

        if (argument.type === "Literal") return;

        if (argument.type === "TemplateLiteral") {
          if (
            argument.expressions.length === 0 &&
            !argument.quasis.some((quasi) => quasi.value.raw.includes("${"))
          ) {
            return;
          }
          for (const expression of argument.expressions) {
            if (!isSafeExpression(expression)) {
              context.report({
                node: expression,
                messageId: "unsafeInterpolation",
                data: { text: sourceCode.getText(expression).slice(0, 80) },
              });
            }
          }
          return;
        }

        if (argument.type === "BinaryExpression" && argument.operator === "+") {
          const check = (part) => {
            part = unwrap(part);
            if (!part) return false;
            if (part.type === "Literal") return typeof part.value === "string";
            if (part.type === "BinaryExpression" && part.operator === "+")
              return check(part.left) && check(part.right);
            return isSafeExpression(part);
          };
          if (!check(argument)) {
            context.report({
              node: argument,
              messageId: "unsafeConcatenation",
              data: { text: sourceCode.getText(argument).slice(0, 80) },
            });
          }
        }
      },
    };
  },
});

export default rule;
