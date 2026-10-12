// Mock `claude -p` for dispatcher tests. Behavior is chosen by OPFR_TASK_ID.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const arg = n => args[args.indexOf(n) + 1];
const id = process.env.OPFR_TASK_ID, res = process.env.OPFR_RESULT, wt = process.cwd(), proj = process.env.OPFR_PROJECT;
const model = arg('--model'), effort = args.includes('--effort') ? arg('--effort') : '-';
const prompt = arg('-p');
const log = path.join(proj, '.opfr', 'mock-calls.txt');
fs.appendFileSync(log, `${id} ${model} ${effort}\n`);
const calls = fs.readFileSync(log, 'utf8').split('\n').filter(l => l.startsWith(id + ' ')).length;

const git = a => spawnSync('git', a, { cwd: wt, encoding: 'utf8' });
const write = (f, s) => fs.writeFileSync(path.join(wt, f), s);
const result = r => fs.writeFileSync(res, JSON.stringify(r));
// OPFR_MOCK_DELAY_MS slows every worker, for watching the office view live.
if (process.env.OPFR_MOCK_DELAY_MS) spawnSync(process.execPath, ['-e', `setTimeout(()=>{},${Number(process.env.OPFR_MOCK_DELAY_MS)})`]);
const out = () => process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'ok', num_turns: 3, duration_ms: 1000, total_cost_usd: 0.01,
  usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 900, cache_creation_input_tokens: 10 } }));

if (id === 'A1') { write('a1.txt', 'a1\n'); result({ status: 'done', summary: 'a1 made', decisions: ['used txt'] }); }
else if (id === 'A2') { write('shared.txt', 'from A2\n'); result({ status: 'done', summary: 'a2' }); }
else if (id === 'B1') { spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},4000)']); write('shared.txt', 'from B1\n'); result({ status: 'done', summary: 'b1' }); }
else if (id === 'B2') { if (calls > 1) { write('b2.txt', 'b2\n'); result({ status: 'done', summary: 'b2 on retry' }); } }
else if (id === 'C1') {
  const a = /Answer to "[^"]*": (.*)/.exec(prompt);
  if (!a) result({ status: 'question', summary: 'need color', question: { text: 'Which color?', options: ['red', 'blue'], recommended: 'blue' } });
  else { write('c1.txt', a[1] + '\n'); result({ status: 'done', summary: 'c1' }); }
}
else if (id === 'C2') result({ status: 'failed', summary: 'cannot' });
else if (id === 'RL') {
  if (calls === 1) { process.stdout.write(JSON.stringify({ type: 'result', is_error: true, result: 'Claude AI usage limit reached|' + Math.floor(Date.now() / 1000 + 2) })); process.exit(1); }
  write('rl.txt', 'x\n'); result({ status: 'done', summary: 'after limit' });
}
// Plan-change scenario (project "change").
else if (id === 'X1' || id === 'Y1') { spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},6000)']); write(id.toLowerCase() + '.txt', id.toLowerCase() + '\n'); result({ status: 'done', summary: id }); }
else if (id === 'Y1-2') { write('y.txt', 'blue\n'); result({ status: 'done', summary: 'blue' }); }
else if (id === 'YC2') { fs.appendFileSync(path.join(wt, 'y.txt'), 'green\n'); result({ status: 'done', summary: 'green' }); }
else if (id === 'XC1') {
  // A change task edits what is already merged, and its prompt says so.
  if (!fs.existsSync(path.join(wt, 'x1.txt')) || !/Plan change c2/.test(prompt)) result({ status: 'failed', summary: 'no merged x1.txt or no change note' });
  else { fs.appendFileSync(path.join(wt, 'x1.txt'), 'changed\n'); result({ status: 'done', summary: 'x changed' }); }
}
else if (id === 'SEC-2') { spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},6000)']); result({ status: 'done', summary: 'clean', bugs: [] }); }
else if (id.startsWith('I-')) {
  git(['merge', 'main']);
  write('shared.txt', 'from A2\nfrom B1\n');
  git(['add', '-A']); git(['commit', '-q', '--no-edit']);
  result({ status: 'done', summary: 'merged' });
}
else if (id === 'V1-A') { write('test-a.txt', 'test\n'); result({ status: 'done', summary: '1 bug', bugs: [{ title: 'a1 missing newline', detail: 'x', area: 'a', tier: 'simple' }] }); }
else if (/^(V\d|FINAL|SEC)/.test(id)) result({ status: 'done', summary: 'clean', bugs: [] });
else if (id.startsWith('F-')) { write('fix-' + id + '.txt', 'fixed\n'); result({ status: 'done', summary: 'fixed' }); }
else if (id.startsWith('REPORT')) { write('REPORT.md', '# Report\n' + fs.readFileSync(path.join(proj, '.opfr', 'summary.md'), 'utf8').slice(0, 300)); result({ status: 'done', summary: 'report' }); }
else result({ status: 'done', summary: 'default' });
out();
