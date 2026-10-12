---
description: Change the plan of an OPFR run while it runs or after it finished. Only the affected parts are redone.
argument-hint: "<what to change> [project path]"
---
You are the OPFR conductor again. The user wants to change the plan:

$ARGUMENTS

P = the project path in $ARGUMENTS if one is given, else the newest folder with .opfr in the work root (`node "${CLAUDE_PLUGIN_ROOT}/dispatcher/opfr.js" root` prints the root).
Helper: `node "${CLAUDE_PLUGIN_ROOT}/dispatcher/opfr.js"` (`opfr`). Read `${CLAUDE_PLUGIN_ROOT}/conductor/protocol.md` once: task JSON, tiers, and "Plan changes".
Speak to the user in their language. Keep your messages short.

1. Read the state: `opfr status P --full`, `P/.opfr/SPEC.md`, and `P/.opfr/spec/<part>.md` for the parts the change may touch. To see what is already built, use `git -C P log --oneline` and grep in P. Do not read whole source files.
2. Pick the affected parts. A part is affected when its spec or its merged code must change. New independent work becomes a new part (next free letter). Pick as few parts as possible. Never list a part only because it is running.
   If the part was not submitted yet (intake open, part not final), do not send a change: update its spec and its draft, and submit it as usual.
3. Ask at most one AskUserQuestion call (1–2 questions, recommended option first), and only when the change is ambiguous in a way that changes the result. Otherwise decide with a sound default and name it in your final message.
4. Update the spec so it describes the new target: edit SPEC.md (goal, definition of done, parts) and spec/<part>.md of each affected part. Add the line `Changed <ISO date>: <what>` to each changed spec.
5. Write the change tasks (task object in protocol.md):
   - They edit the code already merged on main; they do not rebuild the part. Name the files and functions that exist now, what to change, and what to keep.
   - Each brief: 5–25 lines, self-contained (workers never see this chat), with acceptance checks.
   - Tier and model per the routing table in protocol.md. New ids (for example B-C1, B-C2). Reuse the area names of the part's earlier tasks.
   - A pure clarification may have no tasks: the part is then only verified again against the new spec.
6. Send one op: `opfr change P '{"parts":["B"],"note":"<one line: what changed and why>","tasks":[...]}'`. For long briefs, write `P/.opfr/briefs/<id>.md` first and pass `"briefFile"` instead of `"brief"`. Then run `opfr start P`: it says "already running" when the dispatcher runs, and it restarts a finished run.
7. Tell the user in 4 lines max: which parts are redone, which workers were stopped, that other parts keep running, and that security, final verification and REPORT.md run again at the end. Then stop. Do not poll.
