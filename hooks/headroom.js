#!/usr/bin/env node
// Runs `headroom init hook ensure` (same as the headroom plugin) when the CLI
// exists, at most once per minute, so the separate headroom plugin is optional.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const stamp = path.join(os.tmpdir(), 'opfr-headroom.stamp');
try { if (Date.now() - fs.statSync(stamp).mtimeMs < 60000) process.exit(0); } catch {}
const exe = process.platform === 'win32' ? 'headroom.exe' : 'headroom';
const dirs = (process.env.PATH || '').split(path.delimiter);
if (!dirs.some(d => d && fs.existsSync(path.join(d, exe)))) process.exit(0);
try { fs.writeFileSync(stamp, ''); } catch {}
spawnSync(exe, ['init', 'hook', 'ensure'], { stdio: 'ignore', timeout: 12000, windowsHide: true });
