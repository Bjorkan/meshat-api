import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";
import eslintConfigPrettier from "eslint-config-prettier";

/**
 * Meshat.se MCP-V2 - ESLint configuration (flat config).
 *
 * Prettier owns formatting; eslint-config-prettier is loaded last so no
 * stylistic rule fights the formatter. ESLint owns code quality:
 * async/promise correctness and type-aware bug risks.
 *
 * This service contains no SQL and no PostgreSQL access; it talks to the
 * REST API only. Type-aware linting applies to src/ (covered by
 * tsconfig.json); tests are linted without type information because they
 * are intentionally outside the build's tsconfig include set.
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
    files: ["src/**/*.ts"],
  })),
  {
    files: ["src/**/*.ts"],
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
    },
  },

  // Tests are outside the build tsconfig, so they get quality rules
  // without type information.
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ["tests/**/*.ts"],
  })),
  {
    files: ["tests/**/*.ts"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // Must remain last so it can disable stylistic rules.
  eslintConfigPrettier,
);
