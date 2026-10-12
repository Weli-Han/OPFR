// End-to-end dispatcher test with the mock CLI (zero tokens). Run: node test/e2e.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const D = path.resolve(__dirname, '..', 'dispatcher');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opfr-e2e-'));
const opfr = (...a) => execFileSync(process.execPath, [path.join(D, 'opfr.js'), ...a], { encoding: 'utf8' });
const P = opfr('init', 'demo', '--model', 'claude-opus-5-5', '--root', root).trim();
const O = path.join(P, '.opfr');
const op = o => opfr('op', P, JSON.stringify(o));
const t = (id, extra = {}) => ({ id, title: id, brief: 'brief ' + id, tier: 'normal', ...extra });

op({ op: 'meta', set: { maxParallel: 3, intakeIdleMin: 0, taskTimeoutMin: 2 } });
op({ op: 'part', part: 'A', title: 'Part A', final: true, tasks: [t('A1', { area: ['a'] }), t('A2', { deps: ['A1'], area: ['s1'] })] });
op({ op: 'part', part: 'B', title: 'Part B', final: true, tasks: [t('B1', { area: ['s2'] }), t('B2', { tier: 'simple' }), t('RL', { tier: 'simple' })] });
op({ op: 'part', part: 'C', title: 'Part C', tasks: [t('C1'), t('C2', { tier: 'complex' })] });
op({ op: 'draft', part: 'D', title: 'Part D', tasks: [t('D1')] });

const env = { ...process.env, OPFR_CLAUDE: process.execPath, OPFR_CLAUDE_PREFIX: JSON.stringify([path.join(__dirname, 'mock-claude.js')]) };
const child = spawn(process.execPath, [path.join(D, 'dispatcher.js'), P], { env, stdio: 'inherit' });
// OPFR_E2E_OFFICE=<port> also starts the live office view for this run.
const office = process.env.OPFR_E2E_OFFICE ? spawn(process.execPath, [path.join(__dirname, '..', 'office', 'server.js'), P, '--port', process.env.OPFR_E2E_OFFICE], { stdio: 'inherit' }) : null;

let answered = false, closed = false, done = false;
const started = Date.now();
const iv = setInterval(() => {
  const q = opfr('questions', P).trim();
  if (q && !answered) { opfr('answer', P, JSON.parse(q.split('\n')[0]).qid, 'red'); answered = true; }
  if (answered && !closed) { op({ op: 'part', part: 'C', final: true }); op({ op: 'close' }); closed = true; }
  if (Date.now() - started > 400000) { console.log('TIMEOUT'); child.kill(); }
}, 1500);
child.on('exit', finish);

function finish() {
  if (done) return; done = true;
  clearInterval(iv);
  const rd = f => { try { return fs.readFileSync(path.join(O, f), 'utf8'); } catch { return ''; } };
  const b = JSON.parse(rd('board.json'));
  const st = Object.fromEntries(Object.values(b.tasks).map(x => [x.id, x.status]));
  const calls = rd('mock-calls.txt');
  const has = f => fs.existsSync(path.join(P, f));
  const wtDir = path.join(root, '.wt', path.basename(P));
  const checks = [
    ['finished', b.meta.stage === 'finished' && fs.existsSync(path.join(O, 'DONE'))],
    ['A1 merged', has('a1.txt')],
    ['conflict integrated', st['I-A2'] === 'done' || st['I-B1'] === 'done'],
    ['shared merged', has('shared.txt') && /A2[\s\S]*B1/.test(fs.readFileSync(path.join(P, 'shared.txt'), 'utf8'))],
    ['B2 escalated haiku high to xhigh', /B2 haiku high[\s\S]*B2 haiku xhigh/.test(calls) && has('b2.txt')],
    ['rate limit paused and retried', st.RL === 'done' && /"pause"/.test(rd('events.jsonl'))],
    ['question answered', has('c1.txt') && fs.readFileSync(path.join(P, 'c1.txt'), 'utf8').trim() === 'red'],
    ['C2 unresolved', st.C2 === 'unresolved' && /UNRESOLVED C2/.test(rd('BUGS.md'))],
    ['C2 escalated sonnet high to xhigh', /C2 sonnet high[\s\S]*C2 sonnet xhigh/.test(calls)],
    ['draft D promoted', st.D1 === 'done' && /Part D built from draft/.test(rd('DECISIONS.md'))],
    ['verify bug fixed, round 2', st['F-V1-A-1'] === 'done' && st['V2-A'] === 'done' && has('fix-F-V1-A-1.txt')],
    ['security + final', st.SEC === 'done' && st.FINAL === 'done'],
    ['report on conductor model', st.REPORT === 'done' && /REPORT claude-opus-5-5 high/.test(calls) && has('REPORT.md')],
    ['decisions logged', /used txt/.test(rd('DECISIONS.md'))],
    ['usage logged', rd('usage.jsonl').trim().split('\n').length > 10],
    ['no worktrees left', !fs.existsSync(wtDir) || fs.readdirSync(wtDir).length === 0],
  ];
  let bad = 0;
  for (const [n, ok] of checks) { console.log((ok ? 'PASS ' : 'FAIL ') + n); if (!ok) bad++; }
  console.log(JSON.stringify(st));
  console.log('project: ' + P + ' (' + Math.round((Date.now() - started) / 1000) + 's)');
  const hold = office ? Number(process.env.OPFR_E2E_OFFICE_HOLD_MS || 0) : 0;
  setTimeout(() => { if (office) office.kill(); process.exit(bad ? 1 : 0); }, hold);
}
