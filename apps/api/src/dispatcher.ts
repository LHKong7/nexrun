import type { AgentAdapter } from './agents/types.js';
import type { ApiConfig } from './config.js';
import { ChatStore } from './store.js';

type AbortReason = 'cancelled' | 'timeout' | 'shutdown' | 'output_limit' | 'persistence';
interface ActiveExecution { controller: AbortController; reason?: AbortReason; done: Promise<void> }

export class Dispatcher {
  private readonly active = new Map<string, ActiveExecution>();
  private draining = false;
  private requested = false;
  private closed = false;

  constructor(private readonly store: ChatStore, private readonly adapter: AgentAdapter, private readonly config: ApiConfig, private readonly onPersistenceFailure?: () => void) {}

  get activeCount(): number { return this.active.size; }
  get busy(): boolean { return this.closed || this.draining || this.active.size > 0; }

  private failClosed(): void {
    this.closed = true;
    this.onPersistenceFailure?.();
  }

  wake(): void {
    if (this.closed) return;
    this.requested = true;
    if (!this.draining) void this.drain();
  }

  private async drain(): Promise<void> {
    this.draining = true;
    try {
      do {
        this.requested = false;
        const pending = await this.store.pendingRuns(Math.max(0, this.config.maxConcurrentRuns - this.active.size));
        for (const id of pending) {
          if (this.closed) break;
          const work = await this.store.startRun(id);
          if (!work) continue;
          const execution: ActiveExecution = { controller: new AbortController(), done: Promise.resolve() };
          if (this.closed) { execution.reason = 'shutdown'; execution.controller.abort(); }
          this.active.set(id, execution);
          execution.done = this.execute(work, execution).catch(() => {
            // Database failures leave durable active state for conservative reconciliation.
            // Never log prompts, provider responses, credentials, or raw exceptions here.
            this.failClosed();
          }).finally(() => { this.active.delete(id); this.wake(); });
        }
      } while (this.requested && !this.closed);
    } catch {
      // Stop admission instead of leaving an acknowledged but untracked Run live forever.
      // Restart reconciles persisted state and never blindly retries a model request.
      this.failClosed();
    } finally {
      this.draining = false;
    }
  }

  cancel(id: string): void {
    const execution = this.active.get(id);
    if (!execution || execution.controller.signal.aborted) return;
    execution.reason = 'cancelled';
    execution.controller.abort();
  }

  private async execute(work: NonNullable<Awaited<ReturnType<ChatStore['startRun']>>>, execution: ActiveExecution): Promise<void> {
    const { run, attemptId } = work;
    let text = '';
    let savedText = '';
    let acceptingText = true;
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    let persistenceError: unknown;
    let writes = Promise.resolve();
    const flush = (): Promise<void> => {
      if (savedText === text) return writes;
      const captured = text;
      savedText = captured;
      writes = writes.then(() => this.store.updateAssistant(run.id, attemptId, captured));
      return writes;
    };
    const abort = (reason: AbortReason): void => {
      if (execution.controller.signal.aborted) return;
      execution.reason = reason;
      execution.controller.abort();
    };
    const timer = setTimeout(() => abort('timeout'), this.config.generationTimeoutMs);
    try {
      if ((await this.store.getRun(run.id)).status === 'cancelling') abort('cancelled');
      execution.controller.signal.throwIfAborted();
      // Adapters settle only after observing termination. Pi enforces a kill deadline
      // in its supervisor; do not release this slot merely because abort was requested.
      await this.adapter.generate({ conversationId: run.conversationId, runId: run.id, prompt: work.prompt, history: work.history, signal: execution.controller.signal }, async (cumulativeText) => {
          if (!acceptingText) return;
          if (cumulativeText.length > this.config.maxOutputCharacters) {
            text = cumulativeText.slice(0, this.config.maxOutputCharacters);
            acceptingText = false;
            abort('output_limit');
            return;
          }
          text = cumulativeText;
          if (!savedText) await flush();
          else if (!flushTimer) {
            flushTimer = setTimeout(() => {
              flushTimer = undefined;
              void flush().catch((error: unknown) => { persistenceError = error; abort('persistence'); });
            }, 75);
          }
      });
      acceptingText = false;
      if (persistenceError) throw persistenceError;
      await writes;
      if (execution.reason === 'timeout') await this.store.finishRun(run.id, attemptId, 'failed', text, 'GENERATION_TIMEOUT');
      else if (execution.reason === 'output_limit') await this.store.finishRun(run.id, attemptId, 'failed', text, 'OUTPUT_LIMIT_EXCEEDED');
      else await this.store.finishRun(run.id, attemptId, 'completed', text);
    } catch (error) {
      acceptingText = false;
      await writes.catch(() => undefined);
      const code = error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      const isAbort = error instanceof Error && error.name === 'AbortError';
      const allowedCodes = ['UPSTREAM_RATE_LIMITED', 'AGENT_NOT_CONFIGURED', 'UPSTREAM_ERROR', 'NATIVE_SESSION_UNAVAILABLE', 'GENERATION_TIMEOUT'];
      if (execution.reason === 'shutdown' || code === 'RUN_INTERRUPTED') await this.store.finishRun(run.id, attemptId, 'interrupted', text, 'RUN_INTERRUPTED');
      else if (execution.reason === 'cancelled' && (isAbort || !code)) await this.store.finishRun(run.id, attemptId, 'cancelled', text);
      else await this.store.finishRun(run.id, attemptId, 'failed', text, execution.reason === 'timeout' ? 'GENERATION_TIMEOUT' : execution.reason === 'output_limit' ? 'OUTPUT_LIMIT_EXCEEDED' : allowedCodes.includes(code) ? code : 'UPSTREAM_ERROR');
    } finally {
      acceptingText = false;
      clearTimeout(timer);
      if (flushTimer) clearTimeout(flushTimer);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const execution of this.active.values()) {
      if (!execution.controller.signal.aborted) {
        execution.reason = 'shutdown';
        execution.controller.abort();
      }
    }
    await this.adapter.dispose?.();
    while (this.draining) await new Promise((resolve) => setTimeout(resolve, 5));
    await Promise.allSettled([...this.active.values()].map((execution) => execution.done));
  }
}
