// Test for resume-all / autostart in dispatcher/opfr.js. Uses temp dirs only; never touches the real
// Startup folder or registry. Run: node test/autostart-test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.resolve(__dirname, '..', 'dispatcher', 'opfr.js');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'opfr-auto-'));
const env = { ...process.env, OPFR_HOME: path.join(T, 'home'), OPFR_STARTUP_DIR: path.join(T, 'startup') };
const run = (...a) => spawnSync(process.execPath, [CLI, ...a], { env, encoding: 'utf8' }).stdout.trim();
const entry = path.join(T, 'startup', 'opfr-resume.cmd');
const mk = (name, ...flags) => {
  const o = path.join(T, name, '.opfr'); fs.mkdirSync(o, { recursive: true });
  fs.writeFileSync(path.join(o, 'board.json'), '{}');
  for (const f of flags) fs.writeFileSync(path.join(o, f), 'x');
  return path.join(T, name);
};
const A = mk('a'), B = mk('b', 'DONE'), C = mk('c', 'STOP');
fs.mkdirSync(env.OPFR_HOME, { recursive: true });
fs.writeFileSync(path.join(env.OPFR_HOME, 'projects.txt'), [A, B, C].join('\n') + '\n');
// Stale pid file from before the last boot must not count as running.
fs.writeFileSync(path.join(A, '.opfr', 'dispatcher.pid'), String(process.pid));
const past = new Date(Date.now() - os.uptime() * 1000 - 60000);
fs.utimesSync(path.join(A, '.opfr', 'dispatcher.pid'), past, past);

let bad = 0;
const ok = (cond, label) => { if (!cond) { bad++; console.log('FAIL ' + label); } };
const win = process.platform === 'win32';

const dry = run('resume-all', '--dry');
ok(dry.includes(`${A}: would start`), 'unfinished project with stale pid is resumed');
ok(!dry.includes(B) && !dry.includes(C), 'finished and stopped projects are skipped');

fs.utimesSync(path.join(A, '.opfr', 'dispatcher.pid'), new Date(), new Date());
ok(run('resume-all', '--dry').includes(`${A}: already running`), 'live dispatcher is not started twice');

const on = run('autostart', 'auto');
if (win) {
  ok(/autostart: on \(1 unfinished\)/.test(on) && fs.existsSync(entry), 'entry added while a project is unfinished');
  ok(/resume-all\r\n$/.test(fs.readFileSync(entry, 'utf8')), 'entry runs resume-all');
}
ok(fs.readFileSync(path.join(env.OPFR_HOME, 'projects.txt'), 'utf8').trim() === A, 'registry pruned to unfinished');

fs.writeFileSync(path.join(A, '.opfr', 'DONE'), 'x');
ok(run('autostart', 'auto') === 'autostart: off' || !win, 'off when nothing is left');
ok(!fs.existsSync(entry), 'entry removed when all are done');

console.log(`${8 - bad}/8 passed`);
fs.rmSync(T, { recursive: true, force: true });
process.exit(bad ? 1 : 0);
