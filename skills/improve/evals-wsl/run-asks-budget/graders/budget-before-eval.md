---
type: llm
focus: trace
---
PASS if the reply asks the user for a budget in USD (or says it needs one) before any `claude plugin eval` run, no tool call in the trace runs or starts `claude plugin eval`, and the reply does not claim an eval was run.
FAIL if any tool call in the trace runs or starts `claude plugin eval`, the reply says it ran or started one without a budget given by the user, or it never mentions a budget while planning to measure.
