# Running one upgrade

## loop: the measured upgrade loop

Show the user which station you are at as you go. `S` below stands for `node ${CLAUDE_SKILL_DIR}/scripts`.

1. **Evidence.** Restate the item's reasons. The script's corrections and tool errors are leads found by a time window after a skill ran, not proof that the skill caused them: read the transcript lines around each one (session id prefix and date are in the evidence) and write down, in one sentence each, what the user expected and what the skill did. Drop a lead the transcript does not support.
2. **What can be measured.** `claude plugin eval` loads only the target plugin; user settings, hooks, rules, `CLAUDE.md` and other plugins are absent from the run. A change inside the skill folder is measured by its suite. A hook or script is measured by tests (`node --test`) on fake data. A change to `settings.json`, a rule, or an agent outside the skill folder is not measured by any skill suite: say so before starting, and report it as unmeasured unless a case's scaffold installs the file inside the plugin.
3. **Case.** Turn each real failure into an eval case in `skills/<name>/evals/<case>/`, starting from `templates/case/`: a `prompt.md` close to the real request, graders, and one `tool_used` grader on `Skill`. A skill without `evals/` gets 3 to 5 cases: the failures, one plain trigger check, and one negative case where the skill must not fire (`tool_used` on `Skill` with `min: 0`, `max: 0`, `arm: both`). Also write one held-out case: a different wording of the same failure that you do not look at while changing the skill. `claude plugin eval init` may draft cases; review its graders before use.
   - Grade actions with `tool_used`, `tool_order` or `file_exists`; grade text with `regex` or `llm` on `last_message`. Never `regex` with `target: trace`: the trace holds the loaded SKILL.md body, so a pattern the skill text contains always matches. Use an `llm` grader with `focus: trace` when a claim in the reply must be backed by a tool call in the trace.
   - On native Windows, Bash and PowerShell are removed from the run unless granted, and granting them makes every run fail. A case that must prove a command ran goes in `evals-wsl/` and runs under WSL2 with `--eval-dir evals-wsl --allow-tools Bash`; on Windows, grade the written command and the absence of unbacked claims.
4. **Baseline.** Before editing anything, snapshot every path the change may touch: `S/snapshot.mjs start <round> <paths...>` (paths under `~/.claude`; a folder also covers files added inside it). Do not commit or stash the user's other work. Ask for the budget, then from the skill folder:
   ```
   claude plugin eval . --trust-plugin --no-publish --scaffold --allow-tools Read --model <full model id> --judge-model claude-haiku-5-5 --max-cost-usd <budget>
   ```
   Save it with `S/record.mjs <skill> before-<short reason> --model <same id>`: the result does not store the model under test, so record.mjs adds it with a hash of every file under the evaluated plugin. Never Read `aggregate-result.json` or a trace: they hold full transcripts and flood the context. Read results only through `S/compare.mjs`.
5. **Change one thing.** For a skill or agent prompt, first invoke the `claude-api` skill with `prompt-audit` on the target file (SKILL.md or `agents/<name>.md`, plus any rule it loads). Keep only findings tied to the failure from step 1; list the rest for a later round. Skill text or description: use `/skill-creator`. A rule that must always hold: add or extend a hook. An agent problem: edit the agent file, or use `fold` below. Nothing else in the same round. Then `S/snapshot.mjs mark <round>` so the experiment's own edit is recorded.
6. **Measure again** with the identical command, same `--model`, and save it with `S/record.mjs <skill> after-<short reason> --model <same id>`. A `--runs 1 --ablation none` run is fine while editing graders; confirm the result at the default 3 runs. If the cases or graders changed since the baseline, re-run the baseline first, because the old scores no longer compare. When scripts changed, also run `node --test` in the skill folder.
7. **Report** from `S/compare.mjs <skill> --before <before label> --after <after label> --snapshot <round>`. It uses the official per-case scores, counts errored runs in both arms, and ends with a verdict. `NOT COMPARABLE` (exit code 2) means no keep/revert decision on these numbers: fix what it lists under `blocking` (run errors, a different model, judge or CLI, changed cases, a change outside the evaluated plugin, a run that did not load the changed file) and measure again. Report per case before, after, lift against no-skill, run errors in each arm, cost and duration, the held-out case separately, and the warnings. Three runs per case is a smoke check: say that a change of one run in three is within noise, and for a change with wide effect ask whether to spend on `--runs 5` or more cases. To see why one grader failed, open only that run's grader `explanation`, not the whole file. Ask: keep or revert.
8. **Close.**
   - Keep: `S/snapshot.mjs keep <round>` checks that no file changed after the mark and that no added line looks like a secret, then prints the exact paths to `git add`. Commit only those paths with a message stating the measured change (for example `0.67→1.00`); the new cases stay as regression cases; then `S/snapshot.mjs drop <round>`.
   - Revert: `S/snapshot.mjs revert <round>`. It restores only files whose content is still the experiment's, deletes files the experiment added, and checks each restored hash. A file edited by someone else after the mark is refused: show the user its path and the saved original, and never fall back to `git checkout`. Keep the new cases only if the user wants them.

Machine constraints that shape the commands:
- `scaffold_script` runs only with `--scaffold`; without it the workspace is empty and every case scores 0.
- The eval sandbox blocks Read outside the workspace; plain `--allow-tools Read` is needed for skills that read their own templates.
- Pass full model ids to both `--model` and `--judge-model`: model aliases can be remapped in `settings.json`.
- A case that loads several skills must point to folders under the target.
- `evals-wsl/` needs the `claude` CLI installed and logged in inside WSL2.

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
3. If the change can alter behaviour (model, effort), measure it like `loop` only where the eval can carry it: a model through `--model`, an agent file inside the evaluated plugin. `claude plugin eval` does not load `settings.json`, so a settings-only change is reported as unmeasured.
4. Edit `settings.json` or the agent files only after the user agrees.
