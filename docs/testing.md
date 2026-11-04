# Testing and mock data

[Simplified Chinese version](testing.zh-CN.md) · [Runbook](../README.md) · [Sprint 1](sprints/sprint1.md)

NexRun separates deterministic application checks from live model verification. Mock replies are presentation fixtures, not a substitute for a model or evidence that an external provider works. All fixtures in this repository are first-party synthetic data.

## Run the checks

Start the local PostgreSQL service, install the locked dependencies, and configure `.env` as described in the runbook. Then run:

```sh
npm run check
npm run build
```

`check` runs TypeScript, ESLint, the exact-release license gate, and the Node test suite. API and demo-data tests create temporary database schemas and remove them afterward. They never reset the development schema. `TEST_DATABASE_URL` selects their database independently of the application's `DATABASE_URL`.

Local verification on 2026-11-04 passed all 65 Node tests, all ten browser scenarios, typecheck, lint, build, and the license gate for 552 exact locked artifacts. No remote CI or successful live provider run is claimed by these results.

For browser tests, stop any manually started API and Web servers before running:

```sh
npm run test:e2e
```

Playwright reserves ports 3001 and 5173, forces mock mode, creates its own random PostgreSQL schema and temporary Pi state, and shuts the API down gracefully to remove those resources. Local tests use installed Google Chrome; CI uses the matching Playwright Chromium. Browser installation instructions are in the runbook. No provider credentials are required by these checks.

To isolate a failure, run only the relevant files:

```sh
node --import tsx --test apps/api/test/mock.test.ts
node --import tsx --test apps/api/test/pi-output.test.ts
node --env-file-if-exists=.env --import tsx --test apps/api/test/demo.test.ts
npm run test:e2e -- --grep 'loads earlier history'
```

Pi host lifecycle tests also inspect and signal only their own marked child processes. They require normal local process permissions. A test failure must be fixed or recorded; do not weaken an assertion simply to make a run pass.

## Deterministic mock scenarios

Normal messages receive a short, intent-based suggestion or greeting. They do not echo the full prompt, append previous messages, or expose a transcript. English is the fallback; explicit response-language requests in the current prompt take priority, followed by Chinese-script detection. UI locale and prior conversation language do not select the answer language.

These case-sensitive commands are development fixtures. Surrounding whitespace is ignored; embedded newlines or command lookalikes are ordinary input. Optional single-line arguments can select a response language; code and Markdown payloads remain fixed.

| Input | Expected behavior |
| --- | --- |
| `Hello` | A brief greeting |
| `请用英文简要回答` | A concise English reply despite the Chinese prompt |
| `Reply in Simplified Chinese` | A concise Chinese reply despite the English prompt |
| `/slow` | About five seconds of cumulative snapshots, with an early partial reply for Stop/reconnect checks |
| `/error` | Partial reply followed by `UPSTREAM_ERROR`; previously observed text remains visible |
| `/code` | A fixed TypeScript block; copying preserves the original code and trailing newline |
| `/markdown` | Fixed formatting, harmless XSS test strings, an unsafe URL, and an ordinary reference link; the UI must block active content |
| `/remember release-42` | Acknowledge a single-line value without echoing it |
| `/context` | Return only the most recent valid remembered user value in this conversation, or a localized absence message |

Remembered values are limited to 80 Unicode characters. Only prior user `/remember` messages qualify; assistant messages and unrelated history cannot replace the value. There is no shared memory in the Adapter. The API supplies the latest 100 prior messages, so this fixture is a bounded context check rather than permanent key/value storage. Mock commands have no special meaning in Pi mode.

`/markdown` deliberately includes unsafe text as test data. Its purpose is to test Markdown rendering without reflecting arbitrary user input into an assistant answer. Do not enable HTML execution to render this fixture.

## Import demo conversations

With PostgreSQL running and `AGENT_MODE=mock`, run:

```sh
npm run demo:seed
npm run dev
```

The seed command applies migrations and imports missing fixtures into the loopback development database. It refuses Pi mode, non-PostgreSQL URLs, remote hosts, and routing overrides such as `?host=remote.example`. Supported URL query parameters are `sslmode`, `application_name`, `connect_timeout`, and `statement_timeout`. It does not call an Agent, contact a model, or enqueue executable work.

The dataset contains seven conversations, 72 terminal Runs, and 144 messages on a fresh import:

| Conversation | Contents |
| --- | --- |
| `Demo · Release checklist` | Three English exchanges with focused answers and an honest text-only capability boundary |
| `Demo · 发布准备` | Two Chinese exchanges |
| `Demo · Markdown and code` | Two exchanges with exact code text |
| `Demo · Recovery examples` | Failed, recovered, stopped, and interrupted replies with retained partial text |
| `Demo · Long history (60 turns)` | 120 ordered messages spanning several history pages and event batches |
| `Demo · Archived conversation` | Retained history excluded from the active list |
| `Demo · Start a conversation` | An empty chat ready for a new message |

All seeded Runs are terminal, all outbox records are retired, and event snapshots reconstruct the same canonical messages. Six chats appear in the active list. Imported chats can continue normally in mock mode.

Stable fixture IDs make import repeatable. A second import skips existing IDs, preserving edits, archives, added messages, and unrelated conversations. A conflicting owner aborts the entire fixture transaction. There is no destructive reset command; archiving a demo uses the same UI as any other conversation.

## Response boundaries and coverage

The Pi system policy asks for key conclusions and relevant information, concise by default, in the requested language. It permits detailed explanations when requested. It disallows transcript replay, private reasoning, internal traces, status logs, and claims of actions unavailable to the text-only runtime.

The host forwards only the current assistant message's public text events and canonical final text. It does not serialize aggregate Agent/session history, user messages, thinking content, tool arguments/results, or status events as the reply. Previous chat messages still exist as separate history entries in the UI. Ordinary quoted labels, requested code, Unicode, whitespace, and longer explanations are preserved; there is no blanket regex deletion or arbitrary shortening of model text.

| Layer | Checks |
| --- | --- |
| Mock Adapter | Concise deterministic replies, explicit language requests, bounded relevant context, command parsing, Unicode, exact cumulative streaming, Stop, partial failure, callback backpressure |
| Pi output and host | Public-text filtering, canonical final text, stale/late events, real SDK event wiring with a synthetic stream, private resources, credential isolation, cancellation, timeout, crash reconciliation |
| API | Atomic acceptance/outbox, idempotency, capacity, ownership, history pagination, SSE replay/resync, partial persistence, restart interruption |
| Demo data | Atomic/repeatable imports, owner conflicts, user edit preservation, continuation, multi-page history and event reconstruction |
| Browser | Context isolation and concise replies, offline/navigation/refresh recovery, Stop, send retry, failure recovery, rename/archive, Chinese mobile IME, Markdown/code copying, answer/UI language independence, pagination, input validation |
| Dependency gate | Lockfile changes, unreviewed or incompatible licenses, copied component source drift |

## Live Pi verification

Configure an authorized `NEXRUN_OPENAI_API_KEY` privately in the ignored root `.env`, then run:

```sh
npm run test:pi
```

This opt-in check makes real OpenAI requests. It verifies native two-turn context, conversation isolation, persisted session permissions, cancellation, and configuration failure. Deterministic tests prove event selection and application behavior, not a model's compliance with every instruction. Live response quality and provider authentication still require this separate check. The earlier live attempt returned HTTP 401; no successful live result is claimed until usable credentials are supplied.
