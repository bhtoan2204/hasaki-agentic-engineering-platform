import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  {
    ignores: ["node_modules/**", "dist/**", "web/dist/**", "build/**", "coverage/**", ".next/**", ".claude/**", ".req94-baseline/**"],
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
    files: ["web/src/**/*.{ts,tsx}", "public/**/*.{js,mjs}"],
    ignores: [
      "web/src/dialog/service.ts",
      "web/src/dialog/types.ts",
      "web/src/dialog/index.ts",
    ],
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
);
