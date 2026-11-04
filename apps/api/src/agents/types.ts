export interface AgentInput {
  conversationId: string;
  runId: string;
  prompt: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  signal: AbortSignal;
}
export interface AgentAdapter {
  mode: 'mock' | 'pi';
  configured: boolean;
  model: string | null;
  generate(input: AgentInput, onText: (text: string) => Promise<void>): Promise<void>;
  reconcile?(): Promise<void>;
  dispose?(): Promise<void>;
}
