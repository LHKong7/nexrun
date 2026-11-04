import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { AcceptedMessage, ChatEvent, ChatSnapshot, Conversation, ConversationPage, Message, Run, RunStatus } from '@nexrun/protocol';
import type { ApiConfig } from './config.js';
import { transaction } from './db.js';
import { AppError } from './errors.js';

interface ConversationRow {
  id: string; title: string; kind: 'direct'; created_at: Date; updated_at: Date; archived_at: Date | null;
  custom_title: boolean; next_message_order: number; event_sequence: string; preview?: string;
}
interface RunRow {
  id: string; conversation_id: string; user_message_id: string; assistant_message_id: string;
  adapter: 'mock' | 'pi'; status: RunStatus; error_code: string | null; request_key: string; request_hash: string;
  attempt_id: string | null; created_at: Date; updated_at: Date;
}
interface MessageRow {
  id: string; conversation_id: string; run_id: string; role: 'user' | 'assistant'; content: string;
  status: Message['status']; order_no: number; created_at: Date;
}
interface EventRow { id: string; conversation_id: string; sequence: string; type: ChatEvent['type']; payload: ChatEvent['payload'] }

const activeStatuses = ['queued', 'running', 'cancelling'];
const iso = (date: Date): string => date.toISOString();
export const toRun = (row: RunRow): Run => ({ id: row.id, conversationId: row.conversation_id, adapter: row.adapter, status: row.status, errorCode: row.error_code, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) });
const toMessage = (row: MessageRow): Message => ({ id: row.id, conversationId: row.conversation_id, runId: row.run_id, role: row.role, content: row.content, status: row.status, order: row.order_no, createdAt: iso(row.created_at) });

export class ChatStore {
  constructor(readonly pool: Pool, private readonly config: ApiConfig) {}

  private async conversation(client: PoolClient, id: string, lock = false): Promise<ConversationRow> {
    const result = await client.query<ConversationRow>(`SELECT * FROM conversations WHERE id = $1 AND owner_id = $2${lock ? ' FOR UPDATE' : ''}`, [id, this.config.ownerId]);
    const row = result.rows[0];
    if (!row) throw new AppError('CONVERSATION_NOT_FOUND', 404);
    return row;
  }

  private async activeRun(client: PoolClient, conversationId: string): Promise<Run | null> {
    const result = await client.query<RunRow>('SELECT * FROM runs WHERE conversation_id = $1 AND status = ANY($2::text[])', [conversationId, activeStatuses]);
    return result.rows[0] ? toRun(result.rows[0]) : null;
  }

  private async describeConversation(client: PoolClient, row: ConversationRow): Promise<Conversation> {
    const preview = await client.query<{ content: string }>("SELECT content FROM messages WHERE conversation_id = $1 AND content <> '' ORDER BY order_no DESC LIMIT 1", [row.id]);
    return {
      id: row.id, title: row.title, kind: 'direct', createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
      archivedAt: row.archived_at ? iso(row.archived_at) : null,
      preview: (preview.rows[0]?.content ?? '').slice(0, 180), activeRun: await this.activeRun(client, row.id),
    };
  }

  async createConversation(title?: string): Promise<Conversation> {
    return transaction(this.pool, async (client) => {
      const result = await client.query<ConversationRow>('INSERT INTO conversations (id, owner_id, title, custom_title) VALUES ($1, $2, $3, $4) RETURNING *', [randomUUID(), this.config.ownerId, title ?? 'New chat', title !== undefined]);
      return this.describeConversation(client, result.rows[0]!);
    });
  }

  async listConversations(limit: number, cursor?: { updatedAt: string; id: string }): Promise<ConversationPage> {
    return transaction(this.pool, async (client) => {
      const result = await client.query<ConversationRow>(`SELECT * FROM conversations WHERE owner_id = $1 AND archived_at IS NULL ${cursor ? 'AND (updated_at, id) < ($3::timestamptz, $4::uuid)' : ''} ORDER BY updated_at DESC, id DESC LIMIT $2`, cursor ? [this.config.ownerId, limit + 1, cursor.updatedAt, cursor.id] : [this.config.ownerId, limit + 1]);
      const rows = result.rows.slice(0, limit);
      const conversations: Conversation[] = [];
      for (const row of rows) conversations.push(await this.describeConversation(client, row));
      const last = rows.at(-1);
      return {
        conversations,
        nextCursor: result.rows.length > limit && last ? Buffer.from(JSON.stringify({ updatedAt: iso(last.updated_at), id: last.id })).toString('base64url') : null,
      };
    });
  }

  async patchConversation(id: string, patch: { title?: string; archived?: boolean }): Promise<Conversation> {
    return transaction(this.pool, async (client) => {
      const row = await this.conversation(client, id, true);
      if (patch.archived && await this.activeRun(client, id)) throw new AppError('CONVERSATION_BUSY', 409);
      const result = await client.query<ConversationRow>(`UPDATE conversations SET title = $2, custom_title = $3, archived_at = $4, updated_at = clock_timestamp() WHERE id = $1 RETURNING *`, [id, patch.title ?? row.title, patch.title !== undefined || row.custom_title, patch.archived === undefined ? row.archived_at : patch.archived ? new Date() : null]);
      return this.describeConversation(client, result.rows[0]!);
    });
  }

  async snapshot(id: string, limit: number, before?: number): Promise<ChatSnapshot> {
    return transaction(this.pool, async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      const conversation = await this.conversation(client, id);
      const result = await client.query<MessageRow>(`SELECT * FROM messages WHERE conversation_id = $1${before === undefined ? '' : ' AND order_no < $3'} ORDER BY order_no DESC LIMIT $2`, before === undefined ? [id, limit + 1] : [id, limit + 1, before]);
      const messages = result.rows.slice(0, limit).reverse().map(toMessage);
      return {
        messages, activeRun: await this.activeRun(client, id), cursor: Number(conversation.event_sequence),
        nextCursor: result.rows.length > limit ? messages[0]!.order : null,
      };
    });
  }

  private async emit(client: PoolClient, conversationId: string, type: ChatEvent['type'], payload: ChatEvent['payload']): Promise<number> {
    const result = await client.query<{ event_sequence: string }>('UPDATE conversations SET event_sequence = event_sequence + 1 WHERE id = $1 RETURNING event_sequence', [conversationId]);
    const sequence = Number(result.rows[0]!.event_sequence);
    await client.query('INSERT INTO conversation_events (id, conversation_id, sequence, type, payload) VALUES ($1, $2, $3, $4, $5::jsonb)', [randomUUID(), conversationId, sequence, type, JSON.stringify(payload)]);
    return sequence;
  }

  private async accepted(client: PoolClient, run: RunRow, cursor: number): Promise<AcceptedMessage> {
    const result = await client.query<MessageRow>('SELECT * FROM messages WHERE id = ANY($1::uuid[])', [[run.user_message_id, run.assistant_message_id]]);
    return {
      userMessage: toMessage(result.rows.find((row) => row.id === run.user_message_id)!),
      assistantMessage: toMessage(result.rows.find((row) => row.id === run.assistant_message_id)!),
      run: toRun(run), cursor,
    };
  }

  async acceptMessage(conversationId: string, content: string, key: string, configured: boolean): Promise<AcceptedMessage> {
    const hash = createHash('sha256').update(content).digest('hex');
    return transaction(this.pool, async (client) => {
      const conversation = await this.conversation(client, conversationId, true);
      const existing = await client.query<RunRow>('SELECT * FROM runs WHERE conversation_id = $1 AND request_key = $2', [conversationId, key]);
      if (existing.rows[0]) {
        if (existing.rows[0].request_hash !== hash) throw new AppError('IDEMPOTENCY_CONFLICT', 409);
        return this.accepted(client, existing.rows[0], Number(conversation.event_sequence));
      }
      if (conversation.archived_at) throw new AppError('CONVERSATION_ARCHIVED', 409);
      if (await this.activeRun(client, conversationId)) throw new AppError('CONVERSATION_BUSY', 409);
      if (!configured) throw new AppError('AGENT_NOT_CONFIGURED', 503);
      const session = await client.query<{ adapter: string; model: string | null; provider: string | null }>('SELECT adapter, model, provider FROM agent_sessions WHERE conversation_id = $1', [conversationId]);
      if (session.rows[0] && session.rows[0].adapter !== this.config.agentMode) throw new AppError('AGENT_SESSION_MISMATCH', 409);
      if (session.rows[0]?.adapter === 'pi' && (session.rows[0].model !== (this.config.model ?? 'gpt-5-mini') || session.rows[0].provider !== this.config.provider)) throw new AppError('AGENT_SESSION_MISMATCH', 409);
      await client.query("SELECT pg_advisory_xact_lock(hashtext('nexrun-admission'), hashtext(current_schema()))");
      const count = await client.query<{ count: string }>('SELECT count(*) FROM runs r JOIN conversations c ON c.id = r.conversation_id WHERE c.owner_id = $1 AND r.status = ANY($2::text[])', [this.config.ownerId, activeStatuses]);
      if (Number(count.rows[0]!.count) >= this.config.maxConcurrentRuns) throw new AppError('SERVICE_BUSY', 429);
      const runId = randomUUID();
      const userId = randomUUID();
      const assistantId = randomUUID();
      const run = await client.query<RunRow>("INSERT INTO runs (id, conversation_id, user_message_id, assistant_message_id, adapter, status, request_key, request_hash) VALUES ($1, $2, $3, $4, $5, 'queued', $6, $7) RETURNING *", [runId, conversationId, userId, assistantId, this.config.agentMode, key, hash]);
      await client.query("INSERT INTO messages (id, conversation_id, run_id, role, content, status, order_no) VALUES ($1, $2, $3, 'user', $4, 'completed', $5), ($6, $2, $3, 'assistant', '', 'pending', $7)", [userId, conversationId, runId, content, conversation.next_message_order + 1, assistantId, conversation.next_message_order + 2]);
      const defaultTitle = Array.from(content.trim().replace(/\s+/gu, ' ')).slice(0, 72).join('');
      await client.query('UPDATE conversations SET next_message_order = next_message_order + 2, title = $2, updated_at = clock_timestamp() WHERE id = $1', [conversationId, !conversation.custom_title && conversation.next_message_order === 0 ? defaultTitle : conversation.title]);
      await client.query("INSERT INTO agent_sessions (conversation_id, adapter, native_session_ref, persistence_location, model, provider) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (conversation_id) DO NOTHING", [conversationId, this.config.agentMode, conversationId, this.config.agentMode === 'pi' ? this.config.stateDir : null, this.config.agentMode === 'pi' ? this.config.model ?? 'gpt-5-mini' : null, this.config.agentMode === 'pi' ? this.config.provider : null]);
      await client.query('INSERT INTO command_outbox (id, run_id) VALUES ($1, $2)', [randomUUID(), runId]);
      const accepted = await this.accepted(client, run.rows[0]!, 0);
      accepted.cursor = await this.emit(client, conversationId, 'message.accepted', { userMessage: accepted.userMessage, assistantMessage: accepted.assistantMessage, run: accepted.run });
      return accepted;
    });
  }

  async getRun(id: string): Promise<Run> {
    const result = await this.pool.query<RunRow>('SELECT r.* FROM runs r JOIN conversations c ON c.id = r.conversation_id WHERE r.id = $1 AND c.owner_id = $2', [id, this.config.ownerId]);
    if (!result.rows[0]) throw new AppError('RUN_NOT_FOUND', 404);
    return toRun(result.rows[0]);
  }

  private async lockRun(client: PoolClient, runId: string): Promise<RunRow> {
    const ref = await client.query<{ conversation_id: string }>('SELECT r.conversation_id FROM runs r JOIN conversations c ON c.id = r.conversation_id WHERE r.id = $1 AND c.owner_id = $2', [runId, this.config.ownerId]);
    if (!ref.rows[0]) throw new AppError('RUN_NOT_FOUND', 404);
    await this.conversation(client, ref.rows[0].conversation_id, true);
    const result = await client.query<RunRow>('SELECT * FROM runs WHERE id = $1 FOR UPDATE', [runId]);
    return result.rows[0]!;
  }

  async cancelRun(id: string): Promise<Run> {
    return transaction(this.pool, async (client) => {
      const row = await this.lockRun(client, id);
      if (row.status === 'queued') return this.finishLocked(client, row, 'cancelled', '', null);
      if (row.status !== 'running') return toRun(row);
      const result = await client.query<RunRow>("UPDATE runs SET status = 'cancelling', updated_at = clock_timestamp() WHERE id = $1 RETURNING *", [id]);
      const run = toRun(result.rows[0]!);
      await this.emit(client, run.conversationId, 'run.updated', { run });
      return run;
    });
  }

  async pendingRuns(limit: number): Promise<string[]> {
    const result = await this.pool.query<{ id: string }>("SELECT r.id FROM runs r JOIN conversations c ON c.id = r.conversation_id JOIN command_outbox o ON o.run_id = r.id WHERE c.owner_id = $1 AND r.status = 'queued' AND o.state = 'pending' ORDER BY r.created_at, r.id LIMIT $2", [this.config.ownerId, limit]);
    return result.rows.map((row) => row.id);
  }

  async startRun(id: string): Promise<{ run: Run; attemptId: string; prompt: string; history: Array<{ role: 'user' | 'assistant'; content: string }> } | null> {
    return transaction(this.pool, async (client) => {
      const row = await this.lockRun(client, id);
      if (row.status !== 'queued') return null;
      const attemptId = randomUUID();
      const claim = await client.query("UPDATE command_outbox SET state = 'dispatched', attempt_id = $2, updated_at = clock_timestamp() WHERE run_id = $1 AND state = 'pending'", [id, attemptId]);
      if (!claim.rowCount) return null;
      const result = await client.query<RunRow>("UPDATE runs SET status = 'running', attempt_id = $2, updated_at = clock_timestamp() WHERE id = $1 RETURNING *", [id, attemptId]);
      const user = await client.query<MessageRow>('SELECT * FROM messages WHERE id = $1', [row.user_message_id]);
      const history = await client.query<MessageRow>("SELECT * FROM messages WHERE conversation_id = $1 AND order_no < $2 AND content <> '' ORDER BY order_no DESC LIMIT 100", [row.conversation_id, user.rows[0]!.order_no]);
      await client.query("UPDATE messages SET status = 'streaming' WHERE id = $1", [row.assistant_message_id]);
      await client.query("UPDATE agent_sessions SET state = 'running', updated_at = clock_timestamp() WHERE conversation_id = $1", [row.conversation_id]);
      const run = toRun(result.rows[0]!);
      await this.emit(client, row.conversation_id, 'run.updated', { run });
      return { run, attemptId, prompt: user.rows[0]!.content, history: history.rows.reverse().map((message) => ({ role: message.role, content: message.content })) };
    });
  }

  async updateAssistant(id: string, attemptId: string, text: string): Promise<void> {
    await transaction(this.pool, async (client) => {
      const row = await this.lockRun(client, id);
      if (row.attempt_id !== attemptId || !['running', 'cancelling'].includes(row.status)) return;
      const result = await client.query<MessageRow>("UPDATE messages SET content = $2, status = 'streaming' WHERE id = $1 AND content IS DISTINCT FROM $2 RETURNING *", [row.assistant_message_id, text]);
      if (!result.rows[0]) return;
      await client.query('UPDATE conversations SET updated_at = clock_timestamp() WHERE id = $1', [row.conversation_id]);
      await this.emit(client, row.conversation_id, 'message.updated', { message: toMessage(result.rows[0]) });
    });
  }

  private async finishLocked(client: PoolClient, row: RunRow, status: 'completed' | 'failed' | 'cancelled' | 'interrupted', text: string | null, errorCode: string | null): Promise<Run> {
    const result = await client.query<RunRow>('UPDATE runs SET status = $2, error_code = $3, updated_at = clock_timestamp() WHERE id = $1 RETURNING *', [row.id, status, status === 'cancelled' ? null : errorCode]);
    const message = await client.query<MessageRow>('UPDATE messages SET status = $2, content = COALESCE($3, content) WHERE id = $1 RETURNING *', [row.assistant_message_id, status, text]);
    await client.query("UPDATE command_outbox SET state = 'retired', updated_at = clock_timestamp() WHERE run_id = $1", [row.id]);
    await client.query("UPDATE agent_sessions SET state = $2, updated_at = clock_timestamp() WHERE conversation_id = $1", [row.conversation_id, status === 'interrupted' ? 'interrupted' : 'idle']);
    await client.query('UPDATE conversations SET updated_at = clock_timestamp() WHERE id = $1', [row.conversation_id]);
    const run = toRun(result.rows[0]!);
    await this.emit(client, row.conversation_id, 'run.updated', { run, message: toMessage(message.rows[0]!) });
    return run;
  }

  async finishRun(id: string, attemptId: string, status: 'completed' | 'failed' | 'cancelled' | 'interrupted', text: string, errorCode: string | null = null): Promise<void> {
    await transaction(this.pool, async (client) => {
      const row = await this.lockRun(client, id);
      if (row.attempt_id !== attemptId || !activeStatuses.includes(row.status)) return;
      await this.finishLocked(client, row, status, text, errorCode);
    });
  }

  async interruptAbandoned(): Promise<void> {
    const result = await this.pool.query<{ id: string }>('SELECT r.id FROM runs r JOIN conversations c ON c.id = r.conversation_id WHERE c.owner_id = $1 AND r.status = ANY($2::text[]) ORDER BY r.created_at', [this.config.ownerId, activeStatuses]);
    for (const { id } of result.rows) {
      await transaction(this.pool, async (client) => {
        const row = await this.lockRun(client, id);
        if (activeStatuses.includes(row.status)) await this.finishLocked(client, row, 'interrupted', null, 'RUN_INTERRUPTED');
      });
    }
  }

  async events(conversationId: string, after: number, limit = 128): Promise<ChatEvent[]> {
    return transaction(this.pool, async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      const conversation = await this.conversation(client, conversationId);
      const current = Number(conversation.event_sequence);
      if (after > current) throw new AppError('RESYNC_REQUIRED', 409);
      const result = await client.query<EventRow>('SELECT * FROM conversation_events WHERE conversation_id = $1 AND sequence > $2 ORDER BY sequence LIMIT $3', [conversationId, after, limit]);
      if (after < current && (!result.rows[0] || Number(result.rows[0].sequence) !== after + 1)) throw new AppError('RESYNC_REQUIRED', 409);
      let expected = after + 1;
      return result.rows.map((row) => {
        const sequence = Number(row.sequence);
        if (sequence !== expected++) throw new AppError('RESYNC_REQUIRED', 409);
        return { id: row.id, conversationId: row.conversation_id, sequence, type: row.type, payload: row.payload };
      });
    });
  }
}
