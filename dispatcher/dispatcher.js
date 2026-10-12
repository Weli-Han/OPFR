#!/usr/bin/env node
// OPFR dispatcher: zero-token scheduler. Sole writer of .opfr/board.json.
// Reads conductor ops from .opfr/inbox/*.json, launches `claude -p` workers in git
// worktrees, merges results, creates verify/fix/integrate/report tasks, escalates
// models, logs events/usage, and stops after REPORT.md. Usage: node dispatcher.js <project>
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const route = require('./route');

const PROJECT = path.resolve(process.argv[2] || process.cwd());
const O = path.join(PROJECT, '.opfr');
const PLUGIN = path.resolve(__dirname, '..');
const BOARD = path.join(O, 'board.json');
const TICK_MS = 2000;
const TERMINAL = new Set(['done', 'unresolved', 'cancelled', 'skipped']);
const KIND_ORDER = { fix: 0, integrate: 1, verify: 2, security: 3, build: 4, research: 4, report: 5 };

if (!fs.existsSync(BOARD)) { console.error('No board at ' + BOARD); process.exit(1); }
for (const d of ['inbox', 'inbox/done', 'results', 'briefs', 'logs', 'scratch', 'spec']) fs.mkdirSync(path.join(O, d), { recursive: true });

// ---- single instance ---------------------------------------------------------
const PID = path.join(O, 'dispatcher.pid');
try {
  const old = Number(fs.readFileSync(PID, 'utf8'));
  if (old && old !== process.pid) { process.kill(old, 0); console.error('Dispatcher already running: ' + old); process.exit(0); }
} catch {}
fs.writeFileSync(PID, String(process.pid));
const cleanup = () => { try { if (fs.readFileSync(PID, 'utf8') === String(process.pid)) fs.unlinkSync(PID); } catch {} };
process.on('exit', cleanup);
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { save(true); process.exit(0); });

// ---- board io ----------------------------------------------------------------
let B = JSON.parse(fs.readFileSync(BOARD, 'utf8'));
const M = B.meta;
B.parts ||= {}; B.tasks ||= {}; B.seq ||= 0;
Object.assign(M, {
  maxParallel: M.maxParallel ?? 3, permissionMode: M.permissionMode ?? 'bypassPermissions',
  taskTimeoutMin: M.taskTimeoutMin ?? 60, maxAttempts: M.maxAttempts ?? 2, verifyRounds: M.verifyRounds ?? 2,
  intakeIdleMin: M.intakeIdleMin ?? 45, reportReserveMin: M.reportReserveMin ?? 60, security: M.security ?? true,
  stage: M.stage ?? 'parts', usage: M.usage ?? {}, lastInbox: M.lastInbox ?? Date.now(),
});

let dirty = true;
const sleepMs = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function save(final) {
  if (!dirty) return;
  const tmp = BOARD + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(B, null, 1));
  // On Windows the rename fails while another process (office view, opfr.js) has board.json open.
  // Retry briefly; if it still fails, the board stays dirty and the next tick saves it.
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, BOARD); break; }
    catch (e) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      if (i >= (final ? 400 : 20)) { note('board save deferred: ' + e.code); return; }
      sleepMs(25);
    }
  }
  writeStatus();
  dirty = false;
}
const touch = () => { dirty = true; };
const now = () => Date.now();
const iso = () => new Date().toISOString();
function append(file, line) { fs.appendFileSync(path.join(O, file), line + '\n'); }
function ev(type, o = {}) { append('events.jsonl', JSON.stringify({ t: iso(), type, ...o })); }
function note(msg) { append('dispatcher.log', `${iso()} ${msg}`); }

// ---- helpers -----------------------------------------------------------------
function git(args, cwd = PROJECT) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  return { ok: r.status === 0, out: (r.stdout || '') + (r.stderr || '') };
}
function tail(s, n = 1500) { s = String(s || ''); return s.length > n ? '…' + s.slice(-n) : s; }
function wtPath(id) { return path.join(path.dirname(PROJECT), '.wt', path.basename(PROJECT), id); }

function findClaude() {
  if (process.env.OPFR_CLAUDE && fs.existsSync(process.env.OPFR_CLAUDE)) return process.env.OPFR_CLAUDE;
  const names = process.platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude'];
  for (const d of (process.env.PATH || '').split(path.delimiter)) for (const n of names) {
    const p = path.join(d, n); if (d && fs.existsSync(p)) return p;
  }
  const cands = [path.join(os.homedir(), '.local', 'bin', names[0])];
  // The MSIX desktop app keeps its CLI under LocalAppData\Packages; only processes inside the app see it under AppData.
  const bases = [path.join(process.env.APPDATA || '', 'Claude', 'claude-code')];
  const pk = path.join(process.env.LOCALAPPDATA || '', 'Packages');
  try { for (const d of fs.readdirSync(pk)) if (/^Claude_/.test(d)) bases.push(path.join(pk, d, 'LocalCache', 'Roaming', 'Claude', 'claude-code')); } catch {}
  for (const base of bases) try {
    for (const v of fs.readdirSync(base)) for (const h of fs.readdirSync(path.join(base, v))) cands.push(path.join(base, v, h, 'claude.exe'));
  } catch {}
  return cands.filter(p => fs.existsSync(p)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || null;
}

// ---- tasks -------------------------------------------------------------------
function addTask(spec, part) {
  const id = String(spec.id || `${(spec.kind || 'build')[0].toUpperCase()}${++B.seq}`).replace(/[^\w.-]/g, '_');
  if (B.tasks[id]) { note(`duplicate task id ${id} ignored`); return B.tasks[id]; }
  const t = {
    id, part: spec.part || part || '_', title: spec.title || id, kind: spec.kind || 'build', role: spec.role || roleFor(spec.kind),
    tier: spec.tier || 'normal', small: !!spec.small, risky: !!spec.risky, model: spec.model, effort: spec.effort,
    deps: spec.deps || [], area: [].concat(spec.area || []), skills: spec.skills || [], mcp: spec.mcp || [],
    verify: spec.verify !== false, status: 'todo', attempts: 0, created: iso(), wtOf: spec.wtOf, bug: spec.bug,
    answers: [], noEffort: false, epoch: (B.parts[spec.part || part] || {}).epoch || 0, change: spec.change,
  };
  t.rung = t.model && !route.LADDER.some(([m]) => m === t.model) ? null : route.startRung(t);
  const brief = path.join(O, 'briefs', id + '.md');
  if (spec.brief) fs.writeFileSync(brief, spec.brief);
  else if (spec.briefFile) t.briefFile = path.resolve(PROJECT, spec.briefFile);
  t.briefFile ||= brief;
  B.tasks[id] = t; touch();
  ev('task-add', { id, part: t.part, kind: t.kind, title: t.title, tier: t.tier });
  return t;
}
// First free id among base, base-2, base-3…: re-runs after a plan change get new ids.
function freshId(base) { let id = base, n = 1; while (B.tasks[id]) id = `${base}-${++n}`; return id; }
function roleFor(kind) { return ({ verify: 'verify', fix: 'fix', integrate: 'integrate', security: 'security', report: 'report', research: 'research' })[kind] || 'build'; }
const tasks = () => Object.values(B.tasks);
const running = () => tasks().filter(t => t.status === 'running');

// ---- inbox (conductor ops) ----------------------------------------------------
function processInbox() {
  const dir = path.join(O, 'inbox');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
  for (const f of files) {
    const p = path.join(dir, f);
    let ops;
    try { ops = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { if (now() - fs.statSync(p).mtimeMs > 60000) { fs.renameSync(p, p + '.bad'); note('bad inbox file ' + f); } continue; }
    for (const op of [].concat(ops)) try { applyOp(op); } catch (e) { note(`op failed ${f}: ${e.message}`); }
    fs.renameSync(p, path.join(dir, 'done', f));
    M.lastInbox = now(); touch();
  }
}

function applyOp(op) {
  switch (op.op) {
    case 'meta': Object.assign(M, op.set || {}); ev('meta', { keys: Object.keys(op.set || {}) }); break;
    case 'part': {
      const P = B.parts[op.part] ||= { title: op.title || op.part, final: false, round: 0, state: 'open' };
      if (op.title) P.title = op.title;
      for (const s of op.tasks || []) addTask(s, op.part);
      if (op.final) { P.final = true; delete P.draft; ev('part-final', { part: op.part }); }
      break;
    }
    case 'draft': {
      const P = B.parts[op.part] ||= { title: op.title || op.part, final: false, round: 0, state: 'open' };
      if (!P.final) P.draft = op.tasks || [];
      break;
    }
    case 'task': addTask(op, op.part); break;
    case 'answer': {
      const t = tasks().find(x => x.qid === op.qid);
      if (t && t.status === 'waiting') { t.answers.push({ q: t.question, a: op.text }); t.status = 'ready'; delete t.qid; ev('answer', { id: t.id, qid: op.qid }); }
      append('answers.jsonl', JSON.stringify({ t: iso(), qid: op.qid, text: op.text }));
      break;
    }
    case 'cancel': { const t = B.tasks[op.id]; if (t && !TERMINAL.has(t.status) && t.status !== 'running') { t.status = 'cancelled'; ev('cancel', { id: t.id }); } break; }
    case 'change': applyChange(op); break;
    case 'close': closeIntake('conductor'); break;
    default: note('unknown op ' + op.op);
  }
  touch();
}

function closeIntake(by) {
  if (M.intakeClosed) return;
  M.intakeClosed = true; M.intakeClosedAt = iso();
  for (const [name, P] of Object.entries(B.parts)) {
    if (!P.final && P.draft) {
      for (const s of P.draft) addTask(s, name);
      append('DECISIONS.md', `- [intake] Part ${name} built from draft assumptions (interview for it did not finish).`);
    }
    P.final = true; delete P.draft;
  }
  for (const t of tasks()) if (t.status === 'waiting') autoAnswer(t);
  ev('intake-closed', { by }); touch();
}

function autoAnswer(t) {
  const a = t.questionDefault || 'No answer: choose the safest reasonable default yourself and record it in decisions.';
  t.answers.push({ q: t.question, a, auto: true });
  append('DECISIONS.md', `- [${t.id}] Q: ${t.question} -> default: ${a}`);
  t.status = 'ready'; delete t.qid;
}

// ---- plan changes mid-run ------------------------------------------------------
// {"op":"change","parts":["B"],"note":"...","tasks":[...]}: drop the open work of the listed
// parts (queued tasks cancelled, running workers killed, worktrees discarded), reopen them,
// and add change tasks that edit the merged code on main. The parts then run their verify
// rounds again. Other parts keep running. A change during the security/final/report stage,
// or after the finish, sends the run back to the parts stage so those run again afterwards.
function applyChange(op) {
  const parts = [...new Set([].concat(op.parts || [], (op.tasks || []).map(s => s.part).filter(Boolean)).map(String))].filter(p => !p.startsWith('_'));
  if (!parts.length) { note('change without parts ignored'); return; }
  const log = M.changeLog ||= [];
  const tag = 'c' + (log.length + 1);
  // The user asked for this work now; a deadline already inside the report reserve would skip it at once.
  if (M.deadline && new Date(M.deadline).getTime() - now() <= M.reportReserveMin * 60000) {
    append('DECISIONS.md', `- [change ${tag}] deadline ${M.deadline} had passed its report reserve; removed so the change can run.`);
    M.deadline = null;
  }
  const drop = tasks().filter(t => parts.includes(t.part) && !TERMINAL.has(t.status));
  let reset = null;
  if (M.stage !== 'parts') {
    reset = M.stage;
    // Re-run security, final verify and report after the changed parts; fixes already under way finish.
    drop.push(...tasks().filter(t => t.part === '_final' && ['verify', 'security', 'report'].includes(t.kind) && !TERMINAL.has(t.status)));
    if (M.stage === 'finished') { try { fs.unlinkSync(path.join(O, 'DONE')); } catch {} delete M.finishedAt; }
    M.stage = 'parts'; ev('stage', { stage: 'parts', by: tag });
  }
  // An integrate task works in the worktree of the task it merges; drop it together with that task.
  drop.push(...tasks().filter(t => t.wtOf && drop.includes(B.tasks[t.wtOf]) && !drop.includes(t) && !TERMINAL.has(t.status)));
  const stopped = drop.filter(t => t.status === 'running').map(t => t.id);
  const dropped = drop.filter(t => t.status !== 'running').map(t => t.id);
  // Kill every worker first, then remove worktrees: a killed integrate worker may still sit in its base's worktree.
  for (const t of drop) if (procs.has(t.id)) killTree(procs.get(t.id).pid);
  for (const t of drop) {
    const hadWt = ['running', 'integrating'].includes(t.status);
    Object.assign(t, { status: 'cancelled', cancelledBy: tag, ended: iso() });
    if (hadWt && !t.wtOf) removeWorktree(t.wt, t.branch);
    ev('cancel', { id: t.id, by: tag });
  }
  for (const name of parts) {
    const P = B.parts[name] ||= { title: (parts.length === 1 && op.title) || name, round: 0, state: 'open' };
    Object.assign(P, { final: true, state: 'open', round: 0, epoch: (P.epoch || 0) + 1 });
    delete P.draft;
    (P.changes ||= []).push(`${tag}: ${op.note || ''}`);
  }
  // Change task ids that already exist get a fresh suffix; deps inside the batch follow the rename.
  const ids = {};
  for (const s of op.tasks || []) if (s.id) ids[s.id] = freshId(String(s.id).replace(/[^\w.-]/g, '_'));
  const added = (op.tasks || []).map(s => addTask({ ...s, id: ids[s.id], deps: (s.deps || []).map(d => ids[d] || d), change: tag }, s.part || parts[0]).id);
  log.push({ tag, t: iso(), parts, note: op.note || '', stopped, dropped, added, reset });
  append('DECISIONS.md', `- [change ${tag}] parts ${parts.join(', ')}: ${op.note || '(no note)'}. Stopped: ${stopped.join(', ') || '-'}; dropped: ${dropped.join(', ') || '-'}; new tasks: ${added.join(', ') || '-'}${reset ? `; ${reset === 'finished' ? 'finished run reopened' : reset + ' stage reset'}, security/final/report run again after the parts` : ''}.`);
  ev('change', { tag, parts, stopped, dropped, added, reset });
}

// ---- part lifecycle: verify rounds -------------------------------------------
function partTasks(name) { return tasks().filter(t => t.part === name); }
function advanceParts() {
  if (M.stage !== 'parts') return;
  for (const [name, P] of Object.entries(B.parts)) {
    if (!P.final || P.state === 'done') continue;
    const ts = partTasks(name);
    if (!ts.length || ts.some(t => !TERMINAL.has(t.status))) continue;
    // Only the current epoch counts: a plan change starts a new one, so the part is verified again.
    const ep = P.epoch || 0, cur = ts.filter(t => (t.epoch || 0) === ep);
    const builds = cur.filter(t => ['build', 'research'].includes(t.kind) && t.verify);
    const lastVerify = cur.filter(t => t.kind === 'verify').pop();
    const fixesSince = lastVerify ? cur.filter(t => t.kind === 'fix' && t.fromVerify === lastVerify.id) : [];
    const needRound = !lastVerify ? ep > 0 || builds.some(t => t.status === 'done') : fixesSince.some(t => t.status === 'done');
    if (needRound && P.round < M.verifyRounds) {
      P.round++; P.state = 'verifying';
      addTask({ id: freshId(`V${P.round}-${name}`), kind: 'verify', tier: 'normal', title: `Verify part ${name} (round ${P.round})`, brief: verifyBrief(name, P), mcp: M.verifyMcp || [] }, name);
    } else { P.state = 'done'; ev('part-done', { part: name }); }
    touch();
  }
}

function verifyBrief(name, P) {
  const done = partTasks(name).filter(t => t.status === 'done' && t.kind !== 'verify').map(t => `- ${t.id} ${t.title}: ${t.summary || ''}`).join('\n');
  const spec = path.join(O, 'spec', name + '.md');
  const changes = P.changes ? `The plan for this part changed mid-run (${P.changes.join('; ')}). Check the changed behavior and that nothing else broke.\n` : '';
  return `Verify part ${name} "${P.title}" against its spec ${fs.existsSync(spec) ? spec : path.join(O, 'SPEC.md')}.\n` +
    `Completed work:\n${done}\n${changes}Run the project checks${M.verifyCmd ? ` (\`${M.verifyCmd}\`)` : ''}, exercise the real behavior, add missing tests.\n` +
    `Report each defect in result "bugs": [{"title","detail","area","tier":"simple|normal|complex","repro"}]. Empty list if clean.`;
}

function advanceGlobal() {
  if (!M.intakeClosed || M.stage === 'finished') return;
  const open = tasks().some(t => !TERMINAL.has(t.status));
  if (M.stage === 'report') { if (!open) finish(); return; }
  const partsDone = Object.values(B.parts).every(P => P.state === 'done');
  if (open || !partsDone) return;
  const next = { parts: M.security ? 'security' : 'final', security: 'final', final: 'report' }[M.stage];
  M.stage = next; ev('stage', { stage: next }); touch();
  if (next === 'security') addTask({ id: freshId('SEC'), kind: 'security', tier: 'complex', risky: true, model: M.critical ? 'opus' : undefined, effort: M.critical ? 'high' : undefined, title: 'Security review of whole project', brief: 'Review the whole project for security defects. Use the security-hits log at ' + path.join(O, 'security-hits.jsonl') + ' as hints. Report bugs[] like verify.' }, '_final');
  if (next === 'final') addTask({ id: freshId('FINAL'), kind: 'verify', tier: 'complex', title: 'Final end-to-end verification', brief: `Verify the whole result against ${path.join(O, 'SPEC.md')}: build, run, use it as the user would. Report bugs[].`, mcp: M.verifyMcp || [] }, '_final');
  if (next === 'report') startReport();
}

function startReport(forced) {
  writeSummary();
  addTask({ id: freshId(forced ? 'REPORT-DEADLINE' : 'REPORT'), kind: 'report', model: M.conductorModel || 'opus', effort: M.conductorEffort || 'high', verify: false, title: 'Write REPORT.md',
    brief: `Write REPORT.md in the work dir root from ${path.join(O, 'summary.md')} and ${path.join(O, 'SPEC.md')}. Be honest: what works, what does not, UNRESOLVED items, decisions taken without the user, plan changes made mid-run, blocked actions, token usage, how to run it. Copy DECISIONS/BUGS/BLOCKED files from ${O} into docs/opfr/ if they exist.` }, '_final');
  M.stage = 'report'; touch();
}

function finish() {
  M.stage = 'finished'; M.finishedAt = iso(); touch(); save(true);
  fs.writeFileSync(path.join(O, 'DONE'), iso());
  ev('finished', { usage: M.usage });
  note('finished'); process.exit(0);
}

// ---- deadline ----------------------------------------------------------------
function checkDeadline() {
  if (!M.deadline || M.stage === 'report' || M.stage === 'finished') return;
  const left = new Date(M.deadline).getTime() - now();
  if (left > M.reportReserveMin * 60000) return;
  for (const t of tasks()) if (['todo', 'ready', 'waiting'].includes(t.status)) { t.status = 'skipped'; t.lastError = 'deadline'; }
  if (running().length) return;
  M.intakeClosed = true;
  ev('deadline', {}); append('DECISIONS.md', '- [deadline] Remaining tasks skipped; report written early.');
  startReport(true);
}

// ---- auto close intake when the user is gone ---------------------------------
function checkIdleIntake() {
  if (M.intakeClosed || !M.intakeIdleMin) return;
  if (now() - M.lastInbox < M.intakeIdleMin * 60000) return;
  const busy = tasks().some(t => ['todo', 'ready', 'running'].includes(t.status));
  const waiting = tasks().some(t => t.status === 'waiting');
  if (!busy || waiting) closeIntake('idle-timeout');
}

// ---- scheduling --------------------------------------------------------------
function promote() {
  for (const t of tasks()) {
    if (t.status !== 'todo') continue;
    const deps = t.deps.map(d => B.tasks[d]).filter(Boolean);
    if (deps.every(d => TERMINAL.has(d.status))) {
      const bad = deps.filter(d => d.status !== 'done').map(d => d.id);
      if (bad.length) t.depNote = `Dependencies not completed: ${bad.join(', ')}. Work around them or report blocked.`;
      t.status = 'ready'; touch();
    }
  }
}

// Area locks: tasks sharing an area never run together; '*' means exclusive.
function areaFree(t) {
  const run = running(), busy = run.flatMap(r => r.area);
  if (busy.includes('*')) return false;
  if (t.area.includes('*')) return run.length === 0;
  return !t.area.some(a => busy.includes(a));
}

function schedule() {
  if (M.pausedUntil && now() < M.pausedUntil) return;
  if (M.pausedUntil) { M.pausedUntil = null; M.authError = false; ev('resume'); touch(); }
  const ready = tasks().filter(t => t.status === 'ready').sort((a, b) => (KIND_ORDER[a.kind] ?? 4) - (KIND_ORDER[b.kind] ?? 4) || a.created.localeCompare(b.created));
  for (const t of ready) {
    if (running().length >= M.maxParallel) break;
    if (!areaFree(t)) continue;
    launch(t);
  }
}

// ---- worktrees ---------------------------------------------------------------
function prepareWorktree(t) {
  if (t.wtOf) { const base = B.tasks[t.wtOf]; return { wt: base.wt, branch: base.branch }; }
  const wt = wtPath(t.id), branch = 'opfr/' + t.id;
  removeWorktree(wt, branch);
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  const r = git(['worktree', 'add', '-b', branch, wt, M.mainBranch || 'HEAD']);
  if (!r.ok) throw new Error('worktree add failed: ' + tail(r.out, 400));
  for (const d of ['node_modules', '.venv']) {
    const src = path.join(PROJECT, d), dst = path.join(wt, d);
    if (fs.existsSync(src) && !fs.existsSync(dst)) try { fs.symlinkSync(src, dst, 'junction'); } catch {}
  }
  // .env is gitignored, so a fresh worktree lacks it; copy it (never committed).
  const env = path.join(PROJECT, '.env');
  if (fs.existsSync(env)) try { fs.copyFileSync(env, path.join(wt, '.env')); } catch {}
  return { wt, branch };
}
function removeWorktree(wt, branch) {
  if (fs.existsSync(wt)) {
    for (const d of ['node_modules', '.venv']) { const p = path.join(wt, d); try { if (fs.lstatSync(p).isSymbolicLink()) fs.unlinkSync(p); } catch {} }
    git(['worktree', 'remove', '--force', wt]);
    if (fs.existsSync(wt)) try { fs.rmSync(wt, { recursive: true, force: true }); } catch {}
  }
  git(['worktree', 'prune']);
  if (branch) git(['branch', '-D', branch]);
}

// ---- launch worker -------------------------------------------------------------
const procs = new Map();
let CLAUDE = null;

function rolePrompt(role) {
  const read = f => { try { return fs.readFileSync(path.join(PLUGIN, 'roles', f), 'utf8'); } catch { return ''; } };
  return read('common.md') + '\n' + (read(role + '.md') || read('build.md'));
}

function taskPrompt(t, wt) {
  const res = path.join(O, 'results', t.id + '.json');
  const lines = [
    `OPFR task ${t.id} | kind ${t.kind} | part ${t.part}: ${t.title}`,
    `Brief (read first): ${t.briefFile}`,
    `Project spec: ${path.join(O, 'SPEC.md')}${fs.existsSync(path.join(O, 'spec', t.part + '.md')) ? ' and ' + path.join(O, 'spec', t.part + '.md') : ''}`,
    `Work dir: ${wt} (git worktree, branch ${t.branch}). Do not commit or push; the dispatcher commits.`,
    `Scratch dir: ${path.join(O, 'scratch', t.id)}`,
    `Intake: ${M.intakeClosed ? 'CLOSED: never ask questions, decide and log in decisions' : 'open: one question allowed via status "question" only if the answer changes the result a lot'}.`,
  ];
  if (M.verifyCmd) lines.push(`Check command: ${M.verifyCmd}`);
  if (t.change) lines.push(`Plan change ${t.change}: ${M.mainBranch} already holds earlier work on this part. Edit that code to match the updated spec; keep what still fits, do not rebuild from scratch.`);
  if (t.skills.length) lines.push('Read only these library skills first: ' + t.skills.map(s => path.join(PLUGIN, 'library', 'skills', s, 'SKILL.md')).join(', '));
  if (t.bug) lines.push('Bug: ' + JSON.stringify(t.bug));
  if (t.depNote) lines.push(t.depNote);
  if (t.lastError) lines.push(`Previous attempt ${t.attempts} failed (model ${t.lastModel}). Cause: ${tail(t.lastError, 1200)}`);
  for (const a of t.answers) lines.push(`Answer to "${a.q}": ${a.a}`);
  lines.push(`Finish by writing ${res} as JSON: {"status":"done|failed|blocked|question","summary":"<=3 lines","files":[],"decisions":[],"bugs":[],"question":{"text":"","options":[],"recommended":""}}`);
  return lines.join('\n');
}

function launch(t) {
  CLAUDE = CLAUDE && fs.existsSync(CLAUDE) ? CLAUDE : findClaude();
  if (!CLAUDE) { pause(10, 'claude CLI not found; set OPFR_CLAUDE'); return; }
  let w;
  try { w = prepareWorktree(t); } catch (e) { fail(t, e.message); return; }
  t.wt = w.wt; t.branch = w.branch;
  const { model, effort } = route.pick(t);
  const res = path.join(O, 'results', t.id + '.json');
  try { fs.unlinkSync(res); } catch {}
  fs.mkdirSync(path.join(O, 'scratch', t.id), { recursive: true });
  const args = ['-p', taskPrompt(t, w.wt), '--model', model, '--output-format', 'json',
    '--permission-mode', M.permissionMode, '--append-system-prompt', rolePrompt(t.role),
    '--plugin-dir', PLUGIN, '--setting-sources', 'project,local',
    '--exclude-dynamic-system-prompt-sections', '--strict-mcp-config'];
  if (effort && !t.noEffort) args.push('--effort', effort);
  if (M.permissionMode !== 'bypassPermissions') args.push('--permission-prompts', 'none');
  for (const m of t.mcp) { const f = path.join(PLUGIN, 'mcp', m + '.json'); if (fs.existsSync(f)) args.push('--mcp-config', f); }
  const env = { ...process.env, OPFR_TASK_ID: t.id, OPFR_PROJECT: PROJECT, OPFR_WORKTREE: w.wt, OPFR_RESULT: res };
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT']) delete env[k];
  // OPFR_CLAUDE_PREFIX (JSON array) lets tests run a mock CLI, e.g. OPFR_CLAUDE=node + ["mock.js"].
  const prefix = process.env.OPFR_CLAUDE_PREFIX ? JSON.parse(process.env.OPFR_CLAUDE_PREFIX) : [];
  const child = spawn(CLAUDE, [...prefix, ...args], { cwd: w.wt, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { err += d; });
  const timer = setTimeout(() => { t.timedOut = true; killTree(child.pid); }, M.taskTimeoutMin * 60000);
  child.on('error', e => { err += e.message; });
  child.on('close', code => { clearTimeout(timer); procs.delete(t.id); onExit(t, code, out, err, model, effort); });
  procs.set(t.id, child);
  Object.assign(t, { status: 'running', started: iso(), lastModel: model, lastEffort: effort });
  ev('launch', { id: t.id, part: t.part, kind: t.kind, role: t.role, model, effort, title: t.title });
  touch();
}

function killTree(pid) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
  else try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch {} }
}

// ---- worker exit -------------------------------------------------------------
function onExit(t, code, out, err, model, effort) {
  fs.writeFileSync(path.join(O, 'logs', `${t.id}.${t.attempts + 1}.json`), out || err);
  let j = null;
  try { j = JSON.parse(out); } catch { const m = /\{[\s\S]*"type"\s*:\s*"result"[\s\S]*\}\s*$/.exec(out); if (m) try { j = JSON.parse(m[0]); } catch {} }
  if (j) recordUsage(t, j, model, effort);
  if (t.status === 'cancelled') {
    // Killed by a plan change: drop whatever it did; the worktree may only now be free to remove.
    const base = t.wtOf ? B.tasks[t.wtOf] : t;
    if (base && base.status === 'cancelled' && base.wt) removeWorktree(base.wt, base.branch);
    note(`${t.id} stopped by plan change ${t.cancelledBy}`); touch(); return;
  }
  const text = `${j ? j.result || '' : ''}\n${j && j.api_error_status ? 'status ' + j.api_error_status : ''}\n${err}\n${j ? '' : out}`;
  t.ended = iso();

  const errored = !j || j.is_error;
  if (errored && /not logged in|please run \/login|invalid api key|authentication_error|OAuth token has expired/i.test(text)) {
    t.status = 'ready'; M.authError = true; pause(10, 'CLI not logged in'); return;
  }
  if (errored && /rate.?limit|usage limit|\b429\b|overloaded|\b529\b|quota/i.test(text)) {
    t.status = 'ready';
    const reset = /\|(\d{10})\b/.exec(text) || /resets?\s+(?:at\s+)?(\d{10})/.exec(text);
    const waitMin = reset ? Math.max(1, (Number(reset[1]) * 1000 - now()) / 60000 + 1) : Math.min(60, 5 * 2 ** (M.limitHits = (M.limitHits || 0) + 1) / 2);
    pause(waitMin, 'rate limit'); return;
  }
  M.limitHits = 0;
  if (errored && /effort/i.test(text) && /(unsupported|not supported|invalid)/i.test(text) && !t.noEffort) { t.noEffort = true; t.status = 'ready'; note(`${t.id}: effort unsupported for ${model}, retry without`); touch(); return; }

  let r = null;
  try { r = JSON.parse(fs.readFileSync(path.join(O, 'results', t.id + '.json'), 'utf8')); } catch {}
  if (t.timedOut) { delete t.timedOut; return fail(t, `timeout after ${M.taskTimeoutMin} min`); }
  if (!r) return fail(t, `no result file (exit ${code}). ${tail(text, 600)}`);
  t.summary = String(r.summary || '').slice(0, 400);
  for (const d of r.decisions || []) append('DECISIONS.md', `- [${t.id}] ${d}`);

  if (r.status === 'question' && r.question && r.question.text) {
    if (t.answers.length >= 2) return fail(t, 'keeps asking questions instead of deciding');
    if (t.asked || M.intakeClosed) { t.question = r.question.text; t.questionDefault = r.question.recommended; autoAnswer(t); return discardWorktree(t); }
    t.asked = true; t.qid = `${t.id}-q`; t.question = r.question.text; t.questionDefault = r.question.recommended; t.status = 'waiting';
    append('questions.jsonl', JSON.stringify({ qid: t.qid, task: t.id, part: t.part, text: r.question.text, options: r.question.options || [], recommended: r.question.recommended || '', t: iso() }));
    ev('question', { id: t.id, qid: t.qid }); discardWorktree(t); touch(); return;
  }
  if (r.status !== 'done') return fail(t, `${r.status}: ${r.summary || ''}`);
  completeTask(t, r);
}

function discardWorktree(t) { if (!t.wtOf) removeWorktree(t.wt, t.branch); }

function completeTask(t, r) {
  const wt = t.wt;
  git(['add', '-A'], wt);
  if (!git(['diff', '--cached', '--quiet'], wt).ok) git(['commit', '-q', '-m', `${t.id}: ${t.title}`.slice(0, 120), '--no-verify'], wt);
  // Bring in what other tasks merged meanwhile, so the check runs on exactly what main will become.
  // Two parallel fixes can each pass alone and break main together. On conflict, abort here;
  // the merge into main below then conflicts too and goes to an integrate task.
  if (!t.wtOf && !git(['merge', '-q', '--no-edit', M.mainBranch], wt).ok) git(['merge', '--abort'], wt);
  if (M.verifyCmd && ['build', 'fix', 'integrate'].includes(t.kind)) {
    const v = spawnSync(M.verifyCmd, { cwd: wt, shell: true, encoding: 'utf8', timeout: 15 * 60000, windowsHide: true });
    if (v.status !== 0) return fail(t, `check command failed: ${tail((v.stdout || '') + (v.stderr || ''), 1500)}`);
  }
  const base = t.wtOf ? B.tasks[t.wtOf] : t;
  const m = git(['merge', '--no-ff', '--no-edit', '-m', `merge ${base.id}`, base.branch]);
  if (!m.ok) {
    git(['merge', '--abort']);
    if (t.kind === 'integrate') return fail(t, 'merge still conflicts: ' + tail(m.out, 600));
    t.status = 'integrating'; t.result = r;
    addTask({ id: `I-${t.id}`, kind: 'integrate', tier: 'complex', wtOf: t.id, area: t.area, title: `Merge ${t.id} into ${M.mainBranch}`,
      brief: `Branch ${t.branch} conflicts with ${M.mainBranch}. In the work dir run \`git merge ${M.mainBranch}\`, resolve every conflict keeping the intent of both sides, run checks, and commit the merge.\nConflict output:\n${tail(m.out, 1200)}` }, t.part);
    ev('conflict', { id: t.id }); touch(); return;
  }
  ev('merge', { id: base.id });
  removeWorktree(base.wt, base.branch);
  if (t.kind === 'integrate') { base.status = 'done'; base.ended = iso(); ev('done', { id: base.id }); afterDone(base, base.result || {}); }
  t.status = 'done'; ev('done', { id: t.id, kind: t.kind }); afterDone(t, r); touch();
}

function afterDone(t, r) {
  if (['verify', 'security'].includes(t.kind)) {
    (r.bugs || []).forEach((b, i) => {
      append('BUGS.md', `- [found by ${t.id}] ${b.title}: ${String(b.detail || '').slice(0, 300)}`);
      addTask({ id: `F-${t.id}-${i + 1}`, kind: 'fix', tier: b.tier || 'normal', risky: t.kind === 'security', area: b.area ? [b.area] : [], bug: b, title: `Fix: ${b.title}`,
        brief: `Fix this defect found by ${t.id}. Reproduce first (write a failing test when practical), fix the root cause, run checks.\n${JSON.stringify(b, null, 1)}` }, t.part)
        .fromVerify = t.id;
      ev('bug', { id: t.id, title: b.title });
    });
  }
}

function fail(t, why) {
  t.attempts++; t.lastError = why; t.ended = iso();
  if (!t.wtOf) removeWorktree(t.wt, t.branch);
  if (t.attempts >= M.maxAttempts) {
    t.status = 'unresolved';
    append('BUGS.md', `- UNRESOLVED ${t.id} "${t.title}" after ${t.attempts} attempts (last ${t.lastModel}/${t.lastEffort}): ${tail(why, 400).replace(/\s+/g, ' ')}`);
    if (t.kind === 'integrate' && B.tasks[t.wtOf]) { const b = B.tasks[t.wtOf]; b.status = 'unresolved'; removeWorktree(b.wt, b.branch); }
    ev('unresolved', { id: t.id });
  } else {
    if (t.kind !== 'report' && t.rung != null) route.escalate(t);
    t.status = 'ready';
    ev('escalate', { id: t.id, attempt: t.attempts, ...route.pick(t) });
  }
  touch();
}

function pause(min, why) {
  M.pausedUntil = now() + min * 60000;
  ev('pause', { minutes: Math.round(min), why }); note(`pause ${Math.round(min)}m: ${why}`); touch();
}

function recordUsage(t, j, model, effort) {
  const u = j.usage || {};
  const rec = { t: iso(), id: t.id, kind: t.kind, model, effort, in: u.input_tokens || 0, out: u.output_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0, usd: j.total_cost_usd || 0, turns: j.num_turns || 0, ms: j.duration_ms || 0 };
  append('usage.jsonl', JSON.stringify(rec));
  const a = M.usage[model] ||= { runs: 0, in: 0, out: 0, cacheRead: 0, cacheWrite: 0, usd: 0 };
  a.runs++; for (const k of ['in', 'out', 'cacheRead', 'cacheWrite', 'usd']) a[k] += rec[k];
  ev('usage', { id: t.id, model, out: rec.out, in: rec.in + rec.cacheRead + rec.cacheWrite });
}

// ---- status & summary ----------------------------------------------------------
function counts() { const c = {}; for (const t of tasks()) c[t.status] = (c[t.status] || 0) + 1; return c; }
function writeStatus() {
  const c = counts(), run = running();
  const q = tasks().filter(t => t.status === 'waiting');
  const lines = [
    `stage: ${M.stage} | intake: ${M.intakeClosed ? 'closed' : 'open'} | ${Object.entries(c).map(([k, v]) => `${k} ${v}`).join(', ') || 'no tasks'}`,
    M.pausedUntil ? `PAUSED until ${new Date(M.pausedUntil).toLocaleString()}${M.authError ? ' (CLI not logged in)' : ''}` : 'active',
    `running: ${run.map(t => `${t.id}[${t.lastModel}/${t.lastEffort}]`).join(' ') || '-'}`,
    `questions waiting: ${q.map(t => t.qid).join(' ') || '-'}`,
    `parts: ${Object.entries(B.parts).map(([k, P]) => `${k}:${P.state}${P.final ? '' : '(open)'}${P.epoch ? '(changed x' + P.epoch + ')' : ''}`).join(' ') || '-'}`,
    `changes: ${(M.changeLog || []).map(c => `${c.tag} ${c.parts.join('+')}${c.stopped.length ? ' stopped ' + c.stopped.join(',') : ''}`).join(' | ') || '-'}`,
    `tokens out: ${Object.entries(M.usage).map(([m, u]) => `${m} ${u.out}`).join(', ') || '0'}`,
    '',
    ...tasks().map(t => `${t.status.padEnd(11)} ${t.id.padEnd(14)} ${(t.lastModel || '').padEnd(7)} ${t.title}`),
  ];
  fs.writeFileSync(path.join(O, 'STATUS.md'), lines.join('\n') + '\n');
}

function writeSummary() {
  const rd = f => { try { return fs.readFileSync(path.join(O, f), 'utf8'); } catch { return '(none)\n'; } };
  const rows = tasks().map(t => `| ${t.id} | ${t.part} | ${t.kind} | ${t.status} | ${t.lastModel || '-'}/${t.lastEffort || '-'} | ${t.attempts} | ${(t.summary || t.lastError || '').replace(/\|/g, '/').replace(/\s+/g, ' ').slice(0, 160)} |`);
  const usage = Object.entries(M.usage).map(([m, u]) => `| ${m} | ${u.runs} | ${u.in} | ${u.cacheRead} | ${u.cacheWrite} | ${u.out} | ${u.usd.toFixed(2)} |`);
  fs.writeFileSync(path.join(O, 'summary.md'), [
    `# OPFR summary ${iso()}`, '', `Started ${M.created}, intake closed ${M.intakeClosedAt || '-'}.`, '',
    '| task | part | kind | status | model/effort | attempts | summary |', '|---|---|---|---|---|---|---|', ...rows, '',
    '## Usage', '| model | runs | input | cache read | cache write | output | usd (API-equivalent) |', '|---|---|---|---|---|---|---|', ...usage, '',
    '## Plan changes', ...(M.changeLog || []).map(c => `- ${c.tag} ${c.t}: parts ${c.parts.join(', ')}: ${c.note || '-'} (stopped ${c.stopped.join(', ') || '-'}; dropped ${c.dropped.join(', ') || '-'}; new ${c.added.join(', ') || '-'}${c.reset ? '; reran from ' + c.reset : ''})`), (M.changeLog || []).length ? '' : '(none)\n',
    '## Decisions', rd('DECISIONS.md'), '## Bugs and unresolved', rd('BUGS.md'), '## Blocked actions', rd('BLOCKED.md'),
  ].join('\n'));
}

// ---- main loop -----------------------------------------------------------------
function recover() {
  for (const t of tasks()) if (t.status === 'running') { t.status = 'ready'; if (!t.wtOf) removeWorktree(t.wt, t.branch); note('recovered ' + t.id); }
  if (!git(['rev-parse', '--verify', 'HEAD']).ok) git(['commit', '--allow-empty', '-q', '-m', 'opfr: init']);
  M.mainBranch ||= git(['symbolic-ref', '--short', 'HEAD']).out.trim() || 'main';
  touch();
}

function stopIfAsked() {
  if (!fs.existsSync(path.join(O, 'STOP'))) return;
  for (const [id, child] of procs) { killTree(child.pid); const t = B.tasks[id]; t.status = 'ready'; t.stopped = true; }
  ev('stopped'); note('stopped by STOP file'); touch(); save(true); process.exit(0);
}

function tick() {
  try {
    stopIfAsked();
    processInbox();
    // Started on a finished run with no change op in the inbox: nothing to do.
    if (M.stage === 'finished') { note('run already finished'); fs.writeFileSync(path.join(O, 'DONE'), M.finishedAt || iso()); save(true); process.exit(0); }
    checkIdleIntake();
    checkDeadline();
    promote();
    advanceParts();
    advanceGlobal();
    schedule();
  } catch (e) { note('tick error: ' + (e.stack || e.message)); }
  save();
}

recover();
ev('dispatcher-start', { pid: process.pid });
note('start pid ' + process.pid);
save();
setInterval(tick, TICK_MS);
tick();
