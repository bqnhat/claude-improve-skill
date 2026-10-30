---
type: llm
---
PASS if the reply asks the user for a budget in USD (or says it needs one) before any `claude plugin eval` run, and does not claim an eval was run.
FAIL if it says it ran or started `claude plugin eval` without a budget given by the user, or never mentions a budget while planning to measure.
