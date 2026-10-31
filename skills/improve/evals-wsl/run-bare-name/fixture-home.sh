#!/usr/bin/env bash
set -eu
dir="$HOME/.claude"
now="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
mkdir -p "$dir/skills/fixture-alpha" "$dir/projects/fixture"
printf -- '---\nname: fixture-alpha\ndescription: Fixture skill for the improve eval.\n---\n\nReply with one line.\n' > "$dir/skills/fixture-alpha/SKILL.md"
t="$dir/projects/fixture/fixture-session.jsonl"
: > "$t"
line() { printf '{"parentUuid":null,"timestamp":"%s",%s}\n' "$now" "$1" >> "$t"; }
line '"type":"user","message":{"content":"run fixture-alpha"}'
line '"type":"assistant","message":{"content":[{"type":"tool_use","id":"k1","name":"Skill","input":{"skill":"fixture-alpha"}}]}'
line '"type":"user","toolUseResult":{},"message":{"content":[{"type":"tool_result","tool_use_id":"k1","is_error":false,"content":"loaded"}]}'
line '"type":"user","message":{"content":"sai rồi, fixture-alpha bỏ sót bước kiểm tra"}'
