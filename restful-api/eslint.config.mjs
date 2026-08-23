import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";
import eslintConfigPrettier from "eslint-config-prettier";
import sqlRule from "./eslint-rules/no-unsafe-sql-interpolation.mjs";
import sqlBrandCastRule from "./eslint-rules/no-sql-brand-casts.mjs";

/**
 * Meshat.se REST API - ESLint configuration (flat config).
 *
 * Prettier owns formatting; eslint-config-prettier is loaded last so no
 * stylistic rule fights the formatter. ESLint owns code quality:
 * async/promise correctness and type-aware bug risks.
 *
 * SQL construction safety is enforced by the local, conservative rule
 * meshat/no-unsafe-sql-interpolation: interpolation into SQL passed
 * directly to query calls is only allowed through branded SqlParam/
 * SqlFragment values (src/sql.ts) or compile-time string literal types.
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
    plugins: {
      meshat: {
        rules: {
          "no-unsafe-sql-interpolation": sqlRule,
          "no-sql-brand-casts": sqlBrandCastRule,
        },
      },
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

      // SQL construction safety (branded fragments only, see src/sql.ts).
      "meshat/no-unsafe-sql-interpolation": "error",
      // Brand casts are allowed only inside src/sql.ts.
      "meshat/no-sql-brand-casts": "error",

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
