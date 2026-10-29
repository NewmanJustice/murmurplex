# Murmurplex

A VS Code extension prototype for terminal agents working together on a persistent project, locally or in a devcontainer.

See [SPECIFICATION.md](SPECIFICATION.md) for the agreed requirements, architecture, acceptance scenarios, and prototype implementation status.
See [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) for proposed milestones, dependencies, and validation gates.

Terminals share the available editor space evenly and rebalance when terminals or editor groups are added or removed. Each group can contain multiple agent tabs. One agent is designated coordinator; tasks, decisions, roles and mailbox messages survive restarting the extension.

## Try the prototype

Requirements: desktop VS Code 1.95 or later; Node.js 20 or later in the project environment; whichever agent CLIs you want to run already installed and authenticated there. Node.js 22 is recommended for the devcontainer. No npm dependencies or build step are required.

1. Open this repository in VS Code. Optionally choose **Dev Containers: Reopen in Container**; the included development container provides Node.js, not the agent CLIs or their credentials.
2. Press **F5** and select **Run Murmurplex**. This opens an Extension Development Host with the prototype loaded.
3. In that new window, open the project folder you want the agents to work on.
4. Run **Murmurplex: Start or Resume Project** from the Command Palette. On a new project, choose the first agent and give it a name. The first agent is the coordinator. Choose `shell` to explore without starting an AI agent.
5. Run **Murmurplex: Add Agent Terminal Group** to add a visible pane, or **Murmurplex: Add Agent Tab to Current Group** to add a tab in the focused group.
6. Run **Murmurplex: Copy Project Handover**, choose its recipient, then paste that brief into that agent. Repeat for other agents; do not share the coordinator's full brief with workers.

Look for **Murmurplex** in Explorer and the status bar. The coordinator is marked with a star in the agent list; amber dots identify unresolved questions or permission requests. Clicking an agent focuses its terminal without clearing its request.

If F5 does not bring the project into a development host, this equivalent command launches it directly:

```sh
code --new-window --extensionDevelopmentPath=/absolute/path/to/murmurplex /absolute/path/to/your-project
```

### Commands

| Command | Behaviour |
| --- | --- |
| Start or Resume Project | Starts the local service and loads the project record; launches the first agent on a new project. |
| Recover Stale Project Lock | After confirming all project services are stopped, removes the unchanged writer lock. Does not remove a crashed writer-operation guard. |
| Refresh Repository State | Re-reads the current branch, `HEAD`, working-tree changes and worktrees without changing Git or Murmurplex state. |
| Add Agent Terminal Group | Adds an agent in a new visible editor group. |
| Add Agent Tab to Current Group | Adds another agent tab in the focused group. |
| Balance Terminal Grid | Gives editor panes equal area. |
| Maximize or Restore Terminal Group | Shrinks the other groups to their minimum size so the focused group fills the editor area; run it again to restore the balanced grid. Terminals keep running. Automatic balancing pauses meanwhile, and opening or closing a group ends the maximised state. It does not use VS Code's native maximise, which exposes no state; repeating either step is harmless. |
| Resume Saved Agent | Reuses a saved agent identity and mailbox in a new terminal. Paste the project handover to restore its context. |
| Change Coordinator | Changes the single coordinator identity in the saved record. |
| Copy Project Handover | Selects a recipient and copies its permitted state and mailbox instructions. |
| Send Agent Message | Queues a message for the selected agent. |
| Set Agent Attention State | Exercises the attention indicator or explicitly resolves it. |

All command names begin with **Murmurplex:** in VS Code.

When a project starts or resumes, the **Repository** Explorer view shows a read-only observation of its current Git branch, `HEAD`, working-tree changes and worktrees alongside the saved Murmurplex project record. Refresh it with **Murmurplex: Refresh Repository State** after Git or task-reference changes. Saved task branch/worktree references are compared with local branches and worktrees and marked `PRESENT`, `STALE`, `CONFLICT` or `UNVERIFIED`; Git observations are transient and no reconciliation changes are written. A reference being present does not imply that prior agent work is still running or complete. PR state remains unverified.

### Mailbox and project record

Every terminal launched by Murmurplex has `murmurplex-agent` on its PATH and an assigned agent ID. Agents can use this command through their normal shell tool. Shell terminals can run it directly.

```sh
murmurplex-agent state
murmurplex-agent inbox
murmurplex-agent send RECIPIENT_ID 'Please review my changes.'
murmurplex-agent ack MESSAGE_ID
murmurplex-agent status needs-permission
murmurplex-agent status working
murmurplex-agent task 'Review login changes' review OWNER_ID
murmurplex-agent task 'Implement feature' in-progress OWNER_ID - feature/next /projects/feature
murmurplex-agent decision 'User approval is required before merging.'
```

`state` lists agent and task IDs. `task` accepts a title, optional status, owner ID, existing task ID, branch and worktree path in that order; use `-` to leave a positional value unspecified. Append `--clear-branch` or `--clear-worktree` to clear a reference, or `--branch=VALUE` and `--worktree=VALUE` to set one explicitly; these forms allow literal values such as `null` and `-`. Worktree paths can be absolute or relative to the project root. References persist with the task; omitted references on task updates are retained. Only the coordinator can create or assign tasks and record decisions. Workers can update the title/status/references of their own assigned tasks using the existing task ID, but cannot change ownership. For coordinator updates, provide title, status and owner because omitted status/owner reset to their defaults. Valid task states: `backlog`, `in-progress`, `blocked`, `review`, `done`.

Status values: `working`, `idle`, `needs-input`, `needs-permission`, `finished`, `disconnected`, `unknown`. `working`, `idle`, and `finished` resolve attention; disconnecting or focusing a terminal does not.

Reading an inbox does **not** acknowledge its messages. Acknowledgements persist. Mailbox delivery is pull-based in this prototype: agents need to check their inboxes, and messages never inject keystrokes into a terminal or automatically wake an agent.

### Authentication and permissions

Murmurplex does not collect or store provider API keys. Authenticate each CLI using its supported saved-login/keychain mechanism in the same local or container environment before launching it. In devcontainers, arrange provider authentication separately; do not bake credentials into images or commit them.

New terminals default to **native-login mode**: common API-key, token, password and private-key environment variables are explicitly removed rather than copied into terminal options. Normal environment settings, home directories, configuration paths and SSH-agent access are preserved. For API-key-only or other environment-based authentication, enable the machine-level **Murmurplex: Inherit Authentication Environment** setting (`murmurplex.inheritAuthenticationEnvironment`) and relaunch the terminal. This compatibility mode deliberately allows credentials to be inherited.

Environment filtering is best-effort, not a sandbox: unknown variable names, shell startup scripts, CLI configuration files and same-user file access can still provide credentials. Saved provider logins are managed by the provider, not necessarily encrypted by Murmurplex or backed by an OS keychain.

| Operation | User through VS Code | Coordinator API | Worker API |
| --- | --- | --- | --- |
| Add agents or replace coordinator | Yes | No | No |
| Create/assign tasks; record decisions | Via coordinator; no task/decision UI yet | Yes | No |
| Update assigned tasks | Via agents; no task UI yet | Any task | Own tasks only; no reassignment |
| Read project record | Full record | Full record | Shared agents/tasks/decisions; only messages sent or received by that worker |
| Report status/hooks; acknowledge mail | Manual status available | Own identity only | Own identity only |
| Send messages | As user | As self | As self |

Coordinator permissions follow the current persisted role on every request; a replaced coordinator immediately loses those permissions. Handovers are filtered for the selected recipient. These controls apply to Murmurplex's API, not direct terminal Git/file operations or other VS Code extensions.

### Automatic Claude Code attention

New Claude terminals launched by Murmurplex receive session-scoped [Claude Code hooks](https://code.claude.com/docs/en/hooks). They are supplied through `--settings`, alongside existing user/project settings; Murmurplex does not edit your Claude configuration or change permission decisions. Existing terminals need to be relaunched to receive the hooks. Shell sessions still use manual/helper status reporting.

| Claude event | Murmurplex behaviour |
| --- | --- |
| Session start | Records the conversation ID and reports unknown; preserves unresolved attention. |
| Prompt submission or tool activity | Reports working without dismissing outstanding requests. |
| `AskUserQuestion` tool call | Shows needs input until that call returns or fails. |
| Tool permission request | Shows needs permission until all potentially matching tool calls return or fail. |
| Main response stops | Reports finished unless attention remains; reports idle when background work or scheduled turns remain. Does not complete backlog tasks. |
| API failure / session end | Reports unknown / disconnected, preserving unresolved attention. |

Questions and permissions raised by Claude subagents appear on their parent Murmurplex agent. A subagent finishing or an unrelated tool returning cannot clear another outstanding request. Request tracking persists across service restarts. Hook payloads are reduced to event, conversation, subagent, and tool identifiers plus whether background work remains; prompts, answers, tool output, and transcripts are not stored or forwarded to the service.

This first adapter does not detect questions written as ordinary response text or sandbox network approval dialogs. Denied/cancelled permissions may have no matching result event; those indicators intentionally remain until you explicitly resolve them with **Set Agent Attention State** or `murmurplex-agent status working` (also `idle` or `finished`). A new conversation does not automatically dismiss old requests. **Finished** means Claude reached a response boundary, not that the project is complete; another Stop hook may make Claude continue, and subsequent activity updates the state again.

Hook errors are reported by the helper to Claude as non-blocking failures, never approvals. If hooks are disabled by your settings or managed policy, automatic reporting is unavailable: use manual reporting. The adapter was verified with Claude Code 2.1.311 and requires support for exec-form command hooks (`command` with `args`) and the events listed above.

### Automatic Copilot CLI attention

New Copilot terminals launched by Murmurplex load the bundled `copilot-plugin/` through `--plugin-dir`; your Copilot configuration is not edited. The plugin hooks call `murmurplex-agent copilot-hook`, which is on the terminal's `PATH`.

| Copilot event | Murmurplex behaviour |
|---|---|
| `SessionStart` | Records the conversation; status `unknown`; preserves unresolved requests |
| `UserPromptSubmit`, other tools | `working`, unless attention remains |
| `ask_user` tool starts / finishes | `needs-input` / back to `working` when no other request remains |
| `Stop` | `finished`, unless attention remains |
| `ErrorOccurred` | An unrecoverable main-agent error reports `unknown`, preserving attention; recoverable errors do not change status |
| `SessionEnd` | `disconnected`, preserving attention |

Copilot permission prompts are **not** detected: the `permissionRequest` event fires for every permission check, including auto-approved ones, so it cannot show that you were asked. Set permission attention manually. Only event, conversation, subagent and tool identifiers and error recoverability are kept; prompts, error text and tool output are never forwarded. Verified with Copilot CLI 1.0.104.

Question tracking survives restarts and resuming the same conversation. A replacement conversation cannot resolve the old conversation's requests: clear them explicitly with **Set Agent Attention State** or `murmurplex-agent status working` (also `idle` or `finished`). Both adapters reject events from an inactive conversation, including its subagents.

Copilot hook reporting errors are written to stderr without a permission decision, and the helper exits successfully so a telemetry failure cannot deny a tool call. Ordinary mailbox/status commands still exit nonzero on errors. If hooks are disabled or reporting fails, use manual reporting.

### Automatic Codex CLI attention

New Codex terminals launched by Murmurplex pass a fixed set of [Codex hooks](https://learn.chatgpt.com/docs/hooks) with `-c hooks.<Event>=...`; your Codex configuration is not edited and `--dangerously-bypass-hook-trust` is never used. Codex only runs hooks you have trusted, so the **first time** Murmurplex detects untrusted hooks it shows a warning: in the Codex terminal run `/hooks`, review the Murmurplex hooks and trust them. Trust is recorded by hash in your Codex config and persists, because the definitions contain no per-launch or per-install values. Until then, set Codex status manually.

| Codex event | Murmurplex behaviour |
| --- | --- |
| Session start | Records the conversation ID and reports unknown; preserves unresolved attention. |
| Prompt submission or tool activity | Reports working without dismissing outstanding requests. |
| Permission request | Shows needs permission until all potentially matching tool calls return. Codex fires this only when approval is actually needed. |
| Interrupt | Reports idle and clears permission requests, because the turn was cancelled. |
| Main response stops | Reports finished unless attention remains. |
| Subagent stops | Clears that subagent's outstanding requests. |
| Session end | Reports disconnected, preserving unresolved attention. |

Codex has no question or tool-failure event, so questions and denied permissions must be cleared with **Set Agent Attention State** or `murmurplex-agent status working`. Codex hook reporting errors go to stderr and the helper exits successfully, because exit code 2 would block a tool or continue a turn. Payloads are reduced to event, conversation, subagent and tool identifiers.

### Persistence and devcontainers

The workspace extension and service run in the project environment, including inside a devcontainer. One project service is active per development-host window in this prototype.

The service listens on a random loopback port and rejects browser-origin requests. Each agent gets its own random Murmurplex token. The service keeps token hashes in memory and delivers the plaintext token through an owner-only file in VS Code's extension storage, outside the project checkout. The helper reads that file on every call; Murmurplex puts only its path, not its token, in the terminal environment and does not put its token in command arguments or normal helper output. Credential directories use mode 0700 and files use 0600 on POSIX; these modes do not establish equivalent access restrictions on Windows. Tokens are revoked when a terminal closes and replaced on restart. Do not forward the port.

This is local service authentication, not an encrypted vault or sandbox. The API enforces the permissions described above, but processes running as the same OS user can read other agents' credential files and the project-state file directly. It does not isolate malicious local code or prevent agents from writing secrets into source files.

Writes containing recognisable provider tokens, private keys, bearer credentials, obvious secret assignments or active Murmurplex tokens are rejected before persistence, with a generic error that does not repeat the secret. Existing state containing recognisable secrets is refused without rewriting it or creating migration backups; remove the credential securely and rotate it before retrying. Unknown or encoded secrets may not be detected. Murmurplex diagnostics redact recognisable secret patterns and 64-character hexadecimal strings. This is defence in depth, not a guarantee that arbitrary text is secret-free.

On startup, old `.murmurplex/credentials/` and `.murmurplex/runtime.json` files are removed. Terminals created before the storage change must be closed and relaunched using **Resume Saved Agent**. Previously committed files are not removed from Git history, but their old tokens are no longer accepted by the restarted service.

Project state is written through an atomic file replacement to `.murmurplex/state.json`. There is one writer per project directory. State is updated on each change, independently of an end-of-session handover. Add `.murmurplex/` to the target project's `.gitignore`.

Each write keeps the newest 500 acknowledged messages and 500 decisions; older ones are discarded without an archive. Unacknowledged messages are never discarded.

State is versioned (currently 3). Opening an older project migrates it in memory, validates it, and keeps the original as `state.json.v<N>.bak` (written once, never overwritten) before the first write. State written by a newer Murmurplex, or state that fails validation, is refused and left untouched; there are no downgrades. Migrations live in `src/migrations.js`.

The project directory must be on a persistent bind mount or volume if it is to survive container rebuilds. Back up `.murmurplex/state.json` alongside other important local project data. The included devcontainer mounts the source workspace using the standard Dev Containers workspace mount.

On reopening, saved agents are marked disconnected until their terminals can be reconnected. A restored terminal's actual agent state remains unknown until it reports status. Pending attention and mailbox items remain recorded. **Resume Saved Agent** preserves the identity and its mailbox; it starts a new CLI conversation, not a guaranteed continuation of the original CLI conversation.

The service runs for the extension session. It stops when the extension deactivates; the project record remains on disk. Reconnected terminals discover fresh credentials through their stable credential-file paths in extension storage after a restart. After an abnormal crash, a stale `writer.lock` may remain. It is never reclaimed automatically, because a PID can be reused or belong to another container; the startup error describes the holder when metadata is available. After confirming no service still owns the project, run **Murmurplex: Recover Stale Project Lock**. Recovery refuses a lock that changed during confirmation. Acquisition, recovery, commits and release are serialized, and a displaced service cannot commit or delete its replacement's lock.

The short-lived `writer-operation.lock` directory guards those operations. If a crash leaves it behind, Murmurplex fails closed: stop **all** Murmurplex windows and containers using the project before manually removing that empty directory, then recover `writer.lock` normally. Do not remove the operation guard while any service could still be running.

An interrupted process write leaves the last committed `state.json`; only regular temporary files matching the writer's UUID filename format are cleaned on restart. These guarantees assume a filesystem with atomic exclusive creation and rename. File data is synced before replacement, but directory entries are not synced, so this is not a guarantee of persistence through power loss.

### Prototype boundaries

- Native editor groups provide the layout. Automatic balancing affects the **whole current editor grid**, so it pauses while any source-editor tab (text, diff, custom or notebook) is open or a group is maximised; **Balance Terminal Grid** still balances on request. VS Code offers no API to isolate terminals from source editors, so complete separation is not possible; use a dedicated window or set `murmurplex.autoBalance` to `false` to arrange source editors independently. Balancing never closes or replaces tabs.
- The grid supports up to nine groups. When nine exist, a new agent opens as a tab in the focused group. VS Code's minimum pane sizes still apply. Odd group counts use different row heights to keep pane areas equal. Automatic removal of an empty group relies on VS Code's `workbench.editor.closeEmptyGroups` setting, enabled by default.
- Coordinator styling in the Explorer agent list is live and authoritative. Native terminal star/title/icon styling reflects the role at terminal creation; switching the coordinator does not yet restyle existing native tabs or transfer a model's private conversation history.
- Claude, Codex and Copilot terminals launched by Murmurplex have automatic lifecycle reporting for the events described above (Codex needs one-time hook trust; Copilot permission prompts and Codex questions are manual). Shell sessions and unsupported prompts require the helper or manual status command. Native terminal tabs/groups do not yet have dynamic attention styling; the Explorer list and aggregate status-bar indicator remain authoritative.
- Opening a project already owned by another window or container makes this window a read-only view: the agent list and status bar show the owner's saved state and refresh as it changes, but nothing is written and no agents launch. Run **Start or Resume Project** to take over after the other window closes, or **Recover Stale Project Lock** if its owner crashed.
- VS Code offers no way to decorate terminal tabs, so hidden tabs cannot show attention; use the Explorer list and status bar.
- Task assignment and coordinator selection are persistent records. Automated delegation, active coordinator handover, idle-agent wakeup, PR discovery, repository reconciliation, and merge controls are not implemented yet. The handover instructs agents to check repository state and request approval; this prototype does not enforce external Git actions.
- Backlog and decisions are accessible through the helper and handover; a dedicated backlog UI and richer PR/worktree records are next steps.

### Repository secret protection

This repository uses [Gitleaks](https://github.com/gitleaks/gitleaks) locally and in CI. Install Gitleaks 8.30.1 or later on PATH, then run:

```sh
npm run security:install-hook
npm run security:scan
npm run security:files
```

The hook scans staged changes before committing and fails closed if Gitleaks cannot run. Installation refuses to overwrite an existing hook setup; in that case, add `node scripts/scan-secrets.js staged` to your existing pre-commit hook. CI independently scans Git history and working files, with default provider rules plus a Murmurplex-runtime-token rule; scanner output is redacted. `.env` files are ignored, except `.env.example`, which must contain placeholders only.

Hooks are checkout-local and can be bypassed. For server-side protection, a repository administrator can run `npm run security:github` after `gh auth login`, or enable secret scanning and push protection in the repository's **Settings > Security**. The command reports failure if authentication, permissions or feature availability prevent enabling them; adding a workflow does not itself enable GitHub push protection.

These Git protections apply to this repository. Murmurplex does not silently install hooks or change GitHub settings in projects it manages. Set up equivalent protection in those repositories too. Scanning is best-effort: if a real secret has already been committed or pushed, revoke/rotate it and address Git history; adding ignore rules does not remove tracked secrets.

## Verify changes

```sh
npm test
npm run check
npm run test:vscode
```

The first command tests persistence, migrations, interrupted writes, explicit stale-lock recovery, single-writer protection, read-only views, compaction, corrupt-state handling, message acknowledgement, authentication and role permissions, secret rejection, request limits, grid geometry, Claude, Codex and Copilot hook reporting through the helper/service, and extension indicators. The second checks source/helper/security-script syntax.

The VS Code integration test needs a graphical desktop and `code` on PATH (override with `VSCODE_CLI`; add launch flags such as `--no-sandbox` with `VSCODE_ARGS`). CI runs it under Xvfb. It launches an isolated temporary profile and project, checks real terminal tabs and groups, balanced pane sizes through nine groups with a one-second settle limit, tenth-agent tab fallback, maximise/restore, read-only second-window takeover, persisted attention, and removal of a group while keeping its neighbour. Set `MURMURPLEX_TEST_LOAD=N` to add N busy processes during the test; they stop when the runner finishes. It leaves its temporary logs for diagnosis and does not use your normal VS Code profile. These checks do not replace interactive provider or devcontainer rebuild validation.

## Architecture

- `src/extension.js`: VS Code commands, native terminal groups, agent list and quiet attention indicator.
- `src/layout.js`: equal-area grid geometry.
- `src/claude.js`: launch-scoped Claude hook configuration and lifecycle/attention adapter.
- `src/copilot.js` and `copilot-plugin/`: Copilot lifecycle/attention adapter and the bundled hook plugin.
- `src/codex.js` and `src/codex-trust.js`: Codex launch-time hook definitions, lifecycle/attention adapter, and hook trust detection through `codex app-server`.
- `src/service.js`: authenticated loopback API, bound to the workspace extension lifecycle.
- `src/store.js`: atomic persistent project state, roles, tasks, decisions and mailbox.
- `bin/murmurplex-agent`: agent-facing mailbox and state helper.

The service is intentionally independent of VS Code APIs so its storage and messaging behaviour can be tested separately and later moved into a standalone process if background operation is needed.
