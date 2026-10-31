import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hash, inside, snapshotDir } from './common.mjs';

const ROOT = path.join(os.homedir(), '.claude');
const [cmd, label, ...rest] = process.argv.slice(2);
const USAGE = 'usage: snapshot.mjs <start|mark|status|revert|keep|drop> <label> [paths... (start only)]';
if (!cmd || !label) {
  console.error(USAGE);
  process.exit(1);
}

const SECRETS = [
  ['AWS access key', /AKIA[0-9A-Z]{16}/],
  ['Anthropic key', /sk-ant-[\w-]{20,}/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_\w{30,})/],
  ['Slack token', /\bxox[abprs]-[\w-]{10,}/],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['credential assignment', /\b(?:api[_-]?key|secret|token|password|passwd)\b["']?\s*[:=]\s*["'][^"'\s]{12,}["']/i],
];

const dir = snapshotDir(label);
const manifestFile = path.join(dir, 'manifest.json');
const currentHash = (abs) => (existsSync(abs) && statSync(abs).isFile() ? hash(readFileSync(abs)) : null);
const git = (...args) => {
  try {
    return execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
};
const walk = (abs) => (statSync(abs).isDirectory() ? readdirSync(abs).flatMap((n) => walk(path.join(abs, n))) : [abs]);
const load = () => {
  if (!existsSync(manifestFile)) {
    console.error(`no snapshot ${label}; start one with: snapshot.mjs start ${label} <paths...>`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(manifestFile, 'utf8'));
};
const save = (m) => writeFileSync(manifestFile, JSON.stringify(m, null, 1));
const rel = (abs) => inside(ROOT, abs);
const key = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);

function newFiles(m) {
  const known = new Set(m.files.map((f) => key(f.abs)));
  const found = [];
  for (const d of m.dirs) {
    const abs = path.join(ROOT, d);
    if (!existsSync(abs)) continue;
    for (const f of walk(abs)) if (!known.has(key(f))) found.push({ path: rel(f), abs: f, existed: false, original: null, copy: null, marked: null });
  }
  return found;
}

if (cmd === 'start') {
  if (existsSync(manifestFile)) {
    console.error(`snapshot ${label} already exists; pick another label or drop it`);
    process.exit(1);
  }
  if (!rest.length) {
    console.error(USAGE);
    process.exit(1);
  }
  const files = [];
  const dirs = [];
  for (const p of rest) {
    const abs = path.resolve(ROOT, p);
    const r = rel(abs);
    if (!r) {
      console.error(`${p} is outside ${ROOT}; snapshot only covers ~/.claude`);
      process.exit(1);
    }
    if (existsSync(abs) && statSync(abs).isDirectory()) {
      dirs.push(r);
      for (const f of walk(abs)) files.push(f);
    } else files.push(abs);
  }
  mkdirSync(path.join(dir, 'files'), { recursive: true });
  const m = { label, createdAt: new Date().toISOString(), root: ROOT, dirs, files: [] };
  for (const abs of [...new Set(files)]) {
    const existed = existsSync(abs);
    const copy = existed ? path.join('files', String(m.files.length)) : null;
    if (existed) copyFileSync(abs, path.join(dir, copy));
    m.files.push({ path: rel(abs), abs, existed, original: existed ? currentHash(abs) : null, copy, marked: null });
    const dirty = git('status', '--porcelain', '--', rel(abs));
    if (dirty) console.log(`note: ${rel(abs)} already had uncommitted changes; the snapshot keeps them and revert restores them`);
  }
  save(m);
  console.log(`snapshot ${label}: ${m.files.length} file(s)${dirs.length ? ` and new files under ${dirs.join(', ')}` : ''} saved. Make the change, then: snapshot.mjs mark ${label}`);
} else if (cmd === 'mark') {
  const m = load();
  m.files.push(...newFiles(m));
  for (const f of m.files) f.marked = currentHash(f.abs);
  m.markedAt = new Date().toISOString();
  save(m);
  const changed = m.files.filter((f) => f.marked !== f.original);
  console.log(changed.length ? `marked ${changed.length} file(s) as the experiment's change:` : 'marked: no file changed yet');
  for (const f of changed) console.log(`  ${f.original == null ? 'added' : f.marked == null ? 'deleted' : 'changed'}  ${f.path}`);
} else if (cmd === 'status') {
  const m = load();
  for (const f of [...m.files, ...newFiles(m)]) {
    const now = currentHash(f.abs);
    const state = now === f.original ? (m.markedAt && f.marked !== f.original ? 'back to original' : null) : !m.markedAt ? 'changed, not marked' : now === f.marked ? 'experiment change' : 'changed after mark';
    if (state) console.log(`${state.padEnd(20)} ${f.path}`);
  }
} else if (cmd === 'revert') {
  const m = load();
  if (!m.markedAt) {
    console.error(`snapshot ${label} was never marked; run snapshot.mjs mark ${label} after the change so revert knows what the experiment wrote`);
    process.exit(1);
  }
  const refused = [];
  let restored = 0;
  for (const f of [...m.files, ...newFiles(m)]) {
    const now = currentHash(f.abs);
    if (now === f.original) continue;
    if (now !== f.marked) {
      refused.push(`${f.path}: changed after mark, so it holds edits that are not the experiment's${f.copy ? `; original copy at ${path.join(dir, f.copy)}` : ''}`);
      continue;
    }
    if (f.original == null) unlinkSync(f.abs);
    else {
      mkdirSync(path.dirname(f.abs), { recursive: true });
      copyFileSync(path.join(dir, f.copy), f.abs);
    }
    if (currentHash(f.abs) !== f.original) refused.push(`${f.path}: restore did not match the original hash`);
    else restored += 1;
  }
  console.log(`reverted ${restored} file(s) to the snapshot`);
  for (const r of refused) console.log(`  not reverted: ${r}`);
  process.exitCode = refused.length ? 1 : 0;
} else if (cmd === 'keep') {
  const m = load();
  const problems = [];
  const changed = [];
  for (const f of [...m.files, ...newFiles(m)]) {
    const now = currentHash(f.abs);
    if (now === f.original) continue;
    if (now !== f.marked) {
      problems.push(`${f.path}: changed after mark; mark again or separate the other edits before committing`);
      continue;
    }
    changed.push(f);
    if (now == null) continue;
    const before = new Set(f.copy ? readFileSync(path.join(dir, f.copy), 'utf8').split('\n') : []);
    readFileSync(f.abs, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (before.has(line)) return;
        for (const [name, re] of SECRETS) if (re.test(line)) problems.push(`${f.path}:${i + 1}: added line looks like a ${name}`);
      });
  }
  if (problems.length) {
    console.log('do not commit yet:');
    for (const p of problems) console.log(`  - ${p}`);
    process.exit(1);
  }
  if (!changed.length) {
    console.log('nothing to commit: every file matches the snapshot');
    process.exit(0);
  }
  const ignored = changed.filter((f) => git('check-ignore', '-q', '--', f.path) !== null);
  const paths = changed.filter((f) => !ignored.includes(f)).map((f) => f.path);
  console.log('commit exactly these paths (no secrets found in the added lines):');
  console.log(`  git -C "${ROOT}" add -- ${paths.map((p) => `"${p}"`).join(' ')}`);
  for (const f of ignored) console.log(`  ignored by git, stays local: ${f.path}`);
  console.log(`after the commit: snapshot.mjs drop ${label}`);
} else if (cmd === 'drop') {
  load();
  rmSync(dir, { recursive: true, force: true });
  console.log(`dropped snapshot ${label}`);
} else {
  console.error(USAGE);
  process.exit(1);
}
