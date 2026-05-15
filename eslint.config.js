import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier/flat";

export default [
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    ignores: ["dist/", "coverage/"],
  },
  {
    files: ["src/**/*.ts"],
    rules: {
      complexity: ["error", 75],
      "max-depth": ["error", 6],
      "max-params": ["error", 6],
      "max-lines": ["error", { max: 500, skipBlankLines: true, skipComments: true }],
      "max-lines-per-function": ["error", { max: 280, skipBlankLines: true, skipComments: true }],
    },
  },
];
