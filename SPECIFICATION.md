# Murmurplex specification

Status: agreed product direction, with an initial prototype implemented.
Last updated: 29 October 2026.

This document records the intended product. The implementation status below distinguishes the working prototype from remaining requirements. See [README.md](README.md) for setup and usage.
See [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) for the proposed delivery milestones and acceptance gates.

## 1. Purpose

Murmurplex is a VS Code extension for agentic development using Claude Code, Codex CLI, and Copilot CLI in terminal sessions, including within devcontainers.

It should make several agents easy to arrange, make requests for attention visible without distraction, and provide a coordinator that maintains project progress across working sessions.

Persistence is a first-version requirement. A project must be able to pick up where its previous working session left off.

## 2. Project and session model

- A **project** is the durable workspace, backlog, coordination record, and shared notice board.
- A **working session** is a period of activity on that project. Ending a working session does not end or erase the project.
- A **terminal group** is a visible pane containing one or more terminal tabs.
- An **agent session** is an individual agent conversation or process, represented by a terminal tab.
- A **coordinator** is the single agent currently assigned to coordinate the project. The role can move between agents.

Several agents in a project may use the same CLI or different supported CLIs. A terminal group is not required to represent a separate project.

## 3. Terminal workspace

The workspace lives in VS Code's main editor area.

**Within the project panel, terminals share the available space evenly and rebalance when terminals are added or removed.** Each visible terminal group retains its own tabs, allowing multiple agent sessions within that group.

Required behaviour:

- Add or remove visible terminal groups without manually arranging the remaining groups.
- Add or remove a tab within a group without unnecessarily creating a new pane.
- Resize with the available editor space and maintain an even arrangement.
- Preserve running sessions, terminal contents, and tab membership during rebalancing.
- Temporarily maximise a terminal group and restore the previous grid.
- Keep the coordinator visually distinct and easy to find.
- Avoid changing unrelated source-editor arrangements where the eventual UI permits this separation.

The prototype uses native editor groups. Its balance operation affects the whole editor grid in the current window, so automatic balancing pauses while source-editor tabs are open or a group is maximised. It supports up to nine groups; further agents open as tabs in the focused group. This is a prototype constraint, not a requirement that projects must remain limited to nine agents.

## 4. Quiet attention indicators

Users need to see when an agent has a question, needs permission, or has finished, without being distracted from another agent.

Supported states should include:

| State | Meaning |
| --- | --- |
| Working | The agent reports that it is doing work. |
| Idle | The agent is available and has no reported attention request. |
| Needs input | A question or request for information is outstanding. |
| Needs permission | An approval request is outstanding. |
| Finished | The agent reports completion of its current work. |
| Disconnected | There is no connected terminal for the recorded agent. |
| Unknown | The integration cannot establish the agent's current state. |

Indicators should be subtle, persistent, and visible even when the requesting agent's tab is hidden. A tab colour or dot, with an aggregate indication at the group or project level, is the intended direction. Exact native-tab styling remains subject to VS Code capabilities.

There should be no flashing, sounds, or automatic focus stealing by default. Focusing a terminal must not dismiss an unresolved request. Responding, an appropriate subsequent agent event, or explicit acknowledgement should resolve it.

Use supported agent events where possible. Silence alone is not evidence of completion or a request for attention.

## 5. Coordinator

Each project has one active coordinator. The user can choose Claude Code, Codex CLI, or Copilot CLI for the role.

The coordinator should:

- Maintain the backlog, priorities, dependencies, and task ownership.
- Assign work and collect progress updates.
- Track blockers and outstanding questions.
- Coordinate reviews, PRs, and merging within the user's configured authority.
- Record decisions and keep the next intended actions clear.

The coordinator should be marked with a distinct icon and subtle accent. It should be easy to access from the terminal workspace, preferably appearing first or pinned where supported.

The user can replace the coordinator during a session, including when changing agent provider or encountering usage limits. The shared project record stays with the project. Handover should include task ownership, progress, decisions, shared board history, unresolved board and attention requests, and next actions.

The outgoing coordinator relinquishes its role before the replacement begins assigning work. Other workers continue without losing their identities or shared board history. A handover must not claim to transfer private conversation history that the new agent cannot access.

Task-assignment authority and merge authority are separate settings. The initial default should require user approval for merges. The user can instead allow the coordinator to merge after review. In that mode, Murmurplex must still verify a completed review, passing required checks, and an unchanged head revision at merge time. Enforcement applies to Murmurplex's own operations; it cannot restrict Git commands an agent runs directly in its terminal.

## 6. Persistent project record

Store the following durably as work happens:

- Backlog, priorities, acceptance criteria, and dependencies.
- Task assignments, progress, blockers, and completion or review status.
- Agent identities, coordinator identity, and conversation references where available.
- Branches, worktrees, PR references, reviews, and last known merge status.
- Decisions, handovers, outstanding questions, and next intended actions.
- Shared board posts, task links, mentions, directed requests and explicit acknowledgement state.

Persistence must not depend on remembering to write a final handover before closing VS Code.

On reopening, load the shared record and reconcile it against actual repository and PR state before continuing. Work may have changed outside Murmurplex. Previously running work must not be assumed to remain running or to have finished.

Project context recovery and CLI conversation recovery are separate capabilities. The project must remain resumable when an old agent conversation cannot be restored or a different provider takes over coordination.

State must survive normal VS Code restarts and devcontainer rebuilds when its storage is on a persistent mount. Recovery must preserve shared board history, unresolved board requests, task ownership, and unresolved attention requests.

## 7. Local project service

A small local service is part of the initial architecture. In a devcontainer, it should run alongside the agents inside the container.

Responsibilities:

- Maintain the durable project record.
- Serve the shared notice board to agents and an authenticated human-facing localhost page.
- Record agent status and outstanding requests.
- Provide updates to the extension's visual indicators.
- Recover project state, shared board history and unresolved board requests after restarting.

Use an authenticated local connection. Runtime credentials are separate from durable project state and stored outside the project checkout in private VS Code extension storage, not committed to Git. Per-agent tokens authenticate Murmurplex requests; they are not a vault for provider API keys or an isolation boundary against processes running as the same OS user. Keep project data on a persistent mount or volume. The design must account for the fact that container localhost and host localhost are different network contexts.

Only the user adds agents and replaces the coordinator. The current coordinator creates/assigns tasks and records decisions. Workers can update their own assigned tasks without reassigning them. All agents and the human can read the entire shared board and shared agent/task/decision records. Posts are authenticated as their author; only the addressed participant acknowledges a request. Previously private mailbox history remains in a read-only human-only archive, excluded from all agent API responses and handovers, including the coordinator's. These are service permissions, not filesystem or terminal-command isolation.

Leave provider authentication with supported provider login mechanisms; do not introduce a custom key vault. New terminals remove common authentication-secret environment variables by default, with an explicit machine-level compatibility opt-in to inheritance. Shell startup files, unknown variables and same-user access remain outside this protection. Reject recognisable secrets before writing project records and redact them from diagnostics, without claiming detection of every possible secret.

The prototype service runs within the workspace extension's process and stops when the extension deactivates. Durable state remains on disk. Running independently while VS Code is closed is a possible future extension, not a current requirement.

## 8. Shared notice board

The board is a coordination feed, not a knowledge store. Persistence supports interrupted coordination, not permanent knowledge retention. Lasting decisions belong in the project decision record, task progress and next actions belong on tasks, and durable technical knowledge belongs in project documentation. Pruning board history must not erase the only record of information needed to continue work.

Provide one durable notice board scoped to each project. Agents and the human post questions, progress updates, review requests, results, and handovers to a shared feed. The notice-board-first design replaces active private mailboxes, rather than maintaining two parallel communication systems.

Each post records:

- A stable post ID, authenticated author, creation time and text.
- An associated task where applicable and optional mentions of participants.
- An optional directed request and acknowledgement time. Directed does not mean private.

Posts survive restarts. Reading is separate from acknowledgement. Only the addressed participant may acknowledge a directed request; ordinary notices are not acknowledgeable. Acknowledgement does not imply task completion, delivery to a provider, approval, or a role change.

The human can inspect and post through an authenticated standalone localhost page with near-real-time refresh. Mentions and task links provide context without changing task ownership. New board posts are visible to all project agents; old private mail is preserved separately and never automatically published.

Storing a post does not itself make an agent read it. Integrations must deliver messages at appropriate points and, where supported, wake an idle agent. Avoid injecting text into a terminal while the user is typing or while an unrelated permission prompt is active.

The prototype browser polls once per second. Agents use explicit board read/post commands at safe task boundaries. Automatic delivery, notifications into provider conversations, and wakeup require further agent-specific integration. Board posts are untrusted communication, not instructions with elevated authority.

## 9. Implementation status

| Area | Working prototype | Remaining product requirements |
| --- | --- | --- |
| Layout | Native editor terminal groups, multiple tabs, equal-area balancing, maximise/restore, and additional agents as tabs after nine groups. Read-only view in a second window. | Separation from source-editor groups (not possible with native groups; automatic balancing pauses instead) and tab-level attention indicators (no VS Code API). |
| Agents | Launch installed Claude, Codex, Copilot, or a shell. Reuse a saved agent identity and shared project context; provider lifecycle hooks as described below. | Verified provider-specific conversation resumption and interactive/container validation. |
| Coordinator | Persistent coordinator selection; live visual distinction in Explorer. | Automated delegation, active handover, and updated styling on existing native terminal tabs. |
| Attention | Launch-scoped Claude hooks for tool questions, tool permissions, and response/session boundaries; Copilot plugin hooks for `ask_user` and response/session boundaries; launch-scoped Codex hooks (after one-time trust) for permission requests, interrupts and response/session boundaries; helper/manual fallback; quiet Explorer and status-bar indicators; unresolved requests survive disconnection. | Copilot permission prompts; Codex questions; unsupported Claude prompts and permission cancellation; indicators on hidden tabs and groups where supported. |
| Persistence | Atomic file replacement; one writer; versioned schema, validated migrations and backups; explicit stale-lock recovery and interrupted-write tests. Keeps the newest 500 decisions and 500 resolved board posts in posting order; older ordinary notices and acknowledged requests are permanently deleted on writes. Unacknowledged requests and the read-only legacy mailbox archive are never pruned. Tasks persist priority, acceptance criteria, dependencies, progress, next actions, blockers and optional branch/worktree references; dependencies are validated for existing tasks and cycles. The Repository view displays task metadata and compares saved references with local branches/worktrees without changing either state. Handovers are regenerated from the saved project record, including task progress and next actions. | Persisted PR records, remote-branch/PR reconciliation, archival/completed-task retention, and devcontainer recovery validation. An interrupted writer-operation guard requires offline manual removal; power-loss durability is not verified. |
| Authority | Per-agent credentials outside the checkout; user-only membership/coordinator changes; coordinator-only assignment/decisions; workers update their own tasks; all agents share the board and cannot read the legacy archive through the API. | Configurable assignment authority and interruption-safe active handover. Same-user filesystem and terminal operations are not isolated. |
| Notice board | Authenticated loopback API, agent helper, live localhost browser page for human read/post, durable shared posts with validated task links and mentions, directed-request acknowledgement, and human-only legacy mailbox archive. | Provider-specific safe notifications, idle-agent wakeup, and board archival. |
| PRs and merging | Handover instructions ask agents to verify state and obtain approval. | PR discovery, review tracking, merge actions, and enforced configurable merge authority. |
| Devcontainers | Workspace-side extension/service; development container configuration. | Full end-to-end verification with all three agent CLIs in the user's devcontainer workflow. |

The README describes operational limitations, including stale-lock recovery and the service's shared local trust boundary. Instructions to agents are not a substitute for enforced permissions.

## 10. Delivery sequence

1. Validate the terminal grid, group tabs, local service, and persistent shared board. Implemented locally within documented native-UI limits; devcontainer validation remains.
2. Integrate agent lifecycle events and quiet attention signals. Adapters are implemented for supported events; interactive validation and provider capability gaps remain.
3. Extend persistent task and project records, recovery, and repository reconciliation. Migrations, explicit lock recovery, initial compaction, and local task branch/worktree reference comparison are implemented; richer records and remote/PR reconciliation remain.
4. Add automatic coordinator-to-worker communication and handover.
5. Add PR tracking, review coordination, and configurable merge actions.

Persistence remains part of every stage; it is not deferred until the end.

## 11. Acceptance scenarios

### Terminal arrangement

Open several visible terminal groups, add a tab to an existing group, and remove a group. Available space rebalances evenly while the remaining processes, tabs, and terminal contents remain available.

### Quiet attention

An agent in an inactive tab requests permission. The user can see a subtle indication while continuing with another agent. Focusing the requesting terminal does not dismiss the request. Resolving it clears the indication.

### Cross-session recovery

Start a coordinator and two workers, assign tasks, record a decision, and post a directed review request on the board. Close VS Code with work unfinished. Reopen the project and recover ownership, decisions, board history, and unresolved board and attention requests. Verify actual repository and PR status before continuing.

### Coordinator replacement

Replace the coordinator with another supported agent. The new coordinator receives the shared record and pending work, while workers retain their identities and the board posts still retained under the retention policy. Only one agent has the active coordinator role.

### Devcontainer recovery

Rebuild a devcontainer with project state on persistent storage. Reopen the project and recover the coordination record without relying on surviving agent processes or private conversation history.

These are product acceptance scenarios, not a claim that the full product is complete. Current automated tests cover layout geometry and live VS Code groups/tabs through nine groups, tenth-agent tab fallback, maximise/restore, read-only second-window behaviour, persistence, migrations, explicit lock recovery, interrupted writes, compaction, board request acknowledgement, authentication and role permissions, secret rejection, and helper reconnection. Claude, Codex and Copilot hook tests cover supported lifecycle/attention events, request correlation, subagents and reporting failures; extension tests cover quiet indicators. Full interactive provider flows, repository/PR reconciliation and devcontainer rebuild recovery remain unverified.
