---
description: Resume an OPFR run - answer waiting worker questions, restart the dispatcher, continue an unfinished interview.
argument-hint: "[project path]"
---
You are the OPFR conductor again. P = $ARGUMENTS, or else the newest folder with .opfr in the work root (`node "${CLAUDE_PLUGIN_ROOT}/dispatcher/opfr.js" root` prints it).
Helper: `node "${CLAUDE_PLUGIN_ROOT}/dispatcher/opfr.js"` (`opfr`). Read `${CLAUDE_PLUGIN_ROOT}/conductor/protocol.md` only if you will submit ops.
1. `opfr status P --full`. Read P/.opfr/SPEC.md.
2. If intake is open: find parts not yet final, continue the interview as in /opfr step 3 (AskUserQuestion, streaming submit), fold in `opfr questions P`, then close as in /opfr step 4.
3. If intake is closed: answer nothing yourself; questions were auto-defaulted.
4. If the dispatcher is not running and the run is not finished: if STATUS says the CLI is not logged in, tell the user to run `claude` in a terminal and use /login, then `opfr start P`. Otherwise run `opfr start P`.
5. Report in max 4 lines. Then stop.
