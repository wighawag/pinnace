---
'pinnace': patch
---

Add a `pinnace` logo (SVG mark + wordmark lockup, `assets/logo.svg` / `assets/logo-mark.svg`) and document install as a per-project DEV DEPENDENCY instead of a global install. The README now shows `npm install --save-dev pinnace` (`pnpm add -D pinnace`) run via `npx pinnace …` or a `package.json` script, so the version is pinned in `package.json` and CI uses exactly that version; the machine-wide `npm install -g` remains only where it belongs, on the nodes, done for the operator by the generated cloud-init. The `.env`/`.env.local` cwd auto-load note is reworded accordingly (it applies to `npx pinnace …` just the same).
