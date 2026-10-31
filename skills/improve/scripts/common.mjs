import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
export const hash = (content) => createHash('sha256').update(content).digest('hex').slice(0, 16);

const WORKING = fileURLToPath(new URL('../working/', import.meta.url));
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function checkLabel(label) {
  if (typeof label !== 'string' || !LABEL.test(label) || label.includes('..')) return `invalid label ${JSON.stringify(label)}: use letters, digits, ".", "_" or "-", starting with a letter or digit, without ".."`;
  return null;
}

function labelDir(kind, label) {
  const problem = checkLabel(label);
  if (problem) throw new Error(problem);
  const base = path.join(WORKING, kind);
  const dir = path.join(base, label);
  if (path.dirname(dir) !== base) throw new Error(`label ${label} resolves outside ${base}`);
  return dir;
}
export const snapshotDir = (label) => labelDir('snapshots', label);
export const freezeFile = (label) => `${labelDir('records', label)}.freeze.json`;

export function declaredOutputs() {
  const dir = path.join(WORKING, 'records');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.freeze.json'))
    .flatMap((f) => {
      try {
        const j = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
        return j.root ? [path.join(j.root, j.evalDir || 'evals', 'results'), ...(j.excludes || [])] : [];
      } catch {
        return [];
      }
    });
}

export function inside(root, file) {
  if (!root || !file) return null;
  const rel = path.relative(path.resolve(String(root)), path.resolve(String(file)));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.replace(/\\/g, '/');
}

const SKIP_NAMES = ['.git', 'node_modules'];
const samePath = (a, b) => !path.relative(path.resolve(a), path.resolve(b));
export const isOwnStorage = (p) => samePath(WORKING, p);
export const under = (rel, dir) => rel === dir || rel.startsWith(`${dir}/`);

export function hashTree(root, outputs = []) {
  const files = {};
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_NAMES.includes(e.name) && !isOwnStorage(p) && !outputs.some((o) => samePath(o, p))) walk(p);
      } else if (e.isFile()) files[inside(root, p)] = hash(readFileSync(p));
    }
  };
  if (existsSync(root)) walk(root);
  return files;
}

export const posix = (d) => String(d).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');

function caseDirs(files, base) {
  const dirOf = (f) => f.slice(0, f.lastIndexOf('/'));
  const graded = new Set(files.filter((f) => /\/graders\/[^/]+\.md$/.test(f)).map((f) => dirOf(dirOf(f))));
  return files.filter((f) => under(f, base) && (/\/case\.yaml$/.test(f) || (/\/prompt\.md$/.test(f) && graded.has(dirOf(f))))).map(dirOf);
}

export function splitContract(files, cases, evalDir) {
  const base = posix(evalDir);
  const dirs = cases.filter((c) => c.dir).map((c) => ({ name: c.name, dir: posix(c.dir) }));
  const outside = cases.filter((c) => !c.dir || !under(posix(c.dir), base)).map((c) => c.name);
  const otherCases = caseDirs(Object.keys(files), base);
  const byCase = Object.fromEntries(dirs.map((d) => [d.name, []]));
  const shared = {};
  const subject = {};
  for (const [f, h] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    const owner = dirs.find((d) => under(f, d.dir));
    if (owner) byCase[owner.name].push(`${f.slice(owner.dir.length)}=${h}`);
    else if (under(f, base)) {
      if (!otherCases.some((d) => under(f, d))) shared[f] = h;
    } else subject[f] = h;
  }
  return { subject, shared: hash(JSON.stringify(shared)), cases: Object.fromEntries(Object.entries(byCase).map(([n, list]) => [n, hash(list.join('\n'))])), outside };
}

export function parseStatus(raw) {
  const parts = String(raw ?? '').split('\0');
  const entries = [];
  for (let i = 0; i < parts.length; i += 1) {
    const p = parts[i];
    if (p.length < 4) continue;
    const entry = { code: p.slice(0, 2), path: p.slice(3) };
    if ('RC'.includes(p[0]) || 'RC'.includes(p[1])) {
      entry.from = parts[i + 1];
      i += 1;
    }
    entries.push(entry);
  }
  return entries;
}

const PAID_GRADERS = new Set(['llm', 'baseline']);
export const needsJudge = (c) => (c.graders || []).some((g) => PAID_GRADERS.has(g.type));

function skippedJudgements(run, paid) {
  const s = run.skippedPaidGraders;
  if (Array.isArray(s)) return s.length;
  if (typeof s === 'number') return s;
  return s === true ? Math.max(1, paid) : 0;
}

export const effectiveModel = (j, c) => j.suite?.modelOverride || c.model || null;

export function modelCheck(j) {
  const per = Object.fromEntries((j.cases || []).map((c) => [c.name, effectiveModel(j, c)]));
  const unknown = Object.keys(per).filter((n) => !per[n]);
  const known = [...new Set(Object.values(per).filter(Boolean))];
  const declared = j.recorded?.model ?? null;
  return {
    per,
    unknown,
    model: unknown.length || !known.length ? null : known.length === 1 ? known[0] : `mixed (${known.join(', ')})`,
    conflict: declared && known.some((m) => m !== declared) ? `declared model ${declared}, but the result shows it ran ${known.join(', ')}` : null,
  };
}

export function indicatorGraders(c) {
  return new Set((c.graders || []).filter((g) => g.type === 'tool_used' && g.config?.tool === 'Skill' && !(g.config?.max === 0)).map((g) => g.name));
}

function qualityOf(run, indicators) {
  if (run.error && !(run.graders || []).length) return 0;
  const scored = (run.graders || []).filter((g) => g.scored !== false && !indicators.has(g.name));
  const total = scored.reduce((n, g) => n + (g.weight ?? 1), 0);
  if (!total) return typeof run.score === 'number' ? run.score : 0;
  return scored.reduce((n, g) => n + (g.passed ? g.weight ?? 1 : 0), 0) / total;
}

export function armStats(runs, indicators = new Set(), paid = 0) {
  const list = runs || [];
  const firedRuns = list.filter((r) => (r.graders || []).some((g) => indicators.has(g.name)));
  return {
    runs: list.length,
    errors: list.filter((r) => r.error).length,
    skipped: list.filter((r) => skippedJudgements(r, paid) > 0).length,
    skippedJudgements: list.reduce((n, r) => n + skippedJudgements(r, paid), 0),
    score: list.length ? mean(list.map((r) => (typeof r.score === 'number' ? r.score : 0))) : null,
    quality: list.length ? mean(list.map((r) => qualityOf(r, indicators))) : null,
    fired: indicators.size ? firedRuns.filter((r) => r.graders.filter((g) => indicators.has(g.name)).every((g) => g.passed)).length : null,
    indicatorScored: list.some((r) => (r.graders || []).some((g) => indicators.has(g.name) && g.scored !== false)),
  };
}

export function caseStats(c) {
  const indicators = indicatorGraders(c);
  const paid = (c.graders || []).filter((g) => PAID_GRADERS.has(g.type)).length;
  const w = armStats(c.arms?.with, indicators, paid);
  const wo = armStats(c.arms?.without, indicators, paid);
  const agg = c.aggregates || {};
  const pick = (arm, official) => (!arm.runs ? null : arm.indicatorScored ? arm.quality : typeof official === 'number' ? official : arm.score);
  const withScore = pick(w, agg.score);
  const withoutScore = pick(wo, agg.scoreWithout);
  const inconclusive = w.runs === 0 || w.errors > 0 || wo.errors > 0 || w.skipped > 0 || wo.skipped > 0;
  const deltaUnavailable = 'delta' in agg && agg.delta == null;
  return {
    withScore,
    withoutScore,
    lift: !inconclusive && !deltaUnavailable && withScore != null && withoutScore != null ? withScore - withoutScore : null,
    deltaUnavailable,
    recomputed: w.indicatorScored || wo.indicatorScored,
    fired: w.fired,
    slashPrompt: /^\s*\//.test(c.promptMarkdown || ''),
    runs: w.runs,
    runsWithout: wo.runs,
    errors: w.errors,
    errorsWithout: wo.errors,
    skipped: w.skipped,
    skippedWithout: wo.skipped,
    skippedJudgements: w.skippedJudgements + wo.skippedJudgements,
    inconclusive,
  };
}

export function caseFingerprint(c) {
  return hash(JSON.stringify({ prompt: c.promptMarkdown ?? null, graders: c.graders ?? null, runs: c.runsPerCase ?? null, maxTurns: c.maxTurns ?? null, timeout: c.timeoutSeconds ?? null }));
}

export function runConfig(j) {
  return {
    model: modelCheck(j).model,
    claudeVersion: j.claudeVersion ?? null,
    judgeModel: j.suite?.judgeModel ?? null,
    threshold: j.suite?.threshold ?? null,
    ablation: j.suite?.ablation ?? null,
  };
}

export function runProblems(j) {
  const problems = [];
  const blocking = (text) => problems.push({ level: 'blocking', text });
  const missing = (text) => problems.push({ level: 'missing', text });
  const stats = (j.cases || []).map((c) => [c.name, caseStats(c)]);
  const errors = stats.reduce((n, [, s]) => n + s.errors, 0);
  const errorsWithout = stats.reduce((n, [, s]) => n + s.errorsWithout, 0);
  if (errors || errorsWithout) blocking(`${errors} run error(s) with skill, ${errorsWithout} without; those cases are inconclusive, re-run them`);
  const skipped = stats.filter(([, s]) => s.skipped || s.skippedWithout);
  if (skipped.length) {
    const judgements = skipped.reduce((n, [, s]) => n + s.skippedJudgements, 0);
    blocking(`paid graders skipped, ${judgements} judgement(s) not made: ${skipped.map(([n, s]) => `${n} ${s.skipped} run(s) with skill, ${s.skippedWithout} without`).join('; ')}; those scores are incomplete, re-run them`);
  }
  if (j.partial) blocking('partial run (cost ceiling hit)');
  const m = modelCheck(j);
  if (m.conflict) blocking(m.conflict);
  if (m.unknown.length) missing(`model under test not recorded in the result for ${m.unknown.join(', ')} (no --model and no case model:); a declared model alone is not evidence`);
  if (!j.claudeVersion) missing('CLI version not recorded');
  if (!j.suite?.judgeModel && (j.cases || []).some(needsJudge)) missing('judge model not recorded, but llm graders depend on it');
  if (j.suite?.threshold == null || j.suite?.ablation == null) missing('threshold or ablation not recorded');
  if (!j.recorded?.contract) missing('test contract (case files, fixtures, scaffold, shared eval files) not recorded');
  if (j.recorded?.changedDuringRun?.length) blocking(`files changed while the eval ran: ${j.recorded.changedDuringRun.join(', ')}`);
  else if (j.recorded?.contentVerified !== true) missing(`content not verified (no record.mjs --freeze before the run${j.recorded?.problems?.length ? `; ${j.recorded.problems.join('; ')}` : ''})`);
  return problems;
}

export function sharedContract(j) {
  const r = j.recorded;
  if (!r?.contract) return null;
  if (!r.files || !r.evalDir) return r.contract.shared ?? null;
  return splitContract(r.files, (j.cases || []).map((c) => ({ name: c.name, dir: c.dir })), r.evalDir).shared;
}

export const comparisonKey = (j, c) =>
  JSON.stringify({ ...runConfig(j), caseModel: effectiveModel(j, c), definition: caseFingerprint(c), contract: j.recorded?.contract?.cases?.[c.name] ?? null, shared: sharedContract(j) });

export function askLayout(items, max = 16) {
  const list = items.slice(0, max);
  const leftOut = Math.max(0, items.length - max);
  if (list.length === 1) return { questions: [{ header: `#${list[0].rank}`, multiSelect: false, options: ['run', 'skip'], ranks: [list[0].rank] }], leftOut };
  const sizes = [];
  for (let n = list.length; n > 0; n -= 4) sizes.push(Math.min(4, n));
  if (sizes.length > 1 && sizes.at(-1) === 1) {
    sizes[sizes.length - 2] -= 1;
    sizes[sizes.length - 1] += 1;
  }
  let at = 0;
  const questions = sizes.map((size) => {
    const ranks = list.slice(at, (at += size)).map((x) => x.rank);
    return { header: `#${ranks[0]}–#${ranks.at(-1)}`, multiSelect: true, ranks };
  });
  return { questions, leftOut };
}

const isRun = (r) => r && typeof r === 'object' && (typeof r.score === 'number' || (r.error != null && r.score == null)) && (r.graders == null || Array.isArray(r.graders));

export function resultProblem(j) {
  if (!j || typeof j !== 'object') return 'not a JSON object';
  if (j.schemaVersion != null && j.schemaVersion !== 1) return `schemaVersion ${j.schemaVersion} is not 1`;
  if (typeof j.startedAt !== 'string' || Number.isNaN(Date.parse(j.startedAt))) return 'startedAt is missing or not a date';
  if (!Array.isArray(j.cases)) return 'cases is not an array';
  const threshold = j.suite?.threshold;
  if (threshold != null && !(typeof threshold === 'number' && threshold >= 0 && threshold <= 1)) return `suite.threshold ${threshold} is not a number between 0 and 1`;
  for (const c of j.cases) {
    if (!c || typeof c.name !== 'string' || !c.name) return 'a case has no name';
    if (!c.arms || !Array.isArray(c.arms.with)) return `case ${c.name}: arms.with is not an array`;
    if (c.arms.without != null && !Array.isArray(c.arms.without)) return `case ${c.name}: arms.without is not an array`;
    for (const r of [...c.arms.with, ...(c.arms.without || [])]) if (!isRun(r)) return `case ${c.name}: a run has no numeric score and no error`;
  }
  return null;
}
