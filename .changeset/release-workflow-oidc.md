---
'pinnace': minor
---

Add the npm Trusted-Publishing (OIDC) release workflow (`.github/workflows/release.yml`) and a `release:ci` script, and set changeset access to `public` so `pinnace` publishes to the public npm registry. Landing changesets on `main` opens a "Version Packages" PR; merging it publishes the package via tokenless OIDC with provenance.
