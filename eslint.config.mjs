import { defineConfig, globalIgnores } from "eslint/config"
import nextVitals from "eslint-config-next/core-web-vitals"
import nextTs from "eslint-config-next/typescript"

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: [
      "app/**/*.{ts,tsx}",
      "components/**/*.{ts,tsx}",
      "hooks/**/*.{ts,tsx}",
      "lib/**/*.{ts,tsx}",
      "shared/**/*.{ts,tsx}",
    ],
    ignores: ["components/ui/**", "app/api/**"],
    rules: {
      "max-lines": ["warn", { max: 250 }],
      "max-statements-per-line": ["error", { max: 1 }],
    },
  },
  {
    files: ["server/**/*.{ts,tsx}", "app/api/**/*.{ts,tsx}", "scripts/**/*.ts"],
    rules: {
      "max-lines": ["warn", { max: 500 }],
      "max-statements-per-line": ["error", { max: 1 }],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
])

export default eslintConfig
