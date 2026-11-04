# Testing and mock data

[Simplified Chinese version](testing.zh-CN.md) · [Runbook](../README.md) · [Sprint 1](sprints/sprint1.md) · [Agent administration](admin-settings.md)

NexRun separates deterministic application checks from live model verification. Mock replies are presentation fixtures, not a substitute for a model or evidence that an external provider works. All fixtures in this repository are first-party synthetic data.

## Run the checks

Start the local PostgreSQL service, install the locked dependencies, and configure `.env` as described in the runbook. Then run:

```sh
npm run check
npm run build
```

`check` runs TypeScript, ESLint, the exact-release license gate, and the Node test suite. API and demo-data tests create temporary database schemas and remove them afterward. They never reset the development schema. `TEST_DATABASE_URL` selects their database independently of the application's `DATABASE_URL`.

Local verification on 2026-11-05 passed all 90 Node tests, all 19 browser scenarios, typecheck, lint, build, and the license gate for 552 exact locked artifacts. The deterministic Pi tests comprise 17 host/supervisor tests and six output tests. No remote CI or successful live provider run is claimed by these results.

For browser tests, stop any manually started API and Web servers before running:

```sh
npm run test:e2e
```

Playwright reserves ports 3001 and 5173, starts in mock mode, creates its own random PostgreSQL schema and temporary Pi state, and shuts the API down gracefully to remove those resources. Administration scenarios can select Pi through an injected runtime that cannot start a model host; their credential checker and keys are synthetic. Local tests use installed Google Chrome; CI uses the matching Playwright Chromium. Browser installation instructions are in the runbook. No real provider credentials or model calls are required by these checks.

To isolate a failure, run only the relevant files:

```sh
node --import tsx --test apps/api/test/mock.test.ts
node --import tsx --test apps/api/test/pi-output.test.ts
node --env-file-if-exists=.env --import tsx --test apps/api/test/demo.test.ts
npm run test:e2e -- --grep 'loads earlier history'
```

Pi host lifecycle tests also inspect and signal only their own marked child processes. They require normal local process permissions. A test failure must be fixed or recorded; do not weaken an assertion simply to make a run pass.

## Deterministic mock scenarios

Normal messages receive a short, intent-based suggestion or greeting. They do not echo the full prompt, append previous messages, or expose a transcript. In automatic response-language mode, English is the fallback; the last recognized explicit response-language request in the current prompt takes priority, followed by Chinese-script detection. A fixed English or Simplified Chinese response language saved in administration overrides this automatic selection for future replies. UI locale and prior conversation language do not select the answer language.

These case-sensitive commands are development fixtures. Surrounding whitespace is ignored; embedded newlines or command lookalikes are ordinary input. In automatic mode, optional single-line arguments can select a response language; code and Markdown payloads remain fixed. The language examples below assume automatic mode.

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

The Pi system policy asks for key conclusions and relevant information, concise by default. Automatic mode follows the prompt's language; a fixed administration response-language setting selects future assistant prose independently of the UI locale. Original prompts, quotations, and code are preserved. The policy permits detailed explanations when requested. It disallows transcript replay, private reasoning, internal traces, status logs, and claims of actions unavailable to the text-only runtime.

The host forwards only the current assistant message's public text events and canonical final text. It does not serialize aggregate Agent/session history, user messages, thinking content, tool arguments/results, or status events as the reply. Previous chat messages still exist as separate history entries in the UI. Ordinary quoted labels, requested code, Unicode, whitespace, and longer explanations are preserved; there is no blanket regex deletion or arbitrary shortening of model text.

| Layer | Checks |
| --- | --- |
| Mock Adapter | Concise deterministic replies, explicit language requests, bounded relevant context, command parsing, Unicode, exact cumulative streaming, Stop, partial failure, callback backpressure |
| Pi output and host | Public-text filtering, canonical final text, stale/late events, real SDK event wiring with a synthetic stream, private resources, credential isolation, cancellation, timeout, crash reconciliation |
| API | Atomic acceptance/outbox, idempotency, capacity, ownership, history pagination, SSE replay/resync, partial persistence, restart interruption, serialized configuration/message admission, hot application and Pi model binding |
| Administration | Encrypted credentials, private master-key permissions, restart recovery, key actions/environment fallback, revision conflicts, confirmed rollback, unknown-commit fail-closed recovery, validation, endpoint authorization, sanitized metadata-only checks |
| Demo data | Atomic/repeatable imports, owner conflicts, user edit preservation, continuation, multi-page history and event reconstruction |
| Browser | Context isolation and concise replies, offline/navigation/refresh recovery, Stop, send retry, failure recovery, rename/archive, Chinese mobile IME, Markdown/code copying and localized notifications, answer/UI language independence, pagination, input validation, language-menu keyboard controls, modal focus trapping and restoration, bilingual/mobile administration and synthetic runtime/key workflows |
| Dependency gate | Lockfile changes, unreviewed or incompatible licenses, copied component source drift |

The interface uses official shadcn Base UI primitives. The language tests interact with an accessible combobox/listbox rather than a native selection menu. Modal checks exercise the rename Dialog and archive AlertDialog, including initial focus, Tab containment, Escape/cancel, localized labels, and restored trigger focus. Keyboard tests wait for the actual focused option before the next key so asynchronous focus placement cannot hide a regression or select the previous option.

## Administration coverage

Settings and Node API integration tests verify encrypted persistence without plaintext in the database or public responses, master-key permissions and tamper rejection, revision-zero environment defaults, explicit key replacement/removal/inheritance, stale revisions, active-Run protection, and rollback that leaves the old runtime usable. A lost-COMMIT-acknowledgement regression performs a real PostgreSQL commit before injecting a transport failure: cached settings become unavailable, queued message admission is rejected, the API closes, and a restarted service recovers the committed revision instead of accepting work with old credentials.

Actual local-Origin and token authorization are exercised against Node endpoints. The browser unlock scenario simulates the HTTP 401 transport contract; it does not establish server authorization by itself. Browser workflows use synthetic keys and network-free runtime/checker fixtures to test saving and reloading Mock/Pi/model/language settings, key replacement/removal/environment fallback, credential diagnostics, stale revisions, active-Run rejection, and secret input/token lifetime. These checks make no real model calls.

Hot-application tests verify that configuration changes and message acceptance share admission serialization, same-model credential rotation can continue a Pi chat, and a changed Pi model requires a new chat. Reply-language checks cover both automatic mock selection and a fixed administration override independently of UI language. The credential checker uses model metadata access rather than generation; its successful synthetic result is not proof of provider authentication or a real Pi reply. Setup, access, backup, and recovery details are in the [Agent administration guide](admin-settings.md).

## Live Pi verification

Configure an authorized `NEXRUN_OPENAI_API_KEY` privately in the ignored root `.env`, then run:

```sh
npm run test:pi
```

This opt-in check makes real OpenAI requests. It verifies native two-turn context, conversation isolation, persisted session permissions, cancellation, and configuration failure. Deterministic tests prove event selection and application behavior, not a model's compliance with every instruction. Live response quality and provider authentication still require this separate check. The earlier live attempt returned HTTP 401; no successful live result is claimed until usable credentials are supplied.
