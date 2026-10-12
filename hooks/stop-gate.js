#!/usr/bin/env node
// Stop hook for OPFR workers: a worker may not end its session until it has
// written its result file. stop_hook_active prevents an endless block loop.
const fs = require('fs');
const path = require('path');
const { readInput, ctx } = require('./lib');

const input = readInput();
const c = ctx(input);
if (!c || !c.taskId || input.stop_hook_active) process.exit(0);
const result = path.join(c.opfr, 'results', c.taskId + '.json');
let ok = false;
try { ok = !!JSON.parse(fs.readFileSync(result, 'utf8')).status; } catch {}
if (!ok) {
  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason: `Write the result file ${result} first: {"status":"done|failed|blocked|question","summary":"...","files":[],"decisions":[],"bugs":[]}. Then stop.`,
  }));
}
