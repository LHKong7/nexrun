import type { AcceptedMessage, AdminAccess, AdminSettings, AdminSettingsUpdate, ApiError, ChatSnapshot, Conversation, ConversationPage, CredentialCheck, Run, RuntimeConfig } from '@nexrun/protocol';

export class RequestError extends Error {
  readonly code: string;
  readonly status: number;
  readonly parameters?: Record<string, string | number>;
  constructor(code: string, status = 0, parameters?: Record<string, string | number>) {
    super(code);
    this.name = 'RequestError';
    this.code = code;
    this.status = status;
    this.parameters = parameters;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      credentials: 'same-origin',
      ...init,
      headers: { Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new RequestError('NETWORK_ERROR');
  }
  if (!response.ok) {
    let failure: ApiError | undefined;
    try { failure = await response.json() as ApiError; } catch { /* The response may be unavailable during a service restart. */ }
    throw new RequestError(failure?.error?.code ?? 'REQUEST_FAILED', response.status, failure?.error?.parameters);
  }
  return response.json() as Promise<T>;
}

const adminHeaders = (token?: string): Record<string, string> => token ? { Authorization: `Bearer ${token}` } : {};

export const api = {
  adminAccess: (signal?: AbortSignal) => request<AdminAccess>('/api/admin/access', { signal }),
  adminSettings: (token?: string, signal?: AbortSignal) => request<AdminSettings>('/api/admin/settings', { headers: adminHeaders(token), signal }),
  updateAdminSettings: (settings: AdminSettingsUpdate, token?: string, signal?: AbortSignal) => request<AdminSettings>('/api/admin/settings', { method: 'PATCH', headers: adminHeaders(token), body: JSON.stringify(settings), signal }),
  checkCredentials: (revision: number, token?: string, signal?: AbortSignal) => request<CredentialCheck>('/api/admin/connection-check', { method: 'POST', headers: adminHeaders(token), body: JSON.stringify({ revision }), signal }),
  config: (signal?: AbortSignal) => request<RuntimeConfig>('/api/config', { signal }),
  conversations: (cursor?: string, signal?: AbortSignal) => request<ConversationPage>(`/api/conversations?limit=30${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { signal }),
  createConversation: () => request<Conversation>('/api/conversations', { method: 'POST', body: '{}' }),
  updateConversation: (id: string, change: { title?: string; archived?: boolean }) => request<Conversation>(`/api/conversations/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(change) }),
  snapshot: (id: string, before?: number, signal?: AbortSignal) => request<ChatSnapshot>(`/api/conversations/${encodeURIComponent(id)}/messages?limit=40${before !== undefined ? `&before=${before}` : ''}`, { signal }),
  send: (id: string, content: string, key: string) => request<AcceptedMessage>(`/api/conversations/${encodeURIComponent(id)}/messages`, { method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify({ content }) }),
  cancel: (id: string) => request<Run>(`/api/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: '{}' }),
};
