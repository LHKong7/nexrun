# NexRun

[Simplified Chinese version](README.zh-CN.md) · [Architecture](docs/architecture.md) · [Sprint 1](docs/sprints/sprint1.md) · [Sprint 2](docs/sprints/sprint2.md)

NexRun is a local, single-owner chat application with a React/shadcn UI, a Node.js API, PostgreSQL persistence, and streamed Agent replies. Sprint 1 provides direct chats with a deterministic mock Adapter and a text-only Pi Adapter. Group chats, Agent Teams, repository execution, and the broader execution infrastructure remain later work.

[Sprint 2](docs/sprints/sprint2.md) adds versioned Agent profiles, explicit identities/session scopes, persistent text Workspaces, restricted file tools, and manually enabled knowledge/skills with context manifests. Local implementation and deterministic checks are complete; final acceptance remains unverified because the configured live Pi/OpenAI credential fails authentication. No successful live model-driven workspace edit is claimed.

## Requirements

- Node.js **22.19.0 or newer**, with npm.
- Docker with Docker Compose v2 and a running Docker daemon for the development database.
- macOS or Linux for the current Pi host lifecycle implementation, which uses `/bin/ps` and process signals.
- Model-driven Workspace file tools additionally require the reviewed macOS arm64 environment with the exact Node **22.20.0** and Apple executable hashes in the [native runtime inventory](docs/dependencies/native-runtime.json). Unsupported or unreviewed runtimes fail closed; ordinary text chat does not require that file worker.
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

Interface controls use official shadcn Base UI components, including the sidebar, language Select, rename Dialog, archive AlertDialog, cards, badges, avatars, notifications, tooltips, loading states, and scroll areas. Language selection supports keyboard navigation and persistence; dialogs trap focus and restore it when dismissed. Markdown tables and task-list checkboxes use the same component set.

In mock mode, normal messages receive brief deterministic replies without echoing the prompt or conversation. Use `/code` or `/markdown` for fixed formatting fixtures, `/slow` for Stop/reconnect checks, `/error` for a retained partial failure, and `/remember <value>` followed by `/context` for bounded relevant context. `npm run demo:seed` adds seven repeatable bilingual/historical demo chats to a loopback mock database while preserving existing chats and edits. See the [complete testing and mock-data guide](docs/testing.md) for scenarios and coverage. These fixtures are not Pi commands.

Messages, Runs, and sequenced events are persisted in PostgreSQL. Leaving a chat, refreshing, or losing the browser connection does not cancel a server-owned Run. SSE replay reconstructs the canonical reply rather than appending duplicate text. Only one Run may be active in a conversation; the configured service limit is two concurrent Runs across conversations, with excess work rejected explicitly.

Stop requests cancellation and remains pending until termination is observed or the supervised host is forcibly stopped. Partial text and the observed final state remain visible. On API restart, unresolved accepted work becomes interrupted after previous Pi hosts are reconciled; it is not automatically submitted to the model again.

## Agent administration

Open **Settings** in the sidebar or visit [http://127.0.0.1:5173/admin/settings](http://127.0.0.1:5173/admin/settings). Configure Mock/Pi, an OpenAI model, the Agent's reply language, and an API key using the shadcn form. Saves take effect immediately while the service is idle. Saved keys are encrypted, never returned by the API, and can be replaced, removed, or explicitly inherited from the environment.

For shared deployments, configure `NEXRUN_ADMIN_TOKEN` and authenticated TLS access. Back up the encryption key with the database; by default it is in `.data/pi/configuration/encryption.key`, or supply a stable 32-byte base64 `NEXRUN_CONFIG_ENCRYPTION_KEY`. See the complete [administration and recovery guide](docs/admin-settings.md) for access rules, credential actions, revision conflicts, model binding, and backups.

## Agent profiles and Workspaces

Open **Agents & workspaces** in the sidebar, or visit [http://127.0.0.1:5173/agents-workspaces](http://127.0.0.1:5173/agents-workspaces).

1. Under **Agent profiles**, create a reusable role with model/runtime settings, an independent response language, and allowed file operations. Editing creates a revision; existing chats retain their selected revision until a change is explicitly applied. Credentials remain in Settings and are not copied into profiles.
2. Under **Workspaces**, create a Project and Workspace, then add text using a relative path and the file-content editor. The database stores immutable file revisions; the interface can compare revisions. These are bounded virtual text files, not mounted host directories, imported Git repositories or executable projects.
3. Under **Knowledge & skills**, add explicitly sourced facts/documents or declarative skill instructions. Choose user, project or workspace scope. Skills require an admitted license and recorded authorization evidence and can require only file operations already allowed by the selected profile. No scripts or automatic discovery run.
4. Open a chat and select **Chat resources** to bind its profile, optional Workspace, knowledge and skills. Applying a change starts a fresh native-context epoch while preserving visible chat history. Different chats retain independent Agent identities and Sessions even when using the same profile or using a Workspace serially.
5. With a usable Pi connection, ask the Agent to list, read, search or edit the bound text files. Inspect actual revisions/diffs in **Workspaces**, and the latest Run's source manifest and recorded operations under **Chat resources**. Mock replies remain deterministic fixtures and do not establish real model-driven tool execution.

Workspace Runs hold an exclusive lease; competing live access and edits return a busy result. File writes check the expected revision and operation ID. Source corrections, withdrawals, changed bindings and external file revisions invalidate affected native context. Checkpoints bind a file revision to an immutable copy of compatible native state; keep the database and private Pi state together when backing up.

The local file worker uses deny-by-default macOS Seatbelt enforcement. It receives bounded snapshots over stdin, performs only platform-owned in-memory file operations, and cannot read user host-file contents, write host files, open network connections or create subprocesses. The trusted Pi host and authoritative database broker run outside this worker. Read the [native runtime review](docs/dependencies/native-runtime.md) for exact hashes, readiness probes, resource limits and the deprecated platform interface's limitations. This is a reviewed local implementation, not a VM or general repository-code sandbox.

## Pi runtime and credentials

Use Settings to configure Pi interactively. Before the first explicit settings save, the following private `.env` values also provide the startup defaults:

```dotenv
AGENT_MODE=pi
PI_PROVIDER=openai
PI_MODEL=gpt-5-mini
NEXRUN_OPENAI_API_KEY=replace-with-your-authorized-key
```

`NEXRUN_OPENAI_API_KEY` takes precedence over `OPENAI_API_KEY`; the latter remains a fallback for server environments. Use an authorized, usable OpenAI API credential. A present environment variable does not prove that authentication, quota, or model access is valid. Keep keys out of chat messages, source files, client environment variables, screenshots, and logs. `.env` is ignored by Git.

Settings-page saves apply without restarting. Environment changes require an API restart; after the first settings save, persisted runtime/model/language choices take precedence over those defaults. Chats using service defaults require a new chat after an incompatible runtime/model change. For explicit profiles, apply the selected profile through **Chat resources** while idle to create a compatible context epoch. Existing history stays readable, and replacing a key for the same Pi model can continue a compatible existing Session.

Pi runs in a dedicated supervised child process for each generation, with an independent persisted native Session per Agent/context scope. Pure text chats expose no tools. Explicit Workspace bindings can expose only the selected `file.list`, `file.read`, `file.search` and `file.write` tools through the broker and isolated file worker. Knowledge and declarative skills are supplied from accepted resource revisions. Built-in tools, executable extensions/hooks, prompt templates, repository instructions and automatic resource discovery remain disabled. Slash-prefixed input remains text. The host receives only the selected model credential and controlled environment settings; it does not read personal Pi authentication or settings. Native session files and manifests stay server-side with restricted permissions.

The Pi child-process boundary alone is not an untrusted-code sandbox. The separate file worker processes bounded data without evaluating imported code. Shell/build commands, repository execution, browser actions and user extensions remain unavailable; those require a separately reviewed execution provider.

Configuration values in `.env.example` include:

| Variable | Supplied value or meaning |
| --- | --- |
| `DATABASE_URL` | `postgres://nexrun:nexrun@127.0.0.1:55439/nexrun` |
| `API_HOST` / `API_PORT` | `127.0.0.1` / `3001` |
| `AGENT_MODE` | `mock`; use `pi` for the configured real Adapter |
| `PI_PROVIDER` / `PI_MODEL` | `openai` / `gpt-5-mini`; model selection is server-side |
| `AGENT_RESPONSE_LANGUAGE` | `auto`, `en`, or `zh-CN`; initial reply-language default, independent of UI locale |
| `PI_STATE_DIR` | `../../.data/pi`, resolved from the API workspace directory |
| `NEXRUN_OPENAI_API_KEY` | Preferred project-specific server credential; supply privately |
| `OPENAI_API_KEY` | Fallback server credential |
| `NEXRUN_ADMIN_TOKEN` | Optional long random token; required for management in shared deployments |
| `NEXRUN_CONFIG_ENCRYPTION_KEY` | Optional stable base64-encoded 32-byte key; otherwise use private server state |
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

Playwright starts isolated test API/Web services, forces mock mode and defaults to ports 3001 and 5173. On a local machine with Google Chrome installed and those ports free:

```sh
npm run test:e2e
```

To preserve a running development app, select other free test ports:

```sh
NEXRUN_E2E_API_PORT=3101 NEXRUN_E2E_WEB_PORT=5273 npm run test:e2e
```

The test server adds the selected loopback Web origin explicitly and uses its own generated database schema and temporary state; the default development configuration is unchanged.

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

On 2026-11-05, typecheck, lint, build, license checks, all **113 Node tests** and all **22 browser scenarios** passed. These include actual local file-worker isolation checks alongside deterministic SDK/model fixtures. Live Pi authentication still failed; final Sprint 2 model-driven workspace acceptance remains unverified. See the [Sprint 2 record](docs/sprints/sprint2.md) for the evidence boundary.

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
| Existing local OS/Node runtime evidence | `docs/dependencies/native-runtime.json` and [native runtime review](docs/dependencies/native-runtime.md) |

For an addition or upgrade, inspect the actual selected release artifacts, upstream source, LICENSE/NOTICE files, bundled code, and distribution obligations. Include direct, transitive, development, optional/native dependencies, copied sources, assets, and extra downloads. Pin the change and update its evidence before regenerating the records:

```sh
npm run licenses:review
npm run licenses:check
```

`licenses:review` can fetch locked artifacts for platforms not installed locally and regenerates the inventory, notices, and SBOM. Review the resulting changes and chosen license branches; do not treat generation as automatic approval. Commit the reviewed lockfile and evidence together. `licenses:check` rejects lockfile/evidence mismatches, unreviewed dependencies, disallowed license expressions, and changes to recorded shadcn sources. Preserve required notices with distributed bundles. Review container images, browser binaries, system components, and hosted-service/model terms separately; the npm gate does not establish all of those rights. User-entered knowledge/skill authorization metadata records declarations; platform dependency findings do not automatically authorize imported third-party content.

Keep this README and its [complete Simplified Chinese edition](README.zh-CN.md) synchronized when shared setup or behavior changes.
