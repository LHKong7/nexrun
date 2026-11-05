import type { AgentMode, ResponseLanguage } from './index.js';
import type { FileToolName } from './resources.js';

export interface AgentProfile {
  id: string; revision: number; name: string; instructions: string; adapter: AgentMode; provider: 'openai'; model: string;
  responseLanguage: ResponseLanguage; toolNames: FileToolName[]; archivedAt: string | null; createdAt: string; updatedAt: string;
}
export interface AgentProfileInput {
  name: string; instructions: string; adapter: AgentMode; model: string; responseLanguage: ResponseLanguage; toolNames: FileToolName[];
}
export interface AgentBinding {
  conversationId: string; agentInstanceId: string; profileId: string | null; profileRevision: number | null;
  workspaceId: string | null; knowledgeIds: string[]; skillIds: string[]; contextEpoch: number;
}
export interface AgentBindingInput {
  profileId: string | null; workspaceId: string | null; knowledgeIds: string[]; skillIds: string[]; expectedContextEpoch: number;
}
export interface ContextSource { id: string; revision: number; kind: 'knowledge' | 'skill'; name: string; source: string; }
export interface ContextManifest {
  agentInstanceId: string; contextEpoch: number; profileId: string | null; profileRevision: number | null;
  workspaceId: string | null; workspaceRevision: number | null; sources: ContextSource[];
  budget: { maximumInputBytes: number; accounting: 'conservative-bytes'; includesNativeHistory: true; outputReserve: number };
  omissions: string[];
}
export interface RunExecutionSnapshot {
  agentInstanceId: string; sessionKey: string; contextEpoch: number; profile: AgentProfile | null;
  adapter: AgentMode; provider: 'openai'; model: string; responseLanguage: ResponseLanguage;
  workspaceId: string | null; workspaceRevision: number | null; fencingToken: number | null;
  toolNames: FileToolName[]; roleInstructions: string; resourcesText: string; contextBudget: number;
  manifest: ContextManifest;
}
