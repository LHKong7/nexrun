import { setTimeout as delay } from 'node:timers/promises';
import { buildMockScenario } from './mock-scenarios.js';
import type { AgentAdapter } from './types.js';
import type { ResponseLanguage } from '@nexrun/protocol';

export function createMockAdapter(options: { responseLanguage?: ResponseLanguage } = {}): AgentAdapter {
  return {
    mode: 'mock',
    configured: true,
    model: null,
    async generate(input, onText) {
      input.signal.throwIfAborted();
      const scenario = buildMockScenario(input.prompt, input.history, options.responseLanguage);
      const characters = Array.from(scenario.text);
      for (let offset = scenario.chunkSize; offset < characters.length + scenario.chunkSize; offset += scenario.chunkSize) {
        input.signal.throwIfAborted();
        await delay(scenario.intervalMs, undefined, { signal: input.signal });
        input.signal.throwIfAborted();
        await onText(characters.slice(0, Math.min(offset, characters.length)).join(''));
      }
      if (scenario.failureCode) {
        input.signal.throwIfAborted();
        throw Object.assign(new Error('Mock upstream failure.'), { code: scenario.failureCode });
      }
    },
  };
}
