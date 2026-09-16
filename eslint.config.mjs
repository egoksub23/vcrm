import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Vendored minified opus-recorder encoder worker (served statically).
    "public/opus/**",
    // Standalone Preact bundle (its own tsconfig + JSX runtime, checked
    // separately via `tsc -p widget/tsconfig.json`) — not part of the
    // Next.js app, so the Next-specific / React-JSX-scope rules here
    // don't apply to it.
    "widget/**",
  ]),
]);

export default eslintConfig;
