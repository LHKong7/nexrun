import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { FileToolName } from '@nexrun/protocol';
import type { WorkspaceOperation } from './sandbox.js';

const aliases: Record<FileToolName, string> = { 'file.list': 'file_list', 'file.read': 'file_read', 'file.search': 'file_search', 'file.write': 'file_write' };
export function workspaceToolAliases(names: FileToolName[]): string[] { return names.map(name => aliases[name]); }

/** Standard JSON Schema is accepted by the pinned SDK's tool argument validator. */
const schemas: Record<FileToolName, object> = {
  'file.list': { type: 'object', properties: { prefix: { type: 'string', maxLength: 240 } }, additionalProperties: false },
  'file.read': { type: 'object', properties: { path: { type: 'string', minLength: 1, maxLength: 240 } }, required: ['path'], additionalProperties: false },
  'file.search': { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 200 }, path: { type: 'string', maxLength: 240 } }, required: ['query'], additionalProperties: false },
  'file.write': { type: 'object', properties: { path: { type: 'string', minLength: 1, maxLength: 240 }, content: { type: 'string', maxLength: 65536 }, expectedRevision: { type: 'integer', minimum: 0 } }, required: ['path', 'content', 'expectedRevision'], additionalProperties: false },
};
const descriptions: Record<FileToolName, string> = {
  'file.list': 'List authorized text files in the assigned Workspace. Results include the current Workspace revision.',
  'file.read': 'Read one bounded text file from the assigned Workspace. Relative paths only.',
  'file.search': 'Search literal text in authorized Workspace files. Returns bounded matching lines.',
  'file.write': 'Write one text file in the assigned Workspace. expectedRevision must match the current revision returned by a prior tool; stale writes are rejected.',
};
export function createWorkspaceTools(names: FileToolName[], execute: (operation: WorkspaceOperation) => Promise<unknown>): ToolDefinition[] {
  if (new Set(names).size !== names.length || names.some(name => !Object.hasOwn(aliases, name))) throw Object.assign(new Error('TOOL_NOT_ALLOWED'), { code: 'TOOL_NOT_ALLOWED' });
  return names.map(name => ({
    name: aliases[name], label: aliases[name], description: descriptions[name],
    parameters: schemas[name] as ToolDefinition['parameters'], executionMode: 'sequential',
    async execute(id, args, signal) {
      if (signal?.aborted) throw Object.assign(new Error('RUN_CANCELLED'), { name: 'AbortError' });
      const result = await execute({ id, name, args: args as Record<string, unknown> });
      const text = JSON.stringify(result);
      if (Buffer.byteLength(text) > 64000) throw Object.assign(new Error('WORKSPACE_RESULT_LIMIT'), { code: 'WORKSPACE_RESULT_LIMIT' });
      return { content: [{ type: 'text', text }], details: undefined };
    },
  }));
}

/** Conservative byte estimate; includes serialized native history, prompt and tool declarations. */
export function assertContextBudget(messages: unknown, budget: number, reserve = 4096): { estimatedInputTokens: number; outputReserve: number; accounting: 'conservative-byte-estimate' } {
  const estimatedInputTokens = Buffer.byteLength(JSON.stringify(messages), 'utf8');
  if (!Number.isSafeInteger(budget) || budget < 4096 || estimatedInputTokens + reserve > budget) throw Object.assign(new Error('CONTEXT_LIMIT'), { code: 'CONTEXT_LIMIT' });
  return { estimatedInputTokens, outputReserve: reserve, accounting: 'conservative-byte-estimate' };
}
