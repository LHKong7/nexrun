import { expect, test, type Page } from '@playwright/test';
import type { AgentBinding, AgentProfile, AdminSettings, Project, ResourceItem, Workspace, WorkspaceSnapshot } from '@nexrun/protocol';

const originHeaders = { Origin: `http://127.0.0.1:${process.env.NEXRUN_E2E_WEB_PORT ?? '5173'}` };
async function choose(page: Page, label: string, option: string) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('listbox').getByRole('option', { name: option, exact: true }).click();
}
async function submit<T>(page: Page, path: string, method: string, name: string): Promise<T> {
  const response = page.waitForResponse(value => new URL(value.url()).pathname === path && value.request().method() === method);
  await page.getByRole('button', { name, exact: true }).click();
  const value = await response;
  expect(value.ok(), await value.text()).toBeTruthy();
  await expect(page.getByRole('status').filter({ hasText: 'Changes saved.' })).toBeVisible();
  return value.json() as Promise<T>;
}

test.beforeEach(async ({ request }) => {
  const response = await request.get('/api/admin/settings', { headers: originHeaders });
  expect(response.ok()).toBeTruthy();
  const settings = await response.json() as AdminSettings;
  if (settings.adapter !== 'mock' || settings.responseLanguage !== 'auto') {
    const updated = await request.patch('/api/admin/settings', { headers: originHeaders, data: { revision: settings.revision, adapter: 'mock', provider: 'openai', model: settings.model, responseLanguage: 'auto', keyAction: 'keep' } });
    expect(updated.ok()).toBeTruthy();
  }
});

test('creates and revises a profile, binds it to a chat, and keeps interface and Agent languages independent', async ({ page }, testInfo) => {
  const name = `Writer ${crypto.randomUUID().slice(0, 8)}`;
  await page.goto('/');
  await page.getByRole('link', { name: 'Agents & workspaces', exact: true }).click();
  await expect(page).toHaveURL('/agents-workspaces');
  await expect(page.getByRole('heading', { name: 'Agents & workspaces', exact: true })).toBeVisible();
  await page.getByLabel('Profile name', { exact: true }).fill(name);
  await page.getByLabel('Role instructions', { exact: true }).fill('Give concise, verifiable answers.');
  await choose(page, 'Agent response language', '简体中文');
  await page.getByRole('checkbox', { name: 'Read files', exact: true }).check();
  const created = await submit<AgentProfile>(page, '/api/agent-profiles', 'POST', 'Create');
  expect(created).toMatchObject({ name, revision: 1, adapter: 'mock', responseLanguage: 'zh-CN', toolNames: ['file.read'] });
  await page.getByLabel('Role instructions', { exact: true }).fill('Give concise answers and cite the provided source.');
  const revised = await submit<AgentProfile>(page, `/api/agent-profiles/${created.id}`, 'PATCH', 'Save revision');
  expect(revised.revision).toBe(2);
  await expect(page.getByRole('combobox', { name: 'Language', exact: true })).toContainText('English');

  await page.getByRole('button', { name: 'Go to conversations', exact: true }).click();
  await page.locator('[data-new-chat]').click();
  await expect(page).toHaveURL(/\/chat\//);
  const chatId = new URL(page.url()).pathname.split('/').at(-1)!;
  await page.getByRole('button', { name: 'Chat resources', exact: true }).click();
  await expect(page.getByText('Applying changes starts a fresh Agent context.', { exact: false })).toBeVisible();
  await choose(page, 'Agent profiles', `${name} · Revision 2`);
  const bound = await submit<AgentBinding>(page, `/api/conversations/${chatId}/agent-binding`, 'PATCH', 'Apply to this chat');
  expect(bound).toMatchObject({ conversationId: chatId, profileId: created.id, profileRevision: 2, workspaceId: null });
  const firstIdentity = bound.agentInstanceId;
  await page.screenshot({ path: testInfo.outputPath('desktop-chat-binding.png'), fullPage: true });
  await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
  await page.locator('[data-new-chat]').click();
  await expect.poll(() => new URL(page.url()).pathname.split('/').at(-1)).not.toBe(chatId);
  const secondId = new URL(page.url()).pathname.split('/').at(-1)!;
  const second = await page.request.get(`/api/conversations/${secondId}/agent-binding`);
  expect(second.ok()).toBeTruthy();
  expect((await second.json() as AgentBinding).agentInstanceId).not.toBe(firstIdentity);
});

test('prepares persistent files and attributable knowledge and skills, then binds their scope to a chat', async ({ page }, testInfo) => {
  const suffix = crypto.randomUUID().slice(0, 8);
  await page.goto('/agents-workspaces');
  await page.getByRole('button', { name: 'Workspaces', exact: true }).click();
  await page.getByLabel('Project name', { exact: true }).fill(`Project ${suffix}`);
  const project = await submit<Project>(page, '/api/projects', 'POST', 'Create project');
  await page.getByLabel('Workspace name', { exact: true }).fill(`Workspace ${suffix}`);
  const workspace = await submit<Workspace>(page, '/api/workspaces', 'POST', 'Create workspace');
  expect(workspace.projectId).toBe(project.id);
  await page.getByLabel('File path', { exact: true }).fill('notes/brief.txt');
  await page.getByLabel('File content', { exact: true }).fill('First version\n');
  const first = await submit<WorkspaceSnapshot>(page, `/api/workspaces/${workspace.id}/files`, 'POST', 'Save file');
  expect(first.files).toContainEqual({ path: 'notes/brief.txt', content: 'First version\n' });
  await page.getByLabel('File content', { exact: true }).fill('Second version\n');
  const second = await submit<WorkspaceSnapshot>(page, `/api/workspaces/${workspace.id}/files`, 'POST', 'Save file');
  expect(second.revision).toBe(first.revision + 1);
  await page.getByLabel('From revision', { exact: true }).fill(String(first.revision));
  await page.getByLabel('To revision', { exact: true }).fill(String(second.revision));
  await page.getByRole('button', { name: 'Compare revisions', exact: true }).click();
  await expect(page.locator('.aw-diff')).toContainText('First version');
  await expect(page.locator('.aw-diff')).toContainText('Second version');
  await page.screenshot({ path: testInfo.outputPath('desktop-workspace-files.png'), fullPage: true });

  await page.getByRole('button', { name: 'Knowledge & skills', exact: true }).click();
  await page.getByLabel('Resource name', { exact: true }).fill(`Brief facts ${suffix}`);
  await page.getByLabel('Content', { exact: true }).fill('The project working document is notes/brief.txt.');
  await page.getByLabel('Source or provenance', { exact: true }).fill('User-authored test requirements');
  await choose(page, 'Scope', 'Workspace');
  await choose(page, 'Workspaces', workspace.name);
  const knowledge = await submit<ResourceItem>(page, '/api/knowledge', 'POST', 'Create');
  expect(knowledge).toMatchObject({ kind: 'knowledge', scope: 'workspace', workspaceId: workspace.id });
  await page.getByRole('button', { name: 'Skills', exact: true }).click();
  await page.getByLabel('Resource name', { exact: true }).fill(`Review brief ${suffix}`);
  await page.getByLabel('Content', { exact: true }).fill('Read the working document and report only what the file says.');
  await page.getByLabel('Source or provenance', { exact: true }).fill('Original test instruction');
  await page.getByLabel('License or authorization', { exact: true }).fill('MIT');
  await page.getByLabel('License evidence', { exact: true }).fill('Original instructions authored for this test and supplied under MIT.');
  await page.getByRole('checkbox', { name: 'Read files', exact: true }).check();
  const skill = await submit<ResourceItem>(page, '/api/skills', 'POST', 'Create');
  expect(skill).toMatchObject({ kind: 'skill', requiredTools: ['file.read'], license: 'MIT' });

  await page.getByRole('button', { name: 'Go to conversations', exact: true }).click();
  await page.locator('[data-new-chat]').click();
  await expect(page).toHaveURL(/\/chat\//);
  const chatId = new URL(page.url()).pathname.split('/').at(-1)!;
  await page.getByRole('button', { name: 'Chat resources', exact: true }).click();
  await choose(page, 'Workspaces', workspace.name);
  await page.getByRole('checkbox', { name: `Brief facts ${suffix} Revision 1`, exact: true }).check();
  await page.getByRole('checkbox', { name: `Review brief ${suffix} Revision 1`, exact: true }).check();
  // Required tool permissions are validated by the server. The default profile
  // has no tools, so binding a read skill must be rejected without side effects.
  const rejected = page.waitForResponse(response => new URL(response.url()).pathname === `/api/conversations/${chatId}/agent-binding` && response.request().method() === 'PATCH');
  await page.getByRole('button', { name: 'Apply to this chat', exact: true }).click();
  expect((await rejected).ok()).toBeFalsy();
  await expect(page.getByRole('alert')).toBeVisible();
  const files = await page.request.get(`/api/workspaces/${workspace.id}/files`);
  expect((await files.json() as WorkspaceSnapshot).files).toContainEqual({ path: 'notes/brief.txt', content: 'Second version\n' });
});

test('shows matching Chinese resource controls on mobile without changing saved Agent reply language', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem('nexrun:locale', 'zh-CN'));
  await page.goto('/agents-workspaces');
  await expect(page.getByRole('heading', { name: 'Agent 与工作区', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '知识与技能', exact: true }).click();
  await expect(page.getByLabel('资源名称', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '技能', exact: true }).click();
  await expect(page.getByLabel('许可证或授权', { exact: true })).toBeVisible();
  await expect(page.getByLabel('授权依据', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath('mobile-resources.png'), fullPage: true });
});
