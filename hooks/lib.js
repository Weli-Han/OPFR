// Shared helpers for OPFR hooks. Every hook is a no-op unless it runs inside an
// OPFR project (a folder with .opfr/) or inside an OPFR worker (OPFR_TASK_ID set).
const fs = require('fs');
const path = require('path');
const os = require('os');

function readInput() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { return {}; }
}

function findProject(start) {
  if (process.env.OPFR_PROJECT) return path.resolve(process.env.OPFR_PROJECT);
  let d = path.resolve(start || process.cwd());
  for (;;) {
    if (fs.existsSync(path.join(d, '.opfr', 'board.json'))) return d;
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

function ctx(input) {
  const project = findProject(input.cwd);
  if (!project) return null;
  const taskId = process.env.OPFR_TASK_ID || null;
  const worktree = process.env.OPFR_WORKTREE ? path.resolve(process.env.OPFR_WORKTREE) : null;
  let perms = {};
  try { perms = JSON.parse(fs.readFileSync(path.join(project, '.opfr', 'permissions.json'), 'utf8')); } catch {}
  return { project, taskId, worktree, perms, opfr: path.join(project, '.opfr') };
}

// Case-insensitive on Windows; true when p is root itself or inside it.
function inside(p, root) {
  if (!p || !root) return false;
  let a = path.resolve(p), b = path.resolve(root);
  if (process.platform === 'win32') { a = a.toLowerCase(); b = b.toLowerCase(); }
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

function log(c, file, line) {
  try { fs.appendFileSync(path.join(c.opfr, file), line + '\n'); } catch {}
}

function event(c, obj) {
  log(c, 'events.jsonl', JSON.stringify({ t: new Date().toISOString(), ...obj }));
}

const home = os.homedir();
module.exports = { readInput, findProject, ctx, inside, log, event, home };
