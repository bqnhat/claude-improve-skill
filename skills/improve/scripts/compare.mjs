import { existsSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { caseFingerprint, caseStats, inside, mean, runConfig, snapshotDir } from './common.mjs';

const ROOT = path.join(os.homedir(), '.claude');
const argv = process.argv.slice(2);
const VALUED = ['--before', '--after', '--threshold', '--snapshot'];
const option = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
};
const target = argv.find((a, i) => !a.startsWith('--') && !VALUED.includes(argv[i - 1]));
if (!target) {
  console.error('usage: compare.mjs <skill name | skill dir | results dir> [--before <label>] [--after <label>] [--snapshot <label>] [--list] [--threshold 1]');
  process.exit(1);
}

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};
const fmt = (x) => (x == null ? '-' : x.toFixed(2));
const signed = (x) => (x == null ? '-' : `${x >= 0 ? '+' : ''}${x.toFixed(2)}`);
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T/;

function resultsDir(t) {
  const candidates = [t, path.join(t, 'evals', 'results'), path.join(ROOT, 'skills', t, 'evals', 'results'), path.join(ROOT, 'evals', t, 'results')];
  return candidates.find((d) => existsSync(d) && (path.basename(d) === 'results' || existsSync(path.join(d, 'aggregate-result.json')) || readdirSync(d).some((f) => f.endsWith('.json'))));
}

function loadRuns(dir) {
  const byStart = new Map();
  const add = (file, label) => {
    const j = readJson(file);
    if (!j?.startedAt || !Array.isArray(j.cases)) return;
    const prev = byStart.get(j.startedAt);
    if (!prev || (label && prev.generated) || (label && j.recorded && !prev.j.recorded)) byStart.set(j.startedAt, { j, label: label || j.startedAt.slice(0, 16).replace('T', ' '), generated: !label });
  };
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) add(path.join(dir, e.name, 'aggregate-result.json'), TIMESTAMP.test(e.name) ? null : e.name);
    else if (e.name.endsWith('.json')) add(path.join(dir, e.name), e.name.replace(/\.json$/, ''));
  }
  return [...byStart.values()].sort((a, b) => a.j.startedAt.localeCompare(b.j.startedAt));
}

function summarize({ j, label }) {
  const cases = new Map();
  for (const c of j.cases) {
    const failed = new Set();
    for (const r of c.arms?.with || []) for (const g of r.graders || []) if (g.scored !== false && g.passed === false) failed.add(g.name);
    cases.set(c.name, { ...caseStats(c), fp: caseFingerprint(c), failed: [...failed] });
  }
  const all = [...cases.values()];
  return {
    label,
    startedAt: j.startedAt,
    cost: j.costUsd ?? 0,
    duration: j.durationSeconds ?? null,
    partial: Boolean(j.partial),
    config: runConfig(j),
    recorded: j.recorded || null,
    plugins: (j.suite?.plugins || []).map((p) => p.path).concat(j.suite?.root ? [j.suite.root] : []),
    errors: all.reduce((n, c) => n + c.errors, 0),
    errorsWithout: all.reduce((n, c) => n + c.errorsWithout, 0),
    runs: all.reduce((n, c) => n + c.runs, 0),
    runsWithout: all.reduce((n, c) => n + c.runsWithout, 0),
    threshold: j.suite?.threshold,
    cases,
  };
}

const dir = resultsDir(target);
if (!dir) {
  console.error(`no eval results found for ${target}`);
  process.exit(1);
}
const runs = loadRuns(dir);
if (argv.includes('--list')) {
  for (const r of runs) console.log(`${r.label}\t${r.j.startedAt.slice(0, 16)}\tcases ${r.j.cases.length}\t$${(r.j.costUsd ?? 0).toFixed(2)}\t${r.j.recorded?.model ? `model ${r.j.recorded.model}` : 'model not recorded'}`);
  process.exit(0);
}
const pick = (label, fallback) => (label ? runs.find((r) => r.label === label) : fallback);
const after = pick(option('--after'), runs.at(-1));
const before = pick(option('--before'), after ? runs[runs.indexOf(after) - 1] : null);
if (!after) {
  console.error(`run not found: ${option('--after') || '(none stored)'}`);
  process.exit(1);
}
if (option('--before') && !before) {
  console.error(`run not found: ${option('--before')}`);
  process.exit(1);
}
const A = summarize(after);
const B = before ? summarize(before) : null;
const THRESHOLD = Number(option('--threshold') ?? A.threshold ?? 1);

const blocking = [];
const warnings = [];

const head = (s) =>
  s
    ? `${s.label} (${s.startedAt.slice(0, 16).replace('T', ' ')}, model ${s.config.model || 'not recorded'}, judge ${s.config.judgeModel || '-'}, cli ${s.config.claudeVersion || '-'}, $${s.cost.toFixed(2)}, ${s.duration ?? '-'}s${s.partial ? ', partial' : ''})`
    : '(no earlier run)';
console.log(`${path.relative(ROOT, dir) || dir}`);
console.log(`before: ${head(B)}`);
console.log(`after:  ${head(A)}`);

const names = [...new Set([...(B ? B.cases.keys() : []), ...A.cases.keys()])].sort();
const width = Math.max(4, ...names.map((n) => n.length));
console.log(`\n${'case'.padEnd(width)}  before  after  lift   errors(w/wo)  change`);
const flips = [];
const comparable = [];
for (const n of names) {
  const b = B?.cases.get(n);
  const a = A.cases.get(n);
  const lift = a && !a.inconclusive && a.withScore != null && a.withoutScore != null ? a.withScore - a.withoutScore : null;
  let change = '';
  if (!b) change = 'new';
  else if (!a) change = 'not run';
  else if (a.fp !== b.fp) change = 'case changed';
  else if (a.inconclusive || b.inconclusive) change = 'inconclusive (run errors)';
  else {
    const was = b.withScore >= THRESHOLD;
    const now = a.withScore >= THRESHOLD;
    change = was && !now ? 'PASS->FAIL' : !was && now ? 'FAIL->PASS' : a.withScore > b.withScore ? 'up' : a.withScore < b.withScore ? 'down' : 'same';
    if (was !== now) flips.push(n);
    comparable.push(n);
  }
  const errs = a ? `${a.errors}/${a.errorsWithout}` : '-';
  console.log(`${n.padEnd(width)}  ${fmt(b?.withScore).padStart(6)}  ${fmt(a?.withScore).padStart(5)}  ${signed(lift).padStart(5)}  ${errs.padStart(12)}  ${change}`);
}

const m = (s) => mean(comparable.map((n) => s.cases.get(n).withScore));
if (B) console.log(`\nmean over ${comparable.length} comparable case(s): ${comparable.length ? `${fmt(m(B))} -> ${fmt(m(A))} (${signed(m(A) - m(B))})` : '-'}`);
const liftCases = [...A.cases.values()].filter((c) => c.withScore != null && c.withoutScore != null);
const cleanLift = liftCases.filter((c) => !c.inconclusive);
const liftAll = mean(cleanLift.map((c) => c.withScore - c.withoutScore));
const leftOut = liftCases.length - cleanLift.length;
console.log(`lift vs no-skill (after): ${!liftCases.length ? 'not measured (single arm)' : liftAll == null ? 'not measured (every case has run errors)' : `${signed(liftAll)} over ${cleanLift.length} case(s)`}${leftOut ? `; ${leftOut} case(s) left out for run errors` : ''}`);
console.log(`run errors (after): with skill ${A.errors}/${A.runs}, without skill ${A.errorsWithout}/${A.runsWithout}`);
if (B) console.log(`run errors (before): with skill ${B.errors}/${B.runs}, without skill ${B.errorsWithout}/${B.runsWithout}`);
const perCase = [...new Set([...A.cases.values()].map((c) => c.runs))];
console.log(`runs per case (after): ${perCase.join('/')}${perCase.some((r) => r < 3) ? '  <- below 3, confirm before deciding' : ''}`);
if (flips.length) console.log(`flipped: ${flips.join(', ')}`);

const failing = [...A.cases.entries()].filter(([, c]) => c.failed.length || c.errors || c.errorsWithout);
if (failing.length) {
  console.log('\nfailed graders (after):');
  for (const [n, c] of failing) {
    const errs = [c.errors ? `${c.errors} run error(s) with skill` : '', c.errorsWithout ? `${c.errorsWithout} run error(s) without skill` : ''].filter(Boolean);
    console.log(`  ${n}: ${[...c.failed, ...errs].join(', ')}`);
  }
}

for (const s of [B, A].filter(Boolean)) {
  if (s.errors || s.errorsWithout) blocking.push(`${s.label}: ${s.errors} run error(s) with skill, ${s.errorsWithout} without; those cases are inconclusive, re-run them`);
  if (s.partial) blocking.push(`${s.label}: partial run (cost ceiling hit)`);
  if (!s.config.model) warnings.push(`${s.label}: model under test not recorded; save runs with record.mjs --model <id>`);
  for (const f of s.recorded?.modifiedAfterStart || []) blocking.push(`${s.label}: ${f} changed after the run started; the run may have used other content`);
}
if (B) {
  for (const key of Object.keys(A.config)) {
    if (A.config[key] != null && B.config[key] != null && A.config[key] !== B.config[key]) blocking.push(`${key} differs: ${B.config[key]} -> ${A.config[key]}`);
  }
  const changed = names.filter((n) => B.cases.has(n) && A.cases.has(n) && B.cases.get(n).fp !== A.cases.get(n).fp);
  if (changed.length) blocking.push(`case or grader definition changed: ${changed.join(', ')}; re-run the baseline with the new cases`);
  if (B.cases.size !== A.cases.size || names.some((n) => !B.cases.has(n) || !A.cases.has(n))) warnings.push('the case set changed between runs; only common cases are compared');
}
if (perCase.some((r) => r < 3)) warnings.push('fewer than 3 runs per case');

const snapLabel = option('--snapshot');
if (snapLabel) {
  const manifest = readJson(path.join(snapshotDir(snapLabel), 'manifest.json'));
  if (!manifest) blocking.push(`snapshot ${snapLabel} not found`);
  for (const f of manifest?.files || []) {
    if (!f.marked) {
      blocking.push(`snapshot ${snapLabel}: ${f.path} has no marked change (run snapshot.mjs mark)`);
      continue;
    }
    if (f.marked === f.original) continue;
    const root = A.plugins.find((p) => inside(p, f.abs));
    if (!root) {
      blocking.push(`${f.path} is outside the evaluated plugin (${A.plugins[0] || '-'}): this suite does not load it, so the scores say nothing about that change`);
      continue;
    }
    const rel = inside(root, f.abs);
    const check = (s, want, what) => {
      if (!s) return;
      const got = s.recorded?.files?.[rel];
      if (!s.recorded) warnings.push(`${s.label}: not saved with record.mjs; cannot prove it evaluated the ${what} ${f.path}`);
      else if (got !== want) blocking.push(`${s.label} did not evaluate the ${what} ${f.path} (hash ${got || 'missing'}, expected ${want || 'missing'})`);
    };
    check(B, f.original, 'original');
    check(A, f.marked, 'changed');
  }
}

if (warnings.length) {
  console.log('\nwarnings:');
  for (const w of warnings) console.log(`  - ${w}`);
}
if (blocking.length) {
  console.log('\nblocking:');
  for (const b of blocking) console.log(`  - ${b}`);
}
console.log(`\nverdict: ${!B ? 'no baseline to compare' : blocking.length ? 'NOT COMPARABLE - resolve the blocking items before deciding keep or revert' : comparable.length ? 'comparable' : 'no comparable case'}`);
process.exitCode = blocking.length ? 2 : 0;
