#!/usr/bin/env node
// PreToolUse guard. Deterministic deny rules for OPFR projects and workers:
// writes outside allowed roots, secret files, ~/.claude, destructive or outward
// commands, and installs/network/deploy that permissions.json did not approve.
const os = require('os');
const path = require('path');
const fs = require('fs');
const { readInput, ctx, inside, log, event, home } = require('./lib');

const input = readInput();
const c = ctx(input);
if (!c) process.exit(0);

const tool = input.tool_name || '';
const ti = input.tool_input || {};
const P = c.perms || {};

function deny(reason, detail) {
  const who = c.taskId || 'conductor';
  log(c, 'BLOCKED.md', `- ${new Date().toISOString()} ${who} ${tool}: ${reason}${detail ? ' :: ' + String(detail).replace(/\s+/g, ' ').slice(0, 200) : ''}`);
  event(c, { type: 'blocked', task: c.taskId, tool, reason });
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `OPFR guard: ${reason}. Do not retry this action; pick another way or record it as blocked in your result.`,
    },
  }));
  process.exit(0);
}

const tmp = os.tmpdir();
const roots = c.taskId
  ? [c.worktree, path.join(c.opfr, 'scratch', c.taskId), tmp].filter(Boolean)
  : [c.project, tmp];
const resultFile = c.taskId ? path.join(c.opfr, 'results', c.taskId + '.json') : null;

const SECRET = /([\\/]\.ssh([\\/]|$)|[\\/]\.aws[\\/]|[\\/]\.azure[\\/]|[\\/]\.gnupg[\\/]|[\\/]\.netrc$|[\\/]_netrc$|\.git-credentials|\.credentials\.json|[\\/]\.npmrc$|[\\/]\.pypirc$|[\\/]\.docker[\\/]config\.json|id_(rsa|ed25519|ecdsa|dsa)\b|Login Data|Cookies$|[\\/]Microsoft[\\/]Credentials|[\\/]\.kube[\\/]config)/i;
const claudeHome = path.join(home, '.claude');

function norm(p) {
  if (!p) return p;
  let s = String(p).replace(/^["']|["']$/g, '');
  s = s.replace(/^~(?=[\\/]|$)/, home)
    .replace(/^\$HOME(?=[\\/]|$)/i, home)
    .replace(/^%USERPROFILE%/i, home)
    .replace(/^\$env:USERPROFILE/i, home);
  const m = /^\/([a-zA-Z])(\/.*)?$/.exec(s); // git-bash /d/x -> D:\x
  if (m && process.platform === 'win32') s = m[1].toUpperCase() + ':' + (m[2] || '\\');
  return path.resolve(input.cwd || process.cwd(), s);
}

function writeAllowed(abs) {
  if (resultFile && path.resolve(abs).toLowerCase() === resultFile.toLowerCase()) return true;
  return roots.some(r => inside(abs, r));
}

// ---- file tools -------------------------------------------------------------
const fileTools = { Write: 1, Edit: 1, MultiEdit: 1, NotebookEdit: 1 };
const readTools = { Read: 1, Glob: 1, Grep: 1 };
const fp = ti.file_path || ti.notebook_path || ti.path;

if (fileTools[tool]) {
  const abs = norm(fp);
  if (SECRET.test(abs)) deny('secret file path', abs);
  if (inside(abs, claudeHome)) deny('writes to ~/.claude are not allowed', abs);
  if (!writeAllowed(abs)) deny(`write outside allowed folders (${roots.join(', ')})`, abs);
  process.exit(0);
}
if (readTools[tool]) {
  if (fp && SECRET.test(norm(fp))) deny('secret file path', fp);
  process.exit(0);
}

// ---- shell tools ------------------------------------------------------------
if (tool !== 'Bash' && tool !== 'PowerShell') process.exit(0);
const cmd = String(ti.command || '');
const has = re => re.test(cmd);
const allowExtra = (P.allowCmd || []).some(r => { try { return new RegExp(r, 'i').test(cmd); } catch { return false; } });
for (const r of P.denyCmd || []) { try { if (new RegExp(r, 'i').test(cmd)) deny('command denied by permissions.json', cmd); } catch {} }

// Hard denies: never allowed, whatever permissions say.
const HARD = [
  [/\bgit\s+push\b[^\n]*(\s--force\b|\s-f\b|\s--force-with-lease\b|\s\+\S)/i, 'force push'],
  [/\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)[a-z]*\s+("|')?(\/|~|\$HOME|[a-zA-Z]:[\\/]?)("|')?(\s|$)/i, 'recursive delete of a root folder'],
  [/Remove-Item\b[^\n]*-Recurse[^\n]*\s("|')?([a-zA-Z]:[\\/]?|~|\$HOME|\$env:USERPROFILE)("|')?(\s|$)/i, 'recursive delete of a root folder'],
  [/\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/i, 'pipe download to shell'],
  [/\b(iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^\n]*\|\s*(iex|Invoke-Expression)\b/i, 'pipe download to shell'],
  [/\b(iex|Invoke-Expression)\s*\(?\s*(\(|\$\(|&)?\s*(New-Object\s+Net\.WebClient|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)/i, 'download and execute'],
  [/(^|[\s;&|(])(format(\.com)?\s+[a-z]:|diskpart|bcdedit|shutdown(\.exe)?\s|Stop-Computer|Restart-Computer)/i, 'system-level command'],
  [/\breg(\.exe)?\s+(add|delete|import)\b|Set-ItemProperty\s+[^\n]*HK(LM|CU):|New-ItemProperty\s+[^\n]*HK(LM|CU):/i, 'registry change'],
  [/Set-ExecutionPolicy|\bnetsh\b|New-NetFirewallRule|\bsc(\.exe)?\s+(create|config|delete)\b|New-Service|\bschtasks\b[^\n]*\/create|Register-ScheduledTask/i, 'system or security setting change'],
  [/--dangerously-skip-permissions|bypassPermissions/i, 'permission bypass flag'],
  [/(^|[\s;&|(])claude(\.exe)?\s+(-p|--print)\b/i, 'nested claude session (uncontrolled token use)'],
  [/(webhook\.site|ngrok|pastebin\.com|requestbin|discord(app)?\.com\/api\/webhooks)/i, 'possible exfiltration endpoint'],
];
for (const [re, why] of HARD) if (has(re)) deny(why, cmd);

if (SECRET.test(cmd.replace(/\//g, '\\')) || SECRET.test(cmd)) deny('command touches secret files', cmd);

// Permission-gated categories.
const GATED = [
  ['push', /\bgit\s+push\b/i, 'git push'],
  ['publish', /\b(npm|pnpm|yarn)\s+publish\b|\btwine\s+upload\b|\bcargo\s+publish\b|\bdocker\s+push\b|\bgh\s+(release|pr\s+create|repo\s+create)\b/i, 'publishing'],
  ['deploy', /\b(vercel|netlify\s+deploy|flyctl?\s+deploy|kubectl\s+(apply|delete|create|rollout)|terraform\s+(apply|destroy)|helm\s+(install|upgrade|uninstall)|pulumi\s+up|serverless\s+deploy)\b|(^|[\s;&|])(aws|gcloud|az)\s+\w/i, 'deploy or cloud command'],
  ['ssh', /(^|[\s;&|(])(ssh|scp|sftp)\s|\brsync\b[^\n]*\S+:/i, 'remote shell or copy'],
  ['systemInstall', /\b(npm|pnpm|yarn)\s+(i|install|add)\b[^\n]*\s(-g|--global)\b|\bwinget\s+install|\bchoco\s+install|\bscoop\s+install|\bapt(-get)?\s+install|\bbrew\s+install|Install-Module|\bpip3?\s+install\b[^\n]*--user/i, 'system-wide install'],
  ['install', /\b(npm|pnpm|yarn|bun)\s+(i|install|add|ci)\b|\bpip3?\s+install\b|\buv\s+(add|pip\s+install|sync)\b|\bpoetry\s+(add|install)\b|\bcargo\s+(add|install)\b|\bgo\s+(get|install)\b|\bdotnet\s+add\s+package\b|\bgem\s+install\b/i, 'package install'],
  ['docker', /\bdocker(-compose)?\s+(run|build|compose|up|pull|exec)\b|\bdocker\s+compose\b/i, 'docker'],
];
for (const [key, re, why] of GATED) {
  if (has(re) && !P[key] && !allowExtra) deny(`${why} not approved in permissions.json (${key}=false)`, cmd);
}

// npx downloads packages unless the binary is already local.
const npx = /(^|[\s;&|(])npx\s+(?:-y\s+|--yes\s+)?([@\w./-]+)/i.exec(cmd);
if (npx && !P.install && !allowExtra) {
  const bin = npx[2].replace(/^@[^/]+\//, '').split('@')[0];
  const local = [input.cwd, c.worktree, c.project].filter(Boolean)
    .some(d => fs.existsSync(path.join(d, 'node_modules', '.bin', bin)) || fs.existsSync(path.join(d, 'node_modules', '.bin', bin + '.cmd')));
  if (!local) deny('npx would download a package; install not approved', cmd);
}

// Network to non-local hosts.
const NET = /\b(curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod|Start-BitsTransfer)\b|\bgit\s+(clone|fetch|pull)\s+[^\n]*(https?:|git@)|\bnew\s+Net\.WebClient/i;
if (has(NET) && !P.net && !allowExtra) {
  const hosts = [...cmd.matchAll(/https?:\/\/([^/\s"':]+)/gi)].map(m => m[1].toLowerCase());
  const external = hosts.length === 0 || hosts.some(h => !/^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/.test(h) && !h.endsWith('.localhost'));
  if (external) deny('network access not approved in permissions.json (net=false)', cmd);
}

// Writes or cd outside allowed roots (best-effort: absolute paths in the command).
// Each segment (split on ; && || | outside quotes) is checked on its own, so
// `cd <worktree> && cat <project>/.opfr/briefs/X.md` reads the brief without a deny.
const WRITE = /(>{1,2}|\btee\b|\bcp\b|\bmv\b|\brm\b|\brmdir\b|\bdel\b|\berase\b|\bmkdir\b|\bmd\b|\btouch\b|\bln\b|\bcopy\b|\bmove\b|\bxcopy\b|\brobocopy\b|\bsed\s+-i|\bchmod\b|\bunzip\b|\btar\s+-?x|Copy-Item|Move-Item|Remove-Item|New-Item|Set-Content|Add-Content|Out-File|Expand-Archive|Rename-Item|\bgit\s+(clone|init|worktree)\b|\bcd\b|Set-Location|\bpushd\b|\s-(delete|exec|execdir)\b)/i;
// Commands that only read their path arguments (redirect targets are still checked).
const READER = /^(cat|head|tail|less|more|ls|dir|grep|egrep|fgrep|rg|wc|diff|cmp|stat|file|sort|uniq|cut|awk|jq|test|\[|echo|printf|type|realpath|readlink|dirname|basename|du|tree|Get-Content|gc|Select-String|sls|Get-ChildItem|gci|Test-Path|Get-Item|Resolve-Path|Measure-Object)$/i;
const START = String.raw`(?:[a-zA-Z]:[\\/]|\/[a-zA-Z]\/|~[\\/]|\$HOME[\\/]|\$env:USERPROFILE[\\/]?|%USERPROFILE%[\\/]?)`;
const pathRe = () => new RegExp(String.raw`"(${START}[^"]*)"|'(${START}[^']*)'|(?:^|[\s=(>])(${START}[^\s"'|;&<>)]*)`, 'g');
const redirRe = () => new RegExp(String.raw`\d?>{1,2}\s*(?:"(${START}[^"]*)"|'(${START}[^']*)'|(${START}[^\s"'|;&<>)]*))`, 'g');

function segments(s) {
  const out = []; let cur = '', q = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { if (ch === q) q = ''; cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === ';' || ch === '\n' || (ch === '|' && s[i + 1] !== '|') || ((ch === '&' || ch === '|') && s[i + 1] === ch)) {
      out.push(cur); cur = ''; if (s[i + 1] === ch) i++; continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map(x => x.trim()).filter(Boolean);
}
function checkPath(raw, seg) {
  if (/^\/dev\//.test(raw)) return;
  const abs = norm(raw);
  if (inside(abs, claudeHome)) deny('writes to ~/.claude are not allowed', seg);
  if (!writeAllowed(abs) && !isReadOnlyTool(abs)) deny(`path outside allowed folders: ${abs}`, seg);
}
for (const seg of segments(cmd)) {
  if (!WRITE.test(seg)) continue;
  for (const m of seg.matchAll(redirRe())) checkPath(m[1] || m[2] || m[3], seg);
  const words = seg.split(/\s+/);
  const first = words[0].replace(/^.*[\\/]/, '');
  const readOnly = READER.test(first) ||
    (first === 'sed' && !/\s-[a-z]*i/.test(seg)) ||
    (first === 'find' && !/\s-(delete|exec|execdir|ok|fprint)\b/.test(seg)) ||
    (first === 'git' && /^git\s+(-C\s+\S+\s+)?(status|diff|log|show|ls-files|rev-parse|branch\s*$)\b/.test(seg));
  if (readOnly) continue;
  // mkdir -p on folders that already exist changes nothing.
  if (/^(mkdir|md)$/i.test(first)) {
    const ps = [...seg.matchAll(pathRe())].map(m => norm(m[1] || m[2] || m[3]));
    if (ps.every(p => fs.existsSync(p))) continue;
  }
  for (const m of seg.matchAll(pathRe())) checkPath(m[1] || m[2] || m[3], seg);
}

// Program paths (node.exe, the plugin's own scripts) may appear in a command that
// also writes inside the roots; treat existing executables and the plugin as read-only uses.
function isReadOnlyTool(abs) {
  const plugin = path.resolve(__dirname, '..');
  if (inside(abs, plugin)) return true;
  return /\.(exe|cmd|bat)$/i.test(abs) && fs.existsSync(abs);
}

process.exit(0);
