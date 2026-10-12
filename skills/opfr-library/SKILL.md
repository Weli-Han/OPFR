---
name: opfr-library
description: Bundled skill library (TDD, debugging, code review, React/Next/Vite, Python/FastAPI/PyTorch, Go, Rust, Postgres/Redis/Prisma, Docker/K8s, API design, security review, e2e/Playwright, accessibility, research, MCP/plugin/hook authoring, terse caveman style). Use when a task matches one of these areas and no other skill covers it.
---
Open `${CLAUDE_PLUGIN_ROOT}/library/CATALOG.md`, pick at most 3 matching entries, then read only those files:
`${CLAUDE_PLUGIN_ROOT}/library/skills/<name>/SKILL.md` (or `library/agents/<name>.md` for a role prompt). Follow them as if they were installed skills. Files they reference live next to them.
