import { expect, test, type Page } from '@playwright/test';
import type { AcceptedMessage, ChatSnapshot, Conversation, MessageStatus, Run } from '@nexrun/protocol';

const unique = (label: string) => `E2E ${label} ${crypto.randomUUID().slice(0, 8)}`;
const assistantMessages = (page: Page) => page.locator('.message-assistant');
const expectedTurns = new WeakMap<Page, { conversationId: string; assistantOrder: number }>();

test.describe.configure({ mode: 'default' });

async function createConversation(page: Page, title: string): Promise<Conversation> {
  const response = await page.request.post('/api/conversations', { data: { title } });
  expect(response.status()).toBe(201);
  return response.json() as Promise<Conversation>;
}

async function snapshot(page: Page, conversationId: string): Promise<ChatSnapshot> {
  const response = await page.request.get(`/api/conversations/${conversationId}/messages?limit=100`);
  expect(response.ok()).toBeTruthy();
  return response.json() as Promise<ChatSnapshot>;
}

async function openConversation(page: Page, conversationId: string) {
  await page.goto(`/chat/${conversationId}`);
  await expect(page.getByRole('textbox', { name: 'Message your Agent', exact: true })).toBeEnabled();
  await expect(page.locator('.connection-pill')).toHaveText('Connected');
}

async function chooseLanguage(page: Page, locale: 'en' | 'zh-CN') {
  const current = await page.locator('html').getAttribute('lang');
  const trigger = page.getByRole('combobox', { name: current === 'zh-CN' ? '语言' : 'Language', exact: true });
  await trigger.click();
  const listbox = page.getByRole('listbox');
  await expect(listbox).toBeVisible();
  await listbox.getByRole('option', { name: locale === 'zh-CN' ? '简体中文' : 'English', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', locale);
  await expect(listbox).toHaveCount(0);
}

async function expectNextTurn(page: Page, conversationId: string) {
  const previous = await snapshot(page, conversationId);
  expectedTurns.set(page, { conversationId, assistantOrder: (previous.messages.at(-1)?.order ?? 0) + 2 });
}

async function send(page: Page, content: string, locale: 'en' | 'zh-CN' = 'en') {
  const composer = page.getByRole('textbox', { name: locale === 'en' ? 'Message your Agent' : '向 Agent 发送消息', exact: true });
  await expect(composer).toBeEnabled();
  await composer.fill(content);
  const conversationId = new URL(page.url()).pathname.split('/').at(-1)!;
  await expectNextTurn(page, conversationId);
  await page.getByRole('button', { name: locale === 'en' ? 'Send message' : '发送消息', exact: true }).click();
}

async function seedTurn(page: Page, conversationId: string, content: string): Promise<AcceptedMessage> {
  const response = await page.request.post(`/api/conversations/${conversationId}/messages`, {
    headers: { 'Idempotency-Key': crypto.randomUUID() }, data: { content },
  });
  expect(response.status()).toBe(202);
  const accepted = await response.json() as AcceptedMessage;
  await expect.poll(async () => {
    const result = await page.request.get(`/api/runs/${accepted.run.id}`);
    expect(result.ok()).toBeTruthy();
    return (await result.json() as Run).status;
  }, { timeout: 10_000, intervals: [25, 50, 100] }).toBe('completed');
  return accepted;
}

async function waitForTerminal(page: Page, conversationId: string, status: MessageStatus = 'completed'): Promise<ChatSnapshot> {
  const expected = expectedTurns.get(page);
  if (!expected || expected.conversationId !== conversationId) throw new Error('Record the expected turn before submitting through the UI.');
  let result: ChatSnapshot | undefined;
  await expect.poll(async () => {
    result = await snapshot(page, conversationId);
    return result.messages.find(message => message.role === 'assistant' && message.order === expected.assistantOrder)?.status;
  }, { timeout: 15_000, message: `Assistant message ${expected.assistantOrder} should become ${status}` }).toBe(status);
  const last = result!.messages.find(message => message.role === 'assistant' && message.order === expected.assistantOrder)!;
  const article = page.locator(`[data-message-id="${last.id}"]`);
  await expect(article).toBeVisible();
  await expect(article.locator('.message-generating')).toHaveCount(0);
  return result!;
}

async function waitForPartial(page: Page) {
  await expect.poll(async () => (await assistantMessages(page).last().locator('.message-body').textContent())?.trim().length ?? 0, {
    timeout: 10_000,
    message: 'The slow Agent should expose partial text before cancellation or navigation',
  }).toBeGreaterThan(35);
}

test('streams persisted replies, retains same-chat context, and isolates another conversation', async ({ page }) => {
  const first = await createConversation(page, unique('context'));
  const rememberedValue = unique('remembered value');
  const firstPrompt = `/remember ${rememberedValue}`;
  await openConversation(page, first.id);
  await send(page, firstPrompt);
  await waitForTerminal(page, first.id);
  await expect(assistantMessages(page)).toHaveCount(1);
  await expect(assistantMessages(page).first().locator('.markdown')).toHaveText('Value remembered for this conversation.');
  await expect(assistantMessages(page).first()).not.toContainText(rememberedValue);

  const unrelatedValue = unique('unrelated private detail');
  const unrelatedPrompt = `Suggest a brief next step without repeating this unrelated detail: ${unrelatedValue}.\nKeep this instruction in its own message.`;
  await send(page, unrelatedPrompt);
  await waitForTerminal(page, first.id);
  await expect(assistantMessages(page)).toHaveCount(2);
  await expect(assistantMessages(page).last()).not.toContainText(unrelatedValue);
  await expect(assistantMessages(page).last()).not.toContainText(unrelatedPrompt);
  await expect(assistantMessages(page).last()).not.toContainText(firstPrompt);

  await send(page, '/context');
  await waitForTerminal(page, first.id);
  await expect(assistantMessages(page)).toHaveCount(3);
  await expect(assistantMessages(page).last().locator('.markdown')).toHaveText(rememberedValue);
  await expect(assistantMessages(page).last()).not.toContainText(unrelatedValue);
  await expect(assistantMessages(page).last()).not.toContainText(firstPrompt);
  await expect(page.locator('.message-user .user-content')).toHaveText([firstPrompt, unrelatedPrompt, '/context']);

  const second = await createConversation(page, unique('independent'));
  await openConversation(page, second.id);
  await expect(page.locator('.message')).toHaveCount(0);
  const independentPrompt = '/context';
  await send(page, independentPrompt);
  const saved = await waitForTerminal(page, second.id);
  await expect(assistantMessages(page)).toHaveCount(1);
  await expect(assistantMessages(page).locator('.markdown')).toHaveText('No value has been remembered in this conversation.');
  await expect(assistantMessages(page)).not.toContainText(rememberedValue);
  await expect(assistantMessages(page)).not.toContainText(unrelatedValue);
  expect(saved.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual([independentPrompt]);
});

test('reconnects, navigates, and refreshes an active reply without duplicating messages or text', async ({ page, context }) => {
  const activeChat = await createConversation(page, unique('reconnect'));
  const otherChat = await createConversation(page, unique('navigation'));
  await openConversation(page, activeChat.id);
  await send(page, `/slow ${unique('keep running')}`);
  await waitForPartial(page);
  const running = await snapshot(page, activeChat.id);
  expect(running.activeRun?.status).toBe('running');
  const runId = running.activeRun!.id;

  try {
    await context.setOffline(true);
    await expect(page.locator('.connection-pill')).toHaveText(/Reconnecting|Disconnected/);
  } finally {
    await context.setOffline(false);
  }
  await page.locator(`a.conversation-link[href="/chat/${otherChat.id}"]`).click();
  await expect(page).toHaveURL(`/chat/${otherChat.id}`);
  await expect(page.locator('.message')).toHaveCount(0);
  await page.locator(`a.conversation-link[href="/chat/${activeChat.id}"]`).click();
  await expect(page).toHaveURL(`/chat/${activeChat.id}`);
  await page.reload();

  const saved = await waitForTerminal(page, activeChat.id);
  const assistant = saved.messages.find(message => message.role === 'assistant')!;
  expect(assistant.runId).toBe(runId);
  expect(saved.messages.filter(message => message.role === 'user')).toHaveLength(1);
  await expect(page.locator('.message-user')).toHaveCount(1);
  await expect(assistantMessages(page)).toHaveCount(1);
  await expect(assistantMessages(page).locator('.markdown')).toHaveText(assistant.content);
});

test('stops an active generation and preserves its partial response after refresh', async ({ page }) => {
  const conversation = await createConversation(page, unique('cancellation'));
  await openConversation(page, conversation.id);
  await send(page, `/slow ${unique('cancel this run')}`);
  await waitForPartial(page);
  const running = await snapshot(page, conversation.id);
  const runId = running.activeRun!.id;
  const selectedRow = page.locator('.conversation-row.selected');
  await expect(selectedRow.getByRole('button', { name: /^Archive chat:/ })).toBeDisabled();

  await page.getByRole('button', { name: 'Stop generating', exact: true }).click();
  const saved = await waitForTerminal(page, conversation.id, 'cancelled');
  const partial = saved.messages.find(message => message.role === 'assistant')!;
  expect(partial.content.length).toBeGreaterThan(0);
  expect(partial.content.length).toBeLessThan(560);
  expect(saved.activeRun).toBeNull();
  await expect(page.locator('.message-outcome')).toContainText('Generation stopped. The partial reply has been kept.');
  await expect(page.getByRole('button', { name: 'Stop generating', exact: true })).toHaveCount(0);

  const secondCancellation = await page.request.post(`/api/runs/${runId}/cancel`, { data: {} });
  expect(secondCancellation.ok()).toBeTruthy();
  expect((await secondCancellation.json() as Run).status).toBe('cancelled');
  await page.reload();
  await expect(assistantMessages(page).locator('.markdown')).toHaveText(partial.content);
  await expect(page.locator('.message-outcome')).toContainText('Stopped');
});

test('retries an unconfirmed send with the same key and recovers from an explicit provider failure', async ({ page }) => {
  const conversation = await createConversation(page, unique('failure recovery'));
  await openConversation(page, conversation.id);
  const keys: string[] = [];
  let loseFirstResponse = true;
  const sendUrl = `**/api/conversations/${conversation.id}/messages`;
  await page.route(sendUrl, async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    keys.push(route.request().headers()['idempotency-key'] ?? '');
    if (loseFirstResponse) {
      loseFirstResponse = false;
      const accepted = await route.fetch();
      expect(accepted.status()).toBe(202);
      await route.abort('failed');
    } else await route.continue();
  });
  const prompt = unique('confirm this request once');
  await send(page, prompt);
  await expect(page.getByRole('button', { name: 'Retry send', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Retry send', exact: true }).click();
  await waitForTerminal(page, conversation.id);
  expect(keys).toHaveLength(2);
  expect(keys[0]).not.toBe('');
  expect(keys[1]).toBe(keys[0]);
  const confirmed = await snapshot(page, conversation.id);
  expect(confirmed.messages.filter(message => message.role === 'user')).toHaveLength(1);
  await expect(assistantMessages(page)).toHaveCount(1);
  await page.unroute(sendUrl);

  await send(page, `/error ${unique('show partial failure')}`);
  const failed = await waitForTerminal(page, conversation.id, 'failed');
  expect(failed.activeRun).toBeNull();
  await expect(assistantMessages(page).last()).toContainText('Partial mock response before the simulated error.');
  await expect(page.locator('.composer-error')).toContainText('The model service could not complete the reply. Please try again.');
  await expect(page.locator('body')).not.toContainText('Mock upstream failure.');
  expect(failed.messages.filter(message => message.role === 'user')).toHaveLength(2);

  await send(page, unique('explicit recovery'));
  const recovered = await waitForTerminal(page, conversation.id);
  expect(recovered.messages.filter(message => message.role === 'user')).toHaveLength(3);
  await expect(assistantMessages(page)).toHaveCount(3);
});

test('creates, renames, and archives a conversation while retaining its history', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  await expect(page).toHaveURL(/\/chat\/[0-9a-f-]+$/);
  const conversationId = new URL(page.url()).pathname.split('/').at(-1)!;
  const prompt = unique('archive retained history');
  await send(page, prompt);
  await waitForTerminal(page, conversationId);

  const renamed = unique('renamed chat');
  await page.locator('.conversation-row.selected').getByRole('button', { name: /^Rename chat:/ }).click();
  const renameDialog = page.getByRole('dialog', { name: 'Give this chat a name' });
  await renameDialog.getByRole('textbox', { name: 'Conversation name' }).fill(renamed);
  await renameDialog.getByRole('button', { name: 'Save name', exact: true }).click();
  await expect(renameDialog).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(renamed);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(renamed);

  await page.locator('.conversation-row.selected').getByRole('button', { name: /^Archive chat:/ }).click();
  const archiveDialog = page.getByRole('alertdialog', { name: 'Archive this conversation?' });
  await archiveDialog.getByRole('button', { name: 'Archive chat', exact: true }).click();
  await expect(page).toHaveURL('/');
  await expect(page.locator(`a.conversation-link[href="/chat/${conversationId}"]`)).toHaveCount(0);
  const retained = await snapshot(page, conversationId);
  expect(retained.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual([prompt]);
  expect(retained.messages.find(message => message.role === 'assistant')?.status).toBe('completed');
});

test('preserves Chinese mobile drafts, handles IME composition, and remembers the chosen locale', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const first = await createConversation(page, unique('mobile first'));
  const second = await createConversation(page, unique('mobile second'));
  await page.goto('/');
  await chooseLanguage(page, 'zh-CN');
  await expect(page.getByRole('button', { name: '新建聊天', exact: true })).toBeVisible();
  await page.locator(`a.conversation-link[href="/chat/${first.id}"]`).click();
  let composer = page.getByRole('textbox', { name: '向 Agent 发送消息', exact: true });
  await expect(composer).toBeEnabled();
  await composer.fill('保留这段草稿');
  await page.getByRole('button', { name: '返回对话列表', exact: true }).click();
  await page.locator(`a.conversation-link[href="/chat/${second.id}"]`).click();
  await expect(composer).toHaveValue('');
  await page.getByRole('button', { name: '返回对话列表', exact: true }).click();
  await page.locator(`a.conversation-link[href="/chat/${first.id}"]`).click();
  composer = page.getByRole('textbox', { name: '向 Agent 发送消息', exact: true });
  await expect(composer).toHaveValue('保留这段草稿');

  await composer.dispatchEvent('compositionstart', { data: '稿' });
  await composer.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true, bubbles: true });
  expect((await snapshot(page, first.id)).messages).toHaveLength(0);
  await expect(composer).toHaveValue('保留这段草稿');
  await composer.dispatchEvent('compositionend', { data: '稿' });
  await composer.press('Shift+Enter');
  await composer.pressSequentially('下一行');
  await expect(composer).toHaveValue('保留这段草稿\n下一行');
  await expectNextTurn(page, first.id);
  await composer.press('Enter');
  await waitForTerminal(page, first.id);
  await expect(page.locator('.message-user .user-content')).toHaveText('保留这段草稿\n下一行');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(page.getByRole('textbox', { name: '向 Agent 发送消息', exact: true })).toHaveValue('');
  await expect(assistantMessages(page)).toHaveCount(1);
  expect((await snapshot(page, first.id)).messages.find(message => message.role === 'user')?.content).toBe('保留这段草稿\n下一行');
});

test('renders safe Markdown and copies code and complete messages without changing their text', async ({ page, context }) => {
  const conversation = await createConversation(page, unique('safe markdown'));
  await openConversation(page, conversation.id);
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin });
  await send(page, '/markdown');
  const saved = await waitForTerminal(page, conversation.id);
  const assistant = assistantMessages(page).last();
  await expect(assistant.locator('strong')).toHaveText('Readable text');
  await expect(assistant.locator('script, img, iframe')).toHaveCount(0);
  await expect(assistant.locator('a[href^="javascript:"]')).toHaveCount(0);
  expect(await page.evaluate(() => '__nexrunXss' in window)).toBeFalsy();
  await expect(assistant.getByRole('link', { name: 'reference' })).toHaveAttribute('href', 'https://example.com');
  await expect(assistant.getByRole('link', { name: 'reference' })).toHaveAttribute('rel', /noreferrer/);

  await assistant.getByRole('button', { name: 'Copy message', exact: true }).click();
  const originalMarkdown = saved.messages.find(message => message.role === 'assistant')!.content;
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(originalMarkdown);

  await send(page, '/code');
  const codeSnapshot = await waitForTerminal(page, conversation.id);
  const codeAssistant = assistantMessages(page).last();
  await codeAssistant.getByRole('button', { name: 'Copy code', exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("console.log('Hello from NexRun');\n");
  await expect(page.getByRole('region', { name: 'Notifications', exact: true }).getByText('Code copied', { exact: true })).toBeVisible();
  await codeAssistant.getByRole('button', { name: 'Copy message', exact: true }).click();
  const original = codeSnapshot.messages.filter(message => message.role === 'assistant').at(-1)!.content;
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(original);

  await chooseLanguage(page, 'zh-CN');
  await codeAssistant.getByRole('button', { name: '复制消息', exact: true }).click();
  const notifications = page.getByRole('region', { name: '通知', exact: true });
  const copied = notifications.locator('[data-slot="toast"]').filter({ has: page.getByText('消息已复制', { exact: true }) });
  await expect(copied).toBeVisible();
  await page.keyboard.press('F6');
  await expect(notifications).toBeFocused();
  await copied.getByRole('button', { name: '关闭通知', exact: true }).click();
  await expect(copied).toHaveCount(0);
});

test('answer language follows the current prompt independently of the selected UI language', async ({ page }) => {
  const conversation = await createConversation(page, unique('answer language'));
  await openConversation(page, conversation.id);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  const chinesePrompt = `Please reply in Simplified Chinese. Give one brief suggestion without repeating this request. ${unique('private Chinese request')}`;
  await send(page, chinesePrompt);
  const chineseSnapshot = await waitForTerminal(page, conversation.id);
  const chineseReply = chineseSnapshot.messages.filter(message => message.role === 'assistant').at(-1)!.content;
  expect(chineseReply).toMatch(/[\u3400-\u9fff]/u);
  expect(chineseReply).not.toContain(chinesePrompt);
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeVisible();

  await chooseLanguage(page, 'zh-CN');
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  const englishPrompt = `请用英文简要回答，给出一个建议，不要重复这段请求。${unique('private English request')}`;
  await send(page, englishPrompt, 'zh-CN');
  const englishSnapshot = await waitForTerminal(page, conversation.id);
  const englishReply = englishSnapshot.messages.filter(message => message.role === 'assistant').at(-1)!.content;
  expect(englishReply).toMatch(/[A-Za-z]{3}/u);
  expect(englishReply).not.toMatch(/[\u3400-\u9fff]/u);
  expect(englishReply).not.toContain(englishPrompt);
  expect(englishReply).not.toContain(chinesePrompt);
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeVisible();
  await expect(page.locator('.message-user .user-content')).toHaveText([chinesePrompt, englishPrompt]);

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(assistantMessages(page).first().locator('.markdown')).toHaveText(chineseReply);
  await expect(assistantMessages(page).last().locator('.markdown')).toHaveText(englishReply);
});

test('loads earlier history in server order and merges a new reply without duplicate bubbles', async ({ page }) => {
  test.setTimeout(60_000);
  const conversation = await createConversation(page, unique('history pages'));
  for (let index = 0; index < 23; index++) await seedTurn(page, conversation.id, `/remember page-${index}`);
  const seeded = await snapshot(page, conversation.id);
  expect(seeded.messages).toHaveLength(46);
  await openConversation(page, conversation.id);
  await expect(page.locator('.message')).toHaveCount(40);
  const earlier = page.getByRole('button', { name: 'Load earlier messages', exact: true });
  await earlier.click();
  await expect(page.locator('.message')).toHaveCount(46);
  await expect(earlier).toHaveCount(0);
  expect(await page.locator('.message').evaluateAll(elements => elements.map(element => element.getAttribute('data-message-id')))).toEqual(seeded.messages.map(message => message.id));

  await send(page, '/context');
  const updated = await waitForTerminal(page, conversation.id);
  expect(updated.messages).toHaveLength(48);
  await expect(assistantMessages(page).last().locator('.markdown')).toHaveText('page-22');
  await expect(page.locator('.message')).toHaveCount(48);
  const expectedIds = updated.messages.map(message => message.id);
  expect(await page.locator('.message').evaluateAll(elements => elements.map(element => element.getAttribute('data-message-id')))).toEqual(expectedIds);

  await page.reload();
  await expect(page.locator('.message')).toHaveCount(40);
  await page.getByRole('button', { name: 'Load earlier messages', exact: true }).click();
  await expect(page.locator('.message')).toHaveCount(48);
  const restoredIds = await page.locator('.message').evaluateAll(elements => elements.map(element => element.getAttribute('data-message-id')));
  expect(restoredIds).toEqual(expectedIds);
  expect(new Set(restoredIds).size).toBe(restoredIds.length);
});

test('rejects empty and whitespace messages without creating a Run or changing history', async ({ page }) => {
  const conversation = await createConversation(page, unique('input validation'));
  await openConversation(page, conversation.id);
  const composer = page.getByRole('textbox', { name: 'Message your Agent', exact: true });
  const sendButton = page.getByRole('button', { name: 'Send message', exact: true });
  await expect(sendButton).toBeDisabled();
  await composer.fill(' \n\t ');
  await expect(sendButton).toBeDisabled();
  await composer.press('Enter');
  await expect(composer).toHaveValue(' \n\t ');
  await expect(page.locator('.message')).toHaveCount(0);

  for (const content of ['', ' \n\t ', 'x'.repeat(16_001)]) {
    const rejected = await page.request.post(`/api/conversations/${conversation.id}/messages`, {
      headers: { 'Idempotency-Key': crypto.randomUUID() }, data: { content },
    });
    expect(rejected.status()).toBe(400);
    expect((await rejected.json()).error.code).toBe('VALIDATION_ERROR');
  }
  const unchanged = await snapshot(page, conversation.id);
  expect(unchanged.messages).toEqual([]);
  expect(unchanged.activeRun).toBeNull();
  expect(unchanged.cursor).toBe(0);
  await page.reload();
  await expect(page.locator('.message')).toHaveCount(0);
});

test('uses the language listbox with keyboard cancel, selection and persisted locale', async ({ page }) => {
  await page.goto('/');
  const trigger = page.getByRole('combobox', { name: 'Language', exact: true });
  await expect(trigger).toHaveAttribute('data-slot', 'select-trigger');
  await expect(page.locator('.sidebar-footer select:visible, dialog')).toHaveCount(0);
  await trigger.focus();
  await trigger.press('ArrowDown');
  const listbox = page.getByRole('listbox');
  const englishOption = listbox.getByRole('option', { name: 'English', exact: true });
  const chineseOption = listbox.getByRole('option', { name: '简体中文', exact: true });
  await expect(listbox).toBeVisible();
  await expect(listbox.getByRole('option')).toHaveText(['English', '简体中文']);
  await expect(englishOption).toBeFocused();
  await page.keyboard.press('Home');
  await expect(englishOption).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(chineseOption).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(listbox).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(trigger).toContainText('English');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');

  await trigger.press('ArrowDown');
  await expect(listbox).toBeVisible();
  await expect(englishOption).toBeFocused();
  await page.keyboard.press('Home');
  await expect(englishOption).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(chineseOption).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(listbox).toHaveCount(0);
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(page.getByRole('combobox', { name: '语言', exact: true })).toContainText('简体中文');

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  const localizedTrigger = page.getByRole('combobox', { name: '语言', exact: true });
  await localizedTrigger.focus();
  await localizedTrigger.press('ArrowUp');
  await expect(listbox).toBeVisible();
  await expect(chineseOption).toBeFocused();
  await page.keyboard.press('Home');
  await expect(englishOption).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.reload();
  await expect(page.getByRole('combobox', { name: 'Language', exact: true })).toContainText('English');
});

test('traps rename-dialog focus and restores its trigger after Escape and localized cancellation', async ({ page }) => {
  const conversation = await createConversation(page, unique('dialog keyboard'));
  await openConversation(page, conversation.id);
  const trigger = page.locator('.conversation-row.selected').getByRole('button', { name: `Rename chat: ${conversation.title}`, exact: true });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Give this chat a name', exact: true });
  await expect(dialog).toHaveAttribute('data-slot', 'dialog-content');
  await expect(page.locator('dialog')).toHaveCount(0);
  const input = dialog.getByRole('textbox', { name: 'Conversation name', exact: true });
  await expect(input).toBeFocused();
  await input.fill('An unsaved rename');
  for (const key of ['Tab', 'Tab', 'Tab', 'Tab', 'Tab', 'Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab']) {
    await page.keyboard.press(key);
    await expect.poll(() => dialog.evaluate(element => element.contains(document.activeElement))).toBeTruthy();
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(conversation.title);

  await chooseLanguage(page, 'zh-CN');
  const localizedTrigger = page.locator('.conversation-row.selected').getByRole('button', { name: `重命名聊天: ${conversation.title}`, exact: true });
  await localizedTrigger.click();
  const localizedDialog = page.getByRole('dialog', { name: '为这段对话命名', exact: true });
  await expect(localizedDialog.getByRole('textbox', { name: '对话名称', exact: true })).toBeFocused();
  await localizedDialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(localizedDialog).toHaveCount(0);
  await expect(localizedTrigger).toBeFocused();
  const listed = await page.request.get('/api/conversations');
  const saved = (await listed.json()).conversations.find((chat: Conversation) => chat.id === conversation.id) as Conversation;
  expect(saved.title).toBe(conversation.title);
});

test('cancels an archive alert without changes and confirms it with localized controls', async ({ page }) => {
  const conversation = await createConversation(page, unique('archive alert'));
  await openConversation(page, conversation.id);
  await send(page, 'Hello');
  const before = await waitForTerminal(page, conversation.id);
  const trigger = page.locator('.conversation-row.selected').getByRole('button', { name: `Archive chat: ${conversation.title}`, exact: true });
  await trigger.click();
  const dialog = page.getByRole('alertdialog', { name: 'Archive this conversation?', exact: true });
  await expect(dialog).toHaveAttribute('data-slot', 'alert-dialog-content');
  const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true });
  await expect(cancel).toBeFocused();
  for (const key of ['Tab', 'Tab', 'Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab']) {
    await page.keyboard.press(key);
    await expect.poll(() => dialog.evaluate(element => element.contains(document.activeElement))).toBeTruthy();
  }
  await cancel.click();
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(page).toHaveURL(`/chat/${conversation.id}`);
  await expect(page.locator(`a.conversation-link[href="/chat/${conversation.id}"]`)).toBeVisible();
  expect((await snapshot(page, conversation.id)).messages).toEqual(before.messages);

  await chooseLanguage(page, 'zh-CN');
  await page.locator('.conversation-row.selected').getByRole('button', { name: `归档聊天: ${conversation.title}`, exact: true }).click();
  const localizedDialog = page.getByRole('alertdialog', { name: '归档这段对话？', exact: true });
  await expect(localizedDialog.getByRole('button', { name: '取消', exact: true })).toBeFocused();
  await localizedDialog.getByRole('button', { name: '归档聊天', exact: true }).click();
  await expect(page).toHaveURL('/');
  await expect(page.locator(`a.conversation-link[href="/chat/${conversation.id}"]`)).toHaveCount(0);
  expect((await snapshot(page, conversation.id)).messages).toEqual(before.messages);
});
