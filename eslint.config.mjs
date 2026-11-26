import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "go/**/testdata/**",
      "dist/**",
      "web/dist/**",
      "build/**",
      "coverage/**",
      ".next/**",
      ".claude/**",
      ".req94-baseline/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    files: ["**/*.{js,mjs,cjs,ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      "no-console": "off",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    // The environment is read in one place: src/config.ts maps every variable the platform uses to a named, typed
    // field of `config`. Nothing else under src/ may touch process.env, except these files. Each is listed with its
    // reason; do not add an eslint-disable comment instead.
    files: ["src/**/*.{ts,mjs}"],
    ignores: [
      "src/config.ts",
      // CLI entry points read their own arguments and environment (user-facing output, one-shot processes).
      "src/cli/**",
      // Standalone processes started by node or a provider CLI: they must not import config.ts (it connects to nothing
      // but loads config.json, creates the data directory and validates DATABASE_URL, which these children do not have).
      "src/logging.ts",
      "src/git/nodeDependencies.ts",
      "src/agent/providers/*/bridge.ts",
      "src/agent/providers/*/hook.ts",
      // Launchers: they hand the whole environment (scrubbed of platform secrets by agentEnvironment/childEnv) to a child.
      "src/platform/childEnv.ts",
      "src/platform/selfDevelopment.ts",
      "src/repos/git.ts",
      "src/agent/complete.ts",
      "src/agent/providerStatus.ts",
      "src/agent/handoff.ts",
      "src/agent/isolation.ts",
      "src/agent/process/scope.ts",
      "src/agent/providers/*/run.ts",
      "src/agent/providers/*/complete.ts",
      "src/agent/providers/*/capabilities.ts",
      "src/workflow/executors/verificationSlots.ts",
    ],
    rules: {
      "no-restricted-properties": [
        "error",
        {
          object: "process",
          property: "env",
          message:
            "Read configuration from src/config.ts (config.<section>.<field>, mapped from .env); add the variable there.",
        },
      ],
    },
  },
  {
    files: ["web/src/**/*.{ts,tsx}"],
    ignores: ["web/src/dialog/service.ts", "web/src/dialog/types.ts", "web/src/dialog/index.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        {
          name: "alert",
          message: "Dùng dialog.alert / toast — không dùng alert() gốc của trình duyệt.",
        },
        {
          name: "confirm",
          message: "Dùng dialog.confirm — không dùng confirm() gốc của trình duyệt.",
        },
        {
          name: "prompt",
          message: "Dùng dialog.prompt — không dùng prompt() gốc của trình duyệt.",
        },
      ],
      "no-restricted-properties": [
        "error",
        {
          object: "window",
          property: "alert",
          message: "Dùng dialog.alert / toast — không dùng window.alert.",
        },
        {
          object: "window",
          property: "confirm",
          message: "Dùng dialog.confirm — không dùng window.confirm.",
        },
        {
          object: "window",
          property: "prompt",
          message: "Dùng dialog.prompt — không dùng window.prompt.",
        },
        {
          object: "globalThis",
          property: "alert",
          message: "Dùng dialog.alert / toast — không dùng globalThis.alert.",
        },
        {
          object: "globalThis",
          property: "confirm",
          message: "Dùng dialog.confirm — không dùng globalThis.confirm.",
        },
        {
          object: "globalThis",
          property: "prompt",
          message: "Dùng dialog.prompt — không dùng globalThis.prompt.",
        },
      ],
    },
  },
  {
    files: ["web/src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  },
);
