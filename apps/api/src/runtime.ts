import type { AgentAdapter, AgentInput } from './agents/types.js';

/** Serialize configuration commits and admission without holding a lock for generation. */
export class AdmissionGate {
  private tail = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await operation(); }
    finally { release(); }
  }
}

/** Keep one stable dispatcher dependency while replacing an idle runtime. */
export class RuntimeAdapter implements AgentAdapter {
  constructor(private current: AgentAdapter) {}
  get mode() { return this.current.mode; }
  get configured() { return this.current.configured; }
  get model() { return this.current.model; }

  replace(next: AgentAdapter): AgentAdapter {
    const previous = this.current;
    this.current = next;
    return previous;
  }

  async generate(input: AgentInput, onText: (text: string) => Promise<void>): Promise<void> {
    const invocation = this.current;
    await invocation.generate(input, onText);
  }

  async reconcile(): Promise<void> { await this.current.reconcile?.(); }
  async dispose(): Promise<void> { await this.current.dispose?.(); }
}
