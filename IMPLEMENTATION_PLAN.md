# Murmurplex implementation plan

Status: delivery plan with release scope and decisions agreed below. Remaining
acceptance thresholds and provider capability questions are called out explicitly.
Last updated: 29 October 2026.

[SPECIFICATION.md](SPECIFICATION.md) defines the product requirements; this plan
sequences them and does not relax them. [README.md](README.md) describes what can
be used today.

## Starting point

| Area | Implemented | Not yet complete |
| --- | --- | --- |
| Terminal workspace | Native editor groups, agent tabs, automatic grid balancing, maximise/restore, tenth-agent-as-tab, read-only second-window view, passing graphical validation for one to nine groups. | Isolation from source-editor groups and tab-level indicators (no VS Code API); devcontainer settle timing. |
| Lifecycle and attention | Claude, Codex and Copilot hook adapters, persistent requests, quiet Explorer/status-bar indicators, manual fallback. | Copilot permission prompts, Codex questions, unsupported Claude prompts, tab/group indicators. |
| Project record | Atomic writes, single writer, agents, coordinator identity, basic tasks, decisions, mailbox, versioned schema with tested migrations/backups, explicit stale-lock recovery, interrupted-write coverage and initial compaction. Read-only Git observations show branch, `HEAD`, working-tree changes and worktrees on startup; task branch/worktree references are persisted and compared locally. | Richer records, persisted PR references, remote-branch/PR reconciliation, archival/completed-task retention, devcontainer recovery; crashed operation guards still require offline manual removal. No power-loss durability guarantee. |
| Coordination | Saved coordinator selection, recipient-filtered copyable handover, per-agent credentials and enforced coordinator/worker permissions. | Configurable assignment authority, interruption-safe active handover, delivery tracking, automatic delivery and wakeup. |
| PR workflow | Handover text asks agents to verify state and get approval. | PR/review tracking, controlled merging, approval UI. |
| Engineering | Node tests, syntax check, graphical test script, GitHub Actions CI (Node 20/22, Xvfb VS Code test). | No packaging, no compatibility testing against provider CLI versions. |

Validation as of 29 October 2026 (observations, not guarantees):

- All 48 Node tests, syntax checks, working-file secret scanning and the scanner
  integration test passed locally.
- The expanded graphical test passed locally, including one-to-nine-group
  layout coverage, tenth-agent tab fallback, maximise/restore and read-only
  second-window takeover. It now waits for the worker terminal's tab and focus
  before adding a tab to that group, rather than assuming a group-open event
  means the terminal is ready.
- [CI run 40601270098](https://github.com/NewmanJustice/murmurplex/actions/runs/40601270098)
  passed secret checks, Node 20/22 tests and the Xvfb graphical job for
  `3740798`. The expanded local changes are not yet verified by CI.
- Claude Code 2.1.311 executed startup/shutdown hooks without a model request.
- The graphical test originally failed its equal-pane assertion; unchanged `HEAD`
  failed identically. **Resolved:** on VS Code 1.143.1 the layout reads as a
  transient mix of fractional and pixel sizes (`0.5` and `380.39`) immediately
  after `balance`, and settles to equal panes (`220`/`220`) within 100 ms. The
  test now polls until the layout settles (up to 5 seconds) with the same 2%
  tolerance, and passes. `gridLayout` was not at fault.
- A later graphical run failed its terminal-focus assertion. Reproduction
  showed the requested terminal and group were active, but the terminal tab
  label was empty. The test now checks terminal/group identity and terminal
  tab type instead of label text, with repeated focus switches during balance
  and failure diagnostics. Three consecutive isolated runs passed.
- Real interactive question/permission flows and all-provider devcontainer
  testing are still outstanding.

## Delivery rules

- Persist meaningful changes as they happen; preserve identities, mailboxes, task
  ownership and unresolved requests through upgrades, restarts and role changes.
- Project recovery is independent of provider conversation recovery.
- Use supported provider events and interfaces. Never infer completion from
  silence, treat terminal prose as a protocol, or inject keystrokes into a
  user-controlled terminal.
- Report provider capability gaps as limitations, not successes; keep manual
  status reporting and mailbox polling available.
- Never silently approve provider permissions; keep assignment and merge
  authority separate.
- Keep the service in the extension process for now.
- Ship small increments with focused tests and updated README/specification
  status.

## Agreed release scope

The specification's five acceptance scenarios remain the bar for the finished
product, but they should not all gate the first release.

| Release | Scope | Acceptance scenarios |
| --- | --- | --- |
| v0.1 reliable workspace | Stable terminal grid, automatic lifecycle attention for Claude, Codex and Copilot (manual fallback for any signal a provider cannot supply), durable recovery with local repository reconciliation, devcontainer recovery. | Terminal arrangement, quiet attention (all three providers, within their supported events), cross-session recovery (local repository state; PR state shown as unverified), devcontainer recovery. |
| v0.2 coordination | Per-agent authority, enforced handover, delivery tracking. | Coordinator replacement. |
| v0.3 PRs and merging | PR tracking, review coordination, approval-gated merges. | Cross-session recovery including PR state. |

Each release must document remaining gaps against the specification.

## Foundations and spikes (before milestone work)

These are small and time-boxed. They change later designs, so decide them first.

1. **Layout failure diagnosis (done).** The failure was a test timing artifact:
   the test read the layout before VS Code settled it. The test now waits for
    the settled layout. Local load measurements are recorded under milestone 1;
    devcontainer measurements remain.
2. **Provider capability matrix (partial).** Installed-version hook capabilities
    and launch/trust behaviour are recorded below. Interactive validation,
    conversation resumption and safe message delivery/wakeup remain incomplete.
    Latest stable CLIs are the agreed support target; automated compatibility
    checks are not yet implemented.
3. **VS Code UI options (done; native groups accepted by owner).** Checked against
   the VS Code 1.143 API typings and a throwaway spike in a real VS Code host.
   - *Source-editor isolation:* none for editor-area terminals. Terminals and
     source files share one editor grid (`vscode.setEditorLayout` and
     `tabGroups.all` cover both), so balancing resizes source groups too.
     Panel terminals (`TerminalLocation.Panel`, splits via `parentTerminal`) are
     outside the editor grid and do not appear in `tabGroups`, but the panel has
     one split-group model, so it does not map directly onto "groups with tabs".
   - *Hidden-tab indicators:* no API decorates a terminal tab.
     `registerFileDecorationProvider` applies to resource URIs only and `Tab`
     exposes no badge. Hidden-tab attention is limited to the aggregate Explorer
     tree and status bar, which work today, or a label prefix (below).
   - *Live restyling:* `iconPath`, `color` and `name` are fixed at creation.
     `workbench.action.terminal.renameWithArg {name}` renames the active terminal
     live (verified: `terminal.name` and the tab label update, and `[id]` in the
     name still allows reconnection). A hidden tab must be activated first, which
     changes the visible tab, so it is not suitable for background attention.
     Icon and colour changes (`changeIcon`, `changeColor`) are interactive pickers
     with no argument form. So coordinator styling is creation-time only, and a
     coordinator change cannot restyle existing tabs.
   - *Coordinator placement:* possible at creation via `viewColumn` (a column or
     `Beside`, up to nine); there is no API to pin or lock a group.
   Recommendation: native groups suffice for v0.1 if attention stays in the
   Explorer and status bar, the isolation gap is documented, and balancing is
   scoped (for example, skipped when source editors are open). Revisit a
   webview or pseudoterminal design only if hidden-tab indicators become a
   release requirement. Owner accepted native groups on 2026-10-28.
4. **State schema versioning and migrations (done).** State is version 3.
   Versions 1 and 2 migrate in memory with validation and a one-time original-file
   backup before writing. Newer or invalid state is refused untouched. Tests
   cover migration, backups and refusal; future state-shape changes require a
   new migration and version bump.
5. **Per-agent credentials (done).** Token hashes are held in memory; plaintext
   tokens are delivered in 0600 files in private VS Code extension storage outside
   the checkout, with 0700 credential directories. This is local authentication,
   not a provider-key vault or same-user isolation. User-only membership/role
   changes, coordinator-only task assignment/decisions, worker-owned task updates
   and recipient-filtered state/handovers are enforced. Native provider login is
   the default, with explicit opt-in to authentication-environment inheritance.
   Recognisable secrets are rejected from records and redacted in diagnostics.
   Pre-commit and CI Gitleaks scans protect this repository; enabling GitHub push
   protection still requires authenticated repository-admin access.
   Process-ancestry identity over a Unix socket is a possible
   later hardening. Per-agent credentials replace the original shared token;
   status/hook reporting is limited to the matching identity, within the
   documented same-account trust boundary.
6. **Continuous integration (core done).** Secret scans, Node 20/22 tests and
   syntax checks, and the graphical test under Xvfb are configured and have
   passed in GitHub Actions. Scheduled provider-CLI compatibility checks remain.

Exit criteria: failure explained and reproducible; capability matrix and UI
decision recorded; migrations and per-agent credentials tested; CI passing.

## Milestones and dependencies

| Milestone | Specification | Prerequisites | Release |
| --- | --- | --- | --- |
| 1. Terminal workspace | 3, 7, 11 | Spikes 1 and 3 | v0.1 |
| 2. Lifecycle coverage | 2, 4, 9, 11 | Spikes 2, 4, 5 | v0.1 (all three providers) |
| 3. Durable recovery | 5-8, 11 | Spikes 4 and 5 | v0.1 |
| 4. Coordination and delivery | 5, 7, 8, 11 | Milestone 3 message model; spike 5; milestone 2 for automated delivery | v0.2 |
| 5. PRs and merging | 5, 6, 11 | Milestone 3 for tracking; milestone 4 authority controls | v0.3 |

Milestones 1, 2 and 3 can proceed in parallel once their spikes complete.
Unsupported provider capabilities must not block unrelated work but remain
visible gaps.

## 1. Terminal workspace

Work:

- Verify add/remove of groups and tabs, resizing and rebalancing preserve
  processes, terminal contents and tab membership.
- Implement temporary maximise/restore, handling groups opened or closed while
  maximised.
- Implement the layout approach agreed in spike 3, including source-editor
  separation where supported and any hidden-tab/group indicators and coordinator
  placement.
- Remove the nine-group limit by design: keep extra agents as tabs, and define
  what happens when a tenth agent is added.
- Define multi-window behaviour: a second window opening the same project hits
  the single-writer lock, so show a clear error or a read-only view rather than
  a silent failure.

Acceptance (proposed thresholds, to be confirmed):

- Graphical test passes: pane areas within 2% and the layout settled within one
  second of the last change, for one to nine groups including odd counts.
- Maximise/restore preserves running processes and surviving tabs after
  intermediate additions and removals.
- Unavoidable VS Code limitations are listed as unmet requirements, not treated
  as satisfied.

Status: implemented against native groups. Maximise shrinks the other groups
(`minimizeOtherEditors`) and restore rebalances, so both are safe to repeat; the
native toggle was rejected because VS Code exposes no maximised state and layout
sizes lag behind commands, so the state cannot be derived. Automatic balancing
pauses while source editors are open or a group is maximised. A tenth agent
opens as a tab. A second window becomes a read-only view of the owner's state
(`Store.readOnly`, no lock, no writes) with a lock-recovery action, and can take
over by starting the project once the lock is free. The graphical test covers one
to nine groups with a one-second settle limit, the read-only window, the tenth
agent and maximise/restore. Locally, groups settled in under 0.3 s typically and
under 0.95 s with all 8 cores busy (`MURMURPLEX_TEST_LOAD=N`). Not yet measured
in a devcontainer. Unmet and documented: source-editor isolation and tab-level
attention indicators (no VS Code API).

## 2. Lifecycle coverage

Work:

- Implement provider adapters one at a time, from the capability matrix. Share
  logic only where provider semantics match.
- Complete interactive validation of the Claude adapter: cancellation, denied
  permissions, sandbox prompts, background continuations, hooks disabled by
  settings or policy.
- Distinguish response completion from task completion and CLI exit; keep
  unresolved requests independent of activity and disconnection.
- Add per-tab/group indicators where milestone 1 finds a supported mechanism.
- Add provider conversation resumption only where supported and verified;
  retain resuming shared project context in a new conversation.

Acceptance:

- For each implemented provider, a request in an inactive tab is visible without
  sound, flashing or focus stealing; focusing does not resolve it; a matching
  event or explicit acknowledgement does.
- Unrelated tools, parallel calls, subagent completion and reconnection do not
  clear requests; requests survive service restart and container rebuild.
- Malformed, duplicate, stale and out-of-order events and unavailable hooks
  never produce a finished state the integration cannot establish.
- Adapter/helper/service tests plus interactive smoke tests in local and
  container environments, with the owner's agreement before paid model calls.

Status: Claude, Copilot and Codex adapters are implemented and covered by
helper/service tests. Codex requires one-time hook trust. Copilot permissions,
Codex questions and unsupported Claude prompts remain manual. Conversation
resumption, full interactive flows and all-provider container validation are
not complete; implemented adapters do not close this milestone.

## 3. Durable recovery

Work:

- Harden abnormal-exit recovery: interrupted writes and stale writer locks.
  Never reclaim a lock solely because a PID is absent or reused; account for
  container/process identity.
- Extend tasks with priorities, acceptance criteria, dependencies, progress,
  blockers and review status; validate references and dependency cycles.
- Persist branch/worktree references, next actions, handovers, conversation
  references and unresolved questions.
- Define the message lifecycle once: queued, delivered (with time and delivery
  mechanism) and acknowledged, plus task links. Reading is not acknowledgement.
  Milestone 4 implements automatic delivery against this model.
- Bound state growth: retention or archival of acknowledged messages and old
  records, with a tested compaction that never drops unresolved items.
- Reconcile local repository/worktree state on reopening. Preserve history, show
  conflicts and stale records, and never repair destructively.
- Keep runtime credentials separate from durable state and refresh them after
  restart in local and container network contexts.

Acceptance:

- Focused tests for interrupted writes, corruption, migration, competing writers,
  stale locks and compaction.
- Closing with unfinished work and reopening recovers ownership, decisions,
  messages, next actions and attention without a final handover.
- Branch/worktree changes made outside Murmurplex are detected, not assumed
  running or complete.
- A devcontainer rebuild with persistent state recovers the record without
  surviving agent processes or old credentials.

Status: schema version 3 and migration backups, explicit stale-lock recovery,
writer-ownership checks, interrupted-write cleanup and initial compaction are
implemented and tested. Each write retains the newest 500 acknowledged messages
and 500 decisions, without archival; unacknowledged messages are preserved and
completed tasks are not compacted. Startup now reads branch, `HEAD`,
working-tree changes and worktrees into a separate Explorer view without
writing Git or Murmurplex state; observations are refreshed manually after
Git or task-reference changes and failures remain explicitly unverified.
Optional branch/worktree references persist on tasks and are compared with
local branch/worktree observations as present, stale, conflicting or
unverified; no automatic repair occurs. Remote-branch/PR reconciliation,
devcontainer rebuild validation and a fuller retention policy remain. A crash
inside a guarded writer operation
requires offline manual removal of `writer-operation.lock` after stopping all
project services. File data is synced before rename, but directory entries are
not; power-loss durability is not guaranteed.

## 4. Coordination and delivery

Work:

- Add separate, user-configurable assignment authority and merge authority
  settings; merge authority defaults to explicit user approval.
- Enforce coordinator assignment authority in the service using per-agent
  identity and a handover epoch that rejects requests from a superseded
  coordinator.
- Implement a persisted handover: outgoing coordinator relinquishes, shared
  context is prepared, replacement accepts, then assignment resumes. Recover
  from interruption at every step. Include ownership, progress, decisions,
  pending messages, unresolved requests and next actions; never claim to
  transfer private conversation history.
- Add capability-gated delivery at safe boundaries and idle wakeup only through
  supported interfaces; retries must not falsely acknowledge or duplicate
  assignments.
- Provide a user view of exchanges with controls to send messages, resolve
  blockers and intervene in a failed handover.
- Update coordinator styling and access when roles change, within verified VS
  Code capabilities.

Acceptance:

- Replace a coordinator across supported providers while workers keep identities,
  ownership and mailboxes.
- At most one coordinator can assign work; brief absence of a coordinator is
  preferable to overlapping authority.
- Fault injection before and after relinquishment, delivery and acceptance;
  superseded-coordinator requests are rejected.
- Delivery is marked only after a verified handoff, acknowledgement only
  explicitly; failures stay visible and retryable. Test while the user is typing,
  during permission prompts, and with busy or disconnected agents.

## 5. PRs and merging

Work:

- Link PRs to tasks, branches and worktrees; track reviews, checks, blockers and
  last verified merge state.
- Reconcile remote state on recovery and before acting; show missing network or
  authentication as unverified, not reconciled.
- Provide an approval flow: a VS Code confirmation showing the PR, head
  revision and checks. Approval is bound to that PR and head revision and
  invalidated when they change.
- Recheck head, mergeability, required checks and review policy immediately
  before merging; record the actual result and reconcile ambiguous outcomes.
- Make merge authority a setting with two values: `user-approval` (default) and
  `coordinator-after-review`. In the second mode the coordinator may merge
  without per-merge user approval, but only after a completed review, passing
  required checks, and an unchanged head revision, all rechecked at merge time.
- Document the enforcement boundary: Murmurplex controls its own operations, not
  arbitrary Git/CLI actions by same-account agents. The owner has not asked for
  stronger isolation; revisit only if that changes.

Acceptance:

- Mocked service/CLI tests for PRs changed, reviewed, merged or closed outside
  Murmurplex, and offline or unauthenticated recovery.
- No Murmurplex merge occurs without configured authority; another agent's
  message is never user approval; stale approvals are rejected.
- Failed or uncertain merges are never recorded as successful without
  verification. Live validation uses a disposable repository with the owner's
  approval.

## Packaging and release

- Distribution is the VS Code Marketplace. Before v0.1, settle publisher
  identity, versioning, extension metadata (icon, licence, privacy/telemetry
  statement), and minimum VS Code/Node versions. `package.json` currently has
  `"private": true` and a publisher ID (`murmurplex`) not yet confirmed as registered.
- Produce a VSIX in CI, smoke-test installing it in a clean profile and in a
  devcontainer, and publish from CI with a stored token, never from a
  developer machine.
- Keep the README and specification status table in step with what shipped,
  including supported provider versions and limitations.

## Decisions needing agreement

Agreed on 27 October 2026:

1. **Release scope:** the split above, with Codex and Copilot attention adapters
   in v0.1. If a provider lacks usable events, v0.1 documents it as manual
   fallback for those signals.
2. **Terminal UI:** investigate first (spike 3), then decide whether native editor
   groups remain.
3. **Provider versions:** latest stable release of each CLI only, checked by CI.
4. **Authority:** user approval is the default merge authority; the coordinator
   may merge after review when the setting allows it. Enforcement applies to
   Murmurplex operations; the same-account trust boundary is documented.
5. **Distribution:** VS Code Marketplace.

6. **Codex hook trust:** no bypass flag. Murmurplex installs a stable, hashed
   hook definition (fixed command, no per-launch values) and guides the user
   through a one-time `/hooks` trust review. Until trusted, Codex status stays
   manual and the UI says so.

Still open: the honest scope of conversation resumption, delivery and wakeup per
provider, which the capability matrix (spike 2) will determine.

## Provider capability matrix (verified against installed CLIs)

| | Claude Code 2.1 | Codex CLI 0.164 | Copilot CLI 1.0.104 |
|---|---|---|---|
| Lifecycle events | SessionStart/End, UserPromptSubmit, Stop, StopFailure | SessionStart/End, UserPromptSubmit, Stop, Interrupt | sessionStart/End, userPromptSubmitted, agentStop, errorOccurred |
| Tool/subagent events | Pre/Post/PostFailure, subagents | Pre/PostToolUse, SubagentStart/Stop (no failure event) | pre/postToolUse, postToolUseFailure, subagentStart/Stop |
| Permission signal | PermissionRequest | PermissionRequest (only when approval needed) | permissionRequest, plus `notification` (permission, elicitation, idle) |
| Question signal | AskUserQuestion tool | None documented (MCP elicitation untested) | `ask_user` tool via preToolUse; `notification` elicitation |
| Launch-scoped injection | `--settings <json>` (verified) | `-c hooks.<Event>=...` with a fixed definition; needs one-time `/hooks` trust, which persists by hash (verified; bypass flag not used) | `--plugin-dir <dir>` with `hooks/hooks.json` (verified: start/end payloads received) |
| Resume | `--resume` | `codex resume` | `--resume=<id>`, `--session-id` |
| Wakeup | not yet researched | `codex queue` exists | not yet researched |

Consequences:
- Copilot: injection is clean and the adapter is built (lifecycle plus `ask_user`).
  Permission attention is manual: `permissionRequest` fires for auto-approved
  checks too, and the `notification` payload was not verifiable non-interactively.
  Revisit `notification` once it can be tested in an interactive session.
- Codex: launch-scoped hooks need hash trust. A fixed `-c hooks.<Event>=...`
  definition (no per-launch or per-install values) keeps its hash, so one trust
  review via `/hooks` persists across launches and extension updates. Verified
  with the real CLI: untrusted hooks do not run; after trust, SessionStart,
  UserPromptSubmit and SessionEnd reached the service. The bypass flag is never
  used (decision 6). Trust state is read through `codex app-server`
  (`hooks/list`, `trustStatus`), which drives the one-time warning.
- Codex has no documented question or tool-failure event; those stay manual.
  Codex hook helper failures exit 0, because exit code 2 would block a tool or
  continue a turn.

## Next step

The first two repository-recovery increments are implemented: startup reads
the current branch, HEAD, working-tree changes and worktrees into a separate
read-only Explorer view; persisted task branch/worktree references are compared
against local branches and worktrees. Missing references are marked stale,
branch/worktree disagreement is marked conflicting, and unavailable Git state
is unverified. Nothing is automatically repaired and saved task status does
not imply work is still running or complete. PR state remains unverified until
milestone 5.

Recommended next increment: enrich task records with priorities, acceptance
criteria, dependencies, progress and blocker validation, then address local
branch changes made outside Murmurplex without destructive repair.

Other open v0.1 gates are richer task/recovery records, the remaining retention
policy, interactive provider validation, devcontainer layout/rebuild recovery,
provider-CLI compatibility CI, and packaging. Milestone statuses above distinguish
implemented slices from completed acceptance scenarios.
