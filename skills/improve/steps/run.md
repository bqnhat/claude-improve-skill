# Running one upgrade

## loop: the measured upgrade loop

Show the user which station you are at as you go.

1. **Evidence.** Restate the item's reasons. For a correction, read the transcript lines around it (session id prefix and date are in the script's evidence) and write down, in one sentence each, what the user expected and what the skill did.
2. **Case.** Turn each real failure into an eval case in `skills/<name>/evals/<case>/`, starting from `templates/case/`: a `prompt.md` close to the real request, one grader on the result (`regex` for long output, `llm` with concrete PASS/FAIL for short output) and one `tool_used` grader on `Skill`. A skill without `evals/` gets 3 to 5 cases: the failures plus one plain trigger check. `claude plugin eval init` in the skill folder may draft them; review its graders before use.
3. **Baseline.** Commit the current state first so the run records `gradedCommit`. Ask for the budget, then from the skill folder:
   ```
   claude plugin eval . --trust-plugin --no-publish --scaffold --allow-tools Read --judge-model claude-haiku-5-5 --max-cost-usd <budget>
   ```
   Copy the run's `aggregate-result.json` to `evals/results/<label>.json` (label like `before-<short reason>`). Never Read `aggregate-result.json` or a trace: they hold full transcripts and flood the context. Read results only through `node ${CLAUDE_SKILL_DIR}/scripts/compare.mjs <skill> --after <label>`.
4. **Change one thing.** For a skill or agent prompt, first invoke the `claude-api` skill with `prompt-audit` on the target file (SKILL.md or `agents/<name>.md`, plus any rule it loads). Keep only findings tied to the failure from step 1; list the rest for a later round. Skill text or description: use `/skill-creator`. A rule that must always hold: add or extend a hook. An agent problem: edit the agent file, or use `fold` below. Nothing else in the same round.
5. **Measure again** with the identical command. A `--runs 1 --ablation none` run is fine while editing graders; confirm the result at the default 3 runs. If the cases or graders changed since the baseline, re-run the baseline first, because the old scores no longer compare.
6. **Report** from `node ${CLAUDE_SKILL_DIR}/scripts/compare.mjs <skill> --before <before label> --after <after label>`: per case before, after, lift against no-skill, flips, failed graders, cost, and its warnings (fewer than 3 runs, case set changed). To see why one grader failed, open only that run's grader `explanation`, not the whole file. Ask: keep or revert.
7. **Close.**
   - Keep: commit with a message stating the measured change (for example `0.67→1.00`); the new cases stay as regression cases; save the result as `evals/results/after-<short reason>.json`.
   - Revert: `git -C ~/.claude checkout -- <paths>`; keep the new cases only if the user wants them.

Machine constraints that shape the commands:
- Native Windows has no sandbox, so `claude plugin eval` refuses Bash/PowerShell grants. For skills that run commands, grade the command Claude writes ("if you cannot run it, write the command"), or run the suite under WSL2.
- `scaffold_script` runs only with `--scaffold`; without it the workspace is empty and every case scores 0.
- The eval sandbox blocks Read outside the workspace; plain `--allow-tools Read` is needed for skills that read their own templates.
- Pass the full judge model id: model aliases can be remapped in `settings.json`.
- A case that loads several skills must point to folders under the target.

## fold

1. Write eval cases for the agent's real tasks and measure the current setup as the baseline.
2. Move the agent's prompt into a skill and its actions into tools the main loop calls; keep the agent file in place.
3. Measure again with the identical command. Remove the agent only if the folded version scores at least as well, and only after the user agrees.

## cleanup

1. List each skill with its last use (from `/skill-doctor`) and whether it has evals.
2. Ask per skill: keep off, re-enable, or remove.
3. Remove by moving the folder to `skills/.trash/` (ignored by git, so it can be restored), and delete its `skillOverrides` entry. Re-enable by deleting the `off` entry.
4. Commit once for the batch.

## config

1. Show every layer that sets the value, with file and line.
2. Propose one source of truth and what the others become.
3. If the change can alter behaviour (model, effort), measure it like `loop` on the suites that use the affected agents, one change at a time.
4. Edit `settings.json` or the agent files only after the user agrees.
