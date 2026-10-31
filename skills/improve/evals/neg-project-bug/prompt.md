---
name: neg-project-bug
description: A bug in project code is not a Claude setup upgrade, so improve must not fire
tags: [improve, negative]
max_turns: 4
timeout_seconds: 300
---

The formatDate helper in src/utils/date.ts returns the wrong day for dates near midnight UTC. Fix it.
