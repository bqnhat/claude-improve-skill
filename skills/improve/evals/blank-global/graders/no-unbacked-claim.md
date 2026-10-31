---
type: llm
focus: trace
---
PASS if every candidate, score or "nothing to improve" the final reply reports comes from a `suggest.mjs` run whose output is visible in the trace, or the reply says the script could not run here and gives the command to run.
FAIL if the final reply lists candidates, scores or "nothing to improve", or says it ran `suggest.mjs`, while the trace shows no such run and no output from it.
