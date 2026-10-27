---
description: Scroll through a site like a user, capture animation states, and report the exact scroll positions where scroll animations break
argument-hint: "[url] [--mobile] [--cpu 4] [--step 300] [--fail-on error]"
allowed-tools: Bash(node:*), Bash(npm install:*), Read, Glob, Grep
---

# ScrollProof audit

Arguments: `$ARGUMENTS` (empty: the engine probes common dev-server ports such as 3000 and 5173).

## 1. Make sure the engine can run

```bash
node "${CLAUDE_PLUGIN_ROOT}/engine/cli.mjs" --check
```

- Exit code 4 with "playwright-core is not installed": run
  `npm install --prefix "${CLAUDE_PLUGIN_ROOT}" --omit=dev --no-audit --no-fund` (one time, ~10 s), then check again.
- "No Chromium-based browser could be launched": tell the user to install Google Chrome (or run `npx playwright install chromium`) and stop.

## 2. Run the audit

```bash
node "${CLAUDE_PLUGIN_ROOT}/engine/cli.mjs" $ARGUMENTS
```

Use a 10-minute timeout. The engine writes `./.scrollproof/<site>-<time>/` and prints where the report is.

- Exit code 3 (nothing listening): ask the user to start their dev server, naming the `dev` script from `package.json` if there is one. Don't start a long-running server yourself unless the user asks.
- Any other failure: show the error line and stop.

## 3. Report back

Read `report.md` from the printed folder, then answer in this order:

1. One line: score, error and warning counts, and the single worst problem.
2. A table of errors and warnings: `#`, severity, scroll position, element, what broke (12 words max), source.
3. For each **error** whose source points into this workspace, open the file at that line and explain the concrete cause in one or two sentences, using the `fix-scroll-animations` skill. Propose the code change; edit only if the user asks.
4. The paths to `report.html` (screenshots with the broken element outlined, frame-time chart) and `trace.json.gz` (Chrome DevTools › Performance › Load profile).

Mapping sources to files: dev servers like Vite serve `/src/...` paths that match the project; inline scripts report the HTML file and its line.
If `.scrollproof/` is missing from `.gitignore`, mention it once.
