import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { ChatEvent, Message, Run } from '@nexrun/protocol';
import type { ApiConfig } from './config.js';
import { transaction } from './db.js';

type Outcome = 'completed' | 'failed' | 'cancelled' | 'interrupted';
interface DemoTurn { prompt: string; reply: string; status?: Outcome; errorCode?: string }
interface DemoConversation { key: string; title: string; archived?: boolean; turns: DemoTurn[] }

// First-party historical examples, never provider responses or user data.
export const demoConversations: readonly DemoConversation[] = [
  {
    key: 'release', title: 'Demo · Release checklist', turns: [
      { prompt: 'What should our first chat release include?', reply: 'Focus on three things:\n\n- Reliable streaming and saved history.\n- Clear stop and failure recovery.\n- English and Simplified Chinese support.' },
      { prompt: 'Which part should we verify first?', reply: 'Start with one complete chat: send a message, refresh during streaming, then confirm the reply appears exactly once.' },
      { prompt: 'Can you deploy it for me?', reply: 'I can outline the deployment steps. This text-only preview cannot run commands or deploy services.' },
    ],
  },
  {
    key: 'chinese', title: 'Demo · 发布准备', turns: [
      { prompt: '请列出这次发布的重点。', reply: '本次发布重点：\n\n- 聊天流式输出与历史持久化。\n- 停止生成、断线恢复和错误提示。\n- 中英文界面与移动端使用。' },
      { prompt: '测试完成后还需要注意什么？', reply: '确认真实模型凭据有效，并为共享预览配置登录保护和 HTTPS。模拟测试不能替代真实模型验收。' },
    ],
  },
  {
    key: 'code', title: 'Demo · Markdown and code', turns: [
      { prompt: 'Show a small TypeScript example.', reply: 'Use a typed function:\n\n```typescript\nexport function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n```\n\nPass a name to receive the greeting.' },
      { prompt: 'What does it return for NexRun?', reply: '`greet("NexRun")` returns `"Hello, NexRun!"`.' },
    ],
  },
  {
    key: 'recovery', title: 'Demo · Recovery examples', turns: [
      { prompt: 'Summarize the release checks.', reply: 'The first priority is reliable streaming.', status: 'failed', errorCode: 'UPSTREAM_ERROR' },
      { prompt: 'Try again with just the key checks.', reply: 'Verify streaming, saved history, cancellation, and reconnect recovery.' },
      { prompt: 'Give me the longer explanation.', reply: 'Start by checking that one accepted request creates one reply. ', status: 'cancelled' },
      { prompt: 'Explain what happens after a service restart.', reply: 'Accepted work is retained. ', status: 'interrupted', errorCode: 'RUN_INTERRUPTED' },
    ],
  },
  {
    key: 'history', title: 'Demo · Long history (60 turns)',
    turns: Array.from({ length: 60 }, (_, index) => ({
      prompt: `Review checkpoint ${String(index + 1).padStart(2, '0')}. What should I verify?`,
      reply: `Checkpoint ${String(index + 1).padStart(2, '0')}: verify that saved messages remain ordered and appear once after loading older history.`,
    })),
  },
  { key: 'archived', title: 'Demo · Archived conversation', archived: true, turns: [{ prompt: 'Can I keep an old conversation?', reply: 'Yes. Archiving removes it from the active list while retaining its history.' }] },
  { key: 'empty', title: 'Demo · Start a conversation', turns: [] },
];

export function demoId(key: string): string {
  const hash = createHash('sha256').update(`nexrun-demo-v1:${key}`).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export function assertDemoConfiguration(config: Pick<ApiConfig, 'agentMode' | 'databaseUrl'>): void {
  let local = false;
  try {
    const url = new URL(config.databaseUrl);
    const allowedParameters = new Set(['sslmode', 'application_name', 'connect_timeout', 'statement_timeout']);
    // pg accepts a query-string host override; validating only URL.hostname is insufficient.
    local = ['postgres:', 'postgresql:'].includes(url.protocol)
      && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      && [...url.searchParams.keys()].every(key => allowedParameters.has(key));
  } catch { /* Invalid URLs fail closed below. */ }
  if (config.agentMode !== 'mock' || !local) throw new Error('Demo fixtures require mock mode and a loopback development database.');
}

async function appendEvent(client: PoolClient, conversationId: string, sequence: number, timestamp: string, type: ChatEvent['type'], payload: ChatEvent['payload']): Promise<void> {
  await client.query('INSERT INTO conversation_events (id, conversation_id, sequence, type, payload, created_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6)', [demoId(`${conversationId}:event:${sequence}`), conversationId, sequence, type, JSON.stringify(payload), timestamp]);
}

/** Add missing fixtures atomically. Existing fixture IDs, including user edits, are untouched. */
export async function seedDemo(pool: Pool, config: Pick<ApiConfig, 'agentMode' | 'databaseUrl' | 'ownerId'>, now = new Date()): Promise<{ created: number; skipped: number }> {
  assertDemoConfiguration(config);
  return transaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('nexrun-demo-v1'), hashtext(current_schema()))");
    let created = 0;
    let skipped = 0;
    const base = now.getTime() - 86_400_000;
    for (const [chatIndex, fixture] of demoConversations.entries()) {
      const conversationId = demoId(fixture.key);
      const existing = await client.query<{ owner_id: string }>('SELECT owner_id FROM conversations WHERE id = $1', [conversationId]);
      if (existing.rows[0]) {
        if (existing.rows[0].owner_id !== config.ownerId) throw new Error('A demo fixture ID belongs to a different owner. No fixtures were changed.');
        skipped += 1;
        continue;
      }
      const timestamp = (offset: number): string => new Date(base + chatIndex * 3_600_000 + offset).toISOString();
      const finalTime = timestamp(fixture.turns.length * 10_000);
      await client.query('INSERT INTO conversations (id, owner_id, title, custom_title, archived_at, created_at, updated_at, next_message_order, event_sequence) VALUES ($1, $2, $3, true, $4, $5, $6, $7, $8)', [conversationId, config.ownerId, fixture.title, fixture.archived ? finalTime : null, timestamp(0), finalTime, fixture.turns.length * 2, fixture.turns.length * 4]);
      for (const [index, turn] of fixture.turns.entries()) {
        const runId = demoId(`${fixture.key}:run:${index}`);
        const userId = demoId(`${fixture.key}:user:${index}`);
        const assistantId = demoId(`${fixture.key}:assistant:${index}`);
        const attemptId = demoId(`${fixture.key}:attempt:${index}`);
        const createdAt = timestamp(index * 10_000);
        const updatedAt = timestamp(index * 10_000 + 3_000);
        const status = turn.status ?? 'completed';
        const run: Run = { id: runId, conversationId, adapter: 'mock', status, errorCode: turn.errorCode ?? null, createdAt, updatedAt };
        const user: Message = { id: userId, conversationId, runId, role: 'user', content: turn.prompt, status: 'completed', order: index * 2 + 1, createdAt };
        const assistant: Message = { id: assistantId, conversationId, runId, role: 'assistant', content: turn.reply, status, order: index * 2 + 2, createdAt };
        await client.query('INSERT INTO runs (id, conversation_id, user_message_id, assistant_message_id, adapter, status, request_key, request_hash, attempt_id, error_code, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)', [runId, conversationId, userId, assistantId, 'mock', status, `demo-v1:${fixture.key}:${index}`, createHash('sha256').update(turn.prompt).digest('hex'), attemptId, run.errorCode, createdAt, updatedAt]);
        await client.query('INSERT INTO messages (id, conversation_id, run_id, role, content, status, order_no, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8), ($9, $2, $3, $10, $11, $12, $13, $8)', [userId, conversationId, runId, 'user', user.content, user.status, user.order, createdAt, assistantId, 'assistant', assistant.content, status, assistant.order]);
        await client.query("INSERT INTO command_outbox (id, run_id, state, attempt_id, created_at, updated_at) VALUES ($1, $2, 'retired', $3, $4, $5)", [demoId(`${fixture.key}:outbox:${index}`), runId, attemptId, createdAt, updatedAt]);
        const sequence = index * 4;
        await appendEvent(client, conversationId, sequence + 1, createdAt, 'message.accepted', { userMessage: user, assistantMessage: { ...assistant, content: '', status: 'pending' }, run: { ...run, status: 'queued', errorCode: null, updatedAt: createdAt } });
        await appendEvent(client, conversationId, sequence + 2, timestamp(index * 10_000 + 1_000), 'run.updated', { run: { ...run, status: 'running', errorCode: null, updatedAt: timestamp(index * 10_000 + 1_000) } });
        await appendEvent(client, conversationId, sequence + 3, timestamp(index * 10_000 + 2_000), 'message.updated', { message: { ...assistant, content: turn.reply.slice(0, 24), status: 'streaming' } });
        await appendEvent(client, conversationId, sequence + 4, updatedAt, 'run.updated', { run, message: assistant });
      }
      if (fixture.turns.length) await client.query("INSERT INTO agent_sessions (conversation_id, adapter, native_session_ref, state, updated_at) VALUES ($1::uuid, 'mock', $1::text, $2, $3)", [conversationId, fixture.turns.at(-1)?.status === 'interrupted' ? 'interrupted' : 'idle', finalTime]);
      created += 1;
    }
    return { created, skipped };
  });
}
