import { existsSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.join(os.homedir(), '.claude');
const argv = process.argv.slice(2);
const option = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
};
const target = argv.find((a, i) => !a.startsWith('--') && !['--before', '--after', '--threshold'].includes(argv[i - 1]));
if (!target) {
  console.error('usage: compare.mjs <skill name | skill dir | results dir> [--before <label>] [--after <label>] [--list] [--threshold 1]');
  process.exit(1);
}
const THRESHOLD = Number(option('--threshold') ?? 1);

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const fmt = (x) => (x == null ? '-' : x.toFixed(2));
const signed = (x) => (x == null ? '-' : `${x >= 0 ? '+' : ''}${x.toFixed(2)}`);

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
    if (!prev || (label && prev.generated)) byStart.set(j.startedAt, { j, label: label || j.startedAt.slice(0, 16).replace('T', ' '), generated: !label });
  };
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) add(path.join(dir, e.name, 'aggregate-result.json'), null);
    else if (e.name.endsWith('.json')) add(path.join(dir, e.name), e.name.replace(/\.json$/, ''));
  }
  return [...byStart.values()].sort((a, b) => a.j.startedAt.localeCompare(b.j.startedAt));
}

function summarize({ j, label }) {
  const cases = new Map();
  for (const c of j.cases) {
    const score = (runs) => mean((runs || []).filter((r) => typeof r.score === 'number' && !r.error).map((r) => r.score));
    const failed = new Set();
    for (const r of c.arms?.with || []) for (const g of r.graders || []) if (g.scored !== false && g.passed === false) failed.add(g.name);
    const errors = (c.arms?.with || []).filter((r) => r.error).length;
    cases.set(c.name, { withScore: score(c.arms?.with), withoutScore: score(c.arms?.without), runs: (c.arms?.with || []).length, failed: [...failed], errors });
  }
  return { label, startedAt: j.startedAt, commit: j.gradedCommit || '-', cost: j.costUsd ?? 0, partial: Boolean(j.partial), cases };
}

const dir = resultsDir(target);
if (!dir) {
  console.error(`no eval results found for ${target}`);
  process.exit(1);
}
const runs = loadRuns(dir);
if (argv.includes('--list')) {
  for (const r of runs) console.log(`${r.label}\t${r.j.startedAt.slice(0, 16)}\tcases ${r.j.cases.length}\t$${(r.j.costUsd ?? 0).toFixed(2)}`);
  process.exit(0);
}
const pick = (label, fallback) => (label ? runs.find((r) => r.label === label) : fallback);
const after = pick(option('--after'), runs.at(-1));
const before = pick(option('--before'), runs[runs.indexOf(after) - 1]);
if (!after) {
  console.error(`run not found: ${option('--after') || '(none stored)'}`);
  process.exit(1);
}
const A = summarize(after);
const B = before ? summarize(before) : null;

const head = (s) => (s ? `${s.label} (${s.startedAt.slice(0, 16).replace('T', ' ')}, commit ${s.commit}, $${s.cost.toFixed(2)}${s.partial ? ', partial' : ''})` : '(no earlier run)');
console.log(`${path.relative(ROOT, dir) || dir}`);
console.log(`before: ${head(B)}`);
console.log(`after:  ${head(A)}`);

const names = [...new Set([...(B ? B.cases.keys() : []), ...A.cases.keys()])].sort();
const width = Math.max(4, ...names.map((n) => n.length));
console.log(`\n${'case'.padEnd(width)}  before  after  lift   change`);
const flips = [];
for (const n of names) {
  const b = B?.cases.get(n);
  const a = A.cases.get(n);
  const lift = a && a.withScore != null && a.withoutScore != null ? a.withScore - a.withoutScore : null;
  let change = '';
  if (!b) change = 'new';
  else if (!a) change = 'not run';
  else if (a.withScore == null || b.withScore == null) change = 'run error';
  else {
    const was = b.withScore >= THRESHOLD;
    const now = a.withScore >= THRESHOLD;
    change = was && !now ? 'PASS->FAIL' : !was && now ? 'FAIL->PASS' : a.withScore > b.withScore ? 'up' : a.withScore < b.withScore ? 'down' : 'same';
    if (was !== now) flips.push(n);
  }
  console.log(`${n.padEnd(width)}  ${fmt(b?.withScore).padStart(6)}  ${fmt(a?.withScore).padStart(5)}  ${signed(lift).padStart(5)}  ${change}`);
}

const common = names.filter((n) => B?.cases.get(n)?.withScore != null && A.cases.get(n)?.withScore != null);
const m = (s) => mean(common.map((n) => s.cases.get(n).withScore));
if (B && common.length) console.log(`\nmean over ${common.length} common case(s): ${fmt(m(B))} -> ${fmt(m(A))} (${signed(m(A) - m(B))})`);
const liftAll = mean([...A.cases.values()].filter((c) => c.withScore != null && c.withoutScore != null).map((c) => c.withScore - c.withoutScore));
console.log(`lift vs no-skill (after): ${liftAll == null ? 'not measured (single arm)' : signed(liftAll)}`);
console.log(`runs per case (after): ${[...new Set([...A.cases.values()].map((c) => c.runs))].join('/')}${[...A.cases.values()].some((c) => c.runs < 3) ? '  <- below 3, confirm before deciding' : ''}`);
if (flips.length) console.log(`flipped: ${flips.join(', ')}`);

const failing = [...A.cases.entries()].filter(([, c]) => c.failed.length || c.errors);
if (failing.length) {
  console.log('\nfailed graders (after):');
  for (const [n, c] of failing) console.log(`  ${n}: ${[...c.failed, ...(c.errors ? [`${c.errors} run error(s)`] : [])].join(', ')}`);
}
if (B && (B.cases.size !== A.cases.size || names.some((n) => !B.cases.has(n) || !A.cases.has(n)))) {
  console.log('\nnote: the case set changed between runs; compare only the common cases, or re-run the baseline.');
}
