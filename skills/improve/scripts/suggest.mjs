import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import os from 'node:os';
import path from 'node:path';

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
const SESSION = argv.includes('--session') ? (sessionArg && !sessionArg.startsWith('--') ? sessionArg : process.env.CLAUDE_CODE_SESSION_ID) : null;
if (argv.includes('--session') && !SESSION) {
  console.error('--session needs an id or CLAUDE_CODE_SESSION_ID');
  process.exit(1);
}

const CORRECTION = /(sai rồi|sai mất|vẫn sai|lại sai|vẫn lỗi|lại lỗi|không đúng|chưa đúng|ko đúng|không phải (?:vậy|thế|cái|như)|ko phải|nhầm rồi|bị nhầm|sao lại|tại sao lại|làm lại đi|đã bảo|đã nói là|quên mất|違う|間違)/i;
const TURNS_AFTER_SKILL = 4;
const CALLS_AFTER_SKILL = 8;

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
    return execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
};
const oneLine = (s, n = 90) => s.replace(/\s+/g, ' ').trim().slice(0, n);
const textOf = (content) =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.filter((c) => c.type === 'text').map((c) => c.text).join('') : '';

const localSkills = new Set(dirs(path.join(ROOT, 'skills')).filter((n) => existsSync(path.join(ROOT, 'skills', n, 'SKILL.md'))));
const settings = readJson(path.join(ROOT, 'settings.json')) || {};
const overrides = settings.skillOverrides || {};

const items = new Map();
const add = (target, kind, weight, reason, action, evidence = []) => {
  const key = `${kind}:${target}`;
  const item = items.get(key) || { target, kind, score: 0, reasons: [], action, evidence: [] };
  item.score += weight;
  item.reasons.push(reason);
  item.evidence.push(...evidence);
  if (action === 'loop') item.action = 'loop';
  items.set(key, item);
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
  walk(path.join(ROOT, 'projects'));
  return files;
}

function targetOfPath(file) {
  const rel = String(file || '').replace(/\\/g, '/').split('/.claude/')[1];
  if (!rel) return null;
  const parts = rel.split('/');
  if (parts[0] === 'skills' && localSkills.has(parts[1])) return ['skill', parts[1]];
  if (parts[0] === 'agents' && parts[1]?.endsWith('.md')) return ['agent', parts[1].replace(/\.md$/, '')];
  if (parts[0] === 'hooks' && parts[1]) return ['hook', parts[1]];
  if (parts[0] === 'rules' && parts[1]) return ['rule', parts[1]];
  if (rel === 'settings.json') return ['settings', 'settings.json'];
  return null;
}

async function scanCorrections() {
  const hits = new Map();
  const toolErrors = new Map();
  const edited = new Map();
  if (SESSION && !transcriptFiles().length) {
    console.error(`no transcript found for session ${SESSION}`);
    process.exit(1);
  }
  for (const file of transcriptFiles()) {
    let active = null;
    const lines = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
    for await (const line of lines) {
      const toolLine = line.includes('"name":"Skill"') || (SESSION && /"name":"(Write|Edit|MultiEdit)"/.test(line));
      if (toolLine) {
        let rec;
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }
        for (const c of Array.isArray(rec.message?.content) ? rec.message.content : []) {
          if (c.type !== 'tool_use') continue;
          if (c.name === 'Skill') {
            const name = String(c.input?.skill || '').split(':').pop();
            if (localSkills.has(name)) active = { name, turns: 0, calls: 0 };
          } else if (rec.isSidechain !== true) {
            const target = targetOfPath(c.input?.file_path);
            if (target) edited.set(target.join(':'), target);
          }
        }
        continue;
      }
      if (!line.startsWith('{"parentUuid') && !line.includes('"type":"user"')) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (SESSION && active && rec.type === 'user' && !rec.isSidechain) {
        const content = rec.message?.content;
        const results = Array.isArray(content) ? content.filter((c) => c.type === 'tool_result') : [];
        const n = results.filter((c) => c.is_error).length;
        const owner = active.calls < CALLS_AFTER_SKILL ? active.name : '(no skill active)';
        if (n) toolErrors.set(owner, (toolErrors.get(owner) || 0) + n);
        active.calls += results.length;
      }
      if (rec.type !== 'user' || rec.isMeta || rec.isSidechain || rec.toolUseResult || rec.isCompactSummary) continue;
      const text = textOf(rec.message?.content);
      const command = /<command-name>\/?([\w:-]+)<\/command-name>/.exec(text);
      if (command) {
        const name = command[1].split(':').pop();
        if (localSkills.has(name)) active = { name, turns: 0, calls: 0 };
        continue;
      }
      if (!text || text.trimStart().startsWith('<') || text.startsWith('This session is being continued')) continue;
      const inWindow = SESSION || Date.parse(rec.timestamp) >= SINCE;
      const owner = active && active.turns <= TURNS_AFTER_SKILL ? active.name : SESSION ? '(no skill active)' : null;
      if (owner && inWindow && CORRECTION.test(text)) {
        const list = hits.get(owner) || [];
        list.push(`${String(rec.timestamp).slice(0, 10)} ${path.basename(file).slice(0, 8)}: ${oneLine(text)}`);
        hits.set(owner, list);
      }
      if (active) active.turns += 1;
    }
  }
  const scope = SESSION ? 'in this session' : `last ${DAYS} days`;
  for (const [name, list] of hits) {
    const kind = name.startsWith('(') ? 'session' : 'skill';
    add(name, kind, 3 * list.length, `corrected ${list.length}x ${kind === 'skill' ? 'while this skill was active' : 'with no skill active'} (${scope})`, 'loop', list);
  }
  for (const [name, n] of toolErrors) {
    const kind = name.startsWith('(') ? 'session' : 'skill';
    add(name, kind, n, `${n} tool error(s) or hook block(s) ${kind === 'skill' ? `within ${CALLS_AFTER_SKILL} tool calls of this skill` : `more than ${CALLS_AFTER_SKILL} tool calls after the last skill`} (${scope})`, 'loop');
  }
  for (const [kind, target] of edited.values()) add(target, kind, 2, `edited ${scope}, not measured yet`, 'loop');
  return new Set(edited.keys());
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const armScore = (runs) => mean((runs || []).filter((r) => typeof r.score === 'number' && !r.error).map((r) => r.score));

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
  for (const name of localSkills) {
    const resultsDir = path.join(ROOT, 'skills', name, 'evals', 'results');
    const run = existsSync(resultsDir) ? latestRun(resultsDir) : null;
    if (!run) continue;
    const cases = run.cases.map((c) => ({ name: c.name, with: armScore(c.arms?.with), without: armScore(c.arms?.without) }));
    const failing = cases.filter((c) => c.with != null && c.with < 1);
    if (failing.length) {
      add(name, 'skill', 2, `${failing.length} eval case(s) below 1.0: ${failing.map((c) => `${c.name}=${c.with.toFixed(2)}`).join(', ')}`, 'loop');
    }
    const lift = mean(cases.filter((c) => c.with != null && c.without != null).map((c) => c.with - c.without));
    if (lift != null && lift <= 0.05) add(name, 'skill', 2, `adds almost nothing over the no-skill baseline (lift ${lift.toFixed(2)})`, 'loop');
    const lastCommit = git('log', '-1', '--format=%cI %h', '--', `skills/${name}`);
    if (lastCommit && Date.parse(lastCommit.split(' ')[0]) > Date.parse(run.startedAt)) {
      add(name, 'skill', 2, `changed after its last eval (commit ${lastCommit.split(' ')[1]})`, 'loop');
    }
  }

  const off = Object.keys(overrides).filter((name) => overrides[name] === 'off');
  if (off.length) add(`${off.length} skills turned off`, 'cleanup', off.length >= 5 ? 2 : 1, `off in skillOverrides: ${off.join(', ')}`, 'cleanup');
}

const claude = (args, timeout) => {
  try {
    return execFileSync(`claude ${args}`, { encoding: 'utf8', shell: true, timeout, env: { ...process.env, MSYS_NO_PATHCONV: '1' }, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    return e.stdout || '';
  }
};

function validateSignals(onlyTargets) {
  let report;
  try {
    report = JSON.parse(claude(`plugin validate "${ROOT}" --json`, 60000));
  } catch {
    add('claude plugin validate', 'audit', 1, 'validate did not return a report', 'config');
    return;
  }
  for (const f of report.contents || []) {
    const target = targetOfPath(f.file);
    if (!target || (onlyTargets && !onlyTargets.has(target.join(':')))) continue;
    for (const e of f.errors || []) add(target[1], target[0], 3, `validate error: ${e.path ? `${e.path}: ` : ''}${oneLine(e.message, 120)}`, 'loop');
    for (const w of f.warnings || []) add(target[1], target[0], 1, `validate warning: ${w.path ? `${w.path}: ` : ''}${oneLine(w.message, 120)}`, 'loop');
  }
}

function doctorSignals() {
  const text = claude('-p /skill-doctor', 120000);
  const rows = [];
  for (const line of text.split('\n')) {
    const m = /^\s{2}(\S+)\s+(.+?)\s{2,}(~\d+|-)\s+(\S+)\s+(\d+)×\s+(never|today|\d+ days?)\s*$/.exec(line);
    if (m) rows.push({ name: m[1], source: m[2].trim(), context: m[3] === '-' ? 0 : Number(m[3].slice(1)), uses: Number(m[5]), last: m[6] });
  }
  if (!rows.length) return false;
  const daysAgo = (last) => (last === 'never' ? Infinity : last === 'today' ? 0 : Number(last.split(' ')[0]));
  const groups = new Map();
  for (const r of rows.filter((x) => x.context > 0 && daysAgo(x.last) > 60)) {
    const where = r.source === 'userSettings' ? 'local' : r.source === 'claude.ai sync' ? 'claude.ai sync' : `plugin ${r.source}`;
    const g = groups.get(where) || { names: [], tokens: 0 };
    g.names.push(`${r.name} (${r.last === 'never' ? 'never used' : `${r.last} ago`})`);
    g.tokens += r.context;
    groups.set(where, g);
  }
  const how = { local: 'turn off in skillOverrides or remove', 'claude.ai sync': 'turn off on claude.ai' };
  for (const [where, g] of groups) {
    add(`${g.names.length} ${where} skills idle 60+ days`, 'cleanup', g.tokens >= 500 ? 2 : 1, `skill-doctor: ~${g.tokens} listing tokens every turn; ${how[where] || 'disable the plugin in /plugin'}: ${g.names.join(', ')}`, 'cleanup');
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
  const lines = git('status', '--porcelain', '--', 'skills', 'agents', 'hooks', 'rules', 'settings.json').split('\n').filter(Boolean);
  const byTarget = new Map();
  for (const l of lines) {
    const p = l.replace(/^\s*\S{1,2}\s+/, '').replace(/^"|"$/g, '');
    const parts = p.split('/');
    const [kind, target] = parts[0] === 'skills' ? ['skill', parts[1]] : parts[0] === 'agents' ? ['agent', parts[1]?.replace(/\.md$/, '')] : [parts[0].replace(/s$/, ''), p];
    const key = `${kind}:${target}`;
    byTarget.set(key, { kind, target, n: (byTarget.get(key)?.n || 0) + 1 });
  }
  for (const { kind, target, n } of byTarget.values()) add(target, kind, 2, `${n} uncommitted change(s), not measured yet`, 'loop');
}

const editedTargets = await scanCorrections();
if (SESSION) {
  if (editedTargets.size) validateSignals(editedTargets);
} else {
  if (!argv.includes('--no-doctor')) doctorSignals();
  validateSignals(null);
  evalSignals();
  configSignals();
  uncommitted();
}

const ranked = [...items.values()].sort((a, b) => b.score - a.score || a.target.localeCompare(b.target)).slice(0, TOP).map((x, i) => ({ rank: i + 1, ...x }));
const meta = { generated_at: new Date().toISOString(), scope: SESSION ? `session ${SESSION}` : `last ${DAYS} days` };

if (argv.includes('--json')) {
  console.log(JSON.stringify({ ...meta, items: ranked }, null, 1));
} else {
  console.log(`improve suggestions: ${meta.scope}`);
  if (!ranked.length) console.log('nothing to improve');
  for (const x of ranked) {
    console.log(`${String(x.rank).padStart(2)}. [${x.kind}] ${x.target}  score ${x.score}  action ${x.action}`);
    for (const r of x.reasons) console.log(`     - ${r}`);
    for (const e of x.evidence.slice(0, 3)) console.log(`       > ${e}`);
  }
}
