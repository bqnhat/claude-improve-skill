import { existsSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { caseFingerprint, caseStats, inside, mean, modelCheck, resultProblem, runConfig, runProblems, sharedContract, snapshotDir, under } from './common.mjs';

const ROOT = path.join(os.homedir(), '.claude');
const argv = process.argv.slice(2);
const VALUED = ['--before', '--after', '--threshold', '--snapshot'];
const option = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
};
const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};
const target = argv.find((a, i) => !a.startsWith('--') && !VALUED.includes(argv[i - 1]));
if (!target) fail('usage: compare.mjs <skill name | skill dir | results dir> [--before <label>] [--after <label>] [--snapshot <label>] [--list] [--threshold 0..1]');
let thresholdOption = null;
if (argv.includes('--threshold')) {
  thresholdOption = Number(option('--threshold'));
  if (option('--threshold') == null || !Number.isFinite(thresholdOption) || thresholdOption < 0 || thresholdOption > 1) fail(`--threshold must be a number from 0 to 1, got ${JSON.stringify(option('--threshold'))}`);
}

const readJson = (file) => {
  try {
    return { j: JSON.parse(readFileSync(file, 'utf8')) };
  } catch (e) {
    return { error: e.message };
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
  const broken = [];
  const add = (file, label) => {
    const { j, error } = readJson(file);
    const problem = error ? `unreadable: ${error}` : resultProblem(j) ? `invalid: ${resultProblem(j)}` : null;
    if (problem) {
      broken.push({ file: path.basename(path.dirname(file)) === path.basename(dir) ? path.basename(file) : path.relative(dir, file), label, problem });
      return;
    }
    const prev = byStart.get(j.startedAt);
    if (!prev || (label && prev.generated) || (label && j.recorded && !prev.j.recorded)) byStart.set(j.startedAt, { j, label: label || j.startedAt.slice(0, 16).replace('T', ' '), generated: !label });
  };
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      const f = path.join(dir, e.name, 'aggregate-result.json');
      if (existsSync(f)) add(f, TIMESTAMP.test(e.name) ? null : e.name);
    } else if (e.name.endsWith('.json')) add(path.join(dir, e.name), e.name.replace(/\.json$/, ''));
  }
  return { runs: [...byStart.values()].sort((a, b) => a.j.startedAt.localeCompare(b.j.startedAt)), broken };
}

function summarize({ j, label }) {
  const cases = new Map();
  for (const c of j.cases) {
    const failed = new Set();
    for (const r of c.arms?.with || []) for (const g of r.graders || []) if (g.scored !== false && g.passed === false) failed.add(g.name);
    cases.set(c.name, { ...caseStats(c), fp: caseFingerprint(c), contract: j.recorded?.contract?.cases?.[c.name] ?? null, dir: c.dir ? String(c.dir).replace(/\\/g, '/') : null, failed: [...failed], graders: c.graders || [] });
  }
  const all = [...cases.values()];
  return {
    j,
    label,
    startedAt: j.startedAt,
    cost: j.costUsd ?? 0,
    duration: j.durationSeconds ?? null,
    partial: Boolean(j.partial),
    config: runConfig(j),
    recorded: j.recorded || null,
    plugins: [...new Set([...(j.suite?.plugins || []).map((p) => p.path), ...(j.suite?.root ? [j.suite.root] : [])])],
    errors: all.reduce((n, c) => n + c.errors, 0),
    errorsWithout: all.reduce((n, c) => n + c.errorsWithout, 0),
    runs: all.reduce((n, c) => n + c.runs, 0),
    runsWithout: all.reduce((n, c) => n + c.runsWithout, 0),
    threshold: j.suite?.threshold,
    cases,
  };
}

const dir = resultsDir(target);
if (!dir) fail(`no eval results found for ${target}`);
const { runs, broken } = loadRuns(dir);
if (argv.includes('--list')) {
  for (const r of runs) console.log(`${r.label}\t${r.j.startedAt.slice(0, 16)}\tcases ${r.j.cases.length}\t$${(r.j.costUsd ?? 0).toFixed(2)}\t${modelCheck(r.j).model ? `model ${modelCheck(r.j).model}` : 'model not shown by the result'}`);
  for (const b of broken) console.log(`${b.file}\t${b.problem}`);
  process.exit(0);
}
const pick = (label, fallback) => {
  if (!label) return fallback;
  const bad = broken.find((b) => b.label === label);
  if (bad) fail(`${bad.file} is ${bad.problem}`);
  return runs.find((r) => r.label === label) || fail(`run not found: ${label}`);
};
const after = pick(option('--after'), runs.at(-1));
const before = pick(option('--before'), after ? runs[runs.indexOf(after) - 1] : null);
if (!after) fail(`no readable run in ${dir}${broken.length ? `; broken: ${broken.map((b) => `${b.file} (${b.problem})`).join('; ')}` : ''}`);
const A = summarize(after);
const B = before ? summarize(before) : null;
const THRESHOLD = thresholdOption ?? A.threshold ?? 1;

const blocking = [];
const missing = [];
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
console.log(`\n${'case'.padEnd(width)}  before  after  lift   errors(w/wo)  fired  change`);
const flips = [];
const comparable = [];
const contractChanged = [];
for (const n of names) {
  const b = B?.cases.get(n);
  const a = A.cases.get(n);
  const lift = a ? a.lift : null;
  let change = '';
  if (!b) change = 'new';
  else if (!a) change = 'not run';
  else if (a.fp !== b.fp || (a.contract && b.contract && a.contract !== b.contract)) {
    change = 'case changed';
    if (a.contract && b.contract && a.contract !== b.contract) contractChanged.push(n);
  } else if (a.inconclusive || b.inconclusive) change = [a, b].some((x) => x.skipped || x.skippedWithout) ? 'inconclusive (graders skipped)' : 'inconclusive (run errors)';
  else {
    const was = b.withScore >= THRESHOLD;
    const now = a.withScore >= THRESHOLD;
    change = was && !now ? 'PASS->FAIL' : !was && now ? 'FAIL->PASS' : a.withScore > b.withScore ? 'up' : a.withScore < b.withScore ? 'down' : 'same';
    if (was !== now) flips.push(n);
    comparable.push(n);
  }
  const errs = a ? `${a.errors}/${a.errorsWithout}` : '-';
  const fired = a?.fired == null ? '-' : `${a.fired}/${a.runs}${a.slashPrompt ? '*' : ''}`;
  console.log(`${n.padEnd(width)}  ${fmt(b?.withScore).padStart(6)}  ${fmt(a?.withScore).padStart(5)}  ${signed(lift).padStart(5)}  ${errs.padStart(12)}  ${fired.padStart(5)}  ${change}`);
}

const m = (s) => mean(comparable.map((n) => s.cases.get(n).withScore));
if (B) console.log(`\nmean over ${comparable.length} comparable case(s): ${comparable.length ? `${fmt(m(B))} -> ${fmt(m(A))} (${signed(m(A) - m(B))})` : '-'}`);
const liftCases = [...A.cases.values()].filter((c) => c.withScore != null && c.withoutScore != null);
const cleanLift = liftCases.filter((c) => c.lift != null);
const liftAll = mean(cleanLift.map((c) => c.lift));
const leftOut = liftCases.length - cleanLift.length;
console.log(`lift vs no-skill (after): ${!liftCases.length ? 'not measured (single arm)' : liftAll == null ? 'not available (every case has run errors, skipped graders or a delta the result marks unavailable)' : `${signed(liftAll)} over ${cleanLift.length} case(s)`}${leftOut ? `; ${leftOut} case(s) left out for run errors, skipped graders or an unavailable delta` : ''}`);
console.log(`run errors (after): with skill ${A.errors}/${A.runs}, without skill ${A.errorsWithout}/${A.runsWithout}`);
if (B) console.log(`run errors (before): with skill ${B.errors}/${B.runs}, without skill ${B.errorsWithout}/${B.runsWithout}`);
const perCase = [...new Set([...A.cases.values()].map((c) => c.runs))];
console.log(`runs per case (after): ${perCase.join('/')}${perCase.some((r) => r < 3) ? '  <- below 3, confirm before deciding' : ''}`);
if (flips.length) console.log(`flipped: ${flips.join(', ')}`);
console.log('fired = with-skill runs where the Skill tool_used indicator passed; it is shown apart and never counted in the scores above.');
if ([...A.cases.values()].some((c) => c.recomputed)) console.log('note: this run counted the fired indicator in its score (ablation none); the scores above are recomputed without it.');
if ([...A.cases.values()].some((c) => c.slashPrompt && c.fired != null)) console.log('* slash-command prompt: the skill loads by command expansion without a Skill call, so fired 0 there does not show it failed to load.');

const failing = [...A.cases.entries()].filter(([, c]) => c.failed.length || c.errors || c.errorsWithout);
if (failing.length) {
  console.log('\nfailed graders (after):');
  for (const [n, c] of failing) {
    const errs = [c.errors ? `${c.errors} run error(s) with skill` : '', c.errorsWithout ? `${c.errorsWithout} run error(s) without skill` : ''].filter(Boolean);
    console.log(`  ${n}: ${[...c.failed, ...errs].join(', ')}`);
  }
}

if (broken.length) {
  const list = broken.map((b) => `${b.file} (${b.problem})`).join('; ');
  if (option('--before') && option('--after')) warnings.push(`other result files are broken and were skipped: ${list}`);
  else blocking.push(`result files that could not be read or failed the schema: ${list}; the default pick of the latest runs may be wrong, so fix or move them, or name both runs with --before and --after`);
}

for (const s of [B, A].filter(Boolean)) {
  for (const p of runProblems(s.j)) (p.level === 'blocking' ? blocking : missing).push(`${s.label}: ${p.text}`);
}
if (B) {
  for (const key of Object.keys(A.config)) {
    if (A.config[key] != null && B.config[key] != null && A.config[key] !== B.config[key]) blocking.push(`${key} differs: ${B.config[key]} -> ${A.config[key]}`);
  }
  const changed = names.filter((n) => B.cases.has(n) && A.cases.has(n) && B.cases.get(n).fp !== A.cases.get(n).fp);
  if (changed.length) blocking.push(`case or grader definition changed: ${changed.join(', ')}; re-run the baseline with the new cases`);
  if (contractChanged.length) blocking.push(`test contract changed: ${contractChanged.join(', ')} (prompt, graders, fixtures or scaffold differ); re-run the baseline with the new contract`);
  if (A.recorded?.contract && B.recorded?.contract && sharedContract(A.j) !== sharedContract(B.j)) blocking.push('shared eval files changed (mocks or other files beside the cases); re-run the baseline');
  if (B.cases.size !== A.cases.size || names.some((n) => !B.cases.has(n) || !A.cases.has(n))) warnings.push('the case set changed between runs; only common cases are compared');
}
if (perCase.some((r) => r < 3)) warnings.push('fewer than 3 runs per case');

const snapLabel = option('--snapshot');
if (snapLabel) {
  let manifest = null;
  try {
    manifest = readJson(path.join(snapshotDir(snapLabel), 'manifest.json')).j;
  } catch (e) {
    blocking.push(e.message);
  }
  if (!manifest) blocking.push(`snapshot ${snapLabel} not found`);
  else if (!manifest.markedAt) blocking.push(`snapshot ${snapLabel} has no marked change (run snapshot.mjs mark)`);
  else {
    if (B?.recorded?.frozenAt && Date.parse(manifest.createdAt) > Date.parse(B.recorded.frozenAt)) {
      blocking.push(`snapshot ${snapLabel} started after the baseline was frozen (${manifest.createdAt} > ${B.recorded.frozenAt}); edits made before it cannot be told apart from the original`);
    }
    const outputDirs = [...(A.recorded?.outputs || []), ...(B?.recorded?.outputs || [])];
    const caseDirs = [...A.cases.values(), ...(B ? B.cases.values() : [])].map((c) => c.dir).filter(Boolean);
    const rels = [...new Set([...Object.keys(manifest.baseline || {}), ...Object.keys(manifest.marked || {})])].sort();
    for (const rel of rels) {
      const original = manifest.baseline?.[rel]?.hash ?? null;
      const marked = manifest.marked?.[rel] ?? null;
      if (original === marked) continue;
      const file = path.join(manifest.root, rel);
      const root = A.plugins.find((p) => inside(p, file));
      if (!root) {
        blocking.push(`${rel} is outside the evaluated plugin (${A.plugins[0] || '-'}): this suite does not load it, so the scores say nothing about that change`);
        continue;
      }
      const relIn = inside(root, file);
      if (caseDirs.some((d) => under(relIn, d)) || outputDirs.some((d) => under(relIn, d))) continue;
      const check = (s, want, what) => {
        if (!s) return;
        if (!s.recorded?.files) {
          missing.push(`${s.label}: no file hashes recorded, so it cannot show it evaluated the ${what} ${rel}`);
          return;
        }
        const got = s.recorded.files[relIn] ?? null;
        if (got !== want) blocking.push(`${s.label} did not evaluate the ${what} ${rel} (hash ${got || 'absent'}, expected ${want || 'absent'})`);
      };
      check(B, original, 'original');
      check(A, marked, 'changed');
    }
  }
}

for (const [title, list] of [['warnings', warnings], ['insufficient evidence', missing], ['blocking', blocking]]) {
  if (!list.length) continue;
  console.log(`\n${title}:`);
  for (const x of [...new Set(list)]) console.log(`  - ${x}`);
}
const verdict = blocking.length
  ? 'NOT COMPARABLE - resolve the blocking items before deciding keep or revert'
  : missing.length
    ? 'INSUFFICIENT EVIDENCE - record what is missing and measure again before deciding keep or revert'
    : !B
      ? 'no baseline to compare'
      : comparable.length
        ? 'comparable'
        : 'no comparable case';
console.log(`\nverdict: ${verdict}`);
process.exitCode = blocking.length ? 2 : missing.length ? 3 : 0;
