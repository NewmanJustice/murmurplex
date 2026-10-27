# Murmurplex

A VS Code extension prototype for terminal agents working together on a persistent project, locally or in a devcontainer.

See [SPECIFICATION.md](SPECIFICATION.md) for the agreed requirements, architecture, acceptance scenarios, and prototype implementation status.

Terminals share the available editor space evenly and rebalance when terminals or editor groups are added or removed. Each group can contain multiple agent tabs. One agent is designated coordinator; tasks, decisions, roles and mailbox messages survive restarting the extension.

## Try the prototype

Requirements: desktop VS Code 1.95 or later; Node.js 20 or later in the project environment; whichever agent CLIs you want to run already installed and authenticated there. Node.js 22 is recommended for the devcontainer. No npm dependencies or build step are required.

1. Open this repository in VS Code. Optionally choose **Dev Containers: Reopen in Container**; the included development container provides Node.js, not the agent CLIs or their credentials.
2. Press **F5** and select **Run Murmurplex**. This opens an Extension Development Host with the prototype loaded.
3. In that new window, open the project folder you want the agents to work on.
4. Run **Murmurplex: Start or Resume Project** from the Command Palette. On a new project, choose the first agent and give it a name. The first agent is the coordinator. Choose `shell` to explore without starting an AI agent.
5. Run **Murmurplex: Add Agent Terminal Group** to add a visible pane, or **Murmurplex: Add Agent Tab to Current Group** to add a tab in the focused group.
6. Run **Murmurplex: Copy Project Handover**, then paste the brief into each agent to introduce its project record and mailbox commands.

Look for **Murmurplex** in Explorer and the status bar. The coordinator is marked with a star in the agent list; amber dots identify unresolved questions or permission requests. Clicking an agent focuses its terminal without clearing its request.

If F5 does not bring the project into a development host, this equivalent command launches it directly:

```sh
code --new-window --extensionDevelopmentPath=/absolute/path/to/murmurplex /absolute/path/to/your-project
```

### Commands

| Command | Behaviour |
| --- | --- |
| Start or Resume Project | Starts the local service and loads the project record; launches the first agent on a new project. |
| Add Agent Terminal Group | Adds an agent in a new visible editor group. |
| Add Agent Tab to Current Group | Adds another agent tab in the focused group. |
| Balance Terminal Grid | Gives editor panes equal area. |
| Resume Saved Agent | Reuses a saved agent identity and mailbox in a new terminal. Paste the project handover to restore its context. |
| Change Coordinator | Changes the single coordinator identity in the saved record. |
| Copy Project Handover | Copies the shared state and mailbox instructions. |
| Send Agent Message | Queues a message for the selected agent. |
| Set Agent Attention State | Exercises the attention indicator or explicitly resolves it. |

All command names begin with **Murmurplex:** in VS Code.

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
murmurplex-agent decision 'User approval is required before merging.'
```

`state` lists agent and task IDs. `task` accepts a title, optional status, optional owner ID, and optional existing task ID. Updating a task replaces its title, status and owner, so provide all three. Valid task states: `backlog`, `in-progress`, `blocked`, `review`, `done`.

Status values: `working`, `idle`, `needs-input`, `needs-permission`, `finished`, `disconnected`, `unknown`. `working`, `idle`, and `finished` resolve attention; disconnecting or focusing a terminal does not.

Reading an inbox does **not** acknowledge its messages. Acknowledgements persist. Mailbox delivery is pull-based in this prototype: agents need to check their inboxes, and messages never inject keystrokes into a terminal or automatically wake an agent.

### Persistence and devcontainers

The workspace extension and service run in the project environment, including inside a devcontainer. One project service is active per development-host window in this prototype.

The service listens on a random loopback port, requires a random bearer token, and rejects browser-origin requests. Runtime credentials are kept in `.murmurplex/runtime.json` with owner-only permissions. Do not forward this port or commit runtime credentials. Local project agents share the same trust boundary; the token is not per-agent access control.

Project state is written through an atomic file replacement to `.murmurplex/state.json`. There is one writer per project directory. State is updated on each change, independently of an end-of-session handover. Add `.murmurplex/` to the target project's `.gitignore`.

The project directory must be on a persistent bind mount or volume if it is to survive container rebuilds. Back up `.murmurplex/state.json` alongside other important local project data. The included devcontainer mounts the source workspace using the standard Dev Containers workspace mount.

On reopening, saved agents are marked disconnected until their terminals can be reconnected. A restored terminal's actual agent state remains unknown until it reports status. Pending attention and mailbox items remain recorded. **Resume Saved Agent** preserves the identity and its mailbox; it starts a new CLI conversation, not a guaranteed continuation of the original CLI conversation.

The service runs for the extension session. It stops when the extension deactivates; the project record remains on disk. Existing terminals discover fresh credentials from the project runtime file after a restart. After an abnormal crash, a stale `writer.lock` may need manual removal **after confirming no service still owns the project**. A second service will refuse to start rather than risk overwriting another writer's changes.

### Prototype boundaries

- Native editor groups provide the layout. While Murmurplex is active, auto-balance affects the **whole current editor grid**, including groups containing source files. It does not close or replace their tabs. Use a dedicated window or set `murmurplex.autoBalance` to `false` if you want to arrange source editors independently.
- The grid supports up to nine groups; additional agents can be tabs. VS Code's minimum pane sizes still apply. Odd group counts use different row heights to keep pane areas equal. Automatic removal of an empty group relies on VS Code's `workbench.editor.closeEmptyGroups` setting, enabled by default.
- Coordinator styling in the Explorer agent list is live and authoritative. Native terminal star/title/icon styling reflects the role at terminal creation; switching the coordinator does not yet restyle existing native tabs or transfer a model's private conversation history.
- Attention is supplied by the helper command or the manual status command. Automatic Claude/Codex/Copilot lifecycle hook installation and reliable question detection are not implemented yet.
- Task assignment and coordinator selection are persistent records. Automated delegation, active coordinator handover, idle-agent wakeup, PR discovery, repository reconciliation, and merge controls are not implemented yet. The handover instructs agents to check repository state and request approval; this prototype does not enforce external Git actions.
- Backlog and decisions are accessible through the helper and handover; a dedicated backlog UI and richer PR/worktree records are next steps.

## Verify changes

```sh
npm test
npm run check
npm run test:vscode
```

The first command tests persistence, recovery, single-writer protection, corrupt-state handling, message acknowledgement, authentication, request limits and grid geometry. The second checks extension and service syntax.

The VS Code integration test needs a graphical desktop and `code` on PATH (override with `VSCODE_CLI`). It launches an isolated temporary profile and project, checks real terminal tabs and groups, balanced pane sizes, persisted attention, and removal of a group while keeping its neighbour. It leaves its temporary logs for diagnosis and does not use your normal VS Code profile.

## Architecture

- `src/extension.js`: VS Code commands, native terminal groups, agent list and quiet attention indicator.
- `src/layout.js`: equal-area grid geometry.
- `src/service.js`: authenticated loopback API, bound to the workspace extension lifecycle.
- `src/store.js`: atomic persistent project state, roles, tasks, decisions and mailbox.
- `bin/murmurplex-agent`: agent-facing mailbox and state helper.

The service is intentionally independent of VS Code APIs so its storage and messaging behaviour can be tested separately and later moved into a standalone process if background operation is needed.
