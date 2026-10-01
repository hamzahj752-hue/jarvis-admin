import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

/*
 * Lint rules for the admin panel.
 *
 * The important one is `no-console`: nothing in this bundle may log. The panel
 * runs in the browser of whoever holds an administrator session, so a stray log
 * line is a place where configuration or a session fragment can end up in a
 * console that gets pasted into a support thread.
 */
export default tseslint.config(
  { ignores: ["dist/**", "coverage/**", "node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.es2022 }
    },
    rules: {
      "no-console": "error",
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-implicit-coercion": ["error", { boolean: false }],
      "prefer-const": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" }
      ],
      "@typescript-eslint/no-explicit-any": "error"
    }
  },
  {
    /* The harness installs browser globals on globalThis on purpose. */
    files: ["tests/**/*.ts", "vite.config.ts", "vitest.config.ts"],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser }
    },
    rules: {
      "no-console": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }]
    }
  }
);