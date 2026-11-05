import type { FileToolName } from '@nexrun/protocol';

export interface AgentExecution {
  sessionKey: string;
  roleInstructions: string;
  resourcesText: string;
  toolNames: FileToolName[];
  contextBudget: number;
  contextEpoch: number;
}
export interface NativeSessionReference { id: string; file: string; version: number; sdkVersion: string }
export interface AgentInput {
  conversationId: string;
  runId: string;
  prompt: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  signal: AbortSignal;
  execution?: AgentExecution;
  toolExecutor?: (operation: { id: string; name: FileToolName; args: Record<string, unknown> }) => Promise<unknown>;
  onNativeSession?: (reference: NativeSessionReference) => Promise<void>;
}
export interface AgentAdapter {
  mode: 'mock' | 'pi';
  configured: boolean;
  model: string | null;
  generate(input: AgentInput, onText: (text: string) => Promise<void>): Promise<void>;
  reconcile?(): Promise<void>;
  dispose?(): Promise<void>;
}
