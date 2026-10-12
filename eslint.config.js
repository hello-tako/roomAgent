import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      ".hoplite/**",
      "**/.wrangler/**",
      "**/dist/**",
      "**/worker-configuration.d.ts",
      "**/vitest.config.ts",
      "handoff/**/private/**",
      "c1-operator/private/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["handoff/c1-a2/operator/**/*.mjs"],
    languageOptions: {
      globals: {
        Buffer: "readonly",
        process: "readonly",
        URL: "readonly",
        TextDecoder: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
      },
    },
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parserOptions: {
        projectService: true,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error",
    },
  },
);
