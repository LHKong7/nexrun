import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { FileToolName } from '@nexrun/protocol';
import type { AgentAdapter, AgentInput } from './agents/types.js';
import type { ChatStore } from './store.js';
import { FoundationStore } from './foundations.js';
import { ResourceStore } from './resources.js';
import { AppError } from './errors.js';
import { transaction, TransactionCommitUnknownError } from './db.js';
import { ensureSandbox, executeSandboxedOperation, nativeRuntimeIdentity } from './agents/sandbox.js';

export type StartedRun = NonNullable<Awaited<ReturnType<ChatStore['startRun']>>>;
export type RunGenerator = (work: StartedRun, input: AgentInput, onText: (text: string) => Promise<void>) => Promise<void>;
export type SandboxOperation = { id: string; name: FileToolName; args: Record<string, unknown> };

/** The broker owns durable authority; the native worker receives only bounded file data. */
export class ExecutionBroker {
  constructor(private readonly pool: Pool, private readonly foundations: FoundationStore, private readonly resources: ResourceStore, private readonly onUncertainCommit?: () => void) {}

  async generate(work: StartedRun, input: AgentInput, onText: (text: string) => Promise<void>, adapter: AgentAdapter): Promise<void> {
    const scope = work.execution;
    if (!scope) return adapter.generate(input, onText);
    if (scope.workspaceId) {
      await ensureSandbox();
      scope.runtimeIdentity = await nativeRuntimeIdentity();
      const bound = await this.pool.query("UPDATE runs SET execution_snapshot=jsonb_set(execution_snapshot,'{runtimeIdentity}',$2::jsonb) WHERE id=$1 AND attempt_id=$3 AND status='running'", [work.run.id, JSON.stringify(scope.runtimeIdentity), work.attemptId]);
      if (!bound.rowCount) throw new AppError('RUN_INTERRUPTED', 409);
      await this.foundations.restoreNativeCheckpoint(scope);
    }
    const controller = new AbortController();
    const signal = AbortSignal.any([input.signal, controller.signal]);
    let uncertain = false;
    let operations = Promise.resolve<unknown>(undefined);
    const toolExecutor = (operation: SandboxOperation): Promise<unknown> => {
      const next = operations.then(() => this.operate(work, signal, operation)).catch(error => {
        if (error instanceof TransactionCommitUnknownError) {
          uncertain = true;
          controller.abort();
          this.onUncertainCommit?.();
        }
        throw error;
      });
      operations = next.catch(() => undefined);
      return next;
    };
    try {
      await adapter.generate({ ...input, signal, execution: { sessionKey: scope.sessionKey, contextEpoch: scope.contextEpoch, roleInstructions: scope.roleInstructions,
        resourcesText: scope.resourcesText, toolNames: scope.toolNames, contextBudget: scope.contextBudget },
        toolExecutor, onNativeSession: reference => this.foundations.recordNative(work.run.id, reference) }, onText);
    } finally {
      // Adapter completion cannot release a lease while an issued tool is still settling.
      await operations;
      if (uncertain) throw new AppError('RUN_INTERRUPTED', 503);
    }
  }

  private async operate(work: StartedRun, signal: AbortSignal, operation: SandboxOperation): Promise<unknown> {
    signal.throwIfAborted();
    const scope = work.execution;
    if (!scope?.workspaceId || !scope.toolNames.includes(operation.name)) throw new AppError('TOOL_NOT_ALLOWED', 403);
    if (typeof operation.id !== 'string' || !operation.id || operation.id.length > 256 || Buffer.byteLength(JSON.stringify(operation.args)) > 70_000) throw new AppError('VALIDATION_ERROR', 400);
    const requestHash = createHash('sha256').update(JSON.stringify({ name: operation.name, args: operation.args })).digest('hex');
    return transaction(this.pool, async client => {
      const run = await client.query<{ status: string; attempt_id: string | null }>('SELECT status,attempt_id FROM runs WHERE id=$1 FOR UPDATE', [work.run.id]);
      if (run.rows[0]?.status !== 'running' || run.rows[0].attempt_id !== work.attemptId) throw new AppError('STALE_EXECUTION', 409);
      await this.resources.assertLease(client, scope.workspaceId!, work.run.id, scope.fencingToken!);
      const previous = await client.query<{ request_hash: string; result: unknown }>('SELECT request_hash,result FROM run_tool_operations WHERE run_id=$1 AND operation_id=$2', [work.run.id, operation.id]);
      if (previous.rows[0]) {
        if (previous.rows[0].request_hash !== requestHash) throw new AppError('IDEMPOTENCY_CONFLICT', 409);
        return previous.rows[0].result;
      }
      const files = await this.resources.readRevision(scope.workspaceId!, undefined, client);
      if (operation.name === 'file.write' && operation.args.expectedRevision !== files.revision) throw new AppError('WORKSPACE_CONFLICT', 409);
      const output = await executeSandboxedOperation(files.files, operation, { signal });
      signal.throwIfAborted();
      let revision = files.revision;
      if (operation.name === 'file.write') {
        const path = operation.args.path as string;
        const content = operation.args.content as string | null;
        const operationId = createHash('sha256').update(JSON.stringify([work.run.id, operation.id])).digest('hex');
        const changed = await this.resources.writeFiles({ workspaceId: scope.workspaceId!, expectedRevision: revision, operationId, files: [{ path, content }], runId: work.run.id, fencingToken: scope.fencingToken! }, client);
        revision = changed.revision;
      }
      const result = { revision, result: output.result };
      await client.query('INSERT INTO run_tool_operations(run_id,operation_id,name,request_hash,arguments,result) VALUES($1,$2,$3,$4,$5,$6)', [work.run.id, operation.id, operation.name, requestHash, operation.args, result]);
      return result;
    });
  }
}
