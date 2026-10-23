<p align="center"><img src="assets/logo.svg" alt="OPFR logo" width="160"></p>

# OPFR: One Prompt, Full Result

A Claude Code plugin for long autonomous work. You write one prompt. The conductor asks the
questions that change the result, then asks for permissions. After that you can leave the computer.
Workers build, test, fix, and review in parallel. When you return, `REPORT.md` is in the project folder.

It works for any task type: code, data/ML, infrastructure, automation, research, and docs.

> **Status: 1.0.2.** The full lifecycle passes its tests with a mock CLI, and two runs with the real
> Claude CLI finished. Real-world use is still small. Expect rough edges.

> **Warning: workers run without permission prompts.** Each worker is a headless `claude -p`
> process in `bypassPermissions` mode. A guard hook limits writes to the task's own git worktree
> and denies dangerous commands, but a hook is not a sandbox. Do not point OPFR at a folder with
> production keys, real customer data, or work you cannot lose. Use a separate machine or VM for
> anything sensitive. Workers use your Claude subscription or API key, so a long run can use
> a large part of your limits.

## Install

```
/plugin marketplace add Weli-Han/OPFR
/plugin install opfr@opfr
```

Then log in the headless CLI once (see Requirements).

## Use

```
/opfr <task in your own words>
/opfr-status            progress of the current project
/opfr-resume            continue an interview or restart a stopped run
/opfr-change <change>   change the plan mid-run or after the finish
```

You can change your mind while the run is going. `/opfr-change` updates the spec and redoes only the
parts the change touches: their queued tasks are cancelled, their running workers stop, and new
change tasks edit the code that is already merged. Then those parts are verified again. Other parts
keep running. Security review, final verification and the report run again at the end. After the
run has finished, a change restarts it for the changed parts only.

Each project gets its own pixel office: a separate site on its own port. The runner starts it
with the run, taking the first free port from 7788 up, and `/opfr-status` or `opfr.js status <project>`
prints its URL. Several runs at once means several sites, e.g. http://127.0.0.1:7788/ and
http://127.0.0.1:7789/; the page title names the project. `opfr.js office <project>` prints the URL
(or starts the office); `--port <n>` picks a port. An office stops 30 minutes after its run
finishes when nobody is watching. It binds to 127.0.0.1 only. Add `--lan` to open it to
private-network clients (it rejects public addresses and non-IP Host headers).

Interview and build overlap. When part A is clear, its tasks start right away while the conductor
interviews you about part B. A built part goes to verification at once. No worker waits while
it has work to do.

## How it works

| Piece | Role |
|---|---|
| Conductor (`commands/opfr.md`) | Runs on your session model. Writes SPEC, interviews, sends tasks. Never switches model. |
| Dispatcher (`dispatcher/dispatcher.js`) | Zero-token Node scheduler. It is the only writer of `.opfr/board.json`. It runs workers, merges, and creates verify/fix/integrate/report tasks. |
| Runner (`runner/run.ps1`, `run.sh`) | Keeps the PC awake. Restarts the dispatcher if it crashes. Survives when the Claude window closes. On Windows it adds a login entry, so an unfinished run resumes after a reboot or sign-out. |
| Workers | Headless `claude -p` processes, each in its own git worktree, with a short role prompt (`roles/`). |
| Hooks (`hooks/`) | guard (deny rules), stop-gate (no exit without a result file), security patterns, session context, headroom. |
| Library (`library/`) | 97 skills and 40 agents from known plugins. They are not registered, so they cost no tokens until a task reads one. `library/CATALOG.md` is the index. |

Lifecycle per part: build tasks, then verify round 1, then one fix task for the bugs of that round, then
verify round 2 (at most 2 rounds). With a check command that passes on main, the part skips its LLM verify
rounds. After all parts: security review, final end-to-end verification, and the report.
A failed task retries once on the next model rung. After that it is `UNRESOLVED` and listed in the report.
Fix tasks write a failing regression test first; change tasks update the tests to the new behavior first.
When the run finishes you get a desktop notification (Windows toast, click opens `REPORT.md`; macOS and
Linux too). `OPFR_NOTIFY=0` turns it off.
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
- Workers get only the OPFR hooks (`--settings`), not the plugin's skills and commands, and only six
  built-in tools (Read, Edit, Write, Bash, Grep, Glob). A worker turn starts at about 8k cached tokens.
- One fix task per verify round, not one per bug.
- A part whose check command passes on main gets no LLM verify round; the final verification covers it.
- Tasks with overlapping areas, or without an area in the same part, never run side by side, so merge
  conflicts and their integrate tasks are rare.
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
  - system and registry changes, and nested `claude -p`;
  - edits to existing linter/formatter configs (`.eslintrc*`, `biome.json`, `ruff.toml`, ...): workers fix
    the code, not the rules. New configs are fine; `allowConfigEdit` in permissions.json lifts it.
- Install, network, docker, push, publish, deploy, and ssh each need your yes in the permissions question (`.opfr/permissions.json`).
- OPFR never enters credentials. If a task needs a key, you put it in `<project>/.env` yourself.
- Every denied action is listed in `.opfr/BLOCKED.md` and in the report.

## Requirements

- Node 18+ and git.
- The Claude Code CLI, logged in for headless use. Run `claude` and then `/login` once, or `claude setup-token`.
  The dispatcher finds `claude` on PATH or in the desktop app folder (including the MSIX path
  `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\claude-code`). `OPFR_CLAUDE` overrides the path.
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
Change the plan: `/opfr-change`, or `opfr.js change <project> '<json>'` then `opfr.js start <project>`.

Power loss, reboot, sign-out: work stops, progress stays. Merged tasks are kept; tasks that were
running start again. On Windows the runner puts `opfr-resume.cmd` in your Startup folder (per user,
no admin). At the next login it runs `opfr.js resume-all`, which restarts every unfinished project
that you did not stop. The entry removes itself when all projects are done or stopped.
Turn it off: `node dispatcher/opfr.js autostart off`. On macOS/Linux add
`@reboot node <plugin>/dispatcher/opfr.js resume-all` to your crontab.
Sleep is blocked while a run is active; a closed laptop lid or a shutdown still stops it.

## Tests

```
node test/e2e.js          full lifecycle and plan changes with a mock CLI (no tokens)
node test/guard-test.js   guard and security-pattern rules
node test/autostart-test.js  resume after reboot (temp dirs only)
node test/office-test.js     one office site per project, own port
```

## License

MIT. Bundled third-party material keeps its own license. See `NOTICE` and `licenses/`.
