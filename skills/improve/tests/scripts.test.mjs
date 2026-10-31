import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SOURCE = fileURLToPath(new URL('../', import.meta.url));
const SANDBOX = mkdtempSync(path.join(os.tmpdir(), 'improve-skill-copy-'));
cpSync(path.join(SOURCE, 'scripts'), path.join(SANDBOX, 'scripts'), { recursive: true });
const SCRIPTS = path.join(SANDBOX, 'scripts');
const WORKING = path.join(SANDBOX, 'working');
const REAL_CLAUDE = path.join(os.homedir(), '.claude');
assert.ok(path.relative(REAL_CLAUDE, SANDBOX).startsWith('..'), 'the script copy must live outside the personal ~/.claude');

const homes = [];
after(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

function fakeHome() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'improve-test-home-'));
  homes.push(home);
  const root = path.join(home, '.claude');
  for (const s of ['alpha', 'eli5']) {
    mkdirSync(path.join(root, 'skills', s), { recursive: true });
    writeFileSync(path.join(root, 'skills', s, 'SKILL.md'), `---\nname: ${s}\n---\n`);
  }
  return { home, root };
}

function run(home, script, args, scripts = SCRIPTS) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig-none'), GIT_CONFIG_NOSYSTEM: '1' };
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CLAUDE_CONFIG_DIR;
  const r = spawnSync(process.execPath, [path.join(scripts, script), ...args], { env, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } }).trim();
function gitRepo(root) {
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
}

const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const runOf = (score, error = null, graders = []) => ({ score, passed: score >= 1, error, graders });
const caseOf = (name, withRuns, withoutRuns = [], extra = {}) => ({ name, dir: `evals/${name}`, promptMarkdown: `prompt ${name}`, graders: [{ name: 'g', type: 'regex', weight: 1, config: {} }], runsPerCase: withRuns.length, arms: { with: withRuns, without: withoutRuns }, ...extra });
const suite = (root, extra = {}) => ({ root, modelOverride: 'model-a', judgeModel: 'judge-1', threshold: 1, ablation: 'with-without', plugins: [{ name: 'p', path: root }], ...extra });
const evidence = (extra = {}) => ({ model: 'model-a', contentVerified: true, frozenAt: '2026-01-01T00:00:00Z', contract: { shared: 's', cases: { c1: 'k1' } }, files: {}, ...extra });
const full = (root, startedAt, cases, recorded = {}, extra = {}) => ({ schemaVersion: 1, claudeVersion: '2.1.0', startedAt, suite: suite(root, { modelOverride: evidence(recorded).model }), recorded: evidence(recorded), cases, ...extra });

function results(dir, runs) {
  mkdirSync(dir, { recursive: true });
  for (const [label, j] of Object.entries(runs)) writeFileSync(path.join(dir, `${label}.json`), typeof j === 'string' ? j : JSON.stringify(j));
  return dir;
}

const label = (() => {
  let n = 0;
  return (name) => `t${process.pid}-${name}-${(n += 1)}`;
})();

test('compare keeps errored runs in the denominator and refuses to call it a pass', () => {
  const { home } = fakeHome();
  const dir = results(path.join(home, 'r'), {
    before: full(home, '2026-01-01T00:00:00Z', [caseOf('c1', [runOf(0), runOf(1), runOf(0)], [runOf(0), runOf(0), runOf(0)])]),
    after: full(home, '2026-01-02T00:00:00Z', [caseOf('c1', [runOf(1), runOf(0, 'api'), runOf(0, 'api')], [runOf(0), runOf(0), runOf(0)])]),
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
    before: full(home, '2026-01-01T00:00:00Z', [caseOf('c1', [runOf(1), runOf(1), runOf(1)], [runOf(0), runOf(0), runOf(0)])]),
    after: full(home, '2026-01-02T00:00:00Z', [caseOf('c1', [runOf(1), runOf(1), runOf(1)], [runOf(0, 'api'), runOf(0, 'api'), runOf(0)])]),
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
    only: full(home, '2026-01-02T00:00:00Z', [caseOf('c1', [runOf(1), runOf(1), runOf(1)], [], { aggregates: { score: 0.5 } })]),
  });
  assert.match(run(home, 'compare.mjs', [dir]).out, /c1\s+-\s+0\.50/);
});

test('compare flags a changed case definition and a different model under test', () => {
  const { home } = fakeHome();
  const c = (prompt) => [caseOf('c1', [runOf(1), runOf(1), runOf(1)], [], { promptMarkdown: prompt })];
  const dir = results(path.join(home, 'r'), {
    before: full(home, '2026-01-01T00:00:00Z', c('old prompt'), { model: 'model-a' }),
    after: full(home, '2026-01-02T00:00:00Z', c('new prompt'), { model: 'model-b' }),
  });
  const r = run(home, 'compare.mjs', [dir]);
  assert.match(r.out, /case changed/);
  assert.match(r.out, /model differs: model-a -> model-b/);
  assert.match(r.out, /case or grader definition changed: c1/);
  assert.equal(r.code, 2);
});

test('compare reports a clean flip as comparable when every piece of evidence is present', () => {
  const { home } = fakeHome();
  const dir = results(path.join(home, 'r'), {
    before: full(home, '2026-01-01T00:00:00Z', [caseOf('c1', [runOf(0), runOf(1), runOf(0)], [runOf(0), runOf(0), runOf(0)])]),
    after: full(home, '2026-01-02T00:00:00Z', [caseOf('c1', [runOf(1), runOf(1), runOf(1)], [runOf(0), runOf(0), runOf(0)])]),
  });
  const r = run(home, 'compare.mjs', [dir]);
  assert.match(r.out, /FAIL->PASS/);
  assert.match(r.out, /verdict: comparable/);
  assert.equal(r.code, 0);
});

test('compare treats a fixture change as a different test contract even when everything else matches', () => {
  const { home } = fakeHome();
  const c = [caseOf('c1', [runOf(1), runOf(1), runOf(1)])];
  const dir = results(path.join(home, 'r'), {
    before: full(home, '2026-01-01T00:00:00Z', c, { contract: { shared: 's', cases: { c1: 'hard-fixture' } } }),
    after: full(home, '2026-01-02T00:00:00Z', c, { contract: { shared: 's', cases: { c1: 'easy-fixture' } } }),
  });
  const r = run(home, 'compare.mjs', [dir]);
  assert.match(r.out, /test contract changed: c1/);
  assert.doesNotMatch(r.out, /verdict: comparable/);
  assert.notEqual(r.code, 0);
});

test('compare reports insufficient evidence when the model, CLI version, judge or content proof is missing', () => {
  const { home } = fakeHome();
  const c = [caseOf('c1', [runOf(1), runOf(1), runOf(1)], [], { graders: [{ name: 'q', type: 'llm', weight: 1, config: {} }] })];
  const bare = (startedAt) => ({ startedAt, suite: { root: home, threshold: 1, ablation: 'with-without', plugins: [] }, cases: c });
  const dir = results(path.join(home, 'r'), { before: bare('2026-01-01T00:00:00Z'), after: bare('2026-01-02T00:00:00Z') });
  const r = run(home, 'compare.mjs', [dir]);
  assert.match(r.out, /verdict: INSUFFICIENT EVIDENCE/);
  assert.match(r.out, /model under test not recorded/);
  assert.match(r.out, /CLI version not recorded/);
  assert.match(r.out, /judge model not recorded/);
  assert.match(r.out, /content not verified/);
  assert.notEqual(r.code, 0);
});

test('compare shows whether the skill fired apart from the quality score', () => {
  const { home } = fakeHome();
  const graders = [
    { name: 'quality', type: 'regex', weight: 1, config: {} },
    { name: 'skill-fired', type: 'tool_used', weight: 1, config: { tool: 'Skill', input_match: 'alpha' } },
  ];
  const r1 = (q, f) => runOf(q && f ? 1 : 0.5, null, [{ name: 'quality', passed: q, weight: 1, scored: true }, { name: 'skill-fired', passed: f, weight: 1, scored: true }]);
  const one = (startedAt) => ({ ...full(home, startedAt, [caseOf('c1', [r1(false, true), r1(false, true), r1(false, true)], [], { graders, aggregates: { score: 0.5 } })]), suite: suite(home, { ablation: 'none' }) });
  const dir = results(path.join(home, 'r'), { only: one('2026-01-02T00:00:00Z') });
  const r = run(home, 'compare.mjs', [dir]);
  assert.match(r.out, /fired/);
  assert.match(r.out, /c1\s+-\s+0\.00\s/);
  assert.match(r.out, /3\/3/);
});

test('compare does not silently skip a corrupt newer result and pick an older one', () => {
  const { home } = fakeHome();
  const c = [caseOf('c1', [runOf(1), runOf(1), runOf(1)])];
  const dir = results(path.join(home, 'r'), {
    before: full(home, '2026-01-01T00:00:00Z', c),
    after: full(home, '2026-01-02T00:00:00Z', c),
    newest: '{"startedAt":"2026-01-03T00:00:00Z","cases":[',
  });
  const r = run(home, 'compare.mjs', [dir]);
  assert.match(r.out, /newest\.json/);
  assert.doesNotMatch(r.out, /verdict: comparable/);
  assert.notEqual(r.code, 0);
  const named = run(home, 'compare.mjs', [dir, '--after', 'newest']);
  assert.match(named.out, /newest\.json.*(unreadable|invalid)/);
  assert.equal(named.code, 1);
});

test('compare rejects a bad threshold and a result that breaks the schema', () => {
  const { home } = fakeHome();
  const c = [caseOf('c1', [runOf(1), runOf(1), runOf(1)])];
  const dir = results(path.join(home, 'r'), { before: full(home, '2026-01-01T00:00:00Z', c), after: full(home, '2026-01-02T00:00:00Z', c) });
  for (const bad of ['abc', '1.5', '-0.1']) {
    const r = run(home, 'compare.mjs', [dir, '--threshold', bad]);
    assert.equal(r.code, 1, `threshold ${bad}`);
    assert.match(r.out, /threshold/);
  }
  const broken = results(path.join(home, 'r2'), {
    before: full(home, '2026-01-01T00:00:00Z', c),
    after: full(home, '2026-01-02T00:00:00Z', [{ name: 'c1', arms: { with: [{ score: 'high' }] } }]),
  });
  const r = run(home, 'compare.mjs', [broken, '--after', 'after']);
  assert.equal(r.code, 1);
  assert.match(r.out, /after\.json.*invalid/);
});

test('compare --snapshot proves the change was inside the evaluated plugin and was evaluated', () => {
  const { home, root } = fakeHome();
  const plugin = path.join(root, 'skills', 'alpha');
  const snap = label('plugin');
  run(home, 'snapshot.mjs', ['start', snap, 'skills/alpha/SKILL.md', 'settings.json']);
  writeFileSync(path.join(plugin, 'SKILL.md'), 'changed\n');
  writeFileSync(path.join(root, 'settings.json'), '{"x":1}\n');
  run(home, 'snapshot.mjs', ['mark', snap]);
  const c = [caseOf('c1', [runOf(1), runOf(1), runOf(1)])];
  const at = '2099-01-01T00:00:00Z';
  const dir = results(path.join(home, 'r'), {
    before: { ...full(plugin, '2099-01-01T00:00:00Z', c, { frozenAt: at, files: { 'SKILL.md': hash('---\nname: alpha\n---\n') } }) },
    after: { ...full(plugin, '2099-01-02T00:00:00Z', c, { frozenAt: at, files: { 'SKILL.md': hash('stale content') } }) },
  });
  const r = run(home, 'compare.mjs', [dir, '--snapshot', snap]);
  assert.match(r.out, /settings\.json is outside the evaluated plugin/);
  assert.match(r.out, /after did not evaluate the changed skills\/alpha\/SKILL\.md/);
  assert.doesNotMatch(r.out, /before did not evaluate/);
  assert.equal(r.code, 2);
});

test('compare --snapshot accepts added and deleted files without a false mismatch', () => {
  const { home, root } = fakeHome();
  const plugin = path.join(root, 'skills', 'alpha');
  writeFileSync(path.join(plugin, 'old.md'), 'old\n');
  const snap = label('adddel');
  run(home, 'snapshot.mjs', ['start', snap, 'skills/alpha']);
  rmSync(path.join(plugin, 'old.md'));
  writeFileSync(path.join(plugin, 'new.md'), 'new\n');
  run(home, 'snapshot.mjs', ['mark', snap]);
  const skill = hash('---\nname: alpha\n---\n');
  const c = [caseOf('c1', [runOf(1), runOf(1), runOf(1)])];
  const dir = results(path.join(home, 'r'), {
    before: full(plugin, '2099-01-01T00:00:00Z', c, { frozenAt: '2099-01-01T00:00:00Z', files: { 'SKILL.md': skill, 'old.md': hash('old\n') } }),
    after: full(plugin, '2099-01-02T00:00:00Z', c, { frozenAt: '2099-01-02T00:00:00Z', files: { 'SKILL.md': skill, 'new.md': hash('new\n') } }),
  });
  const r = run(home, 'compare.mjs', [dir, '--snapshot', snap]);
  assert.doesNotMatch(r.out, /did not evaluate/);
  assert.match(r.out, /verdict: comparable/);
});

test('compare --snapshot refuses a baseline frozen before the snapshot started', () => {
  const { home, root } = fakeHome();
  const plugin = path.join(root, 'skills', 'alpha');
  const snap = label('late');
  run(home, 'snapshot.mjs', ['start', snap, 'skills/alpha']);
  writeFileSync(path.join(plugin, 'SKILL.md'), 'changed\n');
  run(home, 'snapshot.mjs', ['mark', snap]);
  const c = [caseOf('c1', [runOf(1), runOf(1), runOf(1)])];
  const dir = results(path.join(home, 'r'), {
    before: full(plugin, '2000-01-01T00:00:00Z', c, { frozenAt: '2000-01-01T00:00:00Z', files: { 'SKILL.md': hash('---\nname: alpha\n---\n') } }),
    after: full(plugin, '2099-01-02T00:00:00Z', c, { frozenAt: '2099-01-02T00:00:00Z', files: { 'SKILL.md': hash('changed\n') } }),
  });
  const r = run(home, 'compare.mjs', [dir, '--snapshot', snap]);
  assert.match(r.out, /snapshot .* started after the baseline/);
  assert.notEqual(r.code, 0);
});

function transcript(root, session, records, when = new Date().toISOString()) {
  const dir = path.join(root, 'projects', 'proj');
  mkdirSync(dir, { recursive: true });
  const lines = records.map((r) => (typeof r === 'string' ? r : JSON.stringify({ parentUuid: null, timestamp: when, ...r })));
  writeFileSync(path.join(dir, `${session}.jsonl`), `${lines.join('\n')}\n`);
}
const useTool = (id, name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (id, isError = false) => ({ type: 'user', toolUseResult: {}, message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: 'x' }] } });
const say = (text) => ({ type: 'user', message: { content: text } });
const command = (name) => say(`<command-name>/${name}</command-name>\n<command-message>${name}</command-message>`);

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

test('suggest drops the old skill when a slash command of unknown source runs', () => {
  const { home, root } = fakeHome();
  transcript(root, 's5', [useTool('k1', 'Skill', { skill: 'alpha' }), result('k1'), command('goal'), say('sai rồi')]);
  const items = JSON.parse(run(home, 'suggest.mjs', ['--session', 's5', '--json']).out).items;
  assert.equal(items.some((x) => x.target === 'alpha'), false);
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

test('suggest applies the time window to each tool error, not only to the file', () => {
  const { home, root } = fakeHome();
  const old = new Date(Date.now() - 30 * 86400000).toISOString();
  transcript(root, 'g2', [useTool('k1', 'Skill', { skill: 'alpha' }), result('k1'), useTool('b1', 'Bash', { command: 'x' }), result('b1', true)], old);
  const out = JSON.parse(run(home, 'suggest.mjs', ['--no-doctor', '--no-validate', '--json']).out);
  assert.equal(out.items.some((x) => x.target === 'alpha'), false);
});

test('suggest marks transcripts with unreadable lines as partial evidence', () => {
  const { home, root } = fakeHome();
  transcript(root, 's6', [useTool('k1', 'Skill', { skill: 'alpha' }), '{"parentUuid":null,"type":"user","message":{"content":"sai r']);
  const out = JSON.parse(run(home, 'suggest.mjs', ['--session', 's6', '--json']).out);
  assert.equal(out.collectors.find((c) => c.name === 'transcripts').status, 'partial');
  assert.equal(out.evidence_complete, false);
});

test('suggest never ranks a candidate with an empty target', () => {
  const { home, root } = fakeHome();
  gitRepo(root);
  mkdirSync(path.join(root, 'agents'), { recursive: true });
  writeFileSync(path.join(root, 'agents', 'helper.md'), '---\nname: helper\n---\n');
  const out = JSON.parse(run(home, 'suggest.mjs', ['--no-doctor', '--no-validate', '--json']).out);
  assert.equal(out.items.some((x) => !String(x.target).trim()), false);
  assert.ok(out.items.some((x) => x.kind === 'agent' && x.target === 'helper'));
});

test('suggest --target narrows the list to the named skill', () => {
  const { home, root } = fakeHome();
  transcript(root, 'g3', [useTool('k1', 'Skill', { skill: 'alpha' }), result('k1'), useTool('b1', 'Bash', { command: 'x' }), result('b1', true), useTool('k2', 'Skill', { skill: 'eli5' }), result('k2'), useTool('b2', 'Bash', { command: 'y' }), result('b2', true)]);
  const out = JSON.parse(run(home, 'suggest.mjs', ['--target', 'alpha', '--no-doctor', '--no-validate', '--json']).out);
  assert.ok(out.items.length > 0);
  assert.deepEqual([...new Set(out.items.map((x) => x.target))], ['alpha']);
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
  const snap = label('revert');
  const a = path.join(root, 'skills', 'alpha', 'SKILL.md');
  const b = path.join(root, 'skills', 'eli5', 'SKILL.md');
  writeFileSync(a, 'user work in progress\n');
  assert.equal(run(home, 'snapshot.mjs', ['start', snap, 'skills/alpha', 'skills/eli5/SKILL.md']).code, 0);
  writeFileSync(a, 'experiment\n');
  writeFileSync(path.join(root, 'skills', 'alpha', 'new.md'), 'new case\n');
  writeFileSync(b, 'experiment\n');
  run(home, 'snapshot.mjs', ['mark', snap]);
  writeFileSync(b, 'someone else edited after mark\n');
  const r = run(home, 'snapshot.mjs', ['revert', snap]);
  assert.equal(readFileSync(a, 'utf8'), 'user work in progress\n');
  assert.equal(existsSync(path.join(root, 'skills', 'alpha', 'new.md')), false);
  assert.equal(readFileSync(b, 'utf8'), 'someone else edited after mark\n');
  assert.match(r.out, /not reverted: skills\/eli5\/SKILL\.md: changed after mark/);
  assert.equal(r.code, 1);
});

test('snapshot refuses a path outside ~/.claude and revert before mark', () => {
  const { home } = fakeHome();
  const snap = label('outside');
  assert.equal(run(home, 'snapshot.mjs', ['start', snap, path.join(home, 'elsewhere.txt')]).code, 1);
  run(home, 'snapshot.mjs', ['start', snap, 'skills/alpha/SKILL.md']);
  assert.match(run(home, 'snapshot.mjs', ['revert', snap]).out, /never marked/);
});

test('snapshot rejects . and .. as labels and drop removes only that one snapshot', () => {
  const { home } = fakeHome();
  const keep = label('keep');
  assert.equal(run(home, 'snapshot.mjs', ['start', keep, 'skills/alpha']).code, 0);
  mkdirSync(WORKING, { recursive: true });
  writeFileSync(path.join(WORKING, 'sentinel.txt'), 'keep me\n');
  for (const bad of ['.', '..', '../x', 'a/b', '']) {
    const s = run(home, 'snapshot.mjs', ['start', bad, 'skills/alpha']);
    assert.notEqual(s.code, 0, `start ${JSON.stringify(bad)}`);
    const d = run(home, 'snapshot.mjs', ['drop', bad]);
    assert.notEqual(d.code, 0, `drop ${JSON.stringify(bad)}`);
  }
  assert.equal(existsSync(path.join(WORKING, 'sentinel.txt')), true);
  assert.equal(existsSync(path.join(WORKING, 'snapshots', keep, 'manifest.json')), true);
  assert.equal(run(home, 'snapshot.mjs', ['drop', keep]).code, 0);
  assert.equal(existsSync(path.join(WORKING, 'snapshots', keep)), false);
  assert.equal(existsSync(path.join(WORKING, 'sentinel.txt')), true);
});

test('snapshot tracks a folder that did not exist at start and removes it on revert', () => {
  const { home, root } = fakeHome();
  const snap = label('newdir');
  assert.equal(run(home, 'snapshot.mjs', ['start', snap, 'skills/alpha/evals/new-case']).code, 0);
  mkdirSync(path.join(root, 'skills', 'alpha', 'evals', 'new-case', 'graders'), { recursive: true });
  writeFileSync(path.join(root, 'skills', 'alpha', 'evals', 'new-case', 'prompt.md'), 'p\n');
  writeFileSync(path.join(root, 'skills', 'alpha', 'evals', 'new-case', 'graders', 'g.md'), 'g\n');
  const m = run(home, 'snapshot.mjs', ['mark', snap]);
  assert.match(m.out, /added\s+skills\/alpha\/evals\/new-case\/prompt\.md/);
  assert.equal(run(home, 'snapshot.mjs', ['revert', snap]).code, 0);
  assert.equal(existsSync(path.join(root, 'skills', 'alpha', 'evals', 'new-case')), false);
});

test('snapshot reverts a rename inside a tracked folder', () => {
  const { home, root } = fakeHome();
  const snap = label('rename');
  run(home, 'snapshot.mjs', ['start', snap, 'skills/alpha']);
  renameSync(path.join(root, 'skills', 'alpha', 'SKILL.md'), path.join(root, 'skills', 'alpha', 'MAIN.md'));
  run(home, 'snapshot.mjs', ['mark', snap]);
  assert.equal(run(home, 'snapshot.mjs', ['revert', snap]).code, 0);
  assert.equal(readFileSync(path.join(root, 'skills', 'alpha', 'SKILL.md'), 'utf8'), '---\nname: alpha\n---\n');
  assert.equal(existsSync(path.join(root, 'skills', 'alpha', 'MAIN.md')), false);
});

test('snapshot keep stages only the experiment hunks of a file that already held user work, and keeps staging', () => {
  const { home, root } = fakeHome();
  const a = path.join(root, 'skills', 'alpha', 'SKILL.md');
  const lines = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`);
  writeFileSync(a, `${lines.join('\n')}\n`);
  gitRepo(root);
  writeFileSync(path.join(root, 'skills', 'eli5', 'SKILL.md'), 'user staged change\n');
  git(root, 'add', 'skills/eli5/SKILL.md');
  writeFileSync(a, `${lines.join('\n')}\nuser wip\n`);
  const snap = label('stage');
  run(home, 'snapshot.mjs', ['start', snap, 'skills/alpha/SKILL.md']);
  writeFileSync(a, `${['line 1 changed by experiment', ...lines.slice(1)].join('\n')}\nuser wip\n`);
  run(home, 'snapshot.mjs', ['mark', snap]);
  const stagedBefore = git(root, 'diff', '--cached', '--name-only');
  const blocked = run(home, 'snapshot.mjs', ['keep', snap]);
  assert.equal(blocked.code, 1, blocked.out);
  assert.match(blocked.out, /already staged.*skills\/eli5\/SKILL\.md/s);
  assert.doesNotMatch(blocked.out, /apply --cached|add -- |plain `git commit`/);
  assert.equal(git(root, 'diff', '--cached', '--name-only'), stagedBefore);
  git(root, 'commit', '-q', '-m', 'the user commits their own staged change');
  const k = run(home, 'snapshot.mjs', ['keep', snap]);
  assert.equal(k.code, 0, k.out);
  assert.doesNotMatch(k.out, /add -- "skills\/alpha\/SKILL\.md"/);
  const apply = /git -C "([^"]+)" apply --cached "([^"]+)"/.exec(k.out);
  assert.ok(apply, k.out);
  assert.equal(git(root, 'diff', '--cached', '--name-only'), '');
  git(apply[1], 'apply', '--cached', apply[2]);
  const staged = git(root, 'diff', '--cached', '--', 'skills/alpha/SKILL.md');
  assert.match(staged, /\+line 1 changed by experiment/);
  assert.doesNotMatch(staged, /user wip/);
  assert.match(readFileSync(a, 'utf8'), /user wip/);
});

test('snapshot revert leaves the git index untouched', () => {
  const { home, root } = fakeHome();
  gitRepo(root);
  writeFileSync(path.join(root, 'skills', 'eli5', 'SKILL.md'), 'staged by user\n');
  git(root, 'add', 'skills/eli5/SKILL.md');
  const snap = label('index');
  run(home, 'snapshot.mjs', ['start', snap, 'skills/alpha']);
  writeFileSync(path.join(root, 'skills', 'alpha', 'SKILL.md'), 'experiment\n');
  run(home, 'snapshot.mjs', ['mark', snap]);
  const before = git(root, 'diff', '--cached');
  assert.equal(run(home, 'snapshot.mjs', ['revert', snap]).code, 0);
  assert.equal(git(root, 'diff', '--cached'), before);
});

test('snapshot keep blocks a secret in an added line and lists exact paths otherwise', () => {
  const { home, root } = fakeHome();
  const snap = label('keep');
  const a = path.join(root, 'skills', 'alpha', 'SKILL.md');
  run(home, 'snapshot.mjs', ['start', snap, 'skills/alpha/SKILL.md']);
  writeFileSync(a, `---\nname: alpha\n---\napi_key: "${'A1b2C3d4'.repeat(3)}"\n`);
  run(home, 'snapshot.mjs', ['mark', snap]);
  const blocked = run(home, 'snapshot.mjs', ['keep', snap]);
  assert.equal(blocked.code, 1);
  assert.match(blocked.out, /skills\/alpha\/SKILL\.md:4: added line looks like a credential assignment/);
  assert.doesNotMatch(blocked.out, /A1b2C3d4/);
  writeFileSync(a, '---\nname: alpha\n---\nmore steps\n');
  run(home, 'snapshot.mjs', ['mark', snap]);
  const ok = run(home, 'snapshot.mjs', ['keep', snap]);
  assert.equal(ok.code, 0);
  assert.match(ok.out, /add -- "skills\/alpha\/SKILL\.md"/);
});

function pluginWithCase(root) {
  const plugin = path.join(root, 'skills', 'alpha');
  mkdirSync(path.join(plugin, 'evals', 'c1', 'graders'), { recursive: true });
  mkdirSync(path.join(plugin, 'evals', 'c1', 'files'), { recursive: true });
  writeFileSync(path.join(plugin, 'evals', 'c1', 'prompt.md'), '---\nname: c1\n---\n\nhi\n');
  writeFileSync(path.join(plugin, 'evals', 'c1', 'graders', 'g.md'), '---\ntype: regex\npattern: x\n---\n');
  writeFileSync(path.join(plugin, 'evals', 'c1', 'files', 'data.txt'), 'hard fixture\n');
  return plugin;
}
function fakeRun(plugin, evalDir = 'evals', dirName = new Date(Date.now() + 1000).toISOString().replace(/[:.]/g, '-')) {
  const runDir = path.join(plugin, evalDir, 'results', dirName);
  mkdirSync(runDir, { recursive: true });
  const j = { schemaVersion: 1, claudeVersion: '2.1.0', startedAt: new Date(Date.now() + 1000).toISOString(), suite: suite(plugin), cases: [caseOf('c1', [runOf(1), runOf(1), runOf(1)], [], { dir: `${evalDir}\\c1` })] };
  writeFileSync(path.join(runDir, 'aggregate-result.json'), JSON.stringify(j));
  writeFileSync(path.join(runDir, 'report.html'), '<html></html>');
  return runDir;
}

test('record requires the model and fingerprints the evaluated plugin', () => {
  const { home, root } = fakeHome();
  const plugin = path.join(root, 'skills', 'alpha');
  fakeRun(plugin);
  assert.equal(run(home, 'record.mjs', ['alpha', 'before-x']).code, 1);
  assert.equal(run(home, 'record.mjs', ['alpha', 'before-x', '--model', 'model-a']).code, 0);
  const saved = JSON.parse(readFileSync(path.join(plugin, 'evals', 'results', 'before-x.json'), 'utf8'));
  assert.equal(saved.recorded.model, 'model-a');
  assert.equal(saved.recorded.files['SKILL.md'], hash('---\nname: alpha\n---\n'));
  assert.equal(Object.keys(saved.recorded.files).some((f) => f.startsWith('evals/results')), false);
});

test('record leaves out evals-wsl results and a custom output folder', () => {
  const { home, root } = fakeHome();
  const plugin = pluginWithCase(root);
  mkdirSync(path.join(plugin, 'evals', 'results'), { recursive: true });
  const runDir = fakeRun(plugin, 'evals-wsl');
  const custom = path.join(plugin, 'out', 'run1');
  mkdirSync(custom, { recursive: true });
  writeFileSync(path.join(custom, 'aggregate-result.json'), readFileSync(path.join(runDir, 'aggregate-result.json')));
  assert.equal(run(home, 'record.mjs', ['alpha', 'wsl', '--freeze', '--eval-dir', 'evals-wsl', '--exclude', 'out/run1']).code, 0);
  const r = run(home, 'record.mjs', ['alpha', 'wsl', '--model', 'model-a', '--from', runDir, '--exclude', 'out/run1']);
  assert.equal(r.code, 0, r.out);
  const saved = JSON.parse(readFileSync(path.join(plugin, 'evals-wsl', 'results', 'wsl.json'), 'utf8'));
  const keys = Object.keys(saved.recorded.files);
  assert.equal(keys.some((f) => f.startsWith('evals-wsl/results') || f.startsWith('out/run1')), false, keys.join(','));
  assert.equal(saved.recorded.contentVerified, true);
});

test('record separates the test contract from the skill and a fixture change breaks comparability', () => {
  const { home, root } = fakeHome();
  const plugin = pluginWithCase(root);
  assert.equal(run(home, 'record.mjs', ['alpha', 'before-f', '--freeze']).code, 0);
  fakeRun(plugin, 'evals', 'run-a');
  assert.equal(run(home, 'record.mjs', ['alpha', 'before-f', '--model', 'model-a']).code, 0);
  writeFileSync(path.join(plugin, 'evals', 'c1', 'files', 'data.txt'), 'easy fixture\n');
  assert.equal(run(home, 'record.mjs', ['alpha', 'after-f', '--freeze']).code, 0);
  fakeRun(plugin, 'evals', 'run-b');
  assert.equal(run(home, 'record.mjs', ['alpha', 'after-f', '--model', 'model-a']).code, 0);
  const saved = JSON.parse(readFileSync(path.join(plugin, 'evals', 'results', 'after-f.json'), 'utf8'));
  assert.ok(saved.recorded.contract.cases.c1);
  assert.ok(saved.recorded.subject['SKILL.md']);
  assert.equal(Object.keys(saved.recorded.subject).some((f) => f.startsWith('evals/')), false);
  const r = run(home, 'compare.mjs', ['alpha', '--before', 'before-f', '--after', 'after-f']);
  assert.match(r.out, /test contract changed: c1/);
  assert.doesNotMatch(r.out, /verdict: comparable/);
});

test('record does not accept content hashed only after the run as proof', () => {
  const { home, root } = fakeHome();
  const plugin = pluginWithCase(root);
  fakeRun(plugin);
  assert.equal(run(home, 'record.mjs', ['alpha', 'no-freeze', '--model', 'model-a']).code, 0);
  const plain = JSON.parse(readFileSync(path.join(plugin, 'evals', 'results', 'no-freeze.json'), 'utf8'));
  assert.equal(plain.recorded.contentVerified, false);
  assert.equal(run(home, 'record.mjs', ['alpha', 'drift', '--freeze']).code, 0);
  fakeRun(plugin, 'evals', 'run-drift');
  writeFileSync(path.join(plugin, 'SKILL.md'), 'edited while the eval ran\n');
  const r = run(home, 'record.mjs', ['alpha', 'drift', '--model', 'model-a']);
  const drift = JSON.parse(readFileSync(path.join(plugin, 'evals', 'results', 'drift.json'), 'utf8'));
  assert.equal(drift.recorded.contentVerified, false);
  assert.deepEqual(drift.recorded.changedDuringRun, ['SKILL.md']);
  assert.match(r.out, /changed while the eval ran/);
});

test('record matches the frozen folder to the evaluated one regardless of letter case on Windows', (t) => {
  if (process.platform !== 'win32') return t.skip('paths are case-sensitive on this platform');
  const { home, root } = fakeHome();
  const plugin = pluginWithCase(root);
  assert.equal(run(home, 'record.mjs', ['alpha', 'case-diff', '--freeze']).code, 0);
  const file = path.join(fakeRun(plugin), 'aggregate-result.json');
  const j = JSON.parse(readFileSync(file, 'utf8'));
  j.suite.root = plugin.replace(/^[a-z]:/i, (d) => (d === d.toUpperCase() ? d.toLowerCase() : d.toUpperCase())).replace('improve-test-home-', 'IMPROVE-TEST-HOME-');
  writeFileSync(file, JSON.stringify(j));
  const r = run(home, 'record.mjs', ['alpha', 'case-diff', '--model', 'model-a']);
  assert.doesNotMatch(r.out, /but the run evaluated/);
  assert.equal(JSON.parse(readFileSync(path.join(plugin, 'evals', 'results', 'case-diff.json'), 'utf8')).recorded.contentVerified, true);
});

test('every regex grader on the trace looks for text the skill itself never contains', () => {
  const skillText = ['SKILL.md', ...readdirSync(path.join(SOURCE, 'steps')).map((f) => `steps/${f}`)].map((f) => readFileSync(path.join(SOURCE, f), 'utf8')).join('\n');
  for (const evalDir of ['evals', 'evals-wsl']) {
    const base = path.join(SOURCE, evalDir);
    if (!existsSync(base)) continue;
    for (const c of readdirSync(base)) {
      const graders = path.join(base, c, 'graders');
      if (!existsSync(graders)) continue;
      for (const g of readdirSync(graders)) {
        const text = readFileSync(path.join(graders, g), 'utf8');
        if (!/^type:\s*regex/m.test(text) || !/^target:\s*trace/m.test(text)) continue;
        const pattern = /^pattern:\s*'(.*)'\s*$/m.exec(text)?.[1];
        assert.ok(pattern, `${evalDir}/${c}/graders/${g} has no pattern`);
        assert.equal(new RegExp(pattern).test(skillText), false, `${evalDir}/${c}/graders/${g} matches the skill's own text`);
      }
    }
  }
});

const BASH = process.platform === 'win32' ? [path.join(process.env.ProgramFiles || 'C:\Program Files', 'Git', 'bin', 'bash.exe')].find((p) => existsSync(p)) : 'bash';

test('the evals-wsl fixture makes suggest.mjs report the fixture skill, and each file grader of that case matches the real output', (t) => {
  const caseDir = path.join(SOURCE, 'evals-wsl', 'blank-global');
  const caseYaml = path.join(caseDir, 'case.yaml');
  assert.ok(existsSync(caseYaml), 'evals-wsl/blank-global has no case.yaml with a scaffold');
  const scaffold = /scaffold_script:\s*(\S+)/.exec(readFileSync(caseYaml, 'utf8'))?.[1];
  assert.ok(scaffold && existsSync(path.join(caseDir, scaffold)), 'the scaffold script is missing');
  if (!BASH) return t.skip('Git Bash is not installed');
  const home = mkdtempSync(path.join(os.tmpdir(), 'improve-test-home-'));
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'improve-test-workspace-'));
  homes.push(home, workspace);
  const s = spawnSync(BASH, [path.join(caseDir, scaffold)], { cwd: workspace, env: { ...process.env, HOME: home }, encoding: 'utf8' });
  assert.equal(s.status, 0, s.stderr);
  const text = run(home, 'suggest.mjs', ['--no-doctor', '--no-validate']);
  const json = run(home, 'suggest.mjs', ['--no-doctor', '--no-validate', '--json']);
  assert.equal(text.code, 0, text.out);
  assert.ok(JSON.parse(json.out).items.some((x) => x.kind === 'skill' && x.target === 'fixture-alpha'));
  assert.equal(JSON.parse(json.out).collectors.find((c) => c.name === 'transcripts').status, 'ok', 'the fixture transcript has an unparsable line');
  const graders = readdirSync(path.join(caseDir, 'graders'))
    .map((g) => [g, readFileSync(path.join(caseDir, 'graders', g), 'utf8')])
    .filter(([, body]) => /^\s+source:\s*file\s*$/m.test(body));
  assert.ok(graders.length >= 2, 'the case grades the saved output file, not only the Bash call');
  for (const [g, body] of graders) {
    const pattern = /^pattern:\s*'(.*)'\s*$/m.exec(body)?.[1]?.replace(/''/g, "'");
    assert.ok(pattern, `${g} has no pattern`);
    assert.match(text.out, new RegExp(pattern), `${g} does not match the text output on the fixture`);
    assert.match(json.out, new RegExp(pattern), `${g} does not match the --json output on the fixture`);
  }
});

test('no evals-wsl grader needs a Skill call before the script, which a slash-command prompt never makes', () => {
  for (const c of readdirSync(path.join(SOURCE, 'evals-wsl'))) {
    const dir = path.join(SOURCE, 'evals-wsl', c, 'graders');
    if (!existsSync(dir)) continue;
    for (const g of readdirSync(dir)) {
      const body = readFileSync(path.join(dir, g), 'utf8');
      assert.equal(/^type:\s*tool_order/m.test(body) && /^before:\s*Skill\s*$/m.test(body), false, `evals-wsl/${c}/graders/${g} orders Skill before another tool`);
    }
  }
});

function fakeRunOf(plugin, caseDirs, evalDir = 'evals') {
  const startedAt = new Date(Date.now() + 1000).toISOString();
  const runDir = path.join(plugin, evalDir, 'results', startedAt.replace(/[:.]/g, '-'));
  mkdirSync(runDir, { recursive: true });
  const cases = caseDirs.map((d) => caseOf(d.split('/').at(-1), [runOf(1), runOf(1), runOf(1)], [], { dir: d.replace(/\//g, '\\') }));
  writeFileSync(path.join(runDir, 'aggregate-result.json'), JSON.stringify({ schemaVersion: 1, claudeVersion: '2.1.0', startedAt, suite: suite(plugin), cases }));
  return runDir;
}

function measured(home, plugin, name, caseDirs, freezeArgs = []) {
  assert.equal(run(home, 'record.mjs', ['alpha', name, '--freeze', ...freezeArgs]).code, 0);
  fakeRunOf(plugin, caseDirs);
  const r = run(home, 'record.mjs', ['alpha', name, '--model', 'model-a']);
  assert.equal(r.code, 0, r.out);
  return JSON.parse(readFileSync(path.join(plugin, 'evals', 'results', `${name}.json`), 'utf8')).recorded;
}

function pluginWithNestedCase(root) {
  const plugin = path.join(root, 'skills', 'alpha');
  mkdirSync(path.join(plugin, 'evals', 'group', 'task', 'graders'), { recursive: true });
  mkdirSync(path.join(plugin, 'evals', 'mocks'), { recursive: true });
  writeFileSync(path.join(plugin, 'evals', 'group', 'task', 'prompt.md'), '---\nname: task\n---\n\nhi\n');
  writeFileSync(path.join(plugin, 'evals', 'group', 'task', 'graders', 'g.md'), '---\ntype: regex\npattern: x\n---\n');
  writeFileSync(path.join(plugin, 'evals', 'mocks', 'api.json'), '{"answer":"hard"}\n');
  return plugin;
}

test('freeze, record and compare --snapshot treat a shared mock beside a nested case as part of the test contract', () => {
  const { home, root } = fakeHome();
  const plugin = pluginWithNestedCase(root);
  const snap = label('mock');
  assert.equal(run(home, 'snapshot.mjs', ['start', snap, 'skills/alpha']).code, 0);
  const before = measured(home, plugin, 'before-m', ['evals/group/task']);
  assert.equal(before.contentVerified, true, before.problems.join('; '));
  assert.equal(Object.keys(before.subject).some((f) => f.startsWith('evals/')), false, Object.keys(before.subject).join(','));
  writeFileSync(path.join(plugin, 'SKILL.md'), '---\nname: alpha\n---\nchanged\n');
  writeFileSync(path.join(plugin, 'evals', 'mocks', 'api.json'), '{"answer":"easy"}\n');
  run(home, 'snapshot.mjs', ['mark', snap]);
  measured(home, plugin, 'after-m', ['evals/group/task']);
  const r = run(home, 'compare.mjs', ['alpha', '--before', 'before-m', '--after', 'after-m', '--snapshot', snap]);
  assert.match(r.out, /shared eval files changed/);
  assert.doesNotMatch(r.out, /did not evaluate|content not verified|not recorded/);
  assert.match(r.out, /verdict: NOT COMPARABLE/);
  assert.notEqual(r.code, 0);
});

test('freeze, record and compare --snapshot stay comparable when only the skill changed in a nested layout', () => {
  const { home, root } = fakeHome();
  const plugin = pluginWithNestedCase(root);
  const snap = label('code');
  run(home, 'snapshot.mjs', ['start', snap, 'skills/alpha']);
  measured(home, plugin, 'before-c', ['evals/group/task']);
  writeFileSync(path.join(plugin, 'SKILL.md'), '---\nname: alpha\n---\nchanged\n');
  run(home, 'snapshot.mjs', ['mark', snap]);
  measured(home, plugin, 'after-c', ['evals/group/task']);
  const r = run(home, 'compare.mjs', ['alpha', '--before', 'before-c', '--after', 'after-c', '--snapshot', snap]);
  assert.match(r.out, /verdict: comparable/, r.out);
});

test('freeze, record and compare --snapshot hash a fixture file named aggregate-result.json as part of the case', () => {
  const { home, root } = fakeHome();
  const plugin = pluginWithCase(root);
  const fixture = path.join(plugin, 'evals', 'c1', 'files', 'aggregate-result.json');
  writeFileSync(fixture, '{"fixture":"hard"}\n');
  const snap = label('agg');
  run(home, 'snapshot.mjs', ['start', snap, 'skills/alpha']);
  const before = measured(home, plugin, 'before-a', ['evals/c1']);
  assert.ok(Object.keys(before.files).includes('evals/c1/files/aggregate-result.json'), Object.keys(before.files).join(','));
  writeFileSync(fixture, '{"fixture":"easy"}\n');
  run(home, 'snapshot.mjs', ['mark', snap]);
  measured(home, plugin, 'after-a', ['evals/c1']);
  const r = run(home, 'compare.mjs', ['alpha', '--before', 'before-a', '--after', 'after-a', '--snapshot', snap]);
  assert.match(r.out, /test contract changed: c1/);
  assert.notEqual(r.code, 0);
});

test('record refuses to verify a run whose cases sit outside the eval folder declared at the freeze', () => {
  const { home, root } = fakeHome();
  const plugin = pluginWithCase(root);
  assert.equal(run(home, 'record.mjs', ['alpha', 'wrong-dir', '--freeze']).code, 0);
  fakeRun(plugin, 'evals-wsl');
  const r = run(home, 'record.mjs', ['alpha', 'wrong-dir', '--model', 'model-a']);
  const saved = JSON.parse(readFileSync(path.join(plugin, 'evals', 'results', 'wrong-dir.json'), 'utf8')).recorded;
  assert.equal(saved.contentVerified, false);
  assert.match(r.out, /outside the eval folder/);
});

function improveInstall(root) {
  const skill = path.join(root, 'skills', 'improve');
  cpSync(SCRIPTS, path.join(skill, 'scripts'), { recursive: true });
  writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: improve\n---\noriginal\n');
  return skill;
}

test('snapshot of the improve skill itself leaves its own storage out and reverts cleanly', () => {
  const { home, root } = fakeHome();
  const skill = improveInstall(root);
  const own = path.join(skill, 'scripts');
  const snap = label('self');
  assert.equal(run(home, 'snapshot.mjs', ['start', snap, 'skills/improve'], own).code, 0);
  writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: improve\n---\nexperiment\n');
  const m = run(home, 'snapshot.mjs', ['mark', snap], own);
  assert.doesNotMatch(m.out, /working\//, m.out);
  assert.match(m.out, /changed\s+skills\/improve\/SKILL\.md/);
  const r = run(home, 'snapshot.mjs', ['revert', snap], own);
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /not reverted/);
  assert.equal(readFileSync(path.join(skill, 'SKILL.md'), 'utf8'), '---\nname: improve\n---\noriginal\n');
  assert.equal(run(home, 'snapshot.mjs', ['drop', snap], own).code, 0);
});

test('snapshot keep blocks the commit when the user had staged changes in the same file, and leaves the index alone', () => {
  const { home, root } = fakeHome();
  const a = path.join(root, 'skills', 'alpha', 'SKILL.md');
  const lines = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`);
  writeFileSync(a, `${lines.join('\n')}\n`);
  gitRepo(root);
  writeFileSync(a, `${lines.join('\n')}\nuser staged line\n`);
  git(root, 'add', 'skills/alpha/SKILL.md');
  const snap = label('samefile');
  run(home, 'snapshot.mjs', ['start', snap, 'skills/alpha/SKILL.md']);
  writeFileSync(a, `${['line 1 changed by experiment', ...lines.slice(1)].join('\n')}\nuser staged line\n`);
  run(home, 'snapshot.mjs', ['mark', snap]);
  const indexBefore = git(root, 'diff', '--cached');
  const k = run(home, 'snapshot.mjs', ['keep', snap]);
  assert.notEqual(k.code, 0, k.out);
  assert.match(k.out, /skills\/alpha\/SKILL\.md.*staged/);
  assert.doesNotMatch(k.out, /apply --cached|add --/);
  assert.equal(git(root, 'diff', '--cached'), indexBefore);
});

test('snapshot keep never suggests a path-limited or -a commit, which would take whole working-tree files', () => {
  const { home, root } = fakeHome();
  const a = path.join(root, 'skills', 'alpha', 'SKILL.md');
  const lines = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`);
  writeFileSync(a, `${lines.join('\n')}\n`);
  gitRepo(root);
  writeFileSync(a, `${lines.join('\n')}\nuser wip\n`);
  const snap = label('commitcmd');
  run(home, 'snapshot.mjs', ['start', snap, 'skills/alpha/SKILL.md']);
  writeFileSync(a, `${['line 1 changed by experiment', ...lines.slice(1)].join('\n')}\nuser wip\n`);
  run(home, 'snapshot.mjs', ['mark', snap]);
  const k = run(home, 'snapshot.mjs', ['keep', snap]);
  assert.equal(k.code, 0, k.out);
  assert.match(k.out, /plain `git commit`/);
  assert.doesNotMatch(k.out, /git commit (-a|--all|--only|-- )/);
});

test('suggest reads git status -z without losing the leading status space of the first record', () => {
  const { home, root } = fakeHome();
  writeFileSync(path.join(root, 'settings.json'), '{}\n');
  gitRepo(root);
  writeFileSync(path.join(root, 'settings.json'), '{"x":1}\n');
  writeFileSync(path.join(root, 'skills', 'alpha', 'notes file.md'), 'n\n');
  const out = JSON.parse(run(home, 'suggest.mjs', ['--no-doctor', '--no-validate', '--json']).out);
  const targets = out.items.map((x) => `${x.kind}:${x.target}`);
  assert.ok(targets.includes('settings:settings.json'), targets.join(','));
  assert.ok(targets.includes('skill:alpha'), targets.join(','));
  assert.equal(targets.some((t) => /ettings\.json$/.test(t) && t !== 'settings:settings.json'), false, targets.join(','));
});

test('suggest parses an unstaged deletion with spaces as the first of several NUL records', () => {
  const { home, root } = fakeHome();
  mkdirSync(path.join(root, 'agents'), { recursive: true });
  writeFileSync(path.join(root, 'agents', 'old helper.md'), '---\nname: old-helper\n---\n');
  gitRepo(root);
  rmSync(path.join(root, 'agents', 'old helper.md'));
  writeFileSync(path.join(root, 'skills', 'alpha', 'SKILL.md'), 'changed\n');
  writeFileSync(path.join(root, 'skills', 'eli5', 'SKILL.md'), 'changed\n');
  const out = JSON.parse(run(home, 'suggest.mjs', ['--no-doctor', '--no-validate', '--json']).out);
  const targets = out.items.map((x) => `${x.kind}:${x.target}`);
  assert.ok(targets.includes('agent:old helper'), targets.join(','));
  assert.ok(targets.includes('skill:alpha') && targets.includes('skill:eli5'), targets.join(','));
  assert.equal(out.collectors.find((c) => c.name === 'git status').detail, '3 uncommitted path(s)');
});

test('record keeps the raw git status codes, including the first record, renames and paths with spaces', () => {
  const { home, root } = fakeHome();
  const plugin = path.join(root, 'skills', 'alpha');
  writeFileSync(path.join(plugin, 'a.md'), 'a\n');
  writeFileSync(path.join(root, '.gitignore'), 'skills/alpha/evals/results/\n');
  gitRepo(root);
  writeFileSync(path.join(plugin, 'SKILL.md'), 'changed\n');
  git(root, 'mv', 'skills/alpha/a.md', 'skills/alpha/b c.md');
  writeFileSync(path.join(plugin, 'new file.md'), 'n\n');
  fakeRun(plugin);
  assert.equal(run(home, 'record.mjs', ['alpha', 'status', '--model', 'model-a']).code, 0);
  const rec = JSON.parse(readFileSync(path.join(plugin, 'evals', 'results', 'status.json'), 'utf8')).recorded;
  assert.deepEqual([...rec.uncommitted].sort(), [' M skills/alpha/SKILL.md', '?? skills/alpha/new file.md', 'R  skills/alpha/b c.md (from skills/alpha/a.md)'].sort());
});

const BARE_REPLIES = {
  wrote: [
    "I couldn't start the upgrade for `eli5`. `/improve` needs to run `suggest.mjs --target eli5` to find what's wrong with the skill, and Bash is disabled, so the script never ran. I won't guess a problem to fix.",
    'Bạn chỉ đưa tên skill, nên bước đầu tiên là chạy lệnh dưới đây:\n\n```\nnode C:/Users/x/.claude/skills/improve/scripts/suggest.mjs --target eli5\n```\n\nBash bị tắt nên chưa chạy được.',
    "You only gave the skill's name, so the first step is to run `suggest.mjs --target eli5`. That didn't work: Bash is turned off. Nothing was changed.",
  ],
  missing: [
    'I could not find an `eli5` skill. Paste its SKILL.md and I will tighten the description.',
    'Run `suggest.mjs` first to collect signals.',
    'Run `node suggest.mjs --session` to see this session.',
    'Run `suggest.mjs --target eli5x` first.',
    'Run `suggest.mjs --target alpha` first.',
  ],
};

test('run-bare-name grades the written command with a fixed pattern and keeps a narrow claim check apart', () => {
  const dir = path.join(SOURCE, 'evals', 'run-bare-name', 'graders');
  const graders = readdirSync(dir).map((g) => [g, readFileSync(path.join(dir, g), 'utf8')]);
  const written = graders.filter(([, body]) => /^type:\s*regex/m.test(body) && !/^target:\s*trace/m.test(body) && !/^\s+source:/m.test(body));
  assert.equal(written.length, 1, 'one regex grader on the reply checks the written command');
  const pattern = new RegExp(/^pattern:\s*'(.*)'\s*$/m.exec(written[0][1])[1].replace(/''/g, "'"));
  for (const reply of BARE_REPLIES.wrote) assert.match(reply, pattern);
  for (const reply of BARE_REPLIES.missing) assert.doesNotMatch(reply, pattern);
  const llm = graders.filter(([, body]) => /^type:\s*llm/m.test(body));
  assert.ok(llm.length >= 1 && llm.every(([, body]) => /^focus:\s*trace/m.test(body)), 'claims are judged against the trace');
  assert.equal(llm.some(([, body]) => /runs or writes/.test(body)), false, 'the llm grader no longer decides whether the command was written');
});

function wslFixtureMatches(t, caseName, args) {
  const caseDir = path.join(SOURCE, 'evals-wsl', caseName);
  const caseYaml = path.join(caseDir, 'case.yaml');
  assert.ok(existsSync(caseYaml), `evals-wsl/${caseName} has no case.yaml with a scaffold`);
  const scaffold = /scaffold_script:\s*(\S+)/.exec(readFileSync(caseYaml, 'utf8'))?.[1];
  assert.ok(scaffold && existsSync(path.join(caseDir, scaffold)), 'the scaffold script is missing');
  if (!BASH) return t.skip('Git Bash is not installed');
  const home = mkdtempSync(path.join(os.tmpdir(), 'improve-test-home-'));
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'improve-test-workspace-'));
  homes.push(home, workspace);
  const s = spawnSync(BASH, [path.join(caseDir, scaffold)], { cwd: workspace, env: { ...process.env, HOME: home }, encoding: 'utf8' });
  assert.equal(s.status, 0, s.stderr);
  const text = run(home, 'suggest.mjs', [...args, '--no-doctor', '--no-validate']);
  const json = run(home, 'suggest.mjs', [...args, '--no-doctor', '--no-validate', '--json']);
  assert.equal(text.code, 0, text.out);
  const graders = readdirSync(path.join(caseDir, 'graders')).map((g) => [g, readFileSync(path.join(caseDir, 'graders', g), 'utf8')]);
  const fileGraders = graders.filter(([, body]) => /^\s+source:\s*file\s*$/m.test(body));
  assert.ok(fileGraders.length >= 2, 'the case grades the saved output file');
  for (const [g, body] of fileGraders) {
    const pattern = new RegExp(/^pattern:\s*'(.*)'\s*$/m.exec(body)[1].replace(/''/g, "'"));
    assert.match(text.out, pattern, `${g} does not match the text output`);
    assert.match(json.out, pattern, `${g} does not match the --json output`);
  }
  return graders;
}

test('evals-wsl run-bare-name checks that suggest.mjs --target actually ran and returned the fixture skill', (t) => {
  const graders = wslFixtureMatches(t, 'run-bare-name', ['--target', 'fixture-alpha']);
  if (!graders) return;
  const ran = graders.find(([, body]) => /^type:\s*tool_used/m.test(body) && /^tool:\s*Bash/m.test(body) && /--target/.test(body) && !/max:\s*0/.test(body));
  assert.ok(ran, 'a tool_used grader proves the Bash call with --target');
});

test('snapshot revert after a measured round keeps the eval results it was told to leave out', () => {
  const { home, root } = fakeHome();
  const plugin = pluginWithCase(root);
  const snap = label('results');
  assert.equal(run(home, 'snapshot.mjs', ['start', snap, 'skills/alpha', '--exclude', 'skills/alpha/evals/results']).code, 0);
  measured(home, plugin, 'before-r', ['evals/c1']);
  writeFileSync(path.join(plugin, 'SKILL.md'), 'experiment\n');
  const m = run(home, 'snapshot.mjs', ['mark', snap]);
  assert.doesNotMatch(m.out, /evals\/results/, m.out);
  const r = run(home, 'snapshot.mjs', ['revert', snap]);
  assert.equal(r.code, 0, r.out);
  assert.ok(existsSync(path.join(plugin, 'evals', 'results', 'before-r.json')), 'the recorded baseline survives revert');
  assert.equal(readFileSync(path.join(plugin, 'SKILL.md'), 'utf8'), '---\nname: alpha\n---\n');
});

test('snapshot started without --exclude still keeps every eval result a freeze declared, before and after mark', () => {
  const { home, root } = fakeHome();
  const plugin = pluginWithCase(root);
  mkdirSync(path.join(plugin, 'evals', 'results'), { recursive: true });
  writeFileSync(path.join(plugin, 'evals', 'results', 'old-run.json'), '{"older":"paid run"}\n');
  const snap = label('noexclude');
  assert.equal(run(home, 'snapshot.mjs', ['start', snap, 'skills/alpha']).code, 0);
  measured(home, plugin, 'before-x', ['evals/c1']);
  writeFileSync(path.join(plugin, 'SKILL.md'), '---\nname: alpha\n---\nexperiment\n');
  const m = run(home, 'snapshot.mjs', ['mark', snap]);
  assert.doesNotMatch(m.out, /evals\/results/, m.out);
  assert.match(m.out, /marked 1 file\(s\)/, m.out);
  measured(home, plugin, 'after-x', ['evals/c1']);
  const c = run(home, 'compare.mjs', ['alpha', '--before', 'before-x', '--after', 'after-x', '--snapshot', snap]);
  assert.match(c.out, /verdict: comparable/, c.out);
  const r = run(home, 'snapshot.mjs', ['revert', snap]);
  assert.equal(r.code, 0, r.out);
  const kept = readdirSync(path.join(plugin, 'evals', 'results')).sort();
  for (const f of ['old-run.json', 'before-x.json', 'after-x.json']) assert.ok(kept.includes(f), `${f} was deleted by revert: ${kept.join(',')}`);
  assert.equal(kept.filter((f) => /^\d{4}-/.test(f)).length, 2, `the two raw run folders were deleted: ${kept.join(',')}`);
  assert.equal(readFileSync(path.join(plugin, 'SKILL.md'), 'utf8'), '---\nname: alpha\n---\n');
});

test('the Bash input_match graders read only the command field, not the description beside it', () => {
  const inputMatch = (file) => new RegExp(/^input_match:\s*'(.*)'\s*$/m.exec(readFileSync(path.join(SOURCE, file), 'utf8'))[1].replace(/''/g, "'"));
  const input = (command, description) => JSON.stringify({ command, description });
  const untargeted = inputMatch('evals/run-bare-name/graders/no-untargeted-run.md');
  for (const call of [
    input('node C:/x/scripts/suggest.mjs --days 7', 'Run suggest.mjs'),
    input('node C:/x/scripts/suggest.mjs', 'Run suggest.mjs --target eli5'),
    input('node "C:/x/scripts/suggest.mjs" --top 5', 'Run it'),
  ])
    assert.match(call, untargeted);
  for (const call of [
    input('node C:/Users/x/.claude/skills/improve/scripts/suggest.mjs --target eli5', 'Run suggest.mjs with eli5 target'),
    input('node "C:/x/scripts/suggest.mjs" --target "eli5" --session', 'Run suggest.mjs'),
    input('ls skills/eli5', 'List suggest.mjs inputs'),
  ])
    assert.doesNotMatch(call, untargeted);
  const ran = inputMatch('evals-wsl/run-bare-name/graders/ran-target.md');
  for (const call of [
    input('node ~/.claude/skills/improve/scripts/suggest.mjs --target fixture-alpha > improve-output.txt', 'Run suggest.mjs'),
    input('node "$HOME/.claude/skills/improve/scripts/suggest.mjs" --target fixture-alpha', 'Run it'),
  ])
    assert.match(call, ran);
  assert.doesNotMatch(input('node x/suggest.mjs --days 7', 'Run suggest.mjs --target fixture-alpha'), ran);
});

const DAY = 86400000;
const threeOf = (score) => [runOf(score), runOf(score), runOf(score)];
function settingsHome(settings = {}) {
  const { home, root } = fakeHome();
  writeFileSync(path.join(root, 'settings.json'), JSON.stringify(settings));
  return { home, root, plugin: path.join(root, 'skills', 'alpha') };
}
const withSuite = (j, extra) => ({ ...j, suite: { ...j.suite, ...extra } });

test('compare refuses runs whose native models differ even when the runner declared the same model for both', () => {
  const { home } = fakeHome();
  const c = [caseOf('c1', threeOf(1))];
  const dir = results(path.join(home, 'r'), {
    before: withSuite(full(home, '2026-01-01T00:00:00Z', c, { model: 'claude-opus-5-5' }), { modelOverride: 'claude-opus-5-5' }),
    after: withSuite(full(home, '2026-01-02T00:00:00Z', c, { model: 'claude-opus-5-5' }), { modelOverride: 'claude-haiku-5-5' }),
  });
  const r = run(home, 'compare.mjs', [dir, '--before', 'before', '--after', 'after']);
  assert.doesNotMatch(r.out, /verdict: comparable/, r.out);
  assert.match(r.out, /claude-haiku-5-5/);
  assert.notEqual(r.code, 0);
});

test('compare reads a case model when no --model was passed, and --model overrides every case model', () => {
  const { home } = fakeHome();
  const caseWith = (model) => [caseOf('c1', threeOf(1), [], { model })];
  const noOverride = (startedAt, model) => withSuite(full(home, startedAt, caseWith(model), { model: 'claude-opus-5-5' }), { modelOverride: undefined });
  const differ = results(path.join(home, 'differ'), { before: noOverride('2026-01-01T00:00:00Z', 'claude-opus-5-5'), after: noOverride('2026-01-02T00:00:00Z', 'claude-haiku-5-5') });
  const d = run(home, 'compare.mjs', [differ, '--before', 'before', '--after', 'after']);
  assert.doesNotMatch(d.out, /verdict: comparable/, d.out);
  const overridden = (startedAt, model) => withSuite(full(home, startedAt, caseWith(model), { model: 'claude-opus-5-5' }), { modelOverride: 'claude-opus-5-5' });
  const same = results(path.join(home, 'same'), { before: overridden('2026-01-01T00:00:00Z', 'claude-haiku-5-5'), after: overridden('2026-01-02T00:00:00Z', 'claude-opus-5-5') });
  const s = run(home, 'compare.mjs', [same, '--before', 'before', '--after', 'after']);
  assert.match(s.out, /verdict: comparable/, s.out);
});

test('compare does not accept a model that only the runner declared', () => {
  const { home } = fakeHome();
  const c = [caseOf('c1', threeOf(1))];
  const dir = results(path.join(home, 'r'), {
    before: withSuite(full(home, '2026-01-01T00:00:00Z', c), { modelOverride: undefined }),
    after: withSuite(full(home, '2026-01-02T00:00:00Z', c), { modelOverride: undefined }),
  });
  const r = run(home, 'compare.mjs', [dir, '--before', 'before', '--after', 'after']);
  assert.match(r.out, /verdict: INSUFFICIENT EVIDENCE/, r.out);
  assert.equal(r.code, 3);
});

test('record refuses a declared model that the eval result contradicts and writes nothing', () => {
  const { home, root } = fakeHome();
  const plugin = path.join(root, 'skills', 'alpha');
  mkdirSync(path.join(plugin, 'evals', 'c1'), { recursive: true });
  writeFileSync(path.join(plugin, 'evals', 'c1', 'prompt.md'), 'hi\n');
  assert.equal(run(home, 'record.mjs', ['alpha', 'haiku-run', '--freeze']).code, 0);
  const runDir = fakeRunOf(plugin, ['evals/c1']);
  const agg = path.join(runDir, 'aggregate-result.json');
  writeFileSync(agg, JSON.stringify(withSuite(JSON.parse(readFileSync(agg, 'utf8')), { modelOverride: 'claude-haiku-5-5' })));
  const r = run(home, 'record.mjs', ['alpha', 'haiku-run', '--model', 'claude-opus-5-5']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /claude-haiku-5-5/);
  assert.equal(existsSync(path.join(plugin, 'evals', 'results', 'haiku-run.json')), false);
  const ok = run(home, 'record.mjs', ['alpha', 'haiku-run', '--model', 'claude-haiku-5-5']);
  assert.equal(ok.code, 0, ok.out);
});

test('the guide and record.mjs no longer say the eval result does not store the model', () => {
  const text = `${readFileSync(path.join(SOURCE, 'steps', 'run.md'), 'utf8')}\n${readFileSync(path.join(SOURCE, 'scripts', 'record.mjs'), 'utf8')}`;
  assert.doesNotMatch(text, /does not store the model/);
  assert.match(readFileSync(path.join(SOURCE, 'steps', 'run.md'), 'utf8'), /modelOverride/);
});

test('compare blocks runs whose paid graders were skipped in either arm, even when the run is not partial', () => {
  const { home } = fakeHome();
  const graders = [{ name: 'g', type: 'regex', weight: 1, config: {} }, { name: 'judge', type: 'llm', weight: 1, config: {} }];
  const skippedRun = (score) => ({ ...runOf(score), skippedPaidGraders: true });
  const clean = caseOf('c1', threeOf(1), threeOf(0), { graders });
  const withSkip = caseOf('c1', [skippedRun(1), runOf(1), runOf(1)], [skippedRun(0), runOf(0), runOf(0)], { graders, aggregates: { score: 1, scoreWithout: 0, delta: null } });
  const onlyWithout = caseOf('c1', threeOf(1), [skippedRun(0), runOf(0), runOf(0)], { graders });
  for (const [name, after] of [['both arms', withSkip], ['without arm only', onlyWithout]]) {
    const dir = results(path.join(home, name), {
      before: full(home, '2026-01-01T00:00:00Z', [clean]),
      after: full(home, '2026-01-02T00:00:00Z', [after], {}, { partial: false }),
    });
    const r = run(home, 'compare.mjs', [dir, '--before', 'before', '--after', 'after']);
    assert.doesNotMatch(r.out, /verdict: comparable/, `${name}: ${r.out}`);
    assert.match(r.out, /skipped/, name);
    assert.equal(r.code, 2, name);
  }
  const both = run(home, 'compare.mjs', [path.join(home, 'both arms'), '--before', 'before', '--after', 'after']);
  assert.match(both.out, /2 judgement\(s\) not made/, both.out);
});

test('compare keeps the delta the eval result marked unavailable instead of recomputing it', () => {
  const { home } = fakeHome();
  const c = (agg) => [caseOf('c1', threeOf(1), threeOf(0.5), { aggregates: agg })];
  const dir = results(path.join(home, 'r'), {
    before: full(home, '2026-01-01T00:00:00Z', c({ score: 1, scoreWithout: 0.5, delta: 0.5 })),
    after: full(home, '2026-01-02T00:00:00Z', c({ score: 1, scoreWithout: 0.5, delta: null })),
  });
  const r = run(home, 'compare.mjs', [dir, '--before', 'before', '--after', 'after']);
  assert.match(r.out, /c1\s+1\.00\s+1\.00\s+-\s/, r.out);
  assert.doesNotMatch(r.out, /\+0\.50/);
});

function suggestHome({ partial = false, skipped = false, settings = {} } = {}) {
  const { home, root, plugin } = settingsHome(settings);
  const judged = skipped ? [{ ...runOf(0), skippedPaidGraders: true }, runOf(0), runOf(0)] : threeOf(0);
  results(path.join(plugin, 'evals', 'results'), { latest: full(plugin, new Date(Date.now() - DAY).toISOString(), [caseOf('c1', threeOf(1), judged, { graders: [{ name: 'judge', type: 'llm', weight: 1, config: {} }] })], {}, { partial }) });
  transcript(root, 'quiet', [say('hello')]);
  gitRepo(root);
  return { home, root };
}
const suggestJson = (home, args = []) => {
  const r = run(home, 'suggest.mjs', ['--no-doctor', '--no-validate', '--json', ...args]);
  assert.equal(r.code, 0, r.out);
  return JSON.parse(r.out);
};

test('suggest reports a partial eval as unfinished evidence, with a clean control', () => {
  const clean = suggestJson(suggestHome().home);
  assert.equal(clean.evidence_complete, true, JSON.stringify(clean.collectors));
  for (const [name, gap] of [['partial', /partial run/], ['skipped', /1 paid judgement\(s\) skipped/]]) {
    const out = suggestJson(suggestHome({ [name]: true }).home);
    assert.equal(out.evidence_complete, false, name);
    assert.equal(out.collectors.find((c) => c.name === 'eval results').status, 'partial', name);
    assert.ok(out.items.some((x) => x.target === 'alpha' && x.reasons.some((r) => gap.test(r))), `${name}: ${JSON.stringify(out.items)}`);
  }
});

test('suggest --target keeps the target signals that the global list grouped with other candidates', () => {
  const { home } = suggestHome({ settings: { skillOverrides: { alpha: 'off', eli5: 'off' } } });
  const global = suggestJson(home);
  for (const [name, pattern] of [['alpha', /off in skillOverrides/], ['eli5', /off in skillOverrides/]]) {
    assert.ok(global.items.some((x) => x.reasons.some((r) => pattern.test(r) && r.includes(name))), `global list lost ${name}`);
    const target = suggestJson(home, ['--target', name]);
    assert.ok(target.items.some((x) => x.target === name && x.reasons.some((r) => pattern.test(r))), `--target ${name} lost its signal: ${JSON.stringify(target.items)}`);
    assert.deepEqual([...new Set(target.items.map((x) => x.target))], [name]);
  }
});

test('snapshot keep refuses to print a commit plan while other files are staged, and leaves the index alone', () => {
  const { home, root } = fakeHome();
  gitRepo(root);
  writeFileSync(path.join(root, 'skills', 'eli5', 'SKILL.md'), 'user staged change\n');
  git(root, 'add', 'skills/eli5/SKILL.md');
  const snap = label('otherstaged');
  run(home, 'snapshot.mjs', ['start', snap, 'skills/alpha']);
  writeFileSync(path.join(root, 'skills', 'alpha', 'SKILL.md'), 'experiment\n');
  run(home, 'snapshot.mjs', ['mark', snap]);
  const index = git(root, 'diff', '--cached');
  const k = run(home, 'snapshot.mjs', ['keep', snap]);
  assert.equal(k.code, 1, k.out);
  assert.match(k.out, /skills\/eli5\/SKILL\.md/);
  assert.doesNotMatch(k.out, /add -- |apply --cached|plain `git commit`/);
  assert.equal(git(root, 'diff', '--cached'), index);
  git(root, 'restore', '--staged', 'skills/eli5/SKILL.md');
  const ok = run(home, 'snapshot.mjs', ['keep', snap]);
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /add -- "skills\/alpha\/SKILL\.md"/);
});

test('a snapshot started in one profile refuses to write in another, before touching any file', () => {
  const a = fakeHome();
  const b = fakeHome();
  const fileA = path.join(a.root, 'skills', 'alpha', 'SKILL.md');
  const fileB = path.join(b.root, 'skills', 'alpha', 'SKILL.md');
  writeFileSync(fileA, 'profile A original\n');
  const snap = label('profiles');
  assert.equal(run(a.home, 'snapshot.mjs', ['start', snap, 'skills/alpha']).code, 0);
  writeFileSync(fileA, 'experiment\n');
  assert.equal(run(a.home, 'snapshot.mjs', ['mark', snap]).code, 0);
  writeFileSync(fileB, 'experiment\n');
  const manifest = readFileSync(path.join(WORKING, 'snapshots', snap, 'manifest.json'), 'utf8');
  for (const cmd of ['revert', 'mark', 'keep', 'drop']) {
    const r = run(b.home, 'snapshot.mjs', [cmd, snap]);
    assert.notEqual(r.code, 0, `${cmd} ran in profile B: ${r.out}`);
    assert.match(r.out, /belongs to/, cmd);
  }
  assert.equal(readFileSync(fileB, 'utf8'), 'experiment\n', 'profile A data was restored into profile B');
  assert.equal(readFileSync(fileA, 'utf8'), 'experiment\n');
  assert.equal(readFileSync(path.join(WORKING, 'snapshots', snap, 'manifest.json'), 'utf8'), manifest);
  assert.equal(run(a.home, 'snapshot.mjs', ['revert', snap]).code, 0);
  assert.equal(readFileSync(fileA, 'utf8'), 'profile A original\n');
});

test('the tick list layout stays valid for 0, 1, 2, 5 and 16 candidates', async () => {
  const { askLayout } = await import(pathToFileURL(path.join(SCRIPTS, 'common.mjs')).href);
  const items = (n) => Array.from({ length: n }, (_, i) => ({ rank: i + 1, target: `t${i + 1}` }));
  assert.deepEqual(askLayout(items(0)).questions, []);
  const one = askLayout(items(1)).questions;
  assert.equal(one.length, 1);
  assert.equal(one[0].multiSelect, false);
  assert.deepEqual(one[0].options, ['run', 'skip']);
  assert.deepEqual(askLayout(items(2)).questions.map((q) => q.ranks.length), [2]);
  assert.deepEqual(askLayout(items(5)).questions.map((q) => q.ranks.length), [3, 2]);
  assert.deepEqual(askLayout(items(16)).questions.map((q) => q.ranks.length), [4, 4, 4, 4]);
  assert.equal(askLayout(items(17)).leftOut, 1);
  for (const n of [2, 5, 13, 16]) {
    const qs = askLayout(items(n)).questions;
    assert.ok(qs.length <= 4 && qs.every((q) => q.multiSelect && q.ranks.length >= 2 && q.ranks.length <= 4 && q.header.length <= 12), `${n}: ${JSON.stringify(qs)}`);
    assert.deepEqual(qs.flatMap((q) => q.ranks), items(n).map((x) => x.rank));
  }
});

test('suggest lays out a single candidate as one run-or-skip question', () => {
  const { home, root } = fakeHome();
  transcript(root, 'g9', [useTool('k1', 'Skill', { skill: 'alpha' }), result('k1'), useTool('b1', 'Bash', { command: 'x' }), result('b1', true)]);
  const out = suggestJson(home, ['--top', '1']);
  assert.equal(out.items.length, 1);
  assert.equal(out.ask.questions.length, 1);
  assert.equal(out.ask.questions[0].multiSelect, false);
  assert.match(run(home, 'suggest.mjs', ['--no-doctor', '--no-validate', '--top', '1']).out, /^ask: .*single-select/m);
});

test('the comparable verdict is required only for measured rounds, and config and cleanup rounds close without a skill score', () => {
  const skill = readFileSync(path.join(SOURCE, 'SKILL.md'), 'utf8');
  const steps = readFileSync(path.join(SOURCE, 'steps', 'run.md'), 'utf8');
  assert.match(skill, /measured `loop` round[^\n]*verdict: comparable/);
  assert.match(skill, /single-select/);
  for (const name of ['cleanup', 'config']) {
    const section = steps.split(`\n## ${name}\n`)[1].split('\n## ')[0];
    assert.match(section, /snapshot\.mjs start/, `${name}: no snapshot`);
    assert.match(section, /plugin validate/, `${name}: no check`);
    assert.match(section, /keep or revert/, `${name}: no user decision`);
    assert.match(section, /Done when/, `${name}: no end condition`);
    assert.match(section, /never [^\n]*skill score/i, `${name}: may cite a skill score`);
  }
});

function pluginWithTwoCases(root) {
  const plugin = pluginWithCase(root);
  mkdirSync(path.join(plugin, 'evals', 'c2', 'graders'), { recursive: true });
  mkdirSync(path.join(plugin, 'evals', 'mocks'), { recursive: true });
  writeFileSync(path.join(plugin, 'evals', 'c2', 'prompt.md'), '---\nname: c2\n---\n\nother\n');
  writeFileSync(path.join(plugin, 'evals', 'c2', 'graders', 'g.md'), '---\ntype: regex\npattern: x\n---\n');
  writeFileSync(path.join(plugin, 'evals', 'mocks', 'api.json'), '{"answer":"hard"}\n');
  return plugin;
}

test('a run filtered to one case compares with a full run and with itself after another case changed, but a changed shared file still blocks', () => {
  const { home, root } = fakeHome();
  const plugin = pluginWithTwoCases(root);
  measured(home, plugin, 'one', ['evals/c1']);
  measured(home, plugin, 'all', ['evals/c1', 'evals/c2']);
  writeFileSync(path.join(plugin, 'evals', 'c2', 'graders', 'g.md'), '---\ntype: regex\npattern: y\n---\n');
  measured(home, plugin, 'one-again', ['evals/c1']);
  for (const [before, after] of [['one', 'all'], ['one', 'one-again'], ['all', 'one-again']]) {
    const r = run(home, 'compare.mjs', ['alpha', '--before', before, '--after', after]);
    assert.doesNotMatch(r.out, /shared eval files changed/, `${before} -> ${after}: ${r.out}`);
    assert.match(r.out, /verdict: comparable/, `${before} -> ${after}: ${r.out}`);
  }
  writeFileSync(path.join(plugin, 'evals', 'mocks', 'api.json'), '{"answer":"easy"}\n');
  measured(home, plugin, 'one-mock', ['evals/c1']);
  const r = run(home, 'compare.mjs', ['alpha', '--before', 'one-again', '--after', 'one-mock']);
  assert.match(r.out, /shared eval files changed/);
  assert.match(r.out, /verdict: NOT COMPARABLE/);
});

test('compare judges shared files from the recorded file list, so an older one-case record still compares with a full run', () => {
  const files = (edit = {}) => ({
    'SKILL.md': 'h0',
    'evals/c1/prompt.md': 'p1',
    'evals/c1/graders/g.md': 'g1',
    'evals/c2/prompt.md': 'p2',
    'evals/c2/graders/g.md': 'g2',
    'evals/c3/case.yaml': 'y3',
    'evals/mocks/prompt.md': 'pm',
    'evals/mocks/api.json': 'm1',
    ...edit,
  });
  const variants = {
    'other case grader edited': [{ 'evals/c2/graders/g.md': 'g2b' }, true],
    'other case.yaml edited': [{ 'evals/c3/case.yaml': 'y3b' }, true],
    'shared mock edited': [{ 'evals/mocks/api.json': 'm2' }, false],
    'shared prompt.md without graders edited': [{ 'evals/mocks/prompt.md': 'pm2' }, false],
  };
  for (const [name, [edit, comparable]] of Object.entries(variants)) {
    const { home, plugin } = settingsHome();
    results(path.join(plugin, 'evals', 'results'), {
      one: full(plugin, '2026-01-01T00:00:00Z', [caseOf('c1', threeOf(0.5), threeOf(0))], { evalDir: 'evals', files: files(), contract: { shared: 'with-c2-c3', cases: { c1: 'k1' } } }),
      all: full(plugin, '2026-01-02T00:00:00Z', [caseOf('c1', threeOf(1), threeOf(0)), caseOf('c2', threeOf(1), threeOf(0))], { evalDir: 'evals', files: files(edit), contract: { shared: 'with-c3', cases: { c1: 'k1', c2: 'k2' } } }),
    });
    const verdict = run(home, 'compare.mjs', ['alpha', '--before', 'one', '--after', 'all']);
    assert.equal(/shared eval files changed/.test(verdict.out), !comparable, `${name}: ${verdict.out}`);
    assert.equal(/verdict: comparable/.test(verdict.out), comparable, `${name}: ${verdict.out}`);
  }
});
