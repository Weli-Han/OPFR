#!/usr/bin/env node
// SessionStart for the conductor: when a session opens inside an OPFR project,
// add a two-line status so /opfr-resume can continue without re-reading files.
// Workers get nothing here (their brief already has all context).
const fs = require('fs');
const path = require('path');
const { readInput, ctx } = require('./lib');

const input = readInput();
const c = ctx(input);
if (!c || c.taskId) process.exit(0);
let status = '';
try { status = fs.readFileSync(path.join(c.opfr, 'STATUS.md'), 'utf8').split('\n').slice(0, 6).join('\n'); } catch {}
process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext: `OPFR project ${c.project}. ${status ? 'Status:\n' + status + '\n' : ''}Use /opfr-resume to continue the interview or /opfr-status for progress.`,
  },
}));
