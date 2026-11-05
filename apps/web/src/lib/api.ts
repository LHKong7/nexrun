import type { AgentProfile, AgentProfileInput, AgentBinding, AgentBindingInput, ContextManifest, Project, Workspace, WorkspaceSnapshot, WorkspaceWrite, WorkspaceDiff, ResourceItem, ResourceInput, ResourceUpdate, AcceptedMessage, AdminAccess, AdminSettings, AdminSettingsUpdate, ApiError, ChatSnapshot, Conversation, ConversationPage, CredentialCheck, Run, RuntimeConfig } from '@nexrun/protocol';

export type { AgentProfileInput } from '@nexrun/protocol';
export type AgentProfileView = AgentProfile;
export type AgentBindingView = AgentBinding;
export type AgentBindingUpdate = AgentBindingInput;
export interface ToolOperationView { id: string; name: string; args: unknown; result: unknown; errorCode: string | null; }

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
  runContext: (id: string, signal?: AbortSignal) => request<ContextManifest | null>(`/api/runs/${encodeURIComponent(id)}/context`, { signal }),
  runTools: (id: string, signal?: AbortSignal) => request<{ operations: ToolOperationView[] }>(`/api/runs/${encodeURIComponent(id)}/tools`, { signal }),
  agentProfiles: (signal?: AbortSignal) => request<{ profiles: AgentProfileView[] }>('/api/agent-profiles', { signal }),
  createAgentProfile: (profile: AgentProfileInput, token?: string) => request<AgentProfileView>('/api/agent-profiles', { method: 'POST', headers: adminHeaders(token), body: JSON.stringify(profile) }),
  updateAgentProfile: (id: string, profile: AgentProfileInput & { revision: number; archived?: boolean }, token?: string) => request<AgentProfileView>(`/api/agent-profiles/${encodeURIComponent(id)}`, { method: 'PATCH', headers: adminHeaders(token), body: JSON.stringify(profile) }),
  agentBinding: (id: string, signal?: AbortSignal) => request<AgentBindingView>(`/api/conversations/${encodeURIComponent(id)}/agent-binding`, { signal }),
  updateAgentBinding: (id: string, binding: AgentBindingUpdate, token?: string) => request<AgentBindingView>(`/api/conversations/${encodeURIComponent(id)}/agent-binding`, { method: 'PATCH', headers: adminHeaders(token), body: JSON.stringify(binding) }),
  projects: (signal?: AbortSignal) => request<{ projects: Project[] }>('/api/projects', { signal }),
  createProject: (name: string, token?: string) => request<Project>('/api/projects', { method: 'POST', headers: adminHeaders(token), body: JSON.stringify({ name }) }),
  updateProject: (id: string, change: { name?: string; archived?: boolean }, token?: string) => request<Project>(`/api/projects/${encodeURIComponent(id)}`, { method: 'PATCH', headers: adminHeaders(token), body: JSON.stringify(change) }),
  workspaces: (signal?: AbortSignal) => request<{ workspaces: Workspace[] }>('/api/workspaces', { signal }),
  createWorkspace: (name: string, projectId: string, token?: string) => request<Workspace>('/api/workspaces', { method: 'POST', headers: adminHeaders(token), body: JSON.stringify({ name, projectId }) }),
  updateWorkspace: (id: string, change: { name?: string; archived?: boolean }, token?: string) => request<Workspace>(`/api/workspaces/${encodeURIComponent(id)}`, { method: 'PATCH', headers: adminHeaders(token), body: JSON.stringify(change) }),
  workspaceFiles: (id: string, revision?: number, signal?: AbortSignal) => request<WorkspaceSnapshot>(`/api/workspaces/${encodeURIComponent(id)}/files${revision === undefined ? '' : `?revision=${revision}`}`, { signal }),
  writeWorkspaceFiles: (id: string, write: WorkspaceWrite, token?: string) => request<WorkspaceSnapshot>(`/api/workspaces/${encodeURIComponent(id)}/files`, { method: 'POST', headers: adminHeaders(token), body: JSON.stringify(write) }),
  workspaceDiff: (id: string, from: number, to: number, signal?: AbortSignal) => request<WorkspaceDiff>(`/api/workspaces/${encodeURIComponent(id)}/diff?from=${from}&to=${to}`, { signal }),
  resources: (kind: 'knowledge' | 'skill', signal?: AbortSignal) => request<{ items: ResourceItem[] }>(kind === 'skill' ? '/api/skills' : '/api/knowledge', { signal }),
  createResource: (kind: 'knowledge' | 'skill', input: ResourceInput, token?: string) => request<ResourceItem>(kind === 'skill' ? '/api/skills' : '/api/knowledge', { method: 'POST', headers: adminHeaders(token), body: JSON.stringify(input) }),
  updateResource: (kind: 'knowledge' | 'skill', id: string, update: ResourceUpdate, token?: string) => request<ResourceItem>(`${kind === 'skill' ? '/api/skills' : '/api/knowledge'}/${encodeURIComponent(id)}`, { method: 'PATCH', headers: adminHeaders(token), body: JSON.stringify(update) }),
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
