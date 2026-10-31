import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import os from 'node:os';
import path from 'node:path';
import { askLayout, caseStats, inside, mean, parseStatus } from './common.mjs';

const ROOT = path.join(os.homedir(), '.claude');
const DAY_MS = 86400000;

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const DAYS = Number(option('--days', 7));
const TOP = Number(option('--top', 10));
const SINCE = Date.now() - DAYS * DAY_MS;
const sessionArg = option('--session', '');
const TARGET = argv.includes('--target') ? option('--target', '').replace(/^\//, '') : null;
if (argv.includes('--target') && (!TARGET || TARGET.startsWith('--'))) {
  console.error('--target needs a skill, agent, hook or rule name');
  process.exit(1);
}
const SESSION = argv.includes('--session') ? (sessionArg && !sessionArg.startsWith('--') ? sessionArg : process.env.CLAUDE_CODE_SESSION_ID) : null;
if (argv.includes('--session') && !SESSION) {
  console.error('--session needs an id or CLAUDE_CODE_SESSION_ID');
  process.exit(1);
}

const CORRECTION = /(sai rồi|sai mất|vẫn sai|lại sai|vẫn lỗi|lại lỗi|không đúng|chưa đúng|ko đúng|không phải (?:vậy|thế|cái|như)|ko phải|nhầm rồi|bị nhầm|sao lại|tại sao lại|làm lại đi|đã bảo|đã nói là|quên mất|違う|間違)/i;
const PASTED = /<pasted_content\b[\s\S]*?<\/pasted_content[^>]*>/g;
const TURNS_AFTER_SKILL = 4;
const CALLS_AFTER_SKILL = 8;
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};
const dirs = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : []);
const git = (...args) => {
  try {
    return execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
};
const oneLine = (s, n = 90) => s.replace(/\s+/g, ' ').trim().slice(0, n);
const textOf = (content) =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.filter((c) => c.type === 'text').map((c) => c.text).join('') : '';

const localSkills = new Set(dirs(path.join(ROOT, 'skills')).filter((n) => existsSync(path.join(ROOT, 'skills', n, 'SKILL.md'))));
const settings = readJson(path.join(ROOT, 'settings.json')) || {};
const overrides = settings.skillOverrides || {};

const collectors = [];
const note = (name, status, detail = '') => collectors.push({ name, status, detail });

const items = new Map();
const add = (target, kind, weight, reason, action, evidence = []) => {
  if (!String(target ?? '').trim()) return;
  const key = `${kind}:${target}`;
  const item = items.get(key) || { target, kind, score: 0, reasons: [], action, evidence: [] };
  item.score += weight;
  item.reasons.push(reason);
  item.evidence.push(...evidence);
  if (action === 'loop') item.action = 'loop';
  items.set(key, item);
};
const groups = [];
const addGroup = (title, members, weight, reason, action) => {
  groups.push({ members, weight, reason, action });
  add(title, 'cleanup', weight, reason, action);
};

function transcriptFiles() {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'subagents' && entry.name !== 'tool-results') walk(p);
      } else if (SESSION ? entry.name === `${SESSION}.jsonl` : entry.name.endsWith('.jsonl') && statSync(p).mtimeMs >= SINCE) files.push(p);
    }
  };
  const projects = path.join(ROOT, 'projects');
  if (existsSync(projects)) walk(projects);
  return files;
}

function targetOfPath(file) {
  const rel = inside(ROOT, file);
  if (!rel) return null;
  const parts = rel.split('/');
  if (parts[0] === 'skills' && localSkills.has(parts[1])) return ['skill', parts[1]];
  if (parts[0] === 'agents' && parts.length === 2 && parts[1].endsWith('.md')) return ['agent', parts[1].replace(/\.md$/, '')];
  if (parts[0] === 'hooks' && parts[1]) return ['hook', parts[1]];
  if (parts[0] === 'rules' && parts[1]) return ['rule', parts[1]];
  if (rel === 'settings.json') return ['settings', 'settings.json'];
  return null;
}

function skillOf(raw) {
  const name = String(raw || '').trim().replace(/^\//, '');
  return { name, local: !name.includes(':') && localSkills.has(name) };
}

function ownerOf(active, inWindow) {
  if (active && inWindow) {
    if (active.local) return { kind: 'skill', target: active.name };
    return SESSION ? { kind: 'session', target: `(skill outside ~/.claude: ${active.name})` } : null;
  }
  return SESSION ? { kind: 'session', target: '(no skill active)' } : null;
}

async function scanFile(file, found) {
  let active = null;
  const pendingEdits = new Map();
  const lines = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of lines) {
    const toolLine = line.includes('"name":"Skill"') || (SESSION && /"name":"(Write|Edit|MultiEdit|NotebookEdit)"/.test(line));
    if (!toolLine && !line.startsWith('{"parentUuid') && !line.includes('"type":"user"')) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      found.badLines += 1;
      continue;
    }
    if (rec.type === 'assistant') {
      for (const c of Array.isArray(rec.message?.content) ? rec.message.content : []) {
        if (c.type !== 'tool_use' || rec.isSidechain === true) continue;
        if (c.name === 'Skill') active = { ...skillOf(c.input?.skill), turns: 0, calls: 0 };
        else if (SESSION && EDIT_TOOLS.has(c.name)) {
          const target = targetOfPath(c.input?.file_path || c.input?.notebook_path);
          if (target) pendingEdits.set(c.id, target);
        }
      }
      continue;
    }
    const inWindow = SESSION || Date.parse(rec.timestamp) >= SINCE;
    if (rec.type === 'user' && !rec.isSidechain) {
      const content = rec.message?.content;
      const results = Array.isArray(content) ? content.filter((c) => c.type === 'tool_result') : [];
      for (const r of results) {
        const target = pendingEdits.get(r.tool_use_id);
        if (target && !r.is_error) found.edited.set(target.join(':'), target);
        pendingEdits.delete(r.tool_use_id);
      }
      if (active) {
        const n = results.filter((c) => c.is_error).length;
        const owner = ownerOf(active, active.calls < CALLS_AFTER_SKILL);
        if (n && owner && inWindow) {
          const key = `${owner.kind}\u0000${owner.target}`;
          found.toolErrors.set(key, { ...owner, n: (found.toolErrors.get(key)?.n || 0) + n });
        }
        active.calls += results.length;
      }
    }
    if (rec.type !== 'user' || rec.isMeta || rec.isSidechain || rec.toolUseResult || rec.isCompactSummary) continue;
    const text = textOf(rec.message?.content);
    const command = /<command-name>\/?([\w:-]+)<\/command-name>/.exec(text);
    if (command) {
      const skill = skillOf(command[1]);
      active = skill.local || skill.name.includes(':') ? { ...skill, turns: 0, calls: 0 } : null;
      continue;
    }
    if (!text || text.trimStart().startsWith('<') || text.startsWith('This session is being continued')) continue;
    const owner = ownerOf(active, active && active.turns <= TURNS_AFTER_SKILL);
    const typed = text.replace(PASTED, ' ');
    if (owner && inWindow && CORRECTION.test(typed)) {
      const key = `${owner.kind}\u0000${owner.target}`;
      const entry = found.hits.get(key) || { ...owner, list: [] };
      entry.list.push(`${String(rec.timestamp).slice(0, 10)} ${path.basename(file).slice(0, 8)}: ${oneLine(typed)}`);
      found.hits.set(key, entry);
    }
    if (active) active.turns += 1;
  }
}

async function scanCorrections() {
  const found = { hits: new Map(), toolErrors: new Map(), edited: new Map(), badLines: 0 };
  const files = transcriptFiles();
  if (SESSION && !files.length) {
    console.error(`no transcript found for session ${SESSION}`);
    process.exit(1);
  }
  const unread = [];
  for (const file of files) {
    try {
      await scanFile(file, found);
    } catch {
      unread.push(path.basename(file));
    }
  }
  const detail = [`${files.length} file(s)`, found.badLines ? `${found.badLines} unparsable line(s) skipped` : '', unread.length ? `${unread.length} file(s) unreadable` : ''].filter(Boolean).join(', ');
  note('transcripts', !files.length ? 'empty' : unread.length || found.badLines ? 'partial' : 'ok', detail);
  const scope = SESSION ? 'in this session' : `last ${DAYS} days`;
  for (const { kind, target, list } of found.hits.values()) {
    const where = kind === 'skill' ? `within ${TURNS_AFTER_SKILL} turns after this skill ran` : target === '(no skill active)' ? 'with no skill active' : 'while a skill outside ~/.claude was active';
    add(target, kind, 3 * list.length, `possible: user corrected ${list.length}x ${where} (${scope}); a lead to check in the transcript, not proof of cause`, 'loop', list);
  }
  for (const { kind, target, n } of found.toolErrors.values()) {
    const where = kind === 'skill' ? `within ${CALLS_AFTER_SKILL} tool calls after this skill ran` : target === '(no skill active)' ? `more than ${CALLS_AFTER_SKILL} tool calls after the last skill` : 'while a skill outside ~/.claude was active';
    add(target, kind, n, `possible: ${n} tool error(s) or hook block(s) ${where} (${scope})`, 'loop');
  }
  for (const [kind, target] of found.edited.values()) add(target, kind, 2, `edited ${scope} (write succeeded), not measured yet`, 'loop');
  return new Set(found.edited.keys());
}

function latestRun(resultsDir) {
  const files = [];
  for (const e of readdirSync(resultsDir, { withFileTypes: true })) {
    if (e.isDirectory()) files.push(path.join(resultsDir, e.name, 'aggregate-result.json'));
    else if (e.name.endsWith('.json')) files.push(path.join(resultsDir, e.name));
  }
  const runs = files.map(readJson).filter((j) => j?.startedAt && Array.isArray(j.cases) && j.cases.length);
  return runs.sort((a, b) => a.startedAt.localeCompare(b.startedAt)).at(-1) || null;
}

function evalSignals() {
  let suites = 0;
  const unfinished = [];
  for (const name of localSkills) {
    const resultsDir = path.join(ROOT, 'skills', name, 'evals', 'results');
    const run = existsSync(resultsDir) ? latestRun(resultsDir) : null;
    if (!run) continue;
    suites += 1;
    const cases = run.cases.map((c) => ({ name: c.name, ...caseStats(c) }));
    const skipped = cases.reduce((n, c) => n + c.skippedJudgements, 0);
    const gaps = [run.partial ? 'partial run (cost ceiling hit)' : '', skipped ? `${skipped} paid judgement(s) skipped` : ''].filter(Boolean);
    if (gaps.length) {
      unfinished.push(name);
      add(name, 'skill', 2, `latest eval did not finish (${gaps.join(', ')}); its scores are incomplete, re-run it before reading them`, 'loop');
    }
    const errored = cases.filter((c) => c.errors || c.errorsWithout);
    if (errored.length) {
      add(name, 'skill', 2, `latest eval has run errors in ${errored.length} case(s): ${errored.map((c) => `${c.name} ${c.errors}/${c.runs} with, ${c.errorsWithout} without`).join('; ')}; its scores are inconclusive`, 'loop');
    }
    const failing = cases.filter((c) => c.withScore != null && c.withScore < 1);
    if (failing.length) {
      add(name, 'skill', 2, `${failing.length} eval case(s) below 1.0: ${failing.map((c) => `${c.name}=${c.withScore.toFixed(2)}`).join(', ')}`, 'loop');
    }
    const lift = mean(cases.map((c) => c.lift).filter((x) => x != null));
    if (lift != null && lift <= 0.05) add(name, 'skill', 2, `adds almost nothing over the no-skill baseline (lift ${lift.toFixed(2)})`, 'loop');
    const lastCommit = git('log', '-1', '--format=%cI %h', '--', `skills/${name}`)?.trim();
    if (lastCommit && Date.parse(lastCommit.split(' ')[0]) > Date.parse(run.startedAt)) {
      add(name, 'skill', 2, `changed after its last eval (commit ${lastCommit.split(' ')[1]})`, 'loop');
    }
  }
  note('eval results', unfinished.length ? 'partial' : 'ok', [`${suites} skill suite(s) with results`, unfinished.length ? `latest eval unfinished for ${unfinished.join(', ')}` : ''].filter(Boolean).join('; '));

  const off = Object.keys(overrides).filter((name) => overrides[name] === 'off');
  if (off.length) addGroup(`${off.length} skills turned off`, off, off.length >= 5 ? 2 : 1, `off in skillOverrides: ${off.join(', ')}`, 'cleanup');
}

const claude = (args, timeout) => {
  try {
    return { ok: true, out: execFileSync(`claude ${args}`, { encoding: 'utf8', shell: true, timeout, env: { ...process.env, MSYS_NO_PATHCONV: '1' }, stdio: ['ignore', 'pipe', 'ignore'] }) };
  } catch (e) {
    return { ok: false, out: e.stdout || '' };
  }
};

function validateSignals(onlyTargets) {
  if (argv.includes('--no-validate')) return note('plugin validate', 'skipped', '--no-validate');
  let report;
  try {
    report = JSON.parse(claude(`plugin validate "${ROOT}" --json`, 60000).out);
  } catch {
    note('plugin validate', 'failed', 'no JSON report');
    return;
  }
  const checked = (report.contents || []).length;
  note('plugin validate', checked ? 'ok' : 'empty', checked ? `${checked} file(s)` : 'the report lists no file, so nothing was validated');
  for (const f of report.contents || []) {
    const target = targetOfPath(path.resolve(ROOT, f.file || ''));
    if (!target || (onlyTargets && !onlyTargets.has(target.join(':')))) continue;
    for (const e of f.errors || []) add(target[1], target[0], 3, `validate error: ${e.path ? `${e.path}: ` : ''}${oneLine(e.message, 120)}`, 'loop');
    for (const w of f.warnings || []) add(target[1], target[0], 1, `validate warning: ${w.path ? `${w.path}: ` : ''}${oneLine(w.message, 120)}`, 'loop');
  }
}

function doctorSignals() {
  if (argv.includes('--no-doctor')) {
    note('skill-doctor', 'skipped', '--no-doctor');
    return false;
  }
  const { ok, out } = claude('-p /skill-doctor', 120000);
  const rows = [];
  for (const line of out.split('\n')) {
    const m = /^\s{2}(\S+)\s+(.+?)\s{2,}(~\d+|-)\s+(\S+)\s+(\d+)×\s+(never|today|\d+ days?)\s*$/.exec(line);
    if (m) rows.push({ name: m[1], source: m[2].trim(), context: m[3] === '-' ? 0 : Number(m[3].slice(1)), uses: Number(m[5]), last: m[6] });
  }
  if (!rows.length) {
    note('skill-doctor', 'failed', ok ? 'output had no skill rows' : 'command failed');
    return false;
  }
  note('skill-doctor', 'ok', `${rows.length} skill(s)`);
  const daysAgo = (last) => (last === 'never' ? Infinity : last === 'today' ? 0 : Number(last.split(' ')[0]));
  const idle = new Map();
  for (const r of rows.filter((x) => x.context > 0 && daysAgo(x.last) > 60)) {
    const where = r.source === 'userSettings' ? 'local' : r.source === 'claude.ai sync' ? 'claude.ai sync' : `plugin ${r.source}`;
    const g = idle.get(where) || { names: [], members: [], tokens: 0 };
    g.names.push(`${r.name} (${r.last === 'never' ? 'never used' : `${r.last} ago`})`);
    g.members.push(r.name);
    g.tokens += r.context;
    idle.set(where, g);
  }
  const how = { local: 'turn off in skillOverrides or remove', 'claude.ai sync': 'turn off on claude.ai' };
  for (const [where, g] of idle) {
    addGroup(`${g.names.length} ${where} skills idle 60+ days`, g.members, g.tokens >= 500 ? 2 : 1, `skill-doctor: ~${g.tokens} listing tokens every turn; ${how[where] || 'disable the plugin in /plugin'}: ${g.names.join(', ')}`, 'cleanup');
  }
  return true;
}

function configSignals() {
  const agentDir = path.join(ROOT, 'agents');
  const pins = [];
  for (const f of existsSync(agentDir) ? readdirSync(agentDir).filter((x) => x.endsWith('.md')) : []) {
    const text = readFileSync(path.join(agentDir, f), 'utf8');
    const name = f.replace(/\.md$/, '');
    text.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/`([\w-]+)` skill/g)) {
        const state = overrides[m[1]] === 'off' ? 'off' : localSkills.has(m[1]) ? null : 'missing';
        if (state) add(name, 'agent', 3, `agents/${f}:${i + 1} points to skill \`${m[1]}\`, which is ${state}`, 'loop');
      }
    });
    const model = /^model:\s*(\S+)/m.exec(text)?.[1];
    if (model) pins.push(`${name}=${model}`);
  }
  const env = settings.env || {};
  const layers = [];
  if (env.CLAUDE_CODE_SUBAGENT_MODEL) layers.push(`env CLAUDE_CODE_SUBAGENT_MODEL=${env.CLAUDE_CODE_SUBAGENT_MODEL}`);
  if (env.ANTHROPIC_DEFAULT_HAIKU_MODEL && !/haiku/i.test(env.ANTHROPIC_DEFAULT_HAIKU_MODEL)) layers.push(`haiku alias -> ${env.ANTHROPIC_DEFAULT_HAIKU_MODEL}`);
  if (pins.length && layers.length) add('subagent model', 'settings', 2, `model set in ${layers.length + 1} layers: ${layers.join('; ')}; agent pins ${pins.join(', ')}`, 'config');
}

function uncommitted() {
  const out = git('status', '--porcelain=v1', '-z', '--untracked-files=all', '--', 'skills', 'agents', 'hooks', 'rules', 'settings.json');
  if (out == null) return note('git status', 'failed', `${ROOT} is not a readable git repository`);
  const paths = parseStatus(out).map((e) => e.path);
  note('git status', 'ok', `${paths.length} uncommitted path(s)`);
  const byTarget = new Map();
  for (const p of paths) {
    const parts = p.split('/');
    const [kind, target] =
      targetOfPath(path.join(ROOT, p)) || (parts[0] === 'skills' ? ['skill', parts[1]] : parts[0] === 'agents' ? ['agent', parts.at(-1).replace(/\.md$/, '')] : [parts[0].replace(/s$/, ''), parts[1] || p]);
    if (!target) continue;
    const key = `${kind}:${target}`;
    byTarget.set(key, { kind, target, n: (byTarget.get(key)?.n || 0) + 1 });
  }
  for (const { kind, target, n } of byTarget.values()) add(target, kind, 2, `${n} uncommitted change(s), not measured yet`, 'loop');
}

const editedTargets = await scanCorrections();
if (SESSION) {
  if (editedTargets.size) validateSignals(editedTargets);
  else note('plugin validate', 'skipped', 'no file in ~/.claude edited in this session');
} else {
  doctorSignals();
  validateSignals(null);
  evalSignals();
  configSignals();
  uncommitted();
}

if (TARGET) {
  for (const g of groups.filter((x) => x.members.includes(TARGET))) {
    const kind = [...items.values()].find((x) => x.target === TARGET && x.kind !== 'cleanup')?.kind || 'skill';
    add(TARGET, kind, g.weight, g.reason, g.action);
  }
}
const ranked = [...items.values()]
  .filter((x) => !TARGET || x.target === TARGET)
  .sort((a, b) => b.score - a.score || a.target.localeCompare(b.target))
  .slice(0, TOP)
  .map((x, i) => ({ rank: i + 1, ...x }));
const ask = askLayout(ranked);
const incomplete = collectors.filter((c) => ['failed', 'partial', 'empty'].includes(c.status));
const meta = {
  generated_at: new Date().toISOString(),
  scope: `${SESSION ? `session ${SESSION}` : `last ${DAYS} days`}${TARGET ? `, target ${TARGET}` : ''}`,
  evidence_complete: !incomplete.length,
  collectors,
};

if (argv.includes('--json')) {
  console.log(JSON.stringify({ ...meta, items: ranked, ask }, null, 1));
} else {
  console.log(`improve suggestions: ${meta.scope}`);
  if (!ranked.length && TARGET) console.log(`no signal for ${TARGET}${incomplete.length ? ` (and the evidence is incomplete: ${incomplete.map((c) => c.name).join(', ')})` : ''}; ask the user what went wrong with it instead of guessing a failure`);
  else if (!ranked.length) console.log(incomplete.length ? `nothing found, but the evidence is incomplete (${incomplete.map((c) => c.name).join(', ')}); this is not a clean bill` : 'nothing to improve (every collector ran)');
  for (const x of ranked) {
    console.log(`${String(x.rank).padStart(2)}. [${x.kind}] ${x.target}  score ${x.score}  action ${x.action}`);
    for (const r of x.reasons) console.log(`     - ${r}`);
    for (const e of x.evidence.slice(0, 3)) console.log(`       > ${e}`);
  }
  if (ask.questions.length === 1 && !ask.questions[0].multiSelect) console.log(`ask: one single-select question on #${ask.questions[0].ranks[0]} with two options, run it or skip it`);
  else if (ask.questions.length) console.log(`ask: ${ask.questions.length} multi-select question(s): ${ask.questions.map((q) => q.ranks.map((r) => `#${r}`).join(' ')).join(' | ')}`);
  console.log('evidence:');
  for (const c of collectors) console.log(`  ${c.name}: ${c.status}${c.detail ? ` (${c.detail})` : ''}`);
}
