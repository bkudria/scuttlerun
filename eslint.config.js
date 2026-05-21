import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier/flat";

export default [
  eslint.configs.recommended,
  ...tseslint.configs.strict,
  prettier,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["tests/*.test.ts"],
          maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 20,
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
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
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    ignores: [
      "dist/",
      "coverage/",
      "node_modules/",
      "eslint.config.js",
      "vitest.config.ts",
      "commitlint.config.js",
      "spike/",
    ],
  },
];
