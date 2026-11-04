# NexRun

[Simplified Chinese version](README.zh-CN.md) · [Architecture](docs/architecture.md) · [Sprint 1](docs/sprints/sprint1.md)

NexRun is a local, single-owner chat application with a React/shadcn UI, a Node.js API, PostgreSQL persistence, and streamed Agent replies. Sprint 1 provides direct chats with a deterministic mock Adapter and a text-only Pi Adapter. Group chats, Agent Teams, repository execution, and the broader execution infrastructure remain later work.

## Requirements

- Node.js **22.19.0 or newer**, with npm.
- Docker with Docker Compose v2 and a running Docker daemon for the development database.
- macOS or Linux for the current Pi host lifecycle implementation, which uses `/bin/ps` and process signals.
- An installed Google Chrome for the default local browser tests, or Playwright's matching Chromium installation for CI.

Run the following commands from the repository root. The repository's `.npmrc` pins added dependencies to exact versions and disables package lifecycle scripts, so `npm ci` installs with scripts ignored. Additional installation scripts or binary downloads require their own dependency review.

## Local setup

For a fresh checkout:

```sh
npm ci
cp .env.example .env
```

Keep an existing configured `.env` rather than replacing it. The default `AGENT_MODE=mock` requires no model credentials.

Start PostgreSQL:

```sh
docker compose up -d db
docker compose ps
```

Wait until `db` is healthy, then apply migrations and start both applications:

```sh
npm run db:migrate
npm run dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). The API listens on `http://127.0.0.1:3001`, and the development database is bound only to `127.0.0.1:55439`. The Web server proxies `/api` and `/healthz` to the API, keeping browser commands and SSE on the same origin. Keep ports 5173 and 3001 available; changing the API port also requires updating the Web proxy.

The database uses the `nexrun-postgres` named volume. `npm run db:down` stops the Compose services without removing that volume. Pi state is stored separately under `.data/pi` with the supplied configuration; preserve it alongside the database when retaining Pi conversations.

## Using the chat

Create a chat, send a message, and watch one assistant reply grow as text arrives. The UI supports English and Simplified Chinese, Markdown/code copying, conversation rename/archive, mobile navigation, and drafts retained during navigation. Archived chats leave the default list; an active chat must finish or stop before it can be archived.

In mock mode, a normal message produces a deterministic reply with a code block. Start a message with `/slow` to exercise slow streaming and Stop, or `/error` to exercise a provider failure with retained partial text. These are development fixtures, not Pi commands.

Messages, Runs, and sequenced events are persisted in PostgreSQL. Leaving a chat, refreshing, or losing the browser connection does not cancel a server-owned Run. SSE replay reconstructs the canonical reply rather than appending duplicate text. Only one Run may be active in a conversation; the configured service limit is two concurrent Runs across conversations, with excess work rejected explicitly.

Stop requests cancellation and remains pending until termination is observed or the supervised host is forcibly stopped. Partial text and the observed final state remain visible. On API restart, unresolved accepted work becomes interrupted after previous Pi hosts are reconciled; it is not automatically submitted to the model again.

## Text-only Pi

Set the following values privately in `.env`:

```dotenv
AGENT_MODE=pi
PI_PROVIDER=openai
PI_MODEL=gpt-5-mini
NEXRUN_OPENAI_API_KEY=replace-with-your-authorized-key
```

`NEXRUN_OPENAI_API_KEY` takes precedence over `OPENAI_API_KEY`; the latter remains a fallback for server environments. Use an authorized, usable OpenAI API credential. A present environment variable does not prove that authentication, quota, or model access is valid. Keep keys out of chat messages, source files, client environment variables, screenshots, and logs. `.env` is ignored by Git.

Restart the API after changing configuration. Start a new chat after switching between `mock` and `pi`; a chat with an existing Agent session cannot switch its runtime or convert mock history into native Pi context.

Pi runs in a dedicated supervised child process for each generation, with an independent persisted native session per conversation. All tools, extensions, hooks, skills, prompt templates, repository instructions, and resource discovery are disabled. Slash-prefixed input remains text. The host receives only the selected model credential and controlled environment settings; it does not read personal Pi authentication or settings. Native session files and manifests stay server-side with restricted permissions.

This process boundary is not an untrusted-code sandbox. Sprint 1 does not execute repositories, shell commands, browser actions, or user extensions. A future executable-tool integration requires a separate sandbox boundary.

Configuration values in `.env.example` include:

| Variable | Supplied value or meaning |
| --- | --- |
| `DATABASE_URL` | `postgres://nexrun:nexrun@127.0.0.1:55439/nexrun` |
| `API_HOST` / `API_PORT` | `127.0.0.1` / `3001` |
| `AGENT_MODE` | `mock`; use `pi` for the configured real Adapter |
| `PI_PROVIDER` / `PI_MODEL` | `openai` / `gpt-5-mini`; model selection is server-side |
| `PI_STATE_DIR` | `../../.data/pi`, resolved from the API workspace directory |
| `NEXRUN_OPENAI_API_KEY` | Preferred project-specific server credential; supply privately |
| `OPENAI_API_KEY` | Fallback server credential |
| `GENERATION_TIMEOUT_MS` | `60000` |
| `MAX_CONCURRENT_RUNS` | `2` |
| `ALLOWED_ORIGINS` | Explicit local Web origins on port 5173 |
| `ALLOWED_HOSTS` | `127.0.0.1,localhost` |

## Checks and integration verification

With the database running, use:

```sh
npm run typecheck
npm run lint
npm run licenses:check
npm test
```

`npm run check` combines those checks. API integration tests create and drop isolated PostgreSQL schemas; `TEST_DATABASE_URL` overrides their default local connection. Pi lifecycle tests use deterministic fixtures and inspect only marked test child processes; restricted environments that prohibit process inspection will fail closed.

For browser scenarios, stop any manually running development servers first: Playwright starts its own API and Web servers, forces mock mode, and requires ports 3001 and 5173. On a local machine with Google Chrome installed:

```sh
npm run test:e2e
```

In CI, or when using Playwright's matching Chromium instead of installed Chrome:

```sh
npx playwright install chromium
CI=1 npm run test:e2e
```

Linux CI runners may need `npx playwright install --with-deps chromium` to install browser system dependencies. Browser and system downloads are separate artifacts to review; they are not covered solely by an npm package license. Failure traces/screenshots are written under `test-results/`, and the HTML report is under `playwright-report/`.

Real Pi verification is an explicit model-using check:

```sh
npm run test:pi
```

The script loads `.env`, requires a valid configured key, and verifies two-turn context, separation from another conversation, native persistence, cancellation, and sanitized configuration failure. It makes real OpenAI requests and may incur usage charges. A missing or unusable credential leaves this verification blocked or failed; mock tests and a mock-only demo do not establish that real Pi integration passed.

## Build and local build preview

Build the API and Web artifacts:

```sh
npm run build
```

With PostgreSQL configured and development servers stopped, run these in separate terminals:

```sh
npm run start --workspace @nexrun/api
```

```sh
npm run preview --workspace @nexrun/web -- --port 5173 --strictPort
```

The compiled API is under `apps/api/dist`, and the Web bundle is under `apps/web/dist`. The API command loads the root `.env`; the Web preview uses the same local API proxy and port 5173 to match the supplied origin policy. These commands support inspecting the build locally; they do not provide a production deployment or an authenticated preview gateway.

## Access and delivery boundary

This sprint uses one fixed, server-derived development owner. There are no user accounts, organization isolation, OIDC, billing, or public multi-tenant service guarantees. Host/Origin checks support the local boundary and are not a login system.

A shared private preview must put authenticated access and TLS around the entire application, including every API and SSE route. Configure explicit allowed hosts/origins for that deployment. Do not expose the current application as an unauthenticated public service. Temporal, Valkey, S3, sandbox pools, Firecracker, groups, and Agent Teams are outside this implementation slice.

## Dependencies and license review

The project uses [Apache-2.0](LICENSE). Third-party admission follows [the repository policy](AGENTS.md#commercial-use-and-third-party-dependency-admission), including exact-version evidence and obligations for commercial use. The generated records are:

| Artifact | Location |
| --- | --- |
| Locked npm releases and integrity | `package-lock.json` |
| Dependency inventory and license evidence hashes | `docs/dependencies/inventory.json` |
| Supplementary exact-release upstream evidence | `docs/dependencies/upstream-licenses/` |
| Copied shadcn source attribution and modifications | `docs/dependencies/shadcn-sources.json` |
| Preserved shadcn license | `vendor/shadcn/LICENSE` |
| CycloneDX SBOM | `docs/dependencies/sbom.cdx.json` |
| Third-party license and notice text | `THIRD_PARTY_NOTICES.txt` |

For an addition or upgrade, inspect the actual selected release artifacts, upstream source, LICENSE/NOTICE files, bundled code, and distribution obligations. Include direct, transitive, development, optional/native dependencies, copied sources, assets, and extra downloads. Pin the change and update its evidence before regenerating the records:

```sh
npm run licenses:review
npm run licenses:check
```

`licenses:review` can fetch locked artifacts for platforms not installed locally and regenerates the inventory, notices, and SBOM. Review the resulting changes and chosen license branches; do not treat generation as automatic approval. Commit the reviewed lockfile and evidence together. `licenses:check` rejects lockfile/evidence mismatches, unreviewed dependencies, disallowed license expressions, and changes to recorded shadcn sources. Preserve required notices with distributed bundles. Review container images, browser binaries, system components, and hosted-service/model terms separately; the npm gate does not establish all of those rights.

Keep this README and its [complete Simplified Chinese edition](README.zh-CN.md) synchronized when shared setup or behavior changes.
