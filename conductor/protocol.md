# OPFR protocol (conductor reference)

## Files in P/.opfr
- SPEC.md: goal, definition of done, parts, defaults. spec/<part>.md: details per part.
- inbox/*.json: your ops to the dispatcher. Write a new file per batch with the Write tool (name `<increasing number>-<what>.json`, never reuse a name), or use `opfr op`.
- board.json: dispatcher state (read only for you). STATUS.md: progress. events.jsonl, usage.jsonl: logs.
- questions.jsonl: worker questions. DECISIONS.md, BUGS.md, BLOCKED.md: logs that go into the report.
- permissions.json: what workers may do (see permissions.md).

## Ops (JSON object or array of objects)
- `{"op":"part","part":"A","title":"Auth","final":true,"tasks":[<task>...]}`: submit tasks of a part. `final:true` = no more build tasks for this part; then the part gets verify rounds automatically.
- `{"op":"draft","part":"B","title":"...","tasks":[...]}`: fallback tasks, used only if intake closes before part B is final.
- `{"op":"task", ...<task>}`: one extra task.
- `{"op":"meta","set":{...}}`: verifyCmd, deadline (ISO), maxParallel (default 3), taskTimeoutMin (60), verifyRounds (2), security (true), critical (false: true makes the security review use opus high), verifyMcp (["playwright"] for web UIs), permissionMode ("bypassPermissions" default; "auto" possible).
- `{"op":"answer","qid":"...","text":"..."}`, `{"op":"cancel","id":"..."}`, `{"op":"close"}`.

## Task object
```json
{"id":"A1","title":"REST API for todos","kind":"build","tier":"normal","small":false,"risky":false,
 "deps":[],"area":["api"],"skills":["api-design","tdd-workflow"],"mcp":[],
 "brief":"What to build, inputs, outputs, acceptance checks, files to touch. Self-contained."}
```
- id: short, unique (A1, A2, B1…). kind: build (default) | research. Verify, fix, integrate, security, report tasks are created by the dispatcher.
- tier and model routing (user-approved table):
  - simple: rename, config, one obvious function. haiku high.
  - normal: typical feature. `small:true` (1–2 files, existing pattern) = haiku xhigh; otherwise sonnet medium.
  - complex: cross-file design, tricky logic. sonnet high; `risky:true` (security, data integrity, concurrency, migrations) = sonnet xhigh.
  - critical: core architecture, money, auth core, irreversible data. opus high.
  Failure escalates one rung: haiku high, haiku xhigh, sonnet medium, sonnet high, sonnet xhigh, opus high. Max 2 attempts, then UNRESOLVED.
- deps: task ids that must finish first. Keep chains short; prefer parallel tasks.
- area: lock names. Two running tasks never share an area. Give tasks that touch the same files the same area. "*" = runs alone.
- skills: names from the library catalog (`${CLAUDE_PLUGIN_ROOT}/library/CATALOG.md`); max 3 per task; only when clearly useful.
- mcp: "playwright" (browser) or "context7" (library docs). Only when the task needs it.
- brief: everything the worker needs. Workers never see the chat. 5–25 lines. Include acceptance checks.

## Splitting rules
- One task = one worker session = one coherent change (about 1–6 files). Bigger: split.
- Put a scaffold task first (project skeleton, tooling, check command) when the project is new; other tasks depend on it.
- Tests are part of each build task. Separate verify rounds come automatically.
- Non-code work (documents, research, data) uses the same model: parts, tasks, briefs, acceptance checks.
