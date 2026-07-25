---
'pinnace': patch
---

Fix the on-box `pinnace node` systemd timers failing with `203/EXEC`: they hardcoded `/usr/local/bin/pinnace`, but a nodesource `npm install -g` puts the bin at `/usr/bin/pinnace` (npm global prefix `/usr`). The units now resolve the bin via PATH (`ExecStart=/usr/bin/env pinnace node <verb>` with an explicit `Environment=PATH=/usr/local/bin:/usr/bin:/bin`), so they work regardless of the npm prefix.
