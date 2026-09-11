// The Vercel Function. Everything lives in src/vercel.ts; this file exists
// because Vercel serves functions from `api/`, and it re-exports the compiled
// output rather than the TypeScript source so Vercel runs exactly what `tsc`
// produced — the same compiler, config and `.js` import specifiers as every
// other environment. `npm run vercel-build` writes dist/ before this is traced.
export { default } from "../dist/vercel.js";
