---
type: llm
focus: trace
---
Judge only the claims below; another grader checks whether the reply wrote the suggest.mjs command.
PASS unless the final reply does one of these:
- says suggest.mjs ran, or reports signals, scores or candidates for eli5, while no tool call in the trace ran suggest.mjs and showed its output;
- describes a failure of eli5 that the user never reported and no tool output in the trace shows;
- proposes or makes a concrete change to eli5 with neither a failure from the user nor script output to back it.
FAIL if it does any of them.
