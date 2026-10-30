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
3. If nothing is found, say so in one line, name the scope, and offer `/improve all`. Stop.
4. Otherwise let the user tick items with AskUserQuestion, `multiSelect: true`. Each option: label `#<rank> <target>` (at most 5 words), description = the main reason in plain words in the user's language. AskUserQuestion holds at most 4 options per question and 4 questions, so split the ranked items in rank order into questions of 4 (never leave a question with 1 option: shift one from the previous question), headers like `Items 1–4`. Show at most 16 items. Do not also print the list as text.
5. Run the ticked items one after another with **Run**, one change per item, finishing each item's keep/revert decision before the next. Nothing ticked: stop.

Signals the script ranks (higher score first): validate errors (3) and warnings (1), skills idle 60+ days by skill-doctor with their listing-token cost, user corrections typed while a skill was active (3 each), agents pointing to a skill that is off or missing (3), eval cases below 1.0, lift near zero, a skill changed after its last eval, uncommitted changes (2 each), skills turned off, subagent model set in several layers.

## Run

Follow `steps/run.md` for the item's `action`:

- `loop`: the measured upgrade loop.
- `fold`: an overlapping agent; fold it into a skill and tools of the main loop.
- `cleanup`: skills turned off or idle; per-skill keep, re-enable or remove.
- `config`: settings layers that contradict each other.

Run mode does not run `suggest.mjs` and shows no tick list. Take the target from the argument; for an error description, name the skill or agent that caused it from the argument and this conversation. The argument and this conversation are the evidence for step 1 of `steps/run.md`; start there with `loop`.

## Review (scheduled)

Run the script in global scope, show the list as a numbered text list (no one is there to tick boxes), and end with "Run `/improve all` to pick the items to upgrade". Edit no file in `~/.claude` and start no eval.

## Hard rules

- One change per round. Measure before and after with the same cases, model and judge.
- Ask for a budget in USD before any `claude plugin eval` run; never start one without an amount the user gave in this conversation.
- The user decides keep or revert. Show the numbers, not a recommendation dressed as a fact.
- Commit only in the local `~/.claude` repository and never push it.
- A rule that must always hold goes into a hook, not only into the skill text.
