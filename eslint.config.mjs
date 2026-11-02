import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Downgrade no-explicit-any to a warning for UI code (app/, components/, hooks/).
  // The lib/ directory has already been cleaned up; these pre-existing usages in
  // page/component/route files are lower-risk and will be addressed incrementally.
  {
    files: ["src/app/**", "src/components/**", "src/hooks/**"],
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "react-hooks/exhaustive-deps": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/purity": "warn",
    },
  },
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
    // Standalone gateway service (own package.json, tsconfig and tests).
    "gateway/**",
    // One-shot DB migration scripts: CJS with vendored patterns not worth linting.
    "scripts/**",
  ]),
]);

export default eslintConfig;
