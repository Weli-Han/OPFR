---
description: Show OPFR progress for the current or given project.
argument-hint: "[project path]"
---
Run `node "${CLAUDE_PLUGIN_ROOT}/dispatcher/opfr.js" status "<P>"` where P is $ARGUMENTS, or else the newest folder with .opfr in the work root (`opfr.js root` prints it). Show the output as is, then one line: what happens next. If it says "NOT running" and not finished, offer `/opfr-resume`. If it shows ops not applied and no dispatcher, offer to run `node "${CLAUDE_PLUGIN_ROOT}/dispatcher/opfr.js" start "<P>"`. If finished, show the first 15 lines of P/REPORT.md.
If $ARGUMENTS contains "office", also run `node "${CLAUDE_PLUGIN_ROOT}/dispatcher/opfr.js" office "<P>"` and show the URL it prints.
