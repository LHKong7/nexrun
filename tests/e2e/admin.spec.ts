import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { AcceptedMessage, AdminSettings, AdminSettingsUpdate, CredentialCheck, RuntimeConfig, Run } from '@nexrun/protocol';

const originHeaders = { Origin: 'http://127.0.0.1:5173' };
const settingsKeys = ['revision', 'adapter', 'provider', 'model', 'responseLanguage', 'keyConfigured', 'keySource', 'environmentKeyAvailable', 'updatedAt', 'activeRuns', 'models'].sort();

function assertSafeSettings(value: AdminSettings, secrets: string[] = []) {
  expect(Object.keys(value).sort()).toEqual(settingsKeys);
  for (const secret of secrets) expect(JSON.stringify(value)).not.toContain(secret);
}

async function readSettings(request: APIRequestContext, secrets: string[] = []): Promise<AdminSettings> {
  const response = await request.get('/api/admin/settings', { headers: originHeaders });
  expect(response.status()).toBe(200);
  const settings = await response.json() as AdminSettings;
  assertSafeSettings(settings, secrets);
  return settings;
}

function updateBody(current: AdminSettings, change: Partial<AdminSettingsUpdate>): AdminSettingsUpdate {
  return {
    revision: current.revision, adapter: current.adapter, provider: 'openai', model: current.model,
    responseLanguage: current.responseLanguage, keyAction: 'keep', ...change,
  };
}

async function restoreMock(request: APIRequestContext) {
  const current = await readSettings(request);
  if (current.adapter === 'mock' && current.responseLanguage === 'auto' && current.keySource === 'environment') return;
  const response = await request.patch('/api/admin/settings', {
    headers: originHeaders,
    data: updateBody(current, { adapter: 'mock', responseLanguage: 'auto', keyAction: 'inherit' }),
  });
  expect(response.status()).toBe(200);
  const publicConfig = await request.get('/api/config');
  expect(await publicConfig.json()).toMatchObject({ adapter: 'mock', configured: true, responseLanguage: 'auto' });
}

async function publicConfig(request: APIRequestContext, secrets: string[] = []): Promise<RuntimeConfig> {
  const response = await request.get('/api/config');
  expect(response.status()).toBe(200);
  const config = await response.json() as RuntimeConfig;
  expect(Object.keys(config).every(key => ['adapter', 'configured', 'model', 'responseLanguage'].includes(key))).toBeTruthy();
  for (const secret of secrets) expect(JSON.stringify(config)).not.toContain(secret);
  return config;
}

async function choose(page: Page, label: string, option: string) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  const listbox = page.getByRole('listbox');
  await expect(listbox).toBeVisible();
  await listbox.getByRole('option', { name: option, exact: true }).click();
  await expect(listbox).toHaveCount(0);
}

async function save(page: Page, secrets: string[] = [], locale: 'en' | 'zh-CN' = 'en'): Promise<AdminSettings> {
  const saved = page.waitForResponse(response => new URL(response.url()).pathname === '/api/admin/settings' && response.request().method() === 'PATCH');
  await page.getByRole('button', { name: locale === 'en' ? 'Save changes' : '保存更改', exact: true }).click();
  const response = await saved;
  expect(response.status()).toBe(200);
  const settings = await response.json() as AdminSettings;
  assertSafeSettings(settings, secrets);
  return settings;
}

async function assertNoBrowserSecret(page: Page, secrets: string[]) {
  const storage = await page.evaluate(() => JSON.stringify({
    local: Object.fromEntries(Object.entries(localStorage)),
    session: Object.fromEntries(Object.entries(sessionStorage)),
  }));
  for (const secret of secrets) expect(storage).not.toContain(secret);
}

async function checkCredentials(page: Page): Promise<CredentialCheck> {
  const checked = page.waitForResponse(response => new URL(response.url()).pathname === '/api/admin/connection-check' && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Check credentials', exact: true }).click();
  const response = await checked;
  expect(response.status()).toBe(200);
  const result = await response.json() as CredentialCheck;
  expect(Object.keys(result).sort()).toEqual(['ok', 'code', 'checkedAt', 'revision'].sort());
  return result;
}

test.beforeEach(async ({ request }) => { await restoreMock(request); });
test.afterEach(async ({ request }) => { await restoreMock(request); });

test('saves runtime settings immediately and replaces, removes, or inherits keys without revealing them', async ({ page }) => {
  const firstKey = `sk-e2e-placeholder-${crypto.randomUUID()}`;
  const secondKey = `sk-e2e-replacement-${crypto.randomUUID()}`;
  const secrets = [firstKey, secondKey, 'e2e-env-key-placeholder-not-real'];
  try {
    const initial = await readSettings(page.request, secrets);
    expect(initial.environmentKeyAvailable).toBeTruthy();
    await page.goto('/');
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await expect(page).toHaveURL('/admin/settings');
    await expect(page.getByRole('heading', { name: 'Agent settings', exact: true })).toBeVisible();
    const key = page.getByLabel('New API key', { exact: true });
    await expect(key).toHaveAttribute('type', 'password');
    await expect(key).toHaveValue('');

    await choose(page, 'Adapter', 'Pi Agent');
    await expect(page.getByRole('combobox', { name: 'Provider', exact: true })).toBeDisabled();
    await choose(page, 'Agent response language', 'English');
    const model = initial.models.find(option => option.id !== initial.model) ?? initial.models[0]!;
    await choose(page, 'Model', model.name);
    await key.fill(firstKey);
    const configured = await save(page, secrets);
    expect(configured).toMatchObject({ adapter: 'pi', provider: 'openai', model: model.id, responseLanguage: 'en', keyConfigured: true, keySource: 'stored' });
    await expect(page.locator('.admin-page').getByRole('status').filter({ hasText: 'Settings saved. New requests use the saved configuration.' })).toBeVisible();
    await expect(key).toHaveValue('');
    expect(await publicConfig(page.request, secrets)).toMatchObject({ adapter: 'pi', configured: true, model: model.id, responseLanguage: 'en' });
    await assertNoBrowserSecret(page, secrets);

    await page.reload();
    await expect(page.getByRole('combobox', { name: 'Adapter', exact: true })).toContainText('Pi Agent');
    await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toContainText(model.name);
    await expect(page.getByRole('combobox', { name: 'Agent response language', exact: true })).toContainText('English');
    await expect(key).toHaveValue('');
    await readSettings(page.request, secrets);

    await key.fill(secondKey);
    const replaced = await save(page, secrets);
    expect(replaced.revision).toBeGreaterThan(configured.revision);
    expect(replaced.keySource).toBe('stored');
    await expect(key).toHaveValue('');
    await assertNoBrowserSecret(page, secrets);
    const successfulCheck = await checkCredentials(page);
    expect(successfulCheck).toMatchObject({ ok: true, code: 'CONNECTION_OK', revision: replaced.revision });
    await expect(page.locator('.admin-verification-card').getByRole('status')).toContainText('The saved credentials can access the selected model.');

    await page.getByRole('button', { name: 'Remove key', exact: true }).click();
    const removal = page.getByRole('alertdialog', { name: 'Remove the API key?', exact: true });
    await removal.getByRole('button', { name: 'Remove key', exact: true }).click();
    await expect(removal).toHaveCount(0);
    expect((await readSettings(page.request, secrets)).keySource).toBe('stored');
    const removed = await save(page, secrets);
    expect(removed).toMatchObject({ keyConfigured: false, keySource: 'none', environmentKeyAvailable: true });
    expect(await publicConfig(page.request, secrets)).toMatchObject({ adapter: 'pi', configured: false });
    await page.reload();
    await expect(key).toHaveValue('');
    expect((await readSettings(page.request, secrets)).keyConfigured).toBeFalsy();

    await page.getByRole('button', { name: 'Use environment key', exact: true }).click();
    const inherited = await save(page, secrets);
    expect(inherited).toMatchObject({ keyConfigured: true, keySource: 'environment' });
    expect(await publicConfig(page.request, secrets)).toMatchObject({ adapter: 'pi', configured: true });
    await assertNoBrowserSecret(page, secrets);
  } finally {
    await restoreMock(page.request);
  }
});

test('reports a sanitized credential-check failure through the configured test checker', async ({ page }) => {
  const rejectedKey = `sk-e2e-reject-placeholder-${crypto.randomUUID()}`;
  try {
    const current = await readSettings(page.request);
    const saved = await page.request.patch('/api/admin/settings', {
      headers: originHeaders,
      data: updateBody(current, { adapter: 'pi', keyAction: 'replace', apiKey: rejectedKey }),
    });
    expect(saved.status()).toBe(200);
    assertSafeSettings(await saved.json() as AdminSettings, [rejectedKey]);
    await page.goto('/admin/settings');
    await expect(page.getByLabel('New API key', { exact: true })).toHaveValue('');
    const result = await checkCredentials(page);
    expect(result).toMatchObject({ ok: false, code: 'UPSTREAM_AUTHENTICATION_FAILED' });
    await expect(page.locator('.admin-verification-card').getByRole('status')).toContainText('The model service rejected the saved credentials.');
    expect(JSON.stringify(result)).not.toContain(rejectedKey);
    await expect(page.locator('body')).not.toContainText(rejectedKey);
    await assertNoBrowserSecret(page, [rejectedKey]);
  } finally {
    await restoreMock(page.request);
  }
});

test('rejects stale settings revisions without overwriting the newer saved runtime', async ({ page }) => {
  try {
    const original = await readSettings(page.request);
    const updatedResponse = await page.request.patch('/api/admin/settings', {
      headers: originHeaders, data: updateBody(original, { responseLanguage: 'en' }),
    });
    expect(updatedResponse.status()).toBe(200);
    const updated = await updatedResponse.json() as AdminSettings;
    const stale = await page.request.patch('/api/admin/settings', {
      headers: originHeaders, data: updateBody(original, { responseLanguage: 'zh-CN' }),
    });
    expect(stale.status()).toBe(409);
    expect((await stale.json()).error.code).toBe('SETTINGS_CONFLICT');
    expect(await readSettings(page.request)).toEqual(updated);
    expect(await publicConfig(page.request)).toMatchObject({ adapter: 'mock', responseLanguage: 'en' });
    await page.goto('/admin/settings');
    await expect(page.getByRole('combobox', { name: 'Agent response language', exact: true })).toContainText('English');
  } finally {
    await restoreMock(page.request);
  }
});

test('refuses configuration changes while a Run is active and leaves that Run untouched', async ({ page }) => {
  let runId: string | undefined;
  try {
    await page.goto('/admin/settings');
    await expect(page.getByRole('heading', { name: 'Agent settings', exact: true })).toBeVisible();
    const created = await page.request.post('/api/conversations', { data: { title: 'E2E settings update during generation' } });
    const conversation = await created.json() as { id: string };
    const acceptedResponse = await page.request.post(`/api/conversations/${conversation.id}/messages`, {
      headers: { ...originHeaders, 'Idempotency-Key': crypto.randomUUID() }, data: { content: '/slow settings guard' },
    });
    expect(acceptedResponse.status()).toBe(202);
    runId = (await acceptedResponse.json() as AcceptedMessage).run.id;
    await expect.poll(async () => (await (await page.request.get(`/api/runs/${runId}`)).json() as Run).status, { intervals: [10, 25, 50] }).toBe('running');
    const before = await readSettings(page.request);
    expect(before.activeRuns).toBe(1);
    const response = await page.request.patch('/api/admin/settings', {
      headers: originHeaders,
      data: updateBody(before, { adapter: 'pi', responseLanguage: 'zh-CN', keyAction: 'replace', apiKey: 'sk-e2e-placeholder-must-not-be-saved' }),
    });
    expect(response.status()).toBe(409);
    expect((await response.json()).error.code).toBe('SETTINGS_BUSY');
    const after = await readSettings(page.request);
    expect(after.revision).toBe(before.revision);
    expect(after.keySource).toBe(before.keySource);
    expect(after.responseLanguage).toBe(before.responseLanguage);
    expect(await publicConfig(page.request)).toMatchObject({ adapter: 'mock', responseLanguage: 'auto' });
    expect((await (await page.request.get(`/api/runs/${runId}`)).json() as Run).status).toBe('running');
  } finally {
    if (runId) {
      await page.request.post(`/api/runs/${runId}/cancel`, { headers: originHeaders, data: {} });
      await expect.poll(async () => (await (await page.request.get(`/api/runs/${runId}`)).json() as Run).status).toBe('cancelled');
    }
    await restoreMock(page.request);
  }
});

test('saves and reloads bilingual settings in a narrow mobile layout', async ({ page }) => {
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await choose(page, 'Language', '简体中文');
    await page.getByRole('link', { name: '设置', exact: true }).click();
    await expect(page).toHaveURL('/admin/settings');
    await expect(page.getByRole('heading', { name: 'Agent 设置', exact: true })).toBeVisible();
    await expect(page.getByRole('combobox', { name: '运行时', exact: true })).toContainText('模拟 Agent');
    await expect(page.getByRole('combobox', { name: '提供方', exact: true })).toBeDisabled();
    await expect(page.getByLabel('新 API 密钥', { exact: true })).toHaveAttribute('type', 'password');
    await expect(page.getByLabel('新 API 密钥', { exact: true })).toHaveValue('');
    await choose(page, 'Agent 回复语言', '简体中文');
    expect((await save(page, [], 'zh-CN')).responseLanguage).toBe('zh-CN');
    expect(await publicConfig(page.request)).toMatchObject({ adapter: 'mock', responseLanguage: 'zh-CN' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await expect(page.getByRole('heading', { name: 'Agent 设置', exact: true })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Agent 回复语言', exact: true })).toContainText('简体中文');
    await expect(page.getByLabel('新 API 密钥', { exact: true })).toHaveValue('');
  } finally {
    await restoreMock(page.request);
  }
});

test('handles a contract-level transport 401 and keeps the unlock token only until settings are left', async ({ page }) => {
  const token = `e2e-admin-token-${crypto.randomUUID()}`;
  const wrongToken = `e2e-wrong-token-${crypto.randomUUID()}`;
  const seenAuthorization: string[] = [];
  const seenUrls: string[] = [];
  // Only the transport authentication challenge is simulated. Authorized reads
  // reach the real isolated API; backend token enforcement has separate Node tests.
  await page.route('**/api/admin/access', route => route.fulfill({
    status: 200, json: { requiresToken: true, localAccess: false },
  }));
  await page.route('**/api/admin/settings', async route => {
    if (route.request().method() !== 'GET') { await route.continue(); return; }
    const authorization = route.request().headers().authorization ?? '';
    seenAuthorization.push(authorization);
    seenUrls.push(route.request().url());
    if (authorization !== `Bearer ${token}`) {
      await route.fulfill({ status: 401, json: { error: { code: 'ADMIN_AUTH_REQUIRED', message: 'ADMIN_AUTH_REQUIRED' } } });
    } else await route.continue();
  });
  try {
    await page.goto('/');
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    const tokenInput = page.getByLabel('Admin token', { exact: true });
    const unlock = page.getByRole('button', { name: 'Unlock settings', exact: true });
    await expect(tokenInput).toBeVisible();
    await expect(tokenInput).toHaveAttribute('type', 'password');
    await expect(unlock).toBeDisabled();
    await tokenInput.fill(wrongToken);
    const rejected = page.waitForResponse(response => new URL(response.url()).pathname === '/api/admin/settings' && response.status() === 401);
    await unlock.click();
    await rejected;
    await expect(tokenInput).toHaveValue('');
    await expect(page.getByRole('alert')).toContainText('The admin token is missing or invalid. Enter the token to unlock settings.');
    await assertNoBrowserSecret(page, [token, wrongToken]);

    await tokenInput.fill(token);
    const accepted = page.waitForResponse(response => new URL(response.url()).pathname === '/api/admin/settings' && response.status() === 200);
    await unlock.click();
    assertSafeSettings(await (await accepted).json() as AdminSettings, [token, wrongToken]);
    await expect(page.getByRole('combobox', { name: 'Adapter', exact: true })).toBeVisible();
    await expect(tokenInput).toHaveCount(0);
    await assertNoBrowserSecret(page, [token, wrongToken]);
    expect(page.url()).not.toContain(token);
    expect(page.url()).not.toContain(wrongToken);

    const reloaded = page.waitForResponse(response => new URL(response.url()).pathname === '/api/admin/settings' && response.status() === 200);
    await page.getByRole('button', { name: 'Reload settings', exact: true }).click();
    assertSafeSettings(await (await reloaded).json() as AdminSettings, [token, wrongToken]);
    await expect(page.getByRole('combobox', { name: 'Adapter', exact: true })).toBeVisible();
    expect(seenAuthorization).toContain(`Bearer ${wrongToken}`);
    expect(seenAuthorization).toContain(`Bearer ${token}`);
    expect(seenUrls.every(url => !url.includes(token) && !url.includes(wrongToken))).toBeTruthy();

    await page.getByRole('button', { name: 'Go to conversations', exact: true }).click();
    await expect(page).toHaveURL('/');
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await expect(tokenInput).toBeVisible();
    await expect(tokenInput).toHaveValue('');
    await expect(unlock).toBeDisabled();
    expect(seenAuthorization.at(-1)).toBe('');
    await assertNoBrowserSecret(page, [token, wrongToken]);
  } finally {
    await page.unroute('**/api/admin/access');
    await page.unroute('**/api/admin/settings');
  }
});
