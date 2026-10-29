# Copilot instructions for Murmurplex

! ------ PLEASE COMPLETE THIS STEP and acknowledged before moving on and reading the rest of this file. ------ !

Read the file getting-started.md and acknowledge that you have understood its context and intentions. Please ask any questions if you are unclear. 

Murmurplex is a dependency-free VS Code extension prototype (plain CommonJS, Node ≥ 20, no build step) that coordinates multiple terminal agents (Claude, Codex, Copilot, shell) around a persistent project record. `SPECIFICATION.md` holds requirements; `IMPLEMENTATION_PLAN.md` holds milestones.

## Commands

```sh
npm test                                   # unit tests: node --test test/*.test.js
node --test test/core.test.js              # single test file
node --test --test-name-pattern="name" test/core.test.js   # single test
npm run check                              # `node --check` syntax pass — new source files must be added to this script in package.json
npm run test:vscode                        # graphical integration test (needs desktop VS Code / xvfb; VSCODE_CLI, VSCODE_ARGS; MURMURPLEX_TEST_LOAD=N adds CPU load)
npm run test:security-scanner              # scanner integration test
npm run security:staged | security:files | security:scan   # secret scanning (gitleaks-based; history/staged/files)
npm run security:install-hook              # sets up .githooks/pre-commit (runs staged secret scan)
```

CI (`.github/workflows/ci.yml`) runs secret scans, `check` + `test` on Node 20 and 22, and the VS Code test under Xvfb. No linter is configured.

## Architecture

- `src/extension.js` – VS Code UI: commands, agent tree, status bar, terminals, attention indicators. `src/layout.js` computes the balanced terminal grid.
- `src/service.js` – local HTTP service on 127.0.0.1 started by the extension. Every request needs a per-agent bearer token (compared by SHA-256 digest); requests with an `Origin` header are rejected; bodies are capped at 64 KB. Role rules (e.g. only the coordinator creates/assigns tasks and records decisions; agents may act only as themselves) are enforced here.
- `src/store.js` – persistent project record in `<project>/.murmurplex/state.json`: atomic temp-file + rename writes, single-writer lock (`writer.lock`) with a short-lived operation guard (`writer-operation.lock`), validation, and a `copy()` snapshot model. Agent-event adapters (`claude.js`, `codex.js`, `copilot.js`, `codex-trust.js`) translate each CLI's hook events into agent attention states (`needs-input`, `needs-permission`, etc.).
- `src/migrations.js` – versioned state schema (`CURRENT_VERSION`); older state is migrated in memory and backed up once as `state.json.v<N>.bak`; newer or invalid state is refused untouched. Any state-shape change needs a new migration plus a version bump.
- `src/security.js` – `assertNoSecrets`/`redact`/`parseJSON`. All persisted text and diagnostics must go through these; writes containing recognisable secrets or live Murmurplex tokens are rejected.
- `bin/murmurplex-agent` – CLI helper placed on PATH of every launched terminal; talks to the service using the agent's credential. Hook helpers for agents must exit 0 on reporting errors (exit 2 would block a CLI tool/turn).
- `copilot-plugin/` – Copilot CLI plugin hooks that report to the helper.
- Credentials live in a private directory outside the project (absolute path required), not in `.murmurplex/`.

## Conventions

- `'use strict'` CommonJS with `node:`-prefixed built-ins; terse, compact style; no npm dependencies — don't add any.
- Tests use `node:test` with temp directories and a real service/`murmurplex-agent` helper; `t.mock` is used sparingly (e.g. fault injection on `fs`).
- Never commit secrets: `.gitleaks.toml` and the pre-commit hook enforce this. Secret-like test fixtures are assembled at runtime (e.g. `['sk','proj',randomBytes(24).toString('base64url')].join('-')`) so the scanner doesn't flag them.
- The store uses two locks: `writer.lock` (one writer per project) and `writer-operation.lock` (short-lived directory guard during an operation).
- README documents user-visible behaviour (commands, helper usage, state guarantees); update it alongside behaviour changes.
