import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hash, inside } from './common.mjs';

const ROOT = path.join(os.homedir(), '.claude');
const argv = process.argv.slice(2);
const VALUED = ['--model', '--from'];
const option = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
};
const [target, label] = argv.filter((a, i) => !a.startsWith('--') && !VALUED.includes(argv[i - 1]));
const model = option('--model');
if (!target || !label || !model) {
  console.error('usage: record.mjs <skill name | skill dir> <label> --model <model id passed to --model> [--from <run dir | aggregate-result.json>]');
  console.error('the eval result does not store the model under test, so --model is required');
  process.exit(1);
}

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};
const git = (...args) => {
  try {
    return execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
};

const skillDir = existsSync(target) ? path.resolve(target) : path.join(ROOT, 'skills', target);
const resultsDir = path.join(skillDir, 'evals', 'results');
if (!existsSync(resultsDir)) {
  console.error(`no results folder at ${resultsDir}`);
  process.exit(1);
}
const dest = path.join(resultsDir, `${label}.json`);
if (existsSync(dest)) {
  console.error(`${dest} already exists; pick a new label`);
  process.exit(1);
}

let source = option('--from');
if (source && statSync(source).isDirectory()) source = path.join(source, 'aggregate-result.json');
if (!source) {
  const runs = readdirSync(resultsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(resultsDir, e.name, 'aggregate-result.json'))
    .map((f) => ({ f, j: readJson(f) }))
    .filter((r) => r.j?.startedAt)
    .sort((a, b) => a.j.startedAt.localeCompare(b.j.startedAt));
  source = runs.at(-1)?.f;
}
const j = source ? readJson(source) : null;
if (!j?.startedAt || !Array.isArray(j.cases)) {
  console.error(`no readable aggregate-result.json${source ? ` at ${source}` : ` under ${resultsDir}`}`);
  process.exit(1);
}
if (j.recorded) {
  console.error(`${source} was already recorded (model ${j.recorded.model})`);
  process.exit(1);
}

const root = j.suite?.root || skillDir;
const skip = new Set(['node_modules', '.git', 'working']);
const files = {};
const modifiedAfterStart = [];
const started = Date.parse(j.startedAt);
const walk = (abs) => {
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    const p = path.join(abs, e.name);
    const r = inside(root, p);
    if (e.isDirectory()) {
      if (!skip.has(e.name) && r !== 'evals/results') walk(p);
      continue;
    }
    files[r] = hash(readFileSync(p));
    if (statSync(p).mtimeMs > started) modifiedAfterStart.push(r);
  }
};
walk(root);

const rootRel = inside(ROOT, root);
const recorded = {
  model,
  recordedAt: new Date().toISOString(),
  source: path.relative(resultsDir, source),
  gitHead: git('rev-parse', '--short', 'HEAD'),
  uncommitted: rootRel ? (git('status', '--porcelain', '--', rootRel) || '').split('\n').filter(Boolean) : [],
  files,
  modifiedAfterStart,
};
writeFileSync(dest, JSON.stringify({ ...j, recorded }, null, 1));
console.log(`saved ${path.relative(ROOT, dest)}: model ${model}, judge ${j.suite?.judgeModel || '-'}, cli ${j.claudeVersion || '-'}, ${Object.keys(files).length} file(s) fingerprinted under ${root}`);
if (modifiedAfterStart.length) console.log(`warning: changed after the run started, so the run may not have used this content: ${modifiedAfterStart.join(', ')}`);
if (recorded.uncommitted.length) console.log(`note: ${recorded.uncommitted.length} uncommitted path(s) under the plugin; the fingerprints, not git, identify what was evaluated`);
