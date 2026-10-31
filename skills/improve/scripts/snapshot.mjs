import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { declaredOutputs, hash, inside, isOwnStorage, parseStatus, snapshotDir, under } from './common.mjs';

const ROOT = path.join(os.homedir(), '.claude');
const [cmd, label, ...rest] = process.argv.slice(2);
const USAGE = 'usage: snapshot.mjs <start|mark|status|revert|keep|drop> <label> [paths... [--exclude <path>]... (start only)]';
const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};
if (!cmd || !['start', 'mark', 'status', 'revert', 'keep', 'drop'].includes(cmd)) fail(USAGE);
let dir;
try {
  dir = snapshotDir(label);
} catch (e) {
  fail(e.message);
}

const SECRETS = [
  ['AWS access key', /AKIA[0-9A-Z]{16}/],
  ['Anthropic key', /sk-ant-[\w-]{20,}/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_\w{30,})/],
  ['Slack token', /\bxox[abprs]-[\w-]{10,}/],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['credential assignment', /\b(?:api[_-]?key|secret|token|password|passwd)\b["']?\s*[:=]\s*["'][^"'\s]{12,}["']/i],
];

const manifestFile = path.join(dir, 'manifest.json');
const git = (cwd, args, ok = [0]) => {
  try {
    return execFileSync('git', ['-c', 'core.autocrlf=false', '-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    return ok.includes(e.status) ? e.stdout : null;
  }
};
const abs = (rel) => path.join(ROOT, rel);
const fileHash = (p) => (existsSync(p) && statSync(p).isFile() ? hash(readFileSync(p)) : null);

function scan(watch, exclude = []) {
  const files = {};
  const dirs = [];
  const walk = (p) => {
    if (!existsSync(p) || isOwnStorage(p) || exclude.some((x) => under(inside(ROOT, p), x))) return;
    if (statSync(p).isDirectory()) {
      dirs.push(inside(ROOT, p));
      for (const name of readdirSync(p)) walk(path.join(p, name));
    } else files[inside(ROOT, p)] = hash(readFileSync(p));
  };
  for (const w of watch) walk(abs(w));
  return { files, dirs };
}

const withOutputs = (exclude) => [...new Set([...exclude, ...declaredOutputs().map((o) => inside(ROOT, o)).filter(Boolean)])];
const load = () => {
  if (!existsSync(manifestFile)) fail(`no snapshot ${label}; start one with: snapshot.mjs start ${label} <paths...>`);
  const m = JSON.parse(readFileSync(manifestFile, 'utf8'));
  if (!m.root || path.relative(path.resolve(m.root), ROOT)) fail(`snapshot ${label} belongs to ${m.root || 'an unknown root'}, but this run's ~/.claude is ${ROOT} (another HOME or profile); nothing was read or written. Run it with the HOME that started it`);
  m.exclude = withOutputs(m.exclude || []);
  const tracked = (files) => files && Object.fromEntries(Object.entries(files).filter(([rel]) => !m.exclude.some((x) => under(rel, x))));
  return { ...m, baseline: tracked(m.baseline), marked: tracked(m.marked) };
};
const save = (m) => writeFileSync(manifestFile, JSON.stringify(m, null, 1));
const origOf = (m, rel) => m.baseline[rel]?.hash ?? null;
const keysOf = (m, current) => [...new Set([...Object.keys(m.baseline), ...Object.keys(m.marked || {}), ...Object.keys(current)])].sort();

function gitState(top, rels) {
  if (!top || !rels.length) return { dirty: [], untracked: [], staged: [] };
  const out = git(top, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...rels.map((r) => inside(top, abs(r)))]);
  const state = { dirty: [], untracked: [], staged: [] };
  for (const e of parseStatus(out)) {
    const rel = inside(ROOT, path.join(top, e.path));
    if (!rel) continue;
    state.dirty.push(rel);
    if (e.code === '??') state.untracked.push(rel);
    else if (e.code[0] !== ' ') state.staged.push(rel);
  }
  return state;
}
const topLevel = () => (git(ROOT, ['rev-parse', '--show-toplevel']) || '').trim() || null;
const stagedNow = (top) => (top ? (git(top, ['diff', '--cached', '--name-only', '-z']) || '').split('\0').filter(Boolean) : []);

if (cmd === 'start') {
  if (existsSync(manifestFile)) fail(`snapshot ${label} already exists; pick another label or drop it`);
  if (!rest.length) fail(USAGE);
  const watch = [];
  const exclude = [];
  for (let i = 0; i < rest.length; i += 1) {
    const excluded = rest[i] === '--exclude';
    const p = excluded ? rest[(i += 1)] : rest[i];
    const r = p && inside(ROOT, path.resolve(ROOT, p));
    if (!r) fail(`${p ?? '--exclude needs a path'} is outside ${ROOT}; snapshot only covers ~/.claude`);
    (excluded ? exclude : watch).push(r);
  }
  if (!watch.length) fail(USAGE);
  exclude.splice(0, exclude.length, ...withOutputs(exclude));
  const { files, dirs } = scan(watch, exclude);
  mkdirSync(path.join(dir, 'files'), { recursive: true });
  const baseline = {};
  Object.keys(files)
    .sort()
    .forEach((rel, i) => {
      copyFileSync(abs(rel), path.join(dir, 'files', String(i)));
      baseline[rel] = { hash: files[rel], copy: path.join('files', String(i)) };
    });
  const top = topLevel();
  const state = gitState(top, watch);
  const m = { label, createdAt: new Date().toISOString(), root: ROOT, top, watch, exclude, dirsAtStart: dirs, baseline, git: top ? state : null, marked: null, markedAt: null };
  save(m);
  for (const rel of state.dirty) console.log(`note: ${rel} already held uncommitted work; revert restores it and keep stages only the experiment's hunks`);
  if (!top) console.log(`note: ${ROOT} is not a git repository; keep cannot plan staging`);
  if (exclude.length) console.log(`not tracked (eval output declared by record.mjs --freeze, or --exclude): ${exclude.join(', ')}`);
  console.log(`snapshot ${label}: ${Object.keys(baseline).length} file(s) under ${watch.join(', ')} saved, including folders that do not exist yet. Change nothing before this point; make the change, then: snapshot.mjs mark ${label}`);
} else if (cmd === 'mark') {
  const m = load();
  m.marked = scan(m.watch, m.exclude).files;
  m.markedAt = new Date().toISOString();
  save(m);
  const changed = keysOf(m, m.marked).filter((rel) => (m.marked[rel] ?? null) !== origOf(m, rel));
  console.log(changed.length ? `marked ${changed.length} file(s) as the experiment's change:` : 'marked: no file changed yet');
  for (const rel of changed) console.log(`  ${origOf(m, rel) == null ? 'added' : m.marked[rel] == null ? 'deleted' : 'changed'}  ${rel}`);
} else if (cmd === 'status') {
  const m = load();
  const current = scan(m.watch, m.exclude).files;
  for (const rel of keysOf(m, current)) {
    const now = current[rel] ?? null;
    const orig = origOf(m, rel);
    const mk = m.marked ? m.marked[rel] ?? null : undefined;
    const state = now === orig ? (m.markedAt && mk !== orig ? 'back to original' : null) : !m.markedAt ? 'changed, not marked' : now === mk ? 'experiment change' : 'changed after mark';
    if (state) console.log(`${state.padEnd(20)} ${rel}`);
  }
} else if (cmd === 'revert') {
  const m = load();
  if (!m.markedAt) fail(`snapshot ${label} was never marked; run snapshot.mjs mark ${label} after the change so revert knows what the experiment wrote`);
  const current = scan(m.watch, m.exclude).files;
  const refused = [];
  let restored = 0;
  for (const rel of keysOf(m, current)) {
    const now = current[rel] ?? null;
    const orig = origOf(m, rel);
    if (now === orig) continue;
    if (now !== (m.marked[rel] ?? null)) {
      refused.push(`${rel}: changed after mark, so it holds edits that are not the experiment's${m.baseline[rel] ? `; original copy at ${path.join(dir, m.baseline[rel].copy)}` : ''}`);
      continue;
    }
    if (orig == null) unlinkSync(abs(rel));
    else {
      mkdirSync(path.dirname(abs(rel)), { recursive: true });
      copyFileSync(path.join(dir, m.baseline[rel].copy), abs(rel));
    }
    if (fileHash(abs(rel)) !== orig) refused.push(`${rel}: restore did not match the original hash`);
    else restored += 1;
  }
  const keepDirs = new Set(m.dirsAtStart);
  for (const d of scan(m.watch, m.exclude).dirs.sort((a, b) => b.length - a.length)) {
    if (!keepDirs.has(d) && !readdirSync(abs(d)).length) rmdirSync(abs(d));
  }
  console.log(`reverted ${restored} file(s) to the snapshot; the git index was not touched`);
  for (const r of refused) console.log(`  not reverted: ${r}`);
  process.exitCode = refused.length ? 1 : 0;
} else if (cmd === 'keep') {
  const m = load();
  if (!m.markedAt) fail(`snapshot ${label} was never marked; mark it after the change`);
  const current = scan(m.watch, m.exclude).files;
  const problems = [];
  const changed = [];
  for (const rel of keysOf(m, current)) {
    const now = current[rel] ?? null;
    if (now === origOf(m, rel)) continue;
    if (now !== (m.marked[rel] ?? null)) {
      problems.push(`${rel}: changed after mark; mark again or separate the other edits before committing`);
      continue;
    }
    changed.push(rel);
    if (now == null) continue;
    const before = new Set(m.baseline[rel] ? readFileSync(path.join(dir, m.baseline[rel].copy), 'utf8').split('\n') : []);
    readFileSync(abs(rel), 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (before.has(line)) return;
        for (const [name, re] of SECRETS) if (re.test(line)) problems.push(`${rel}:${i + 1}: added line looks like a ${name}`);
      });
  }
  if (!changed.length && !problems.length) {
    console.log('nothing to commit: every file matches the snapshot');
    process.exit(0);
  }
  const top = m.top && topLevel();
  const whole = [];
  const patches = [];
  if (top && m.git) {
    const stagedFiles = new Set(stagedNow(top));
    for (const rel of changed) {
      const topRel = inside(top, abs(rel));
      if (stagedFiles.has(topRel)) {
        problems.push(`${rel}: the index already holds staged changes to this file that keep did not make; any commit of this file would carry them together with the experiment. keep left the index as it is: commit or unstage those changes yourself, then run keep again`);
        continue;
      }
      if (!m.git.dirty.includes(rel)) {
        if ((git(top, ['check-ignore', '--', topRel], [0, 1]) || '').trim()) console.log(`  ignored by git, stays local: ${rel}`);
        else whole.push(topRel);
      } else if (m.git.untracked.includes(rel)) problems.push(`${rel}: was untracked user work before the snapshot; stage it by hand`);
      else if (current[rel] == null) problems.push(`${rel}: held user work before the snapshot and the experiment deleted it; stage it by hand`);
      else {
        const diff = git(top, ['diff', '--no-index', '--no-color', '--binary', '--', path.join(dir, m.baseline[rel].copy), abs(rel)], [0, 1]) || '';
        const body = diff
          .split('\n')
          .filter((l) => !/^(old|new) mode /.test(l))
          .map((l) => (l.startsWith('diff --git ') ? `diff --git a/${topRel} b/${topRel}` : l.startsWith('--- ') ? `--- a/${topRel}` : l.startsWith('+++ ') ? `+++ b/${topRel}` : l))
          .join('\n');
        patches.push({ rel, body });
      }
    }
  }
  let patchFile = null;
  if (patches.length) {
    patchFile = path.join(dir, 'experiment.patch');
    writeFileSync(patchFile, patches.map((p) => p.body).join(''));
    if (git(top, ['apply', '--cached', '--check', patchFile]) === null) problems.push(`the experiment's hunks in ${patches.map((p) => p.rel).join(', ')} overlap the user's own edits; stage them by hand`);
  }
  const experimentTop = new Set(changed.map((rel) => (top ? inside(top, abs(rel)) : rel)));
  const otherStaged = stagedNow(top).filter((p) => !experimentTop.has(p));
  if (otherStaged.length) problems.push(`already staged and not part of the experiment: ${otherStaged.join(', ')}. A commit now would carry them with the experiment, so keep prints no staging plan and left the index as it is: commit or unstage them yourself, then run keep again`);
  if (problems.length) {
    console.log('do not commit yet:');
    for (const p of problems) console.log(`  - ${p}`);
    process.exit(1);
  }
  console.log('stage exactly the experiment (no secrets found in the added lines):');
  if (!top || !m.git) console.log(`  git -C "${ROOT}" add -- ${changed.map((p) => `"${p}"`).join(' ')}   (git state was unknown at start)`);
  if (whole.length) console.log(`  git -C "${top}" add -- ${whole.map((p) => `"${p}"`).join(' ')}`);
  if (patchFile) console.log(`  git -C "${top}" apply --cached "${patchFile}"   (only the experiment's hunks of files that already held user work)`);
  console.log("then commit with a plain `git commit` and nothing else: a commit limited to paths or with -a takes whole working-tree files, the user's unstaged work included");
  console.log(`after the commit: snapshot.mjs drop ${label}`);
} else if (cmd === 'drop') {
  load();
  rmSync(dir, { recursive: true, force: true });
  console.log(`dropped snapshot ${label}`);
}
