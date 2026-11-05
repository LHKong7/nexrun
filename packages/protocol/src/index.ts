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
export type AgentMode = 'mock' | 'pi';
export type ResponseLanguage = 'auto' | 'en' | 'zh-CN';
export interface RuntimeConfig { adapter: AgentMode; configured: boolean; model: string | null; responseLanguage?: ResponseLanguage; }
export type CredentialSource = 'stored' | 'environment' | 'none';
export interface AdminAccess { requiresToken: boolean; localAccess: boolean; }
export interface ModelOption { id: string; name: string; }
export interface AdminSettings {
  revision: number;
  adapter: AgentMode;
  provider: 'openai';
  model: string;
  responseLanguage: ResponseLanguage;
  keyConfigured: boolean;
  keySource: CredentialSource;
  environmentKeyAvailable: boolean;
  updatedAt: string | null;
  activeRuns: number;
  models: ModelOption[];
}
export interface AdminSettingsUpdate {
  revision: number;
  adapter: AgentMode;
  provider: 'openai';
  model: string;
  responseLanguage: ResponseLanguage;
  keyAction: 'keep' | 'replace' | 'remove' | 'inherit';
  apiKey?: string;
}
export interface CredentialCheck {
  ok: boolean;
  code: 'CONNECTION_OK' | 'AGENT_NOT_CONFIGURED' | 'UPSTREAM_AUTHENTICATION_FAILED' | 'UPSTREAM_RATE_LIMITED' | 'MODEL_UNAVAILABLE' | 'UPSTREAM_ERROR' | 'NETWORK_ERROR';
  checkedAt: string;
  revision: number;
}
export type * from './foundations.js';
export type * from './resources.js';
