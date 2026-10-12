#!/usr/bin/env node
// OPFR office: live pixel-office view of one project. Read-only, light (one 1 s poll shared by all viewers).
// Usage: node office/server.js <project> [--port <n>] [--lan]
// Without --port it takes the first free port from 7788 up, so each project gets its own site.
// It writes .opfr/office.json (port, pid, url) and exits 30 min after the run finishes with no viewers.
// Default bind is 127.0.0.1. --lan binds all interfaces but answers only private-network clients.
'use strict';
const fs = require('fs');
const http = require('http');
const path = require('path');

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const PROJECT = path.resolve(args.find(a => !a.startsWith('--') && a !== flag('port')) || process.cwd());
const O = path.join(PROJECT, '.opfr');
const FIXED = flag('port') != null;
let PORT = Number(flag('port', 7788));
const LAN = args.includes('--lan');
const MAX_CLIENTS = 8;
if (!fs.existsSync(path.join(O, 'board.json'))) { console.error('No OPFR project at ' + PROJECT); process.exit(1); }

const NAME = path.basename(PROJECT).replace(/[<>&"']/g, '');
const page =fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8').replace('<script>', '<script>window.OPFR_LIVE=1;</script>\n<script>')
  .replace('<title>Conductor Office</title>', `<title>${NAME} · OPFR office</title>`).replace('<h1>Conductor Office</h1>', `<h1>${NAME} · Conductor Office</h1>`);
const INFO = path.join(O, 'office.json');

function privateAddr(a) {
  a = String(a || '').replace(/^::ffff:/, '');
  return a === '::1' || /^127\./.test(a) || /^10\./.test(a) || /^192\.168\./.test(a) || /^172\.(1[6-9]|2\d|3[01])\./.test(a) ||
    /^169\.254\./.test(a) || /^f[cd][0-9a-f]{2}:/i.test(a) || /^fe80:/i.test(a);
}
// Host must be an IP literal or localhost: blocks DNS-rebinding pages from reading the stream.
const hostOk = h => /^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\])(:\d+)?$/i.test(String(h || ''));

// ---- shared poller -----------------------------------------------------------
const clients = new Set();
let evPos = 0, lastState = '', recent = [];
const evFile = path.join(O, 'events.jsonl');

function readNewEvents() {
  let st; try { st = fs.statSync(evFile); } catch { return []; }
  if (st.size < evPos) evPos = 0;
  if (st.size === evPos) return [];
  const fd = fs.openSync(evFile, 'r');
  const buf = Buffer.alloc(Math.min(st.size - evPos, 1 << 20));
  fs.readSync(fd, buf, 0, buf.length, evPos); fs.closeSync(fd);
  const text = buf.toString('utf8'), cut = text.lastIndexOf('\n');
  if (cut < 0) return [];
  evPos += Buffer.byteLength(text.slice(0, cut + 1));
  return text.slice(0, cut).split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function state() {
  let b; try { b = JSON.parse(fs.readFileSync(path.join(O, 'board.json'), 'utf8')); } catch { return null; }
  const ts = Object.values(b.tasks || {}), M = b.meta || {};
  const counts = {}; for (const t of ts) counts[t.status] = (counts[t.status] || 0) + 1;
  const fixes = ts.filter(t => t.kind === 'fix');
  const tokens = Object.values(M.usage || {}).reduce((s, u) => s + (u.in || 0) + (u.out || 0) + (u.cacheWrite || 0), 0);
  return {
    stage: M.stage, intakeClosed: !!M.intakeClosed, created: M.created, counts, tokens,
    paused: !!(M.pausedUntil && M.pausedUntil > Date.now()), pauseWhy: M.authError ? 'CLI не залогинен' : 'лимит',
    bugsOpen: fixes.filter(t => !['done', 'unresolved', 'cancelled', 'skipped'].includes(t.status)).length,
    bugsFixed: fixes.filter(t => t.status === 'done').length,
    questions: ts.filter(t => t.status === 'waiting').length,
    running: ts.filter(t => t.status === 'running').map(t => ({ id: t.id, kind: t.kind, title: t.title, model: t.lastModel, effort: t.lastEffort })),
  };
}

const send = (res, type, obj) => res.write(`event: ${type}\ndata: ${JSON.stringify(obj)}\n\n`);
function poll() {
  const evs = readNewEvents().filter(e => e.type !== 'usage' && e.type !== 'task-add');
  recent = recent.concat(evs).slice(-40);
  const s = state(), sj = JSON.stringify(s);
  for (const res of clients) { for (const e of evs) send(res, 'ev', e); if (s && sj !== lastState) send(res, 'state', s); }
  if (s) lastState = sj;
}
readNewEvents(); // skip history; new viewers get the last few lines from `recent`
setInterval(poll, 1000);
// Free the port once the run is over and nobody is watching.
let idleSince = Date.now();
setInterval(() => {
  if (clients.size || !fs.existsSync(path.join(O, 'DONE'))) { idleSince = Date.now(); return; }
  if (Date.now() - idleSince > 30 * 60000) bye();
}, 60000);
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000);

// ---- http --------------------------------------------------------------------
const server = http.createServer((req, res) => {
  if (!privateAddr(req.socket.remoteAddress) || !hostOk(req.headers.host)) { res.writeHead(403); return res.end(); }
  const url = req.url.split('?')[0];
  const sec = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' };
  if (req.method !== 'GET') { res.writeHead(405, sec); return res.end(); }
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { ...sec, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'" });
    return res.end(page);
  }
  if (url === '/events') {
    if (clients.size >= MAX_CLIENTS) { res.writeHead(503, sec); return res.end(); }
    res.writeHead(200, { ...sec, 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    // Replayed lines only fill the log; the state snapshot after them sets who is in the office.
    for (const e of recent) send(res, 'ev', { ...e, replay: 1 });
    const s = state(); if (s) send(res, 'state', s);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  res.writeHead(404, sec); res.end();
}).on('error', e => {
  if (e.code === 'EADDRINUSE' && !FIXED && PORT < 7888) return server.listen(++PORT, LAN ? '0.0.0.0' : '127.0.0.1');
  console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is busy. Use --port <n>.` : e.message);
  process.exit(1);
}).on('listening', () => {
  const url = `http://${LAN ? '<this-pc-lan-ip>' : '127.0.0.1'}:${PORT}/`;
  fs.writeFileSync(INFO, JSON.stringify({ port: PORT, pid: process.pid, url, lan: LAN }));
  console.log(`OPFR office: ${url}  (project ${PROJECT})`);
}).listen(PORT, LAN ? '0.0.0.0' : '127.0.0.1');
function bye() { try { if (JSON.parse(fs.readFileSync(INFO, 'utf8')).pid === process.pid) fs.unlinkSync(INFO); } catch {} process.exit(0); }
process.on('SIGINT', bye); process.on('SIGTERM', bye);
