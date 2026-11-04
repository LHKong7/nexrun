export type RunStatus = 'queued' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type MessageStatus = 'pending' | 'streaming' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export interface Conversation { id: string; title: string; kind: 'direct'; createdAt: string; updatedAt: string; archivedAt: string | null; preview: string; activeRun: Run | null; }
export interface Message { id: string; conversationId: string; role: 'user' | 'assistant'; content: string; status: MessageStatus; order: number; createdAt: string; runId: string; }
export interface Run { id: string; conversationId: string; status: RunStatus; adapter: 'mock' | 'pi'; errorCode: string | null; createdAt: string; updatedAt: string; }
export interface ChatSnapshot { messages: Message[]; activeRun: Run | null; cursor: number; nextCursor: number | null; }
export interface ConversationPage { conversations: Conversation[]; nextCursor: string | null; }
export interface AcceptedMessage { userMessage: Message; assistantMessage: Message; run: Run; cursor: number; }
export interface ChatEvent { id: string; conversationId: string; sequence: number; type: 'message.accepted' | 'message.updated' | 'run.updated'; payload: { message?: Message; userMessage?: Message; assistantMessage?: Message; run?: Run }; }
export interface ApiError { error: { code: string; message: string; parameters?: Record<string, string | number> }; }
export interface RuntimeConfig { adapter: 'mock' | 'pi'; configured: boolean; model: string | null; }
