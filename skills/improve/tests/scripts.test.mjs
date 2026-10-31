import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPTS = fileURLToPath(new URL('../scripts/', import.meta.url));
const SNAPSHOTS = fileURLToPath(new URL('../working/snapshots/', import.meta.url));
const homes = [];
const labels = [];
after(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
  for (const l of labels) rmSync(path.join(SNAPSHOTS, l), { recursive: true, force: true });
});

function fakeHome() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'improve-test-'));
  homes.push(home);
  const root = path.join(home, '.claude');
  for (const s of ['alpha', 'eli5']) {
    mkdirSync(path.join(root, 'skills', s), { recursive: true });
    writeFileSync(path.join(root, 'skills', s, 'SKILL.md'), `---\nname: ${s}\n---\n`);
  }
  return { home, root };
}

function run(home, script, args) {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.CLAUDE_CODE_SESSION_ID;
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], { env, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const runOf = (score, error = null) => ({ score, passed: score >= 1, error, graders: [] });
const caseOf = (name, withRuns, withoutRuns = [], extra = {}) => ({ name, promptMarkdown: `prompt ${name}`, graders: [{ name: 'g', type: 'regex' }], runsPerCase: withRuns.length, arms: { with: withRuns, without: withoutRuns }, ...extra });
const suite = (root) => ({ root, judgeModel: 'judge-1', threshold: 1, ablation: 'with-without', plugins: [{ name: 'p', path: root }] });

function results(dir, runs) {
  mkdirSync(dir, { recursive: true });
  for (const [label, j] of Object.entries(runs)) writeFileSync(path.join(dir, `${label}.json`), JSON.stringify(j));
  return dir;
}

test('compare keeps errored runs in the denominator and refuses to call it a pass', () => {
  const { home } = fakeHome();
  const dir = results(path.join(home, 'r'), {
    before: { startedAt: '2026-01-01T00:00:00Z', claudeVersion: '1', suite: suite(home), cases: [caseOf('c1', [runOf(0), runOf(1), runOf(0)], [runOf(0), runOf(0), runOf(0)])] },
    after: { startedAt: '2026-01-02T00:00:00Z', claudeVersion: '1', suite: suite(home), cases: [caseOf('c1', [runOf(1), runOf(0, 'api'), runOf(0, 'api')], [runOf(0), runOf(0), runOf(0)])] },
  });
  const r = run(home, 'compare.mjs', [dir, '--before', 'before', '--after', 'after']);
  assert.match(r.out, /c1\s+0\.33\s+0\.33/);
  assert.doesNotMatch(r.out, /FAIL->PASS/);
  assert.match(r.out, /inconclusive/);
  assert.match(r.out, /NOT COMPARABLE/);
  assert.equal(r.code, 2);
});

test('compare reports errors in the no-skill arm and leaves those cases out of the lift', () => {
  const { home } = fakeHome();
  const dir = results(path.join(home, 'r'), {
    before: { startedAt: '2026-01-01T00:00:00Z', suite: suite(home), cases: [caseOf('c1', [runOf(1), runOf(1), runOf(1)], [runOf(0), runOf(0), runOf(0)])] },
    after: { startedAt: '2026-01-02T00:00:00Z', suite: suite(home), cases: [caseOf('c1', [runOf(1), runOf(1), runOf(1)], [runOf(0, 'api'), runOf(0, 'api'), runOf(0)])] },
  });
  const r = run(home, 'compare.mjs', [dir]);
  assert.match(r.out, /without skill 2\/3/);
  assert.match(r.out, /1 case\(s\) left out for run errors/);
  assert.doesNotMatch(r.out, /lift vs no-skill \(after\): \+1\.00/);
  assert.equal(r.code, 2);
});

test('compare prefers the official case aggregate over its own mean', () => {
  const { home } = fakeHome();
  const dir = results(path.join(home, 'r'), {
    only: { startedAt: '2026-01-02T00:00:00Z', suite: suite(home), cases: [caseOf('c1', [runOf(1), runOf(1), runOf(1)], [], { aggregates: { score: 0.5 } })] },
  });
  assert.match(run(home, 'compare.mjs', [dir]).out, /c1\s+-\s+0\.50/);
});

test('compare flags a changed case definition and a different model under test', () => {
  const { home } = fakeHome();
  const base = (prompt, model) => ({ startedAt: '', suite: suite(home), recorded: { model }, cases: [caseOf('c1', [runOf(1), runOf(1), runOf(1)], [], { promptMarkdown: prompt })] });
  const dir = results(path.join(home, 'r'), {
    before: { ...base('old prompt', 'model-a'), startedAt: '2026-01-01T00:00:00Z' },
    after: { ...base('new prompt', 'model-b'), startedAt: '2026-01-02T00:00:00Z' },
  });
  const r = run(home, 'compare.mjs', [dir]);
  assert.match(r.out, /case changed/);
  assert.match(r.out, /model differs: model-a -> model-b/);
  assert.match(r.out, /case or grader definition changed: c1/);
  assert.equal(r.code, 2);
});

test('compare reports a clean flip as comparable', () => {
  const { home } = fakeHome();
  const dir = results(path.join(home, 'r'), {
    before: { startedAt: '2026-01-01T00:00:00Z', suite: suite(home), recorded: { model: 'm' }, cases: [caseOf('c1', [runOf(0), runOf(1), runOf(0)], [runOf(0), runOf(0), runOf(0)])] },
    after: { startedAt: '2026-01-02T00:00:00Z', suite: suite(home), recorded: { model: 'm' }, cases: [caseOf('c1', [runOf(1), runOf(1), runOf(1)], [runOf(0), runOf(0), runOf(0)])] },
  });
  const r = run(home, 'compare.mjs', [dir]);
  assert.match(r.out, /FAIL->PASS/);
  assert.match(r.out, /verdict: comparable/);
  assert.equal(r.code, 0);
});

test('compare --snapshot proves the change was inside the evaluated plugin and was evaluated', () => {
  const { home, root } = fakeHome();
  const plugin = path.join(root, 'skills', 'alpha');
  const label = `t-${process.pid}-plugin`;
  labels.push(label);
  run(home, 'snapshot.mjs', ['start', label, 'skills/alpha/SKILL.md', 'settings.json']);
  writeFileSync(path.join(plugin, 'SKILL.md'), 'changed\n');
  writeFileSync(path.join(root, 'settings.json'), '{"x":1}\n');
  run(home, 'snapshot.mjs', ['mark', label]);
  const rec = (content) => ({ model: 'm', files: { 'SKILL.md': hash(content) } });
  const dir = results(path.join(home, 'r'), {
    before: { startedAt: '2026-01-01T00:00:00Z', suite: suite(plugin), recorded: rec('---\nname: alpha\n---\n'), cases: [caseOf('c1', [runOf(1), runOf(1), runOf(1)])] },
    after: { startedAt: '2026-01-02T00:00:00Z', suite: suite(plugin), recorded: rec('stale content'), cases: [caseOf('c1', [runOf(1), runOf(1), runOf(1)])] },
  });
  const r = run(home, 'compare.mjs', [dir, '--snapshot', label]);
  assert.match(r.out, /settings\.json is outside the evaluated plugin/);
  assert.match(r.out, /after did not evaluate the changed skills\/alpha\/SKILL\.md/);
  assert.doesNotMatch(r.out, /before did not evaluate/);
  assert.equal(r.code, 2);
});

function transcript(root, session, records) {
  const dir = path.join(root, 'projects', 'proj');
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const lines = records.map((r) => JSON.stringify({ parentUuid: null, timestamp: now, ...r }));
  writeFileSync(path.join(dir, `${session}.jsonl`), `${lines.join('\n')}\n`);
}
const useTool = (id, name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (id, isError = false) => ({ type: 'user', toolUseResult: {}, message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: 'x' }] } });
const say = (text) => ({ type: 'user', message: { content: text } });

test('suggest counts an edit only inside ~/.claude and only when the write succeeded', () => {
  const { home, root } = fakeHome();
  const other = path.join(home, 'work', 'customer', '.claude', 'settings.json');
  transcript(root, 's1', [
    useTool('e1', 'Edit', { file_path: other }),
    result('e1'),
    useTool('e2', 'Write', { file_path: path.join(root, 'skills', 'alpha', 'SKILL.md') }),
    result('e2', true),
    useTool('e3', 'Edit', { file_path: path.join(root, 'skills', 'eli5', 'SKILL.md') }),
    result('e3'),
  ]);
  const r = run(home, 'suggest.mjs', ['--session', 's1', '--no-validate', '--json']);
  const items = JSON.parse(r.out).items;
  assert.deepEqual(items.map((x) => `${x.kind}:${x.target}`), ['skill:eli5']);
});

test('suggest does not blame a local skill after a plugin skill took over', () => {
  const { home, root } = fakeHome();
  transcript(root, 's2', [useTool('k1', 'Skill', { skill: 'alpha' }), result('k1'), useTool('k2', 'Skill', { skill: 'vendor:other' }), result('k2'), say('sai rồi, làm lại đi')]);
  const items = JSON.parse(run(home, 'suggest.mjs', ['--session', 's2', '--json']).out).items;
  assert.equal(items.some((x) => x.target === 'alpha'), false);
  assert.ok(items.some((x) => x.target === '(skill outside ~/.claude: vendor:other)'));
});

test('suggest ignores correction words that only appear inside pasted content', () => {
  const { home, root } = fakeHome();
  transcript(root, 's4', [useTool('k1', 'Skill', { skill: 'alpha' }), result('k1'), say('check this <pasted_content id="p1">the old answer was không đúng</pasted_content id="p1">')]);
  const items = JSON.parse(run(home, 'suggest.mjs', ['--session', 's4', '--json']).out).items;
  assert.equal(items.some((x) => x.target === 'alpha'), false);
});

test('suggest keeps a plugin skill apart from a local skill with the same short name', () => {
  const { home, root } = fakeHome();
  transcript(root, 's3', [useTool('k1', 'Skill', { skill: 'vendor:eli5' }), result('k1'), say('vẫn sai')]);
  const items = JSON.parse(run(home, 'suggest.mjs', ['--session', 's3', '--json']).out).items;
  assert.equal(items.some((x) => x.kind === 'skill' && x.target === 'eli5'), false);
});

test('suggest collects tool errors in the 7-day review too', () => {
  const { home, root } = fakeHome();
  transcript(root, 'g1', [useTool('k1', 'Skill', { skill: 'alpha' }), result('k1'), useTool('b1', 'Bash', { command: 'x' }), result('b1', true)]);
  const out = JSON.parse(run(home, 'suggest.mjs', ['--no-doctor', '--no-validate', '--json']).out);
  assert.ok(out.items.some((x) => x.target === 'alpha' && x.reasons.some((r) => /tool error/.test(r))));
});

test('suggest says the evidence is incomplete instead of "nothing to improve" when a collector fails', () => {
  const { home } = fakeHome();
  const r = run(home, 'suggest.mjs', ['--no-doctor', '--no-validate']);
  assert.doesNotMatch(r.out, /^nothing to improve/m);
  assert.match(r.out, /evidence is incomplete/);
  assert.match(r.out, /git status: failed/);
  const j = JSON.parse(run(home, 'suggest.mjs', ['--no-doctor', '--no-validate', '--json']).out);
  assert.equal(j.evidence_complete, false);
});

test('snapshot reverts only what the experiment wrote and refuses files edited after mark', () => {
  const { home, root } = fakeHome();
  const label = `t-${process.pid}-revert`;
  labels.push(label);
  const a = path.join(root, 'skills', 'alpha', 'SKILL.md');
  const b = path.join(root, 'skills', 'eli5', 'SKILL.md');
  writeFileSync(a, 'user work in progress\n');
  assert.equal(run(home, 'snapshot.mjs', ['start', label, 'skills/alpha', 'skills/eli5/SKILL.md']).code, 0);
  writeFileSync(a, 'experiment\n');
  writeFileSync(path.join(root, 'skills', 'alpha', 'new.md'), 'new case\n');
  writeFileSync(b, 'experiment\n');
  run(home, 'snapshot.mjs', ['mark', label]);
  writeFileSync(b, 'someone else edited after mark\n');
  const r = run(home, 'snapshot.mjs', ['revert', label]);
  assert.equal(readFileSync(a, 'utf8'), 'user work in progress\n');
  assert.equal(existsSync(path.join(root, 'skills', 'alpha', 'new.md')), false);
  assert.equal(readFileSync(b, 'utf8'), 'someone else edited after mark\n');
  assert.match(r.out, /not reverted: skills\/eli5\/SKILL\.md: changed after mark/);
  assert.equal(r.code, 1);
});

test('snapshot refuses a path outside ~/.claude and revert before mark', () => {
  const { home } = fakeHome();
  const label = `t-${process.pid}-outside`;
  labels.push(label);
  assert.equal(run(home, 'snapshot.mjs', ['start', label, path.join(home, 'elsewhere.txt')]).code, 1);
  run(home, 'snapshot.mjs', ['start', label, 'skills/alpha/SKILL.md']);
  assert.match(run(home, 'snapshot.mjs', ['revert', label]).out, /never marked/);
});

test('snapshot keep blocks a secret in an added line and lists exact paths otherwise', () => {
  const { home, root } = fakeHome();
  const label = `t-${process.pid}-keep`;
  labels.push(label);
  const a = path.join(root, 'skills', 'alpha', 'SKILL.md');
  run(home, 'snapshot.mjs', ['start', label, 'skills/alpha/SKILL.md']);
  writeFileSync(a, `---\nname: alpha\n---\napi_key: "${'A1b2C3d4'.repeat(3)}"\n`);
  run(home, 'snapshot.mjs', ['mark', label]);
  const blocked = run(home, 'snapshot.mjs', ['keep', label]);
  assert.equal(blocked.code, 1);
  assert.match(blocked.out, /skills\/alpha\/SKILL\.md:4: added line looks like a credential assignment/);
  assert.doesNotMatch(blocked.out, /A1b2C3d4/);
  writeFileSync(a, '---\nname: alpha\n---\nmore steps\n');
  run(home, 'snapshot.mjs', ['mark', label]);
  const ok = run(home, 'snapshot.mjs', ['keep', label]);
  assert.equal(ok.code, 0);
  assert.match(ok.out, /add -- "skills\/alpha\/SKILL\.md"/);
});

test('record requires the model and fingerprints the evaluated plugin', () => {
  const { home, root } = fakeHome();
  const plugin = path.join(root, 'skills', 'alpha');
  const runDir = path.join(plugin, 'evals', 'results', '2026-01-01T00-00-00-000Z');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(path.join(runDir, 'aggregate-result.json'), JSON.stringify({ startedAt: new Date(Date.now() + 60000).toISOString(), suite: suite(plugin), cases: [] }));
  assert.equal(run(home, 'record.mjs', ['alpha', 'before-x']).code, 1);
  assert.equal(run(home, 'record.mjs', ['alpha', 'before-x', '--model', 'model-a']).code, 0);
  const saved = JSON.parse(readFileSync(path.join(plugin, 'evals', 'results', 'before-x.json'), 'utf8'));
  assert.equal(saved.recorded.model, 'model-a');
  assert.equal(saved.recorded.files['SKILL.md'], hash('---\nname: alpha\n---\n'));
  assert.equal(Object.keys(saved.recorded.files).some((f) => f.startsWith('evals/results')), false);
});
