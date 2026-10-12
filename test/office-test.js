// Test: each project gets its own office on its own port; a running office is reused.
// Run: node test/office-test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

const CLI = path.resolve(__dirname, '..', 'dispatcher', 'opfr.js');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'opfr-office-'));
const mk = name => { const o = path.join(T, name, '.opfr'); fs.mkdirSync(o, { recursive: true }); fs.writeFileSync(path.join(o, 'board.json'), '{"meta":{},"tasks":{}}'); return path.join(T, name); };
const office = p => spawnSync(process.execPath, [CLI, 'office', p], { encoding: 'utf8' }).stdout.trim();
const get = url => new Promise(r => http.get(url, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => r(d)); }).on('error', () => r('')));
const pidOf = p => { try { return JSON.parse(fs.readFileSync(path.join(p, '.opfr', 'office.json'), 'utf8')).pid; } catch { return 0; } };

(async () => {
  let bad = 0;
  const ok = (c, l) => { if (!c) { bad++; console.log('FAIL ' + l); } };
  const A = mk('alpha'), B = mk('beta');
  const ua = office(A), ub = office(B);
  const pa = /:(\d+)\//.exec(ua), pb = /:(\d+)\//.exec(ub);
  ok(pa && pb && pa[1] !== pb[1], `two projects, two ports (${ua} | ${ub})`);
  ok(office(A) === ua, 'running office is reused');
  ok(/<title>alpha · OPFR office<\/title>/.test(await get(ua.replace('office: ', ''))), 'page names its project');
  ok(/beta · Conductor Office/.test(await get(ub.replace('office: ', ''))), 'second site shows the second project');
  ok(/office: http/.test(spawnSync(process.execPath, [CLI, 'status', A], { encoding: 'utf8' }).stdout), 'status prints the office URL');
  for (const p of [A, B]) try { process.kill(pidOf(p)); } catch {}
  console.log(`${5 - bad}/5 passed`);
  setTimeout(() => { fs.rmSync(T, { recursive: true, force: true }); process.exit(bad ? 1 : 0); }, 500);
})();
