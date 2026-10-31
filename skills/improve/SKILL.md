---
name: improve
allowed-tools: Bash(node ${CLAUDE_SKILL_DIR}/scripts/*)
description: Find what in ~/.claude (skills, agents, hooks, settings) should be upgraded next (this session's problems when the session already has work, else the last 7 days), let the user tick items, then run the measured upgrade loop on each. Use when the user types /improve, asks what to improve or upgrade in their Claude setup, or reports that a skill or agent misbehaved and wants it fixed for good. Triggers: /improve, what should I improve, upgrade this skill, this skill went wrong again, nâng cấp skill, cải tiến skill, 改善. NOT for fixing project code, and not for redesigning a whole multi-agent system at once.
---

# improve

Two modes. Pick by the argument.

| Argument | Mode |
|---|---|
| none | **List**: show what to upgrade, then let the user tick items |
| a skill/agent name, or a description of an error | **Run**: upgrade that one item |
| `all` | **List** over the last 7 days even inside a busy session |
| `review` (the weekly scheduled run) | **List** as plain text, then stop |

## List

1. Choose the scope from this conversation:
   - **Session scope**: the conversation already holds work before `/improve` (any earlier user request). Run `node ${CLAUDE_SKILL_DIR}/scripts/suggest.mjs --session`. It reads only this session's transcript (id from `CLAUDE_CODE_SESSION_ID`): corrections, tool errors and hook blocks while a skill was active, and files in `~/.claude` edited in this session.
   - **Global scope**: `/improve` is the first request of the session, or the argument is `all`. Run `node ${CLAUDE_SKILL_DIR}/scripts/suggest.mjs` (`--days N`, default 7; `--top N`, default 10; about 30 s). It also runs `claude plugin validate` on `~/.claude` and `claude -p /skill-doctor` (`--no-doctor` skips it).
   - Session scope runs `claude plugin validate` too, but reports only files edited in this session.
2. In session scope, also add problems you can see in this conversation that the script missed: the user correcting a skill's or agent's output in words the script's pattern does not catch, or a skill step that failed or was skipped. Name the skill and quote the user's words. Leave out problems in project code; only skills, agents, hooks, rules and settings belong here.
3. If nothing is found, say so in one line and name the scope. When the script's `evidence:` lines show a collector `failed`, `partial` or `empty`, say which ones and that "nothing found" is not a clean bill; otherwise offer `/improve all`. Stop.
4. Otherwise ask with AskUserQuestion exactly as the script's `ask:` line lays it out (`ask` in `--json`): the ranked items in rank order, at most 4 questions of 2 to 4 options, at most 16 items. In a multi-select question each option has label `#<rank> <target>` (at most 5 words) and description = the main reason in plain words in the user's language; headers like `Items 1–4`. With exactly one item the line says single-select: ask one question about that item with two options, run it and skip it, labelled in the user's language. Do not also print the list as text.
5. Run the ticked items one after another with **Run**, one change per item, finishing each item's keep/revert decision before the next. Nothing ticked, or skip chosen: stop.

Signals the script ranks (higher score first): validate errors (3) and warnings (1), skills idle 60+ days by skill-doctor with their listing-token cost, user corrections typed within a few turns after a local skill ran (3 each), agents pointing to a skill that is off or missing (3), eval cases below 1.0, eval runs that errored, lift near zero, a skill changed after its last eval, uncommitted changes, files in `~/.claude` written successfully in this session (2 each), tool errors within a few calls after a local skill ran (1 each), skills turned off, subagent model set in several layers. Corrections and tool errors are time-window leads marked `possible`, not proof of cause. A plugin skill is never counted as the local skill with the same short name.

## Run

Follow `steps/run.md` for the item's `action`:

- `loop`: the measured upgrade loop.
- `fold`: an overlapping agent; fold it into a skill and tools of the main loop.
- `cleanup`: skills turned off or idle; per-skill keep, re-enable or remove.
- `config`: settings layers that contradict each other.

Run mode shows no tick list.

- **A description of an error**: name the skill or agent that caused it from the argument and this conversation. The argument and this conversation are the evidence for step 1 of `steps/run.md`; start there with `loop`.
- **Only a name, with no failure described**: run `node ${CLAUDE_SKILL_DIR}/scripts/suggest.mjs --target <name>` (add `--session` when the conversation already holds work) and use its signals as the evidence for step 1. When it prints `no signal for <name>`, ask the user what went wrong with that skill and stop; never invent a failure to fix.

## Review (scheduled)

Run the script in global scope, show the list as a numbered text list (no one is there to tick boxes), and end with "Run `/improve all` to pick the items to upgrade". Edit no file in `~/.claude`, take no snapshot, start no eval and commit nothing.

## Hard rules

- One change per round. In a measured `loop` round, measure before and after with the same cases, fixtures, `--model` and judge; freeze each run with `scripts/record.mjs --freeze` before it starts and save it with `scripts/record.mjs --model` after; decide keep or revert only when `scripts/compare.mjs` ends with `verdict: comparable`. `INSUFFICIENT EVIDENCE` and `NOT COMPARABLE` both mean measure again, never decide. A `config` or `cleanup` round that no suite measures closes as `steps/run.md` says for it, on its own checks and the user's decision, and never cites a skill score.
- Keep three kinds of evidence apart in every report: script tests (`node --test`, free, deterministic), reply checks (graders on the reply or a saved file), and model behaviour (`claude plugin eval` scores and the `fired` indicator). Never cite an older result as proof for changed code.
- Eval suites measure what lives inside the evaluated skill folder. `claude plugin eval` does not load settings, hooks or rules: test hooks and scripts with `node --test`, and report other changes as unmeasured instead of citing a skill score for them.
- Snapshot before writing any case, grader or change, and revert only with `scripts/snapshot.mjs`, never `git checkout`, so the user's other edits survive. Stage only what `snapshot.mjs keep` prints, then commit with a plain `git commit`.
- Ask for a budget in USD before any `claude plugin eval` run; never start one without an amount the user gave in this conversation.
- The user decides keep or revert. Show the numbers, not a recommendation dressed as a fact.
- Commit only in the local `~/.claude` repository and never push it.
- A rule that must always hold goes into a hook, not only into the skill text.
