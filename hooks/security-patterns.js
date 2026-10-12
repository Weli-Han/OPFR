#!/usr/bin/env node
// PostToolUse (Edit|Write|MultiEdit): regex check of newly written code for common
// security sinks. Adds a short warning to the model's context; never blocks.
// Patterns ported and shortened from Anthropic's security-guidance plugin
// (Apache-2.0, hooks/patterns.py); modified: JS port, terse reminders, no LLM review.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readInput, ctx, log } = require('./lib');

const input = readInput();
const c = ctx(input);
if (!c) process.exit(0);
const ti = input.tool_input || {};
const file = String(ti.file_path || '').replace(/\\/g, '/');
const text = [ti.content, ti.new_string, ...(ti.edits || []).map(e => e.new_string)].filter(Boolean).join('\n');
if (!file || !text) process.exit(0);

const JS = /\.(js|jsx|ts|tsx|mjs|cjs|mts|cts|vue|svelte)$/i;
const PY = /\.(py|pyi|ipynb)$/i;
const DOC = /\.(md|mdx|txt|rst|json|ya?ml)$/i;
const DESER = 'Unsafe deserialization (pickle/marshal/shelve/dill) of untrusted data = code execution. Use JSON or a schema-validated loader.';

const RULES = [
  ['gha_workflow', p => /\.github\/workflows\/.+\.ya?ml$/.test(p), null, 'GitHub Actions: never put ${{ github.event.* }} text directly in run:. Pass via env: and quote. Validate refs.'],
  ['child_process_exec', p => JS.test(p), /child_process[\s\S]*\bexec(Sync)?\s*\(|\bexecSync\(|(?<![\w.])exec\(/, 'exec() uses a shell: command injection. Use execFile/spawn with an argument array.'],
  ['new_function', p => JS.test(p), /new Function\b/, 'new Function() with interpolated strings = code injection.'],
  ['eval', p => !DOC.test(p), /(?<![\w.])eval\(/, 'eval() runs arbitrary code. Use JSON.parse / ast.literal_eval / a safe parser.'],
  ['dangerously_set_html', p => JS.test(p), /dangerouslySetInnerHTML/, 'dangerouslySetInnerHTML: XSS unless sanitized (DOMPurify).'],
  ['document_write', p => JS.test(p), /document\.write/, 'document.write: XSS sink. Use DOM methods.'],
  ['inner_outer_html', p => JS.test(p), /\.(innerHTML|outerHTML)\s*=|\.insertAdjacentHTML\(/, 'innerHTML/outerHTML/insertAdjacentHTML with untrusted data = XSS. Use textContent or sanitize.'],
  ['pickle', p => PY.test(p), /(?<!\w)pickle\.(loads?|Unpickler)\b|(?<!\w)pkl_load\(|\b(cPickle|cloudpickle|dill)\.loads?\s*\(|\bmarshal\.loads?\s*\(|\bshelve\.open\s*\(/, DESER],
  ['torch_load', p => PY.test(p), /\btorch\.load\s*\((?![^)\n]*weights_only\s*=\s*True)/, 'torch.load without weights_only=True unpickles arbitrary objects.'],
  ['os_system', p => PY.test(p), /\bos\.system\s*\(|from os import system/, 'os.system runs a shell. Use subprocess.run([...]) without shell.'],
  ['subprocess_shell', null, /subprocess\.(run|call|Popen|check_output|check_call)\(.*shell\s*=\s*True/, 'subprocess shell=True: command injection. Pass a list, no shell.'],
  ['go_exec_shell', null, /exec\.Command\(\s*"(sh|bash|\/bin\/sh|\/bin\/bash)"/, 'exec.Command via sh/bash: command injection. Call the program directly with args.'],
  ['yaml_load', null, /\byaml\.load\s*\((?![^)\n]{0,80}\bSafe)|\byaml\.unsafe_load\s*\(/, 'yaml.load executes tags. Use yaml.safe_load.'],
  ['create_cipher', null, /\bcrypto\.(createCipher|createDecipher)\b(?!iv)/, 'createCipher is insecure/removed. Use createCipheriv with a random IV.'],
  ['aes_ecb', null, /\bAES\.MODE_ECB\b|\bmodes\.ECB\s*\(|["']aes-\d+-ecb["']/i, 'AES ECB leaks structure. Use AES-GCM.'],
  ['tls_off', null, /\bverify\s*=\s*False\b|rejectUnauthorized\s*:\s*false|InsecureSkipVerify\s*:\s*true|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*["']?0|ssl\._create_unverified_context|check_hostname\s*=\s*False/, 'TLS verification disabled: MITM risk.'],
  ['xml_unsafe', p => PY.test(p), /\b(xml\.etree\.ElementTree|ElementTree|ET)\.(parse|fromstring|XML)\s*\(|\bminidom\.(parse|parseString)\s*\(|\bxml\.sax\.(parse|make_parser)\b/, 'stdlib XML parsers allow XXE. Use defusedxml.'],
  ['script_no_sri', null, /<script\s+(?![^>]{0,400}integrity\s*=)[^>]{0,200}src\s*=\s*["'](https?:)?\/\/[^"']{1,300}["']/i, 'Remote <script> without integrity= (SRI). Add integrity+crossorigin or self-host.'],
  ['sql_concat', p => !DOC.test(p), /\b(query|execute|exec|raw)\s*\(\s*[`'"][^`'"]*\b(SELECT|INSERT|UPDATE|DELETE)\b[^`'"]*(\$\{|["']\s*\+|%s["']\s*%|\{\w*\}["']\.format)/i, 'SQL built from strings: injection. Use parameters.'],
  ['hardcoded_secret', p => !DOC.test(p), /(api[_-]?key|secret|password|passwd|token)\s*[:=]\s*["'][A-Za-z0-9_\-+/=]{16,}["']/i, 'Hardcoded secret. Read from env; never commit real keys.'],
];

const hits = [];
for (const [name, pathOk, re, msg] of RULES) {
  if (pathOk && !pathOk(file)) continue;
  if (re && !re.test(text)) continue;
  hits.push([name, msg]);
}
if (!hits.length) process.exit(0);

// Warn once per session + file + rule.
const seenFile = path.join(os.tmpdir(), `opfr-sec-${(input.session_id || 'x').replace(/\W/g, '')}.json`);
let seen = {};
try { seen = JSON.parse(fs.readFileSync(seenFile, 'utf8')); } catch {}
const fresh = hits.filter(([n]) => !seen[file + '#' + n]);
if (!fresh.length) process.exit(0);
fresh.forEach(([n]) => { seen[file + '#' + n] = 1; });
try { fs.writeFileSync(seenFile, JSON.stringify(seen)); } catch {}
fresh.forEach(([n]) => log(c, 'security-hits.jsonl', JSON.stringify({ t: new Date().toISOString(), task: c.taskId, file, rule: n })));

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PostToolUse',
    additionalContext: `Security check ${path.basename(file)}: ` + fresh.map(([n, m]) => `[${n}] ${m}`).join(' ') + ' Fix it, or add a one-line comment why it is safe.',
  },
}));
