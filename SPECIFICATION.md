# Murmurplex specification

Status: agreed product direction, with an initial prototype implemented.
Last updated: 27 October 2026.

This document records the intended product. The implementation status below distinguishes the working prototype from remaining requirements. See [README.md](README.md) for setup and usage.

## 1. Purpose

Murmurplex is a VS Code extension for agentic development using Claude Code, Codex CLI, and Copilot CLI in terminal sessions, including within devcontainers.

It should make several agents easy to arrange, make requests for attention visible without distraction, and provide a coordinator that maintains project progress across working sessions.

Persistence is a first-version requirement. A project must be able to pick up where its previous working session left off.

## 2. Project and session model

- A **project** is the durable workspace, backlog, coordination record, and mailbox.
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

The prototype uses native editor groups. Its balance operation affects the whole editor grid in the current window, including groups containing source files. It supports up to nine groups, with additional agents available as tabs. This is a prototype constraint, not a requirement that projects must remain limited to nine agents.

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

The user can replace the coordinator during a session, including when changing agent provider or encountering usage limits. The shared project record stays with the project. Handover should include task ownership, progress, decisions, queued messages, unresolved requests, and next actions.

The outgoing coordinator relinquishes its role before the replacement begins assigning work. Other workers continue without losing their identities or mailboxes. A handover must not claim to transfer private conversation history that the new agent cannot access.

Task-assignment authority and merge authority are separate settings. The initial default should require user approval for merges.

## 6. Persistent project record

Store the following durably as work happens:

- Backlog, priorities, acceptance criteria, and dependencies.
- Task assignments, progress, blockers, and completion or review status.
- Agent identities, coordinator identity, and conversation references where available.
- Branches, worktrees, PR references, reviews, and last known merge status.
- Decisions, handovers, outstanding questions, and next intended actions.
- Mailbox messages and their delivery and acknowledgement state.

Persistence must not depend on remembering to write a final handover before closing VS Code.

On reopening, load the shared record and reconcile it against actual repository and PR state before continuing. Work may have changed outside Murmurplex. Previously running work must not be assumed to remain running or to have finished.

Project context recovery and CLI conversation recovery are separate capabilities. The project must remain resumable when an old agent conversation cannot be restored or a different provider takes over coordination.

State must survive normal VS Code restarts and devcontainer rebuilds when its storage is on a persistent mount. Recovery must preserve pending messages, task ownership, and unresolved attention requests.

## 7. Local project service

A small local service is part of the initial architecture. In a devcontainer, it should run alongside the agents inside the container.

Responsibilities:

- Maintain the durable project record.
- Route messages between the coordinator and workers.
- Record agent status and outstanding requests.
- Provide updates to the extension's visual indicators.
- Recover project state and pending messages after restarting.

Use an authenticated local connection. Runtime credentials are separate from durable project state and are not committed to Git. Keep project data on a persistent mount or volume. The design must account for the fact that container localhost and host localhost are different network contexts.

The prototype service runs within the workspace extension's process and stops when the extension deactivates. Durable state remains on disk. Running independently while VS Code is closed is a possible future extension, not a current requirement.

## 8. Communication and mailbox

Provide a mailbox scoped to each project. Agents should be able to exchange assignments, questions, progress updates, review requests, results, and handovers.

Each message should record:

- A stable message ID, sender, recipient, and creation time.
- Message content and an associated task where applicable.
- Whether it is queued, delivered, or acknowledged, with those stages distinguished.

Messages survive restarts. Reading and acknowledging a message are separate actions. Pending messages should not be represented as completed work.

The user can inspect exchanges, send messages directly to agents, and intervene in coordination.

Storing a message does not itself make an agent read it. Integrations must deliver messages at appropriate points and, where supported, wake an idle agent. Avoid injecting text into a terminal while the user is typing or while an unrelated permission prompt is active.

The prototype uses explicit mailbox commands and inbox polling. Automated delivery and wakeup require further agent-specific integration.

## 9. Implementation status

| Area | Working prototype | Remaining product requirements |
| --- | --- | --- |
| Layout | Native editor terminal groups, multiple tabs, equal-area balancing and automatic rebalancing. | Temporary maximise/restore workflow; finer separation from unrelated source-editor groups. |
| Agents | Launch installed Claude, Codex, Copilot, or a shell. Reuse a saved agent identity and mailbox. | Provider-specific conversation resumption and lifecycle integration. |
| Coordinator | Persistent coordinator selection; live visual distinction in Explorer. | Automated delegation, active handover, and updated styling on existing native terminal tabs. |
| Attention | Helper/manual status updates; quiet Explorer and status-bar indicators; unresolved requests survive disconnection. | Automatic question, permission, and completion detection; indicators on hidden tabs and groups where supported. |
| Persistence | Atomic file replacement; one writer; saved agents, tasks, decisions, messages, and coordinator role. | Richer backlog metadata, PR/worktree records, automatic reconciliation, and improved abnormal-crash recovery. |
| Mailbox | Authenticated loopback API, agent helper, durable messages, explicit acknowledgement. | Task-linked messages, explicit delivery tracking, automatic delivery and idle-agent wakeup. |
| PRs and merging | Handover instructions ask agents to verify state and obtain approval. | PR discovery, review tracking, merge actions, and enforced configurable merge authority. |
| Devcontainers | Workspace-side extension/service; development container configuration. | Full end-to-end verification with all three agent CLIs in the user's devcontainer workflow. |

The README describes operational limitations, including stale-lock recovery and the service's shared local trust boundary. Instructions to agents are not a substitute for enforced permissions.

## 10. Delivery sequence

1. Validate the terminal grid, group tabs, local service, and persistent mailbox. This is the current prototype slice.
2. Integrate agent lifecycle events and quiet attention signals.
3. Extend persistent task and project records, recovery, and repository reconciliation.
4. Add automatic coordinator-to-worker communication and handover.
5. Add PR tracking, review coordination, and configurable merge actions.

Persistence remains part of every stage; it is not deferred until the end.

## 11. Acceptance scenarios

### Terminal arrangement

Open several visible terminal groups, add a tab to an existing group, and remove a group. Available space rebalances evenly while the remaining processes, tabs, and terminal contents remain available.

### Quiet attention

An agent in an inactive tab requests permission. The user can see a subtle indication while continuing with another agent. Focusing the requesting terminal does not dismiss the request. Resolving it clears the indication.

### Cross-session recovery

Start a coordinator and two workers, assign tasks, record a decision, and queue a review request. Close VS Code with work unfinished. Reopen the project and recover ownership, decisions, pending messages, and outstanding requests. Verify actual repository and PR status before continuing.

### Coordinator replacement

Replace the coordinator with another supported agent. The new coordinator receives the shared record and pending work, while workers retain their identities and mailboxes. Only one agent has the active coordinator role.

### Devcontainer recovery

Rebuild a devcontainer with project state on persistent storage. Reopen the project and recover the coordination record without relying on surviving agent processes or private conversation history.

These are product acceptance scenarios. The current automated tests cover a subset: layout geometry, live VS Code group/tab behaviour, persistence, mailbox acknowledgement, service authentication, invalid requests, and helper reconnection after service restart.
