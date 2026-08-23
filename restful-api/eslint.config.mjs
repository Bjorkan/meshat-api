import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";
import eslintConfigPrettier from "eslint-config-prettier";

/**
 * Meshat.se REST API - ESLint configuration (flat config).
 *
 * Prettier owns formatting; eslint-config-prettier is loaded last so no
 * stylistic rule fights the formatter. ESLint owns code quality:
 * async/promise correctness and type-aware bug risks.
 *
 * SQL safety is enforced by convention, not by a custom lint rule: all values
 * must be bound parameters ($1, $2, ...) via the add(sql, value) helper in
 * src/repository.ts, dynamic identifiers/sort columns only via internal
 * allowlist records, and query semantics are verified by PostgreSQL-backed
 * tests. See AGENTS.md.
 */
export default tseslint.config(
  {
    ignores: ["node_modules/**", "dist/**", "coverage/**"],
  },

  // Plain JS tooling files (no TypeScript project context available).
  {
    files: ["**/*.js", "**/*.mjs"],
    ...js.configs.recommended,
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // TypeScript sources with full type-aware linting.
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ["src/**/*.ts", "tests/**/*.ts"],
  })),
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
    rules: {
      // Async / promise correctness.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",

      // Protocol enums and discriminated unions must be handled exhaustively.
      "@typescript-eslint/switch-exhaustiveness-check": "error",

      // Unsafe values must not spread beyond validated boundaries.
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-return": "error",

      // Underscore-prefixed names mark intentionally unused interface fillers
      // (rest-sibling destructuring, unused interface parameters in fakes).
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
    },
  },

  // Test suites legitimately implement async interfaces synchronously
  // (fakes without awaits); require-await only produces noise there while
  // remaining active for src/, where it currently reports nothing.
  {
    files: ["tests/**/*.ts"],
    rules: {
      "@typescript-eslint/require-await": "off",
    },
  },

  // Must remain last so it can disable stylistic rules.
  eslintConfigPrettier,
);
