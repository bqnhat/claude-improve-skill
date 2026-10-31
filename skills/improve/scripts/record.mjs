import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freezeFile, hashTree, inside, modelCheck, parseStatus, posix, resultProblem, splitContract, under } from './common.mjs';

const ROOT = path.join(os.homedir(), '.claude');
const argv = process.argv.slice(2);
const VALUED = ['--model', '--from', '--exclude', '--eval-dir'];
const option = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
};
const options = (name) => argv.flatMap((a, i) => (a === name && argv[i + 1] ? [argv[i + 1]] : []));
const [target, label] = argv.filter((a, i) => !a.startsWith('--') && !VALUED.includes(argv[i - 1]));
const FREEZE = argv.includes('--freeze');
const model = option('--model');
const USAGE = [
  'usage: record.mjs <skill name | skill dir> <label> --freeze [--eval-dir <dir>] [--exclude <dir>]...        (before claude plugin eval)',
  '       record.mjs <skill name | skill dir> <label> --model <id> [--from <run dir | aggregate-result.json>] [--exclude <dir>]...   (after it)',
].join('\n');
const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};
if (!target || !label || (!FREEZE && !model)) fail(`${USAGE}\n--model is required when saving and must match the model the result shows: suite.modelOverride (the eval's --model, which overrides every case) or each case's model:`);

const readJson = (file) => {
  try {
    return { j: JSON.parse(readFileSync(file, 'utf8')) };
  } catch (e) {
    return { error: e.message };
  }
};
const git = (...args) => {
  try {
    return execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
};

const skillDir = existsSync(target) ? path.resolve(target) : path.join(ROOT, 'skills', target);
if (!existsSync(skillDir)) fail(`no skill folder at ${skillDir}`);
let freezePath;
try {
  freezePath = freezeFile(label);
} catch (e) {
  fail(e.message);
}
const excludes = options('--exclude').map((p) => path.resolve(skillDir, p));

if (FREEZE) {
  if (existsSync(freezePath)) fail(`${label} is already frozen at ${freezePath}; use a new label for a new run`);
  const evalDir = posix(option('--eval-dir') || 'evals');
  if (!existsSync(path.join(skillDir, evalDir))) fail(`no eval folder ${evalDir} under ${skillDir}; pass the same --eval-dir as the eval command`);
  const files = hashTree(skillDir, [path.join(skillDir, evalDir, 'results'), ...excludes]);
  mkdirSync(path.dirname(freezePath), { recursive: true });
  writeFileSync(freezePath, JSON.stringify({ label, root: skillDir, frozenAt: new Date().toISOString(), evalDir, excludes, files }, null, 1));
  console.log(`froze ${Object.keys(files).length} file(s) under ${skillDir} as ${label} (eval folder ${evalDir}). Run claude plugin eval now and change nothing until it ends, then: record.mjs ${target} ${label} --model <id>`);
  process.exit(0);
}

function newestRun() {
  const found = [];
  for (const e of readdirSync(skillDir, { withFileTypes: true })) {
    const results = path.join(skillDir, e.name, 'results');
    if (!e.isDirectory() || !existsSync(results)) continue;
    for (const r of readdirSync(results, { withFileTypes: true })) {
      const f = path.join(results, r.name, 'aggregate-result.json');
      if (r.isDirectory() && existsSync(f)) found.push({ f, mtime: statSync(f).mtimeMs, ...readJson(f) });
    }
  }
  const valid = found.filter((x) => x.j && !resultProblem(x.j)).sort((a, b) => a.j.startedAt.localeCompare(b.j.startedAt));
  const best = valid.at(-1);
  const newerBroken = found.filter((x) => (!x.j || resultProblem(x.j)) && (!best || x.mtime > best.mtime));
  if (newerBroken.length) fail(`newest result is unreadable or invalid: ${newerBroken.map((x) => `${x.f} (${x.error || resultProblem(x.j)})`).join('; ')}; pass --from <run dir>`);
  return best?.f;
}

let source = option('--from');
if (source && existsSync(source) && statSync(source).isDirectory()) source = path.join(source, 'aggregate-result.json');
source ||= newestRun();
if (!source || !existsSync(source)) fail(`no aggregate-result.json${source ? ` at ${source}` : ` under ${skillDir}/*/results/`}`);
const { j, error } = readJson(source);
if (error) fail(`${source} is unreadable: ${error}`);
const problem = resultProblem(j);
if (problem) fail(`${source} is invalid: ${problem}`);
if (j.recorded) fail(`${source} was already recorded (model ${j.recorded.model})`);
const modelShown = modelCheck({ ...j, recorded: { model } });
if (modelShown.conflict) fail(`${source}: ${modelShown.conflict}; nothing was saved. Save it with the model the run used`);

const runDir = path.dirname(source);
const root = j.suite?.root ? path.resolve(j.suite.root) : skillDir;
const problems = [];
let frozen = null;
if (existsSync(freezePath)) {
  frozen = readJson(freezePath).j;
  if (!frozen) problems.push(`freeze file ${freezePath} is unreadable`);
} else problems.push(`no freeze for ${label}: these hashes were taken after the run, so they do not prove what the run evaluated`);

const runLayout = path.basename(path.dirname(runDir)) === 'results' ? inside(root, path.dirname(path.dirname(runDir))) : null;
const evalDir = posix(frozen?.evalDir ?? option('--eval-dir') ?? runLayout ?? 'evals');
if (frozen?.evalDir && option('--eval-dir') && posix(option('--eval-dir')) !== evalDir) problems.push(`frozen with eval folder ${evalDir}, but --eval-dir ${option('--eval-dir')} was passed now`);
const outputs = [path.join(root, evalDir, 'results'), runDir, ...(frozen?.excludes || []), ...excludes];
const outputRels = [...new Set(outputs.map((o) => inside(root, o)).filter(Boolean))];
const now = hashTree(root, outputs);
let files = now;
let frozenAt = null;
let changedDuringRun = [];
if (frozen) {
  frozenAt = frozen.frozenAt;
  files = Object.fromEntries(Object.entries(frozen.files).filter(([f]) => !outputRels.some((o) => under(f, o))));
  if (path.relative(path.resolve(frozen.root), root)) problems.push(`frozen ${frozen.root}, but the run evaluated ${root}`);
  if (Date.parse(j.startedAt) < Date.parse(frozen.frozenAt)) problems.push(`the run started ${j.startedAt}, before the freeze at ${frozen.frozenAt}`);
  const keys = new Set([...Object.keys(files), ...Object.keys(now)]);
  changedDuringRun = [...keys].filter((k) => (files[k] ?? null) !== (now[k] ?? null)).sort();
  if (changedDuringRun.length) problems.push(`changed while the eval ran: ${changedDuringRun.join(', ')}`);
}

const split = splitContract(files, j.cases.map((c) => ({ name: c.name, dir: c.dir })), evalDir);
if (split.outside.length) problems.push(`case(s) ${split.outside.join(', ')} sit outside the eval folder ${evalDir}, so their contract cannot be told apart from the skill; freeze with the --eval-dir the eval used`);

const destDir = path.join(root, evalDir, 'results');
const dest = path.join(destDir, `${label}.json`);
if (existsSync(dest)) fail(`${dest} already exists; pick a new label`);
const rootRel = inside(ROOT, root);
const recorded = {
  model,
  modelShownByResult: !modelShown.unknown.length,
  recordedAt: new Date().toISOString(),
  frozenAt,
  contentVerified: !problems.length,
  changedDuringRun,
  problems,
  source: path.relative(destDir, source).replace(/\\/g, '/'),
  gitHead: git('rev-parse', '--short', 'HEAD')?.trim() || null,
  uncommitted: rootRel ? parseStatus(git('status', '--porcelain=v1', '-z', '--untracked-files=all', '--', rootRel)).map((e) => `${e.code} ${e.path}${e.from ? ` (from ${e.from})` : ''}`) : [],
  evalDir,
  outputs: outputRels,
  files,
  subject: split.subject,
  contract: { shared: split.shared, cases: split.cases },
};
mkdirSync(destDir, { recursive: true });
writeFileSync(dest, JSON.stringify({ ...j, recorded }, null, 1));
console.log(`saved ${dest}: model ${model} (${modelShown.unknown.length ? `declared only: the result does not show the model for ${modelShown.unknown.join(', ')}, so compare will call the evidence insufficient` : 'matches the result'}), judge ${j.suite?.judgeModel || '-'}, cli ${j.claudeVersion || '-'}, eval folder ${evalDir}, ${Object.keys(split.subject).length} skill file(s), ${Object.keys(split.cases).length} case contract(s)`);
console.log(recorded.contentVerified ? `content verified: unchanged from the freeze at ${frozenAt} to now` : `content NOT verified:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
