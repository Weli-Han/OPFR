#!/usr/bin/env node
// OPFR helper CLI for the conductor. Commands:
//   init <slug> --model <id> [--root <dir>]          create project + board, print path
//   root                                              print the default work root
//   start <project>                                   start dispatcher outside this session (keeps running);
//                                                     reopens a finished run when a change op is pending
//   resume-all [--dry]                                restart every unfinished, unstopped project (run at Windows login)
//   autostart [auto|off]                              add/remove the login entry (auto: only while a project is unfinished)
//   stop <project>                                    stop dispatcher and workers (tasks resume on next start)
//   status <project> [--full]                         compact progress
//   questions <project>                               open worker questions (JSON lines)
//   answer <project> <qid> <text...>                  answer a worker question
//   op <project> <json>                               queue one raw op (meta/part/draft/task/cancel/change/close)
//   change <project> <json>                           queue a plan change {"parts":[..],"note":"..","tasks":[..]}
//   ping <project>                                    mark the user as present (delays idle auto-close)
//   office <project> [--port <n>] [--lan]             this project's own office site (free port from 7788 up), print URL
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const [cmd, ...rest] = process.argv.slice(2);
const flag = (n, d) => { const i = rest.indexOf('--' + n); return i >= 0 ? rest[i + 1] : d; };
const opfr = p => path.join(path.resolve(p), '.opfr');
const PLUGIN = path.resolve(__dirname, '..');

function queue(project, ops) {
  const dir = path.join(opfr(project), 'inbox');
  fs.mkdirSync(dir, { recursive: true });
  const name = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 6)}.json`;
  fs.writeFileSync(path.join(dir, name + '.tmp'), JSON.stringify(ops));
  fs.renameSync(path.join(dir, name + '.tmp'), path.join(dir, name));
  return name;
}
// Work root: OPFR_ROOT, else D:\opfr-work when drive D: exists on Windows, else ~/opfr-work.
function workRoot() {
  if (process.env.OPFR_ROOT) return path.resolve(process.env.OPFR_ROOT);
  if (process.platform === 'win32' && fs.existsSync('D:\\')) return 'D:\\opfr-work';
  return path.join(require('os').homedir(), 'opfr-work');
}
const pending = p => { try { return fs.readdirSync(path.join(opfr(p), 'inbox')).filter(f => f.endsWith('.json')).length; } catch { return 0; } };
function git(args, cwd) { return spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }); }
function alive(project) {
  try {
    const f = path.join(opfr(project), 'dispatcher.pid');
    // A pid file older than the last boot is stale even if the number was reused.
    if (fs.statSync(f).mtimeMs < Date.now() - require('os').uptime() * 1000) return 0;
    const pid = Number(fs.readFileSync(f, 'utf8')); process.kill(pid, 0); return pid;
  } catch { return 0; }
}
// URL of this project's live office, or ''. office.json is written by office/server.js.
function officeUrl(project) {
  try {
    const f = path.join(opfr(project), 'office.json');
    if (fs.statSync(f).mtimeMs < Date.now() - require('os').uptime() * 1000) return '';
    const o = JSON.parse(fs.readFileSync(f, 'utf8')); process.kill(o.pid, 0); return o.url;
  } catch { return ''; }
}
// Registry of started projects, so resume-all also finds projects outside the work root.
const REG = path.join(process.env.OPFR_HOME || path.join(require('os').homedir(), '.opfr'), 'projects.txt');
const readReg = () => { try { return fs.readFileSync(REG, 'utf8').split('\n').map(s => s.trim()).filter(Boolean); } catch { return []; } };
const has = (p, f) => fs.existsSync(path.join(opfr(p), f));
const unfinished = p => has(p, 'board.json') && !has(p, 'DONE') && !has(p, 'STOP');
function writeReg(list) { fs.mkdirSync(path.dirname(REG), { recursive: true }); fs.writeFileSync(REG, list.map(p => p + '\n').join('')); }
function startRunner(p) {
  try { fs.unlinkSync(path.join(opfr(p), 'STOP')); } catch {}
  writeReg([...new Set([...readReg().filter(unfinished), p])]);
  if (process.platform === 'win32') {
    // Win32_Process.Create starts the runner outside this session's job object,
    // so it survives when the Claude session or terminal closes.
    const ps1 = path.join(PLUGIN, 'runner', 'run.ps1');
    const line = `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${ps1}" -Project "${p}"`;
    const r = spawnSync('powershell.exe', ['-NoProfile', '-Command',
      `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${line.replace(/'/g, "''")}'; CurrentDirectory = '${p.replace(/'/g, "''")}' }; "$($r.ReturnValue) $($r.ProcessId)"`],
    { encoding: 'utf8', windowsHide: true });
    return 'runner: ' + (r.stdout || r.stderr).trim();
  }
  const { spawn } = require('child_process');
  spawn('sh', [path.join(PLUGIN, 'runner', 'run.sh'), p], { detached: true, stdio: 'ignore' }).unref();
  return 'runner started';
}
// Per-user login entry (Windows Startup folder). The runner calls this, because it runs outside
// the Claude app sandbox, where %APPDATA% is the real one.
function autostart(mode) {
  if (process.platform !== 'win32') return 'autostart: Windows only; elsewhere add `node opfr.js resume-all` to cron @reboot';
  const dir = process.env.OPFR_STARTUP_DIR || path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  const f = path.join(dir, 'opfr-resume.cmd');
  const left = readReg().filter(unfinished);
  writeReg(left);
  if (mode === 'off' || !left.length) { try { fs.unlinkSync(f); } catch {} return 'autostart: off'; }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(f, ['@echo off', 'rem OPFR: resume unfinished projects after login. Removed automatically when all are done.',
    `start "" /min "${process.execPath}" "${__filename}" resume-all`, ''].join('\r\n'));
  return `autostart: on (${left.length} unfinished) ${f}`;
}

switch (cmd) {
  case 'init': {
    const slug = String(rest[0] || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '');
    if (!slug) { console.error('slug required'); process.exit(1); }
    const root = flag('root', process.platform === 'win32' ? 'D:\\opfr-work' : path.join(require('os').homedir(), 'opfr-work'));
    let p = path.join(root, slug), n = 2;
    while (fs.existsSync(path.join(p, '.opfr'))) p = path.join(root, `${slug}-${n++}`);
    const o = path.join(p, '.opfr');
    for (const d of ['inbox/done', 'results', 'briefs', 'logs', 'scratch', 'spec']) fs.mkdirSync(path.join(o, d), { recursive: true });
    if (!fs.existsSync(path.join(p, '.git'))) {
      git(['init', '-q', '-b', 'main'], p);
      git(['config', 'user.name', 'opfr'], p);
      git(['config', 'user.email', 'opfr@localhost'], p);
      git(['config', 'core.autocrlf', 'false'], p);
    }
    const gi = path.join(p, '.gitignore');
    if (!fs.existsSync(gi)) fs.writeFileSync(gi, '.opfr/\nnode_modules/\n.venv/\n__pycache__/\n.env\n.env.*\n*.log\n');
    git(['add', '.gitignore'], p);
    git(['commit', '-q', '-m', 'opfr: init', '--no-verify'], p);
    const board = { meta: { slug, project: p, created: new Date().toISOString(), conductorModel: flag('model', 'opus'), conductorEffort: flag('effort', 'high'), intakeClosed: false, mainBranch: 'main', stage: 'parts' }, parts: {}, tasks: {}, seq: 0 };
    fs.writeFileSync(path.join(o, 'board.json'), JSON.stringify(board, null, 1));
    fs.writeFileSync(path.join(o, 'permissions.json'), JSON.stringify({ install: false, net: false, docker: false, push: false, publish: false, deploy: false, ssh: false, systemInstall: false, allowCmd: [], denyCmd: [] }, null, 1));
    for (const f of ['DECISIONS.md', 'BUGS.md', 'BLOCKED.md']) fs.writeFileSync(path.join(o, f), '');
    console.log(p);
    break;
  }
  case 'start': {
    const p = path.resolve(rest[0]);
    if (alive(p)) { console.log('already running pid ' + alive(p)); break; }
    const done = path.join(opfr(p), 'DONE');
    if (fs.existsSync(done)) {
      if (!pending(p)) { console.log('run finished; queue a change first (opfr change)'); break; }
      fs.unlinkSync(done); // the runner loops until DONE; the dispatcher applies the pending ops
    }
    console.log(startRunner(p));
    break;
  }
  case 'resume-all': {
    for (const p of readReg().filter(unfinished)) {
      if (alive(p)) console.log(`${p}: already running`);
      else console.log(`${p}: ` + (rest.includes('--dry') ? 'would start' : startRunner(p)));
    }
    if (!rest.includes('--dry')) console.log(autostart('auto'));
    break;
  }
  case 'autostart': console.log(autostart(rest[0] || 'auto')); break;
  case 'stop': {
    const p = path.resolve(rest[0]);
    fs.writeFileSync(path.join(opfr(p), 'STOP'), new Date().toISOString());
    console.log('stop requested; dispatcher exits within a few seconds');
    break;
  }
  case 'status': {
    const p = path.resolve(rest[0]);
    let s = '';
    try { s = fs.readFileSync(path.join(opfr(p), 'STATUS.md'), 'utf8'); } catch { s = 'no status yet\n'; }
    const lines = s.split('\n');
    console.log((rest.includes('--full') ? lines : lines.slice(0, 7)).join('\n').trim());
    console.log(`dispatcher: ${alive(p) ? 'running pid ' + alive(p) : fs.existsSync(path.join(opfr(p), 'DONE')) ? 'finished' : 'NOT running'}`);
    if (officeUrl(p)) console.log('office: ' + officeUrl(p));
    if (pending(p)) console.log(`inbox: ${pending(p)} op file(s) not applied yet${alive(p) ? '' : ' (run opfr start)'}`);
    break;
  }
  case 'questions': {
    const p = path.resolve(rest[0]);
    const b = JSON.parse(fs.readFileSync(path.join(opfr(p), 'board.json'), 'utf8'));
    const waiting = new Set(Object.values(b.tasks).filter(t => t.status === 'waiting').map(t => t.qid));
    let qs = [];
    try { qs = fs.readFileSync(path.join(opfr(p), 'questions.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch {}
    for (const q of qs) if (waiting.has(q.qid)) console.log(JSON.stringify({ qid: q.qid, part: q.part, text: q.text, options: q.options, recommended: q.recommended }));
    break;
  }
  case 'answer': {
    const [p, qid, ...words] = rest;
    console.log(queue(p, [{ op: 'answer', qid, text: words.join(' ') }]));
    break;
  }
  case 'op': {
    const [p, ...json] = rest;
    console.log(queue(p, JSON.parse(json.join(' '))));
    break;
  }
  case 'change': {
    const [p, ...json] = rest;
    const o = { ...JSON.parse(json.join(' ')), op: 'change' };
    o.parts = [].concat(o.parts || []);
    const errs = [];
    if (!o.parts.length && !(o.tasks || []).some(t => t.part)) errs.push('parts required');
    if (!o.note) errs.push('note required (what changed and why)');
    for (const t of o.tasks || []) if (!t.id || !(t.brief || t.briefFile)) errs.push('each task needs id and brief: ' + JSON.stringify(t).slice(0, 80));
    if (errs.length) { console.error(errs.join('\n')); process.exit(1); }
    const done = path.join(opfr(p), 'DONE'), reopened = fs.existsSync(done);
    if (reopened) fs.unlinkSync(done); // a change reopens a finished run
    console.log(queue(p, [o]));
    console.log(alive(p) ? 'dispatcher running: applies the change within seconds' : `dispatcher not running${reopened ? ' (run was finished, now reopened)' : ''}: run opfr start`);
    break;
  }
  case 'root': console.log(workRoot()); break;
  case 'ping': console.log(queue(rest[0], [{ op: 'meta', set: {} }])); break;
  case 'office': {
    // One office per project, each on its own port. A running one is reused.
    const p = path.resolve(rest[0]), port = flag('port'), info = path.join(opfr(p), 'office.json');
    if (officeUrl(p) && !port) { console.log('office: ' + officeUrl(p)); break; }
    try { fs.unlinkSync(info); } catch {}
    const a = [path.join(PLUGIN, 'office', 'server.js'), p].concat(port ? ['--port', port] : [], rest.includes('--lan') ? ['--lan'] : []);
    const log = fs.openSync(path.join(opfr(p), 'office.log'), 'a');
    require('child_process').spawn(process.execPath, a, { detached: true, stdio: ['ignore', log, log], windowsHide: true }).unref();
    for (let i = 0; i < 50 && !fs.existsSync(info); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    console.log(officeUrl(p) ? 'office: ' + officeUrl(p) : `office did not start, see ${path.join(opfr(p), 'office.log')}`);
    break;
  }
  default:
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1).filter(l => l.startsWith('//')).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
}
