import { setTimeout as delay } from 'node:timers/promises';
import type { AgentAdapter } from './types.js';

export function createMockAdapter(): AgentAdapter {
  return {
    mode: 'mock',
    configured: true,
    model: null,
    async generate(input, onText) {
      const previous = input.history.filter((message) => message.role === 'user').at(-1)?.content;
      const text = input.prompt.startsWith('/slow')
        ? `This is a deliberately slow mock response. ${'Streaming remains active until completed or stopped. '.repeat(10)}`
        : `Mock response: ${input.prompt}${previous ? `\n\nPrevious message in this conversation: ${previous}` : ''}\n\n\`\`\`typescript\nconsole.log('Hello from NexRun');\n\`\`\``;
      if (input.prompt.startsWith('/error')) {
        await onText('Partial mock response before the simulated error.');
        throw Object.assign(new Error('Mock upstream failure.'), { code: 'UPSTREAM_ERROR' });
      }
      const step = input.prompt.startsWith('/slow') ? 5 : 12;
      for (let offset = step; offset < text.length + step; offset += step) {
        input.signal.throwIfAborted();
        await delay(input.prompt.startsWith('/slow') ? 50 : 12, undefined, { signal: input.signal });
        await onText(text.slice(0, Math.min(offset, text.length)));
      }
    },
  };
}
