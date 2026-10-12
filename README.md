# OPFR: One Prompt, Full Result

A Claude Code plugin for long autonomous work. You write one prompt. The conductor asks the
questions that change the result, then asks for permissions. After that you can leave the computer.
Workers build, test, fix, and review in parallel. When you return, `REPORT.md` is in the project folder.

It works for any task type: code, data/ML, infrastructure, automation, research, and docs.

> **Status: experimental (0.1.0-alpha).** The full lifecycle passes its tests with a mock CLI.
> Runs with the real Claude CLI are still few. Expect rough edges.

> **Warning: workers run without permission prompts.** Each worker is a headless `claude -p`
> process in `bypassPermissions` mode. A guard hook limits writes to the task's own git worktree
> and denies dangerous commands, but a hook is not a sandbox. Do not point OPFR at a folder with
> production keys, real customer data, or work you cannot lose. Use a separate machine or VM for
> anything sensitive. Workers use your Claude subscription or API key, so a long run can use
> a large part of your limits.

## Install

```
/plugin marketplace add <owner>/opfr
/plugin install opfr@opfr
```

Then log in the headless CLI once (see Requirements).

## Use

```
/opfr <task in your own words>
/opfr-status            progress of the current project
/opfr-resume            continue an interview or restart a stopped run
```

To watch the run as a pixel office, run `node dispatcher/opfr.js office <project>` and open
http://127.0.0.1:7788/. It binds to 127.0.0.1 only. Add `--lan` to open it to private-network
clients (it rejects public addresses and non-IP Host headers).

Interview and build overlap. When part A is clear, its tasks start right away while the conductor
interviews you about part B. A built part goes to verification at once. No worker waits while
it has work to do.

## How it works

| Piece | Role |
|---|---|
| Conductor (`commands/opfr.md`) | Runs on your session model. Writes SPEC, interviews, sends tasks. Never switches model. |
| Dispatcher (`dispatcher/dispatcher.js`) | Zero-token Node scheduler. It is the only writer of `.opfr/board.json`. It runs workers, merges, and creates verify/fix/integrate/report tasks. |
| Runner (`runner/run.ps1`, `run.sh`) | Keeps the PC awake. Restarts the dispatcher if it crashes. Survives when the Claude window closes. |
| Workers | Headless `claude -p` processes, each in its own git worktree, with a short role prompt (`roles/`). |
| Hooks (`hooks/`) | guard (deny rules), stop-gate (no exit without a result file), security patterns, session context, headroom. |
| Library (`library/`) | 97 skills and 40 agents from known plugins. They are not registered, so they cost no tokens until a task reads one. `library/CATALOG.md` is the index. |

Lifecycle per part: build tasks, then verify round 1, then fixes for each bug, then verify round 2
(at most 2 rounds). After all parts: security review, final end-to-end verification, and the report.
A failed task retries once on the next model rung. After that it is `UNRESOLVED` and listed in the report.
After the intake closes, nobody asks you questions: workers choose defaults and log them in `DECISIONS.md`.

## Model routing

| Tier | Model / effort |
|---|---|
| simple | haiku high |
| normal | haiku xhigh (1–2 files, existing pattern), else sonnet medium |
| complex | sonnet high; sonnet xhigh for security, data, or concurrency |
| critical | opus high |
| report | the conductor's own model |

Escalation ladder: haiku high, haiku xhigh, sonnet medium, sonnet high, sonnet xhigh, opus high.

## Token economy

- Each task gets a fresh session with a stable role prompt, so the prompt cache is reused.
- `--setting-sources project,local` keeps your user plugins out of workers.
- MCP servers are passed per task only (`--strict-mcp-config`).
- The library stays unregistered. Each task reads at most 3 entries.
- Workers read grep-first, keep test output quiet, and write short result files.
- The dispatcher and the runner use no tokens.
- `usage.jsonl` and the report show tokens per model.

## Safety

- Work happens only in `<work root>\<project>`. The work root is `OPFR_ROOT` if set, else
  `D:\opfr-work` on Windows when drive D: exists, else `~/opfr-work`. `opfr.js root` prints it.
- Workers use `bypassPermissions` only there. The guard hook denies:
  - writes outside the worktree;
  - `~/.claude` and secret files;
  - force push, recursive deletes of root folders, and pipe-to-shell downloads;
  - system and registry changes, and nested `claude -p`.
- Install, network, docker, push, publish, deploy, and ssh each need your yes in the permissions question (`.opfr/permissions.json`).
- OPFR never enters credentials. If a task needs a key, you put it in `<project>/.env` yourself.
- Every denied action is listed in `.opfr/BLOCKED.md` and in the report.

## Requirements

- Node 18+ and git.
- The Claude Code CLI, logged in for headless use. Run `claude` and then `/login` once, or `claude setup-token`.
  The dispatcher finds `claude` on PATH or in the desktop app folder. `OPFR_CLAUDE` overrides the path.
- Optional:
  - `headroom`;
  - `typescript-language-server` and `pyright` for LSP;
  - `npx` access for the Playwright MCP (verify tasks on web UIs).

## Files in a project

```
<project>/            git repo, main branch = merged result, REPORT.md at the end
<project>/.opfr/      board.json, SPEC.md, spec/, briefs/, results/, logs/, STATUS.md,
                      DECISIONS.md, BUGS.md, BLOCKED.md, events.jsonl, usage.jsonl, summary.md
<root>/.wt/<project>/ worker worktrees (removed after merge)
```

Stop: `node dispatcher/opfr.js stop <project>`. Resume: `/opfr-resume` or `opfr.js start <project>`.

## Tests

```
node test/e2e.js          full lifecycle with a mock CLI (no tokens)
node test/guard-test.js   guard and security-pattern rules
```

## License

MIT. Bundled third-party material keeps its own license. See `NOTICE` and `licenses/`.
