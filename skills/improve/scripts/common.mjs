import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
export const hash = (content) => createHash('sha256').update(content).digest('hex').slice(0, 16);
export const snapshotDir = (label) => fileURLToPath(new URL(`../working/snapshots/${encodeURIComponent(label)}/`, import.meta.url));

export function armStats(runs) {
  const list = runs || [];
  return {
    runs: list.length,
    errors: list.filter((r) => r.error).length,
    score: list.length ? mean(list.map((r) => (typeof r.score === 'number' ? r.score : 0))) : null,
  };
}

export function caseStats(c) {
  const w = armStats(c.arms?.with);
  const wo = armStats(c.arms?.without);
  const agg = c.aggregates || {};
  const withScore = w.runs ? (typeof agg.score === 'number' ? agg.score : w.score) : null;
  const withoutScore = wo.runs ? (typeof agg.scoreWithout === 'number' ? agg.scoreWithout : wo.score) : null;
  return {
    withScore,
    withoutScore,
    runs: w.runs,
    runsWithout: wo.runs,
    errors: w.errors,
    errorsWithout: wo.errors,
    inconclusive: w.runs === 0 || w.errors > 0 || wo.errors > 0,
  };
}

export function caseFingerprint(c) {
  return hash(JSON.stringify({ prompt: c.promptMarkdown ?? null, graders: c.graders ?? null, runs: c.runsPerCase ?? null, maxTurns: c.maxTurns ?? null, timeout: c.timeoutSeconds ?? null }));
}

export function runConfig(j) {
  return {
    model: j.recorded?.model ?? null,
    claudeVersion: j.claudeVersion ?? null,
    judgeModel: j.suite?.judgeModel ?? null,
    threshold: j.suite?.threshold ?? null,
    ablation: j.suite?.ablation ?? null,
  };
}

export function inside(root, file) {
  if (!root || !file) return null;
  const rel = path.relative(path.resolve(String(root)), path.resolve(String(file)));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.replace(/\\/g, '/');
}
