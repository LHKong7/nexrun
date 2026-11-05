import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ResourceInput, ResourceKind, ResourceUpdate, WorkspaceWrite } from '@nexrun/protocol';
import { validation } from './errors.js';
import { ResourceStore } from './resources.js';

interface ResourceRouteOptions {
  store: ResourceStore;
  admission: { run<T>(operation: () => Promise<T>): Promise<T> };
  authorizeMutation?: (request: FastifyRequest) => void | Promise<void>;
}
function body(value: unknown, keys: string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) validation();
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some(k => !keys.includes(k))) validation();
  return object;
}
function at(value: unknown, fallback?: number): number | undefined {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 2_000_000_000) validation({ field: 'revision' });
  return Number(value);
}
const resourceKeys = ['name', 'content', 'source', 'scope', 'projectId', 'workspaceId', 'requiredTools', 'license', 'licenseEvidence'];

/** Routes retain the application's single server-derived owner and admission gate. */
export function registerResourceRoutes(app: FastifyInstance, options: ResourceRouteOptions): void {
  const { store, admission } = options;
  const mutate = async <T>(request: FastifyRequest, operation: () => Promise<T>): Promise<T> => {
    await options.authorizeMutation?.(request);
    return admission.run(operation);
  };
  app.get('/api/projects', async () => ({ projects: await store.listProjects() }));
  app.post('/api/projects', async (request, reply) => {
    const input = body(request.body, ['name']);
    const result = await mutate(request, () => store.createProject(input as unknown as { name: string }));
    return reply.code(201).send(result);
  });
  app.patch<{ Params: { id: string } }>('/api/projects/:id', async request => {
    const input = body(request.body, ['name', 'archived']);
    if (!Object.keys(input).length) validation();
    return mutate(request, () => store.patchProject(request.params.id, input));
  });
  app.get('/api/workspaces', async () => ({ workspaces: await store.listWorkspaces() }));
  app.post('/api/workspaces', async (request, reply) => {
    const input = body(request.body, ['name', 'projectId']);
    const result = await mutate(request, () => store.createWorkspace(input as unknown as { name: string; projectId: string }));
    return reply.code(201).send(result);
  });
  app.get<{ Params: { id: string } }>('/api/workspaces/:id', async request => store.getWorkspace(request.params.id));
  app.patch<{ Params: { id: string } }>('/api/workspaces/:id', async request => {
    const input = body(request.body, ['name', 'archived']);
    if (!Object.keys(input).length) validation();
    return mutate(request, () => store.patchWorkspace(request.params.id, input));
  });
  app.get<{ Params: { id: string }; Querystring: { revision?: string } }>('/api/workspaces/:id/files', async request => store.readRevision(request.params.id, at(request.query.revision)));
  app.post<{ Params: { id: string } }>('/api/workspaces/:id/files', async request => {
    const input = body(request.body, ['expectedRevision', 'operationId', 'files']);
    return mutate(request, () => store.importFiles({ ...(input as unknown as WorkspaceWrite), workspaceId: request.params.id }));
  });
  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string } }>('/api/workspaces/:id/diff', async request => store.diff(request.params.id, at(request.query.from, 0)!, at(request.query.to)));
  app.get<{ Params: { id: string } }>('/api/workspaces/:id/checkpoints', async request => ({ checkpoints: await store.listCheckpoints(request.params.id) }));
  for (const [path, kind] of [['knowledge', 'knowledge'], ['skills', 'skill']] as const) {
    app.get(`/api/${path}`, async () => ({ items: await store.listResources(kind) }));
    app.get<{ Params: { id: string } }>(`/api/${path}/:id`, async request => store.getResource(request.params.id, kind));
    app.post(`/api/${path}`, async (request, reply) => {
      const input = body(request.body, resourceKeys);
      const result = await mutate(request, () => store.createResource(kind as ResourceKind, input as unknown as ResourceInput));
      return reply.code(201).send(result);
    });
    app.patch<{ Params: { id: string } }>(`/api/${path}/:id`, async request => {
      const input = body(request.body, [...resourceKeys, 'expectedRevision', 'withdrawn']);
      return mutate(request, () => store.updateResource(request.params.id, kind as ResourceKind, input as unknown as ResourceUpdate));
    });
  }
}
