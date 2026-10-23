// End-to-end dispatcher test with the mock CLI (zero tokens). Run: node test/e2e.js
// Two projects run at once: "demo" covers the full lifecycle, "change" covers plan changes mid-run.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const D = path.resolve(__dirname, '..', 'dispatcher');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opfr-e2e-'));
const opfr = (...a) => execFileSync(process.execPath, [path.join(D, 'opfr.js'), ...a], { encoding: 'utf8' });
const t = (id, extra = {}) => ({ id, title: id, brief: 'brief ' + id, tier: 'normal', ...extra });
const env = { ...process.env, OPFR_NOTIFY: '0', OPFR_CLAUDE: process.execPath, OPFR_CLAUDE_PREFIX: JSON.stringify([path.join(__dirname, 'mock-claude.js')]) };
const dispatch = p => spawn(process.execPath, [path.join(D, 'dispatcher.js'), p], { env, stdio: 'inherit' });
const exited = c => new Promise(r => c.on('exit', r));
const rd = (p, f) => { try { return fs.readFileSync(path.join(p, '.opfr', f), 'utf8'); } catch { return ''; } };
const board = p => { try { return JSON.parse(rd(p, 'board.json')); } catch { return null; } };
const status = p => Object.fromEntries(Object.values(board(p).tasks).map(x => [x.id, x.status]));
const has = (p, f) => fs.existsSync(path.join(p, f));
const noWorktrees = p => { const w = path.join(root, '.wt', path.basename(p)); return !fs.existsSync(w) || fs.readdirSync(w).length === 0; };
const started = Date.now();
const waitFor = (cond, ms = 300000) => new Promise((res, rej) => {
  const iv = setInterval(() => {
    let ok = false; try { ok = cond(); } catch {}
    if (ok) { clearInterval(iv); res(); } else if (Date.now() - started > ms) { clearInterval(iv); rej(new Error('TIMEOUT')); }
  }, 500);
});

// ---- demo: full lifecycle -------------------------------------------------------
async function demo() {
  const P = opfr('init', 'demo', '--model', 'claude-opus-5-5', '--root', root).trim();
  const op = o => opfr('op', P, JSON.stringify(o));
  op({ op: 'meta', set: { maxParallel: 3, intakeIdleMin: 0, taskTimeoutMin: 2 } });
  op({ op: 'part', part: 'A', title: 'Part A', final: true, tasks: [t('A1', { area: ['a'] }), t('A2', { deps: ['A1'], area: ['s1'] })] });
  op({ op: 'part', part: 'B', title: 'Part B', final: true, tasks: [t('B1', { area: ['s2'] }), t('B2', { tier: 'simple' }), t('RL', { tier: 'simple' })] });
  op({ op: 'part', part: 'C', title: 'Part C', tasks: [t('C1'), t('C2', { tier: 'complex' })] });
  op({ op: 'draft', part: 'D', title: 'Part D', tasks: [t('D1')] });

  const child = dispatch(P);
  // OPFR_E2E_OFFICE=<port> also starts the live office view for this run.
  const office = process.env.OPFR_E2E_OFFICE ? spawn(process.execPath, [path.join(__dirname, '..', 'office', 'server.js'), P, '--port', process.env.OPFR_E2E_OFFICE], { stdio: 'inherit' }) : null;
  let answered = false, closed = false;
  const iv = setInterval(() => {
    const q = opfr('questions', P).trim();
    if (q && !answered) { opfr('answer', P, JSON.parse(q.split('\n')[0]).qid, 'red'); answered = true; }
    if (answered && !closed) { op({ op: 'part', part: 'C', final: true }); op({ op: 'close' }); closed = true; }
    if (Date.now() - started > 400000) { console.log('TIMEOUT'); child.kill(); }
  }, 1500);
  await exited(child);
  clearInterval(iv);

  const b = board(P), st = status(P), calls = rd(P, 'mock-calls.txt');
  console.log('demo ' + JSON.stringify(st));
  const hold = office ? Number(process.env.OPFR_E2E_OFFICE_HOLD_MS || 0) : 0;
  if (office) setTimeout(() => office.kill(), hold);
  return [
    ['finished', b.meta.stage === 'finished' && has(P, '.opfr/DONE')],
    ['finish notification', /"type":"notify","title":"OPFR: demo finished","body":"\d+ tasks done, 1 unresolved/.test(rd(P, 'events.jsonl'))],
    ['A1 merged', has(P, 'a1.txt')],
    ['conflict integrated', st['I-A2'] === 'done' || st['I-B1'] === 'done'],
    ['shared merged', has(P, 'shared.txt') && /A2[\s\S]*B1/.test(fs.readFileSync(path.join(P, 'shared.txt'), 'utf8'))],
    ['B2 escalated haiku high to xhigh', /B2 haiku high[\s\S]*B2 haiku xhigh/.test(calls) && has(P, 'b2.txt')],
    ['rate limit paused and retried', st.RL === 'done' && /"pause"/.test(rd(P, 'events.jsonl'))],
    ['question answered', has(P, 'c1.txt') && fs.readFileSync(path.join(P, 'c1.txt'), 'utf8').trim() === 'red'],
    ['C2 unresolved', st.C2 === 'unresolved' && /UNRESOLVED C2/.test(rd(P, 'BUGS.md'))],
    ['C2 escalated sonnet high to xhigh', /C2 sonnet high[\s\S]*C2 sonnet xhigh/.test(calls)],
    ['draft D promoted', st.D1 === 'done' && /Part D built from draft/.test(rd(P, 'DECISIONS.md'))],
    ['verify bugs fixed in one task, round 2', st['F-V1-A'] === 'done' && !st['F-V1-A-2'] && b.tasks['F-V1-A'].tier === 'normal' && st['V2-A'] === 'done' && has(P, 'fix-F-V1-A.txt')],
    ['part without areas runs serially', /^B2 /m.test(calls) && /^RL /m.test(calls) && !/OVERLAP/.test(calls)],
    ['worker starts light', (a => { try { a = JSON.parse(a); } catch { return false; }
      const s = a[a.indexOf('--settings') + 1] || '';
      return !a.includes('--plugin-dir') && a.includes('--disable-slash-commands') && a[a.indexOf('--tools') + 1] === 'Read,Edit,Write,Bash,Grep,Glob' &&
        fs.existsSync(s) && fs.readFileSync(s, 'utf8').includes(path.resolve(__dirname, '..', 'hooks', 'guard.js').replace(/\\/g, '/'));
    })(rd(P, 'mock-args.json'))],
    ['security + final', st.SEC === 'done' && st.FINAL === 'done'],
    ['report on conductor model', st.REPORT === 'done' && /REPORT claude-opus-5-5 high/.test(calls) && has(P, 'REPORT.md')],
    ['decisions logged', /used txt/.test(rd(P, 'DECISIONS.md'))],
    ['usage logged', rd(P, 'usage.jsonl').trim().split('\n').length > 10],
    ['no worktrees left', noWorktrees(P)],
  ];
}

// ---- change: plan changes mid-run and after the finish ------------------------------
async function change() {
  const P = opfr('init', 'change', '--model', 'claude-opus-5-5', '--root', root).trim();
  const op = o => opfr('op', P, JSON.stringify(o));
  const running = id => board(P).tasks[id]?.status === 'running';
  op({ op: 'meta', set: { maxParallel: 3, intakeIdleMin: 0, taskTimeoutMin: 2 } });
  op([{ op: 'part', part: 'X', title: 'Part X', final: true, tasks: [t('X1')] }, { op: 'part', part: 'Y', title: 'Part Y', final: true, tasks: [t('Y1')] }, { op: 'close' }]);

  // 1. Y changes while X1 and Y1 both run: Y1 is killed, X1 goes on. The reused id Y1 becomes Y1-2.
  let child = dispatch(P);
  await waitFor(() => running('X1') && running('Y1'));
  opfr('change', P, JSON.stringify({ parts: ['Y'], note: 'Y says blue', tasks: [t('Y1', { brief: 'Write y.txt with blue' })] }));
  await exited(child);
  const s1 = status(P), finished1 = board(P).meta.stage === 'finished' && has(P, '.opfr/DONE');
  console.log('change#1 ' + JSON.stringify(s1));

  // 2. Change X after the finish: the run reopens, XC1 edits the merged x.txt, X is verified again.
  //    A second change to Y while SEC-2 runs sends the run back to the parts stage.
  const out = opfr('change', P, JSON.stringify({ parts: ['X'], note: 'X gets a second line', tasks: [t('XC1', { brief: 'Append a line to x.txt' })] }));
  const reopened = /reopened/.test(out) && !has(P, '.opfr/DONE') && /not applied yet/.test(opfr('status', P));
  child = dispatch(P);
  await waitFor(() => running('SEC-2'));
  opfr('change', P, JSON.stringify({ parts: ['Y'], note: 'Y also green', tasks: [t('YC2', { brief: 'Add green to y.txt' })] }));
  await exited(child);
  const b = board(P), st = status(P), calls = rd(P, 'mock-calls.txt'), dec = rd(P, 'DECISIONS.md');
  console.log('change#2 ' + JSON.stringify(st));
  const x = has(P, 'x1.txt') ? fs.readFileSync(path.join(P, 'x1.txt'), 'utf8') : '';
  const y = has(P, 'y.txt') ? fs.readFileSync(path.join(P, 'y.txt'), 'utf8') : '';
  const finished = b.meta.stage === 'finished' && has(P, '.opfr/DONE');
  // Only safe to call `opfr start` (which would launch a real runner) when it must refuse.
  const startRefused = finished && !/not applied yet/.test(opfr('status', P)) && /run finished/.test(opfr('start', P));
  return [
    ['change: running worker of changed part killed', s1.Y1 === 'cancelled' && b.tasks.Y1.cancelledBy === 'c1' && calls.split('\n').filter(l => l.startsWith('Y1 ')).length === 1 && !has(P, 'y1.txt')],
    ['change: other part kept running', s1.X1 === 'done' && calls.split('\n').filter(l => l.startsWith('X1 ')).length === 1 && has(P, 'x1.txt')],
    ['change: new task id renamed, merged, part re-verified', s1['Y1-2'] === 'done' && /blue/.test(y) && s1['V1-Y'] === 'done' && b.tasks['V1-Y'].epoch === 1 && finished1],
    ['change after finish reopens run', reopened],
    ['change task edits merged code', st.XC1 === 'done' && /x1\nchanged/.test(x) && st['V1-X-2'] === 'done' && b.tasks['V1-X-2'].epoch === 1],
    ['change during security resets final stage', st['SEC-2'] === 'cancelled' && st.YC2 === 'done' && /green/.test(y) && st['V1-Y-2'] === 'done' && st['SEC-3'] === 'done' && st['FINAL-2'] === 'done'],
    ['change: finished again with new report', finished && st['REPORT-2'] === 'done' && /Plan changes[\s\S]*c3/.test(rd(P, 'summary.md'))],
    ['summary has exact task totals', (m => !!m && +m[1] === Object.keys(b.tasks).length - 1)(/Totals \(exact[^)]*\): (\d+) tasks before the report/.exec(rd(P, 'summary.md')))],
    ['change logged', /\[change c1\] parts Y[\s\S]*\[change c2\] parts X[\s\S]*\[change c3\] parts Y.*security stage reset/.test(dec)],
    ['change: start refuses finished run', startRefused],
    ['change: no worktrees left', noWorktrees(P)],
  ];
}

// ---- check: a passing check command replaces the per-part LLM verify ---------------
async function check() {
  const P = opfr('init', 'check', '--model', 'claude-opus-5-5', '--root', root).trim();
  const op = o => opfr('op', P, JSON.stringify(o));
  op({ op: 'meta', set: { maxParallel: 2, intakeIdleMin: 0, taskTimeoutMin: 2, verifyCmd: 'node -e "process.exit(0)"' } });
  op([{ op: 'part', part: 'K', title: 'Part K', final: true, tasks: [t('K1'), t('K2', { area: ['k'] })] }, { op: 'close' }]);
  await exited(dispatch(P));
  const st = status(P);
  console.log('check ' + JSON.stringify(st));
  return [
    ['check: part verify skipped when the check passes', st.K1 === 'done' && st.K2 === 'done' && !Object.keys(st).some(id => /^V\d/.test(id)) &&
      /"type":"verify-skip","part":"K"/.test(rd(P, 'events.jsonl')) && /LLM verify of this part left to FINAL/.test(rd(P, 'DECISIONS.md'))],
    ['check: final verify still runs', st.FINAL === 'done' && st.REPORT === 'done' && board(P).meta.stage === 'finished'],
  ];
}

Promise.all([demo(), change().catch(e => [['change scenario: ' + e.message, false]]), check().catch(e => [['check scenario: ' + e.message, false]])]).then(([a, c, k]) => {
  let bad = 0;
  for (const [n, ok] of [...a, ...c, ...k]) { console.log((ok ? 'PASS ' : 'FAIL ') + n); if (!ok) bad++; }
  console.log('root: ' + root + ' (' + Math.round((Date.now() - started) / 1000) + 's)');
  const hold = process.env.OPFR_E2E_OFFICE ? Number(process.env.OPFR_E2E_OFFICE_HOLD_MS || 0) : 0;
  setTimeout(() => process.exit(bad ? 1 : 0), hold);
});
