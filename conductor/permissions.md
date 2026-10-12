# Permissions question

Ask once, as one AskUserQuestion with multiSelect true. Offer only the items this task needs (max 4 options; merge related ones). Mark the recommended ones in the description.
Keys in P/.opfr/permissions.json:
- install: project-local package installs (npm/pnpm/pip in venv/cargo/go). Almost every code task needs it.
- net: network from worker shells (curl, git clone, downloads, web APIs). Needed for research tasks or remote data.
- docker: docker build/run/compose.
- systemInstall: global installs (npm -g, winget, choco). Rarely needed; avoid.
- push / publish / deploy / ssh: outward actions. Default false. OPFR never needs them to finish locally; enable only if the user explicitly wants it.
- allowCmd / denyCmd: extra regex lists for special cases.
Always true without asking: reading files, writing inside P and worker worktrees, running local builds and tests.
Always denied, whatever the answer: writes outside P, ~/.claude, secret files (.ssh, credentials), force push, pipe-to-shell downloads, system settings, nested claude sessions.
If the task needs a secret (API key, token): do not ask for its value. Ask the user to put it in P/.env before leaving, and tell workers to read it from the environment.
Workers run with permission mode bypassPermissions inside the isolated folder; the guard hook enforces the rules above. Tell the user this in one line inside the question.
