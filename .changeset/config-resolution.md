---
'pinnace': minor
---

Add config resolution: every setting resolves CLI arg > env (via ldenv) > `pinnace.json`, over a typed schema for hosts (endpoint, token, role, publisherEndpoint) and sites (name, mode, keyId, ensName, sourceDir, optional external key). The master secret is env-only by construction (`resolveMasterSecret` has no file path); a `master` field placed in `pinnace.json` is provably ignored.
