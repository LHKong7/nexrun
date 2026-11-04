# Sprint 1 Single Agent Chat

Status: Implemented; final real Pi acceptance blocked by OpenAI authentication

Created: 2026-11-04

Language: English

[Simplified Chinese version](sprint1.zh-CN.md) · [Target architecture](../architecture.md)

## Sprint goal

Deliver a usable direct-chat application: create a conversation, send a message, watch one Agent reply incrementally, stop generation, and return to persisted history after navigation or refresh. Use React with shadcn/ui for the client and Node.js for the service layer. Pi remains the first real Agent integration, restricted to text conversation in this sprint.

This is the first delivery slice, not an implementation of the entire target architecture. Group chats and Agent Teams are deferred. Preserve suitable identifiers and integration boundaries without implementing team tables, delegation tools, or a scheduler for future features.

## Product decisions

| Concern | Sprint 1 decision |
| --- | --- |
| Interaction | Chat list and chat detail; adjacent desktop panes, separate mobile routes |
| Conversation | One development owner and one configured Agent per direct chat |
| UI | React, Vite, TypeScript, Tailwind CSS, and official shadcn/ui components |
| Service | Node.js, TypeScript, and Fastify; one API process with an internal dispatcher |
| Storage | PostgreSQL for chats, messages, execution state, durable events, and pending dispatch |
| Agent development | Deterministic mock Adapter for development/tests and a minimal real Pi Adapter |
| Pi capability | Text input/output, independent native context per conversation, cancellation, and persisted session references |
| Tools | No Shell, file, browser, MCP, team, or repository execution tools |
| Streaming | Same-origin SSE with persisted events, cursors, and explicit reconnection states |
| Languages | English by default; complete Simplified Chinese UI and a separate Chinese sprint document |
| Delivery boundary | Local development and an access-controlled private preview; no public multi-tenant service |

## Scope and priorities

### Required features

- Create, list, open, rename, and archive direct conversations. Hide archived chats from the default list; reject archiving an active conversation until its Run has stopped. Hard deletion is outside this sprint.
- Display messages in stable server order with loading, empty, error, pending-send, generating, stopped, and interrupted states. Persist a default title from the first user message without another model call.
- Send nonempty text, preserve an unsent draft per conversation during navigation, support Enter to send and Shift+Enter for a newline, and never send prematurely during IME composition.
- Render safe Markdown with code blocks and copy actions. Disable raw HTML execution and unsafe URL schemes. Preserve the original text when copying code or messages.
- Stream one assistant message without creating a new bubble for every delta. Preserve a reader's scroll position and offer a new-output indicator when they are reading earlier messages.
- Show a Stop action during generation and distinguish a pending cancellation from confirmed termination. Keep partial output and its actual terminal state.
- Restore chat history and active execution after refresh or route changes. A browser disconnection must not cancel a server-owned Run.
- Provide matching `en` and `zh-CN` text, accessible keyboard/focus behavior, and usable desktop/mobile layouts.

### Optional after required work

Title search, dark mode, richer code highlighting, and additional small visual refinements may be added only after the core flow and reliability checks pass. They do not replace required streaming, persistence, or error handling.

### Explicitly deferred

Agent Teams, group chats, mentions, member management, task DAGs, multi-Agent execution, attachments, repository import, file modification, terminals, application previews, tool approvals, model-selection UI, secret-entry UI, full user accounts/OIDC, organizations, billing, background schedules, and other CLI integrations are deferred.

Do not deploy Temporal, Valkey, S3, a sandbox pool, or Firecracker for this slice. Those remain target-architecture options for later execution workloads. Do not add placeholder controls that imply these features already work.

## Client design

| Area | Required behavior | Candidate shadcn/ui building blocks |
| --- | --- | --- |
| Chat list | New chat, recent ordering, title, latest-message preview, selected state, archive/rename actions | Sidebar, Button, Dropdown Menu, Dialog, Input, Skeleton |
| Chat header | Title, Pi/mock identity, current generation status, navigation on mobile | Button, Badge, Dropdown Menu |
| Message timeline | User/assistant attribution, Markdown, partial output, retryable transport errors, copy, scroll behavior | Avatar, Scroll Area, Button, Tooltip, Alert |
| Composer | Multiline draft, send/stop, disabled/busy states, inline validation | Textarea, Button, Tooltip |
| Preferences | Language selection; optional later theme toggle | Select or Dropdown Menu |
| Feedback | Empty conversation, missing configuration, failed request, disconnection, cancellation | Skeleton, Alert, supported toast component |

Compose application-specific chat components above `components/ui`; do not place conversation state or API calls inside generated primitives. Start with CSS-variable design tokens and the system font to avoid unnecessary font downloads and extra license scope.

Use the official shadcn registry, record the selected primitive base in `components.json`, and keep it consistent. Base UI is the initial candidate; do not mix primitive bases accidentally or adopt unreviewed third-party chat kits. Official shadcn documentation covers [Vite setup](https://ui.shadcn.com/docs/installation/vite) and [the Base UI default](https://ui.shadcn.com/docs/changelog/2026-07-base-ui-default).

## Service design

### Minimal runtime topology

```text
React client
    -> Node.js API: conversation/message commands and SSE
        -> PostgreSQL: application state, event log, command outbox
        -> Internal dispatcher: one active Run per conversation
            -> Mock Adapter OR supervised Pi host process
                -> Authorized configured model service (Pi mode only)
```

The dispatcher runs inside the API service for this sprint. Keep its interface separate so a later worker process can replace it. Claims and active-Run constraints live in PostgreSQL rather than only in an in-memory map. Enforce a small configurable service concurrency limit and generation timeout; reject excess admission explicitly instead of silently accumulating unlimited work.

Start Pi in a dedicated child host with an explicit working directory and durable, conversation-specific session storage. Disable all built-in tools, custom tools, resource discovery, hooks, extensions, and project content unless explicitly needed and reviewed for text-only operation. No user request may enable tools or select an arbitrary provider URL. Verify that the runtime exposes an empty tool list; disable skills and repository instructions as well as extension discovery. Configure the model and credentials on the server; never put keys in frontend environment variables, API responses, logs, or committed files.

A process boundary is not an untrusted-code sandbox. This sprint accepts text and does not execute repository code. Add a true sandbox boundary before introducing executable tools or user-supplied extensions. The Pi host must shut down on parent disconnect, have a bounded lifetime, and reject stale attempt output.

### Data model

| Record | Required information |
| --- | --- |
| Conversation | ID, owner ID, `kind = direct`, title, archived timestamp, created/updated timestamps |
| Message | ID, Conversation ID, user/assistant role, stable display order, content, delivery/generation state, client message ID, timestamps |
| Run | ID, Conversation ID, triggering user Message, assistant Message, Adapter mode, status, request key/hash, cancellation/error information |
| ConversationEvent | Event ID, Conversation ID, per-conversation sequence, Run/Message references, event type, payload |
| AgentSession | Conversation/Agent scope, native session reference, runtime version, persistence location, last known state |
| CommandOutbox | Stable dispatch ID, Run ID, dispatch state, attempt identity, and timestamps |

Persist user Message, Run, assistant placeholder, initial acceptance event, and dispatch record in one transaction. Enforce one active Run per Conversation across tabs and duplicate HTTP requests. Reusing an idempotency key with the same body returns the original result; reusing it with different content returns a conflict. Check an existing request key before rejecting a duplicate as busy.

Do not create Team, TeamBinding, membership, Project, or task-graph storage for this sprint. Keep Run separate from Message so execution lifecycle does not distort the chat log. Add schema migrations and a fixture database for development/tests; browser storage is not authoritative history.

### API surface

| Method and route | Purpose |
| --- | --- |
| `GET /healthz` | Service liveness without exposing configuration secrets |
| `GET /api/conversations?cursor=&limit=` | Paginated recent nonarchived conversations |
| `POST /api/conversations` | Create an empty direct conversation |
| `PATCH /api/conversations/:id` | Rename or archive, with active-Run protection |
| `GET /api/conversations/:id/messages?before=&limit=` | Read history and current Run state with a snapshot event cursor |
| `POST /api/conversations/:id/messages` | Atomically accept text and a single-Agent Run using `Idempotency-Key` |
| `GET /api/conversations/:id/events?after=` | Replay and subscribe to SSE events |
| `GET /api/runs/:id` | Inspect an authorized Run, including cancellation outcome |
| `POST /api/runs/:id/cancel` | Request idempotent cancellation |

Return stable errors such as `VALIDATION_ERROR`, `CONVERSATION_NOT_FOUND`, `CONVERSATION_BUSY`, `IDEMPOTENCY_CONFLICT`, `AGENT_NOT_CONFIGURED`, `UPSTREAM_RATE_LIMITED`, and `RUN_INTERRUPTED`, with parameters for localization. Validate text size, pagination bounds, identifier ownership, content type, and concurrency before dispatch.

### Streaming and reconciliation

Persist sequenced events before broadcasting them. Notifications are wakeups; the database log remains the replay source. Subscribe from the history response's cursor so output produced between the initial history read and the SSE connection is not lost. Snapshot content and its cursor must represent the same consistent view.

Events cover message acceptance, assistant deltas, and Run state changes. Give deltas an assistant-message revision/offset, or reconstruct that message from a canonical snapshot on resynchronization, so reconnects cannot append text twice. A terminal event commits the canonical final/partial content and status. Keep bounded buffers and send heartbeats; expired cursors require explicit resynchronization.

Switching chats detaches the old UI subscription without stopping the old Run. Switching back restores current state. While one Run is active, new generation requests return a clear busy result; this sprint does not implement steering or a second-message queue. Network retries reuse the same request key; retrying a failed generation is an explicit new user action, not an automatic duplicate model request.

### Cancellation and restart semantics

Use Run states `queued`, `running`, `cancelling`, `completed`, `failed`, `cancelled`, and `interrupted`. Cancellation of queued work prevents dispatch. Cancellation during generation requests Pi abort and stays `cancelling` until termination is observed or the bounded host is forcibly stopped. Completion and cancellation compete through conditional database transitions so there is one terminal outcome; Stop cannot overwrite an already completed reply as cancelled.

Retain partial assistant content after failure, cancellation, or interruption and show its status. Late deltas after a terminal state are ignored. A stopped local request does not guarantee that the provider immediately stops billing.

On service restart, reconcile abandoned dispatch records and confirm that previous hosts can no longer execute before marking unresolved accepted Runs `interrupted`. For this sprint, that includes accepted-but-undispatched queued work: retire its outbox entry rather than automatically starting it. Do not blindly relaunch any old Run. Keep the affected Conversation unavailable for new generation until previous-host termination is established. Reconcile Pi/session state before accepting a later explicit continuation. This sprint promises persisted chat history and browser reconnection, not exact tool-level or model-request resumption after a process crash.

## Backlog

P0 items are required; P1 is optional and cannot delay P0. Current implementation and verification status is recorded below.

| ID | Priority | Deliverable | Depends on | Acceptance |
| --- | --- | --- | --- | --- |
| S1-01 | P0 | Initialize TypeScript workspace, web/API packages, scripts, lint/typecheck, and environment templates | None | A fresh checkout can install reproducibly and start the client/API from documented commands |
| S1-02 | P0 | Dependency inventory, pinned sources/lockfile, license CI gate, third-party notices and SBOM generation | S1-01 | Direct/transitive dependencies and copied shadcn sources have evidence; unknown/unreviewed additions fail the gate |
| S1-03 | P0 | English/Chinese catalogs, shadcn setup, design tokens, routes, responsive shell, and API contracts | S1-01, S1-02 | Both locales render the same navigation and states without missing keys; components use one recorded primitive base |
| S1-04 | P0 | PostgreSQL schema/migrations, owner-scoped repositories, chat APIs, atomic message acceptance | S1-01, S1-02 | Create/list/open/rename/archive work through Node.js and survive service restart; duplicate sends have one effect |
| S1-05 | P0 | Mock Adapter, dispatcher, durable event log, SSE replay, cancellation, and restart reconciliation | S1-03, S1-04 | Deterministic scenarios cover success, slow streaming, failure, disconnect, cancellation, and interruption |
| S1-06 | P0 | Chat list/detail, composer, safe Markdown/copy, streaming reconciliation, loading/error states | S1-03, S1-05 | Browser completes the required chat flow against the real Node.js API; history is not a frontend-only mock |
| S1-07 | P0 | Tool-disabled Pi Adapter, supervised host, configured model, native conversation scope, and real integration smoke | S1-02, S1-04, S1-05 | Two turns use the correct context; another conversation cannot see it; generation/abort/failure behavior is verified |
| S1-08 | P0 | Targeted automated checks, visual/accessibility review, runbook, and private-preview instructions | S1-06, S1-07 | Required demo and reliability checks pass; setup, limitations, and model credential requirements are documented |
| S1-09 | P1 | Title search, dark mode, or richer syntax highlighting | S1-08 | Added only when P0 is complete, with matching locales and reviewed dependencies |

## Implementation order

1. Establish workspace, dependency admission, shared contracts, and database migrations.
2. Build the English-first shadcn shell with Chinese resources and deterministic UI fixtures.
3. Connect persisted chat APIs and the mock streaming Adapter; finish send, stop, refresh, and reconnect behavior.
4. Add the constrained Pi Adapter and run the credential-backed integration smoke.
5. Complete focused regression checks, responsive/keyboard review, and setup documentation.

These are dependency-ordered milestones, not calendar commitments. Assign owners and dates when implementation capacity is known. UI fixtures and mock execution are development tools, not substitutes for the persisted service or real Pi verification.

## Demo and definition of done

Demonstrate the following in both English and Simplified Chinese:

1. Start a new chat, send a message, receive a streamed reply, and copy a code block.
2. Send a second message that refers to the first; the same conversation retains context.
3. Open another chat; its history and Agent context are independent.
4. Leave and reopen an active chat, then refresh; the reply is reconstructed without duplicate bubbles or duplicated text.
5. Submit the same request twice; only one logical Run and model dispatch are admitted. Another active request receives a busy response.
6. Stop during streaming; partial output remains and the final state reflects the observed result. Cancelling twice is harmless.
7. Trigger a mock provider error and a temporary stream disconnect; show actionable states without silently resending generation.
8. Restart the service during execution; history survives and unresolved work becomes interrupted rather than complete or automatically rerun.
9. Rename and archive an inactive conversation; it disappears from the default list without hard-deleting history.
10. Use the mobile layout, keyboard navigation, and Chinese IME without losing the draft or sending during composition.

The definition of done also requires migration/setup documentation, passing typecheck/build and focused API/UI tests, safe Markdown rendering, message/credential redaction, ownership checks, bounded input/work limits, and passing commercial-dependency gates for the actual artifacts.

The mock mode must run without external credentials. Real Pi verification needs an authorized, usable model credential supplied through server configuration. If it is unavailable, mark S1-07 and the real-integration result as blocked/unverified; a mock-only demo must not be reported as a completed Pi integration or a fully completed sprint unless that scope is explicitly deferred.

## Test and delivery boundaries

Use deterministic mock fixtures for most tests. Focus integration tests on atomic acceptance, same-key conflicts, one active Run, snapshot/replay races, cancellation-versus-completion, partial persistence, and restart behavior. Add browser scenarios for navigation, streaming, locale switching, IME input, and safe Markdown. Screen-reader announcements summarize status and completed content rather than announcing every token. Avoid tests that merely duplicate generated component implementation.

Default the development service to loopback and a fixed server-derived development owner. Never accept a client-provided owner ID as authority. Enforce expected Host/Origin, explicit allowed development origins, appropriate CSRF protections for cookie-authenticated commands, and no wildcard authenticated CORS. Do not put API credentials in SSE URLs.

A shared preview requires an authenticated access gate and TLS around the whole application, not just the landing page, with access to APIs/SSE protected as well. Full platform identity and multi-tenant claims are deferred. No public unauthenticated deployment or production-readiness claim is part of Sprint 1.

Review exact versions of React, shadcn sources, the selected primitives, Tailwind, Fastify, database client, Pi packages, Markdown renderer, icons, build/test tooling, and all transitive components. The upstream [shadcn/ui MIT license](https://github.com/shadcn-ui/ui/blob/main/LICENSE.md) is useful evidence but does not approve every generated dependency or third-party registry item. Preserve required license and notice material under [the project policy](../../AGENTS.md).

No dependency, CI gate, or application feature is considered implemented merely because it appears in this plan.

## Follow-up candidates

After reviewing Sprint 1, choose the next slice based on observed gaps: stronger authentication and private deployment, repository/sandbox execution, richer single-Agent controls, or group conversations. Agent Teams remain deferred until single-Agent lifecycle, persistence, and permissions are reliable. Preserve the broader architecture as a target without pulling its infrastructure into this sprint.

## Implementation record

Verification date: 2026-11-04. This sprint is not signed off as fully complete while real Pi acceptance is blocked.

| Item | Current status |
| --- | --- |
| S1-01 | Implemented; clean lockfile installation, startup configuration, typecheck and build verified |
| S1-02 | Implemented; 552 exact locked artifacts inventoried, SBOM/notices generated, license gate and three rejection tests passed |
| S1-03 | Implemented; English/Chinese catalogs, official shadcn Base UI primitives, responsive routes and contracts |
| S1-04 | Implemented; PostgreSQL persistence, migrations and owner-scoped chat APIs verified |
| S1-05 | Implemented; replay, idempotency, cancellation, partial persistence and conservative restart behavior verified |
| S1-06 | Implemented; all ten mock-backed browser acceptance scenarios passed, including concise replies, language independence, pagination, offline recovery and Chinese mobile IME |
| S1-07 | Implemented; 22 deterministic Pi host/output tests passed, including real SDK events with a synthetic stream, but live OpenAI/Pi acceptance remains blocked by HTTP 401 authentication |
| S1-08 | Local typecheck, lint, build and 65 automated tests passed; all ten browser scenarios passed; final acceptance still depends on S1-07 |
| S1-09 | Not started; optional refinements remain deferred |

The initial browser run exposed an offline status bug. It was fixed with explicit browser offline/online handling and a fresh snapshot before reconnect; the original assertions were retained. Browser tests now use their own generated PostgreSQL schema and temporary Pi state rather than sharing development chat history.

Git checkpoints: `b4a591d` records the plan; `d687f99` adds workspace and license admission; `b1e583f` adds the API and Pi host; `862924d` adds the chat UI. Later verification/runbook commits are listed in Git history.

The first real Pi smoke failed safely, and a direct OpenAI authentication probe returned HTTP 401. No successful real reply or live context-retention result is claimed. Configure a valid `NEXRUN_OPENAI_API_KEY` in the ignored root `.env` and run `npm run test:pi` to complete this gate. The mock mode remains usable without a model credential. CI configuration is committed, but no remote CI execution is claimed by local checks.

The mock/test follow-up replaces prompt/history reflection with concise deterministic answers, adds explicit formatting/context/failure fixtures, and enforces a current-assistant public-text boundary in the Pi host. Seven repeatable demo conversations contain 72 terminal Runs and 144 synthetic messages, including bilingual content, 60-turn history, and failed/stopped/interrupted examples. Import preserves existing IDs and user edits; its loopback guard rejects routing overrides. See the separate [testing and mock-data guide](../testing.md).

The expanded browser suite initially exposed a test-helper race: after a second send, a terminal-state assertion could select the previous completed turn. It now waits for the exact newly submitted assistant message order. All substantive assertions were retained, and the complete ten-scenario suite passed. Isolated browser/demo test schemas were confirmed removed after teardown. This follow-up makes no new model requests and does not change the live authentication blocker.
