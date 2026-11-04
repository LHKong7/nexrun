# Agent administration

[Simplified Chinese version](admin-settings.zh-CN.md) · [Runbook](../README.md) · [Testing](testing.md)

Implemented on 2026-11-05. The administration page configures the single-owner application's default Mock/Pi runtime and OpenAI model connection.

## Configure the runtime

Open **Settings** in the sidebar, or visit [the administration page](http://127.0.0.1:5173/admin/settings).

1. Choose **Mock Agent** or **Pi Agent**.
2. Select an OpenAI model from the installed Pi SDK's supported catalog.
3. Set the Agent response language: follow the prompt, English, or Simplified Chinese. This setting is independent of the interface language and preserves original prompts, quoted content, code, and history.
4. Enter a new API key if needed, then select **Save changes**.
5. Optionally select **Check credentials** after saving. The check uses the saved configuration.

Saving applies the runtime immediately and persists it across API restarts. A saved key is shown only as a configured/not-configured state and a source; it is never filled back into the password input. Configuration state and a successful connection check are displayed separately.

## Credential actions

| Action | Result when saved |
| --- | --- |
| Leave the key field blank | Keep the current credential policy and key |
| Enter a new key | Encrypt and store it; prefer it over environment credentials |
| Remove key | Remove the stored key and disable environment fallback |
| Use environment key | Clear the stored key and explicitly enable environment fallback |
| Reset changes | Discard unsaved form changes |

Environment fallback selects `NEXRUN_OPENAI_API_KEY` before `OPENAI_API_KEY`. Changing an inherited environment key requires an API restart. The application never writes provider keys into `.env`.

Until the first explicit save, revision-zero settings follow the server's `AGENT_MODE`, `PI_MODEL`, and `AGENT_RESPONSE_LANGUAGE` defaults on startup. After a save, persisted runtime/model/language choices take precedence over these defaults. Credential fallback remains controlled by the separate actions above.

## Applying changes safely

Configuration commits and message admission share a server gate. Updates are rejected with `SETTINGS_BUSY` while a Run is queued, running, cancelling, or still settling in the dispatcher. Stop the Run or wait for it, then reload settings. An update cannot interrupt a live generation or assign an accepted message to a different configuration.

Each save carries its revision. A stale revision returns `SETTINGS_CONFLICT` without overwriting newer settings. Reload before saving again. A confirmed rollback leaves the previous runtime and revision active. If the database commit outcome cannot be confirmed, the API returns `SETTINGS_COMMIT_UNKNOWN` and closes admission instead of continuing with potentially stale credentials. Restart the API to recover the committed database state before accepting more work.

Changing between Mock and Pi, or selecting a different Pi model, requires a fresh chat. Existing history remains readable. Replacing a credential for the same Pi model can continue an existing chat. Legacy Pi chats created before model binding was recorded also require a fresh chat. Response-language changes apply to future replies and do not rewrite prior messages.

## Stored secrets and backups

Provider keys are encrypted in PostgreSQL's `admin_settings` table using AES-256-GCM with a random nonce and owner-bound authenticated data. Public/admin JSON responses exclude both plaintext keys and ciphertext. New key inputs and admin unlock tokens stay in component memory; the application does not put them in URLs, local storage, or session storage. Leaving settings clears its secret inputs and unlock state.

The default encryption key is a separate 32-byte file at `PI_STATE_DIR/configuration/encryption.key`, with directory mode `0700` and file mode `0600`. With the supplied `.env.example`, that is `.data/pi/configuration/encryption.key`. Preserve the matching private state alongside database backups. A database backup alone cannot recover encrypted provider keys.

For a stable deployment-managed key, privately set `NEXRUN_CONFIG_ENCRYPTION_KEY` to a canonical base64 encoding of 32 random bytes. For example, generate a value locally with:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Supply it through the server's secret configuration. Keep it out of source control and screenshots. Replacing or losing the encryption key while stored credentials exist causes authenticated decryption to fail; restore the matching key before starting the API. The implementation does not silently replace unreadable credentials. Persist the private state volume when using containers.

## Administration access

Without `NEXRUN_ADMIN_TOKEN`, management endpoints accept only direct loopback connections using an allowed local host; mutations also require an explicit allowed local Origin. Forwarded/proxy headers disable this local fallback.

For a shared deployment, set a long random `NEXRUN_ADMIN_TOKEN` privately and provide authenticated TLS access around the application. A token is then mandatory for management endpoints, including from localhost. The page presents a password-based unlock form and sends the token only in admin API Authorization headers. The token stays in memory until settings is left. The general chat application still uses the existing single development owner; the admin token protects configuration rather than introducing user accounts or organization roles.

The server also applies its existing Host/Origin policy. Configure `ALLOWED_HOSTS` and `ALLOWED_ORIGINS` for the deployment. A reverse proxy must not be treated as a direct local administrator; configure the admin token whenever sharing access.

## API and connection checks

| Endpoint | Purpose |
| --- | --- |
| `GET /api/admin/access` | Return token requirement and local-access metadata |
| `GET /api/admin/settings` | Return sanitized settings, revision, model catalog, and active Run count |
| `PATCH /api/admin/settings` | Save a validated configuration with optimistic revision checking |
| `POST /api/admin/connection-check` | Check the saved revision's credential and model metadata access |
| `GET /api/config` | Return current public runtime metadata, including response language |

The connection check calls the fixed OpenAI `GET /v1/models/{model}` endpoint with server-side Bearer credentials and a five-second deadline. It sends no conversation text, follows no redirects, and returns stable diagnostic codes rather than provider response bodies. This verifies model metadata access, which is distinct from a successful generated reply. See the [official model retrieval reference](https://developers.openai.com/api/reference/resources/models/methods/retrieve) and [authentication guidance](https://developers.openai.com/api/reference/overview).

## Verification

Local checks on 2026-11-05 passed all 90 Node tests without skips, 19 browser scenarios, typecheck, lint, build, and the existing license gate. Configuration tests cover encryption, restart recovery, environment fallback, revisions, confirmed rollback, unknown-COMMIT fail-closed recovery, authorization, active-Run protection, immediate runtime changes, model binding, and independent reply language. The lost-commit-acknowledgement regression verifies that committed database changes invalidate old cached settings, reject queued message admission, close the API, and recover on restart. Browser tests use synthetic keys and network-free runtime/checker fixtures; the unlock test simulates the HTTP 401 contract, while actual endpoint authorization is covered by Node integration tests.

No live provider success is established by those fixtures. Use **Check credentials** for a saved key and a new Pi chat for generation. The standalone `npm run test:pi` smoke still uses environment-provided credentials, as described in the runbook. No new third-party dependencies were introduced by this feature.
