import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";

export default tseslint.config(
    { ignores: ["dist", "node_modules", "test-results", "playwright-report"] },
    {
        files: ["src/**/*.{ts,tsx}"],
        extends: [
            js.configs.recommended,
            ...tseslint.configs.recommended,
            reactHooks.configs.flat["recommended-latest"],
            reactRefresh.configs.vite,
        ],
        languageOptions: {
            ecmaVersion: 2023,
            globals: globals.browser,
        },
    },
    {
        files: ["server/**/*.ts", "api/**/*.ts", "*.config.ts"],
        extends: [js.configs.recommended, ...tseslint.configs.recommended],
        languageOptions: {
            ecmaVersion: 2023,
            globals: globals.node,
        },
    },
    {
        files: ["e2e/**/*.ts"],
        extends: [js.configs.recommended, ...tseslint.configs.recommended],
        languageOptions: {
            ecmaVersion: 2023,
            globals: { ...globals.node, ...globals.browser },
        },
    },
);
