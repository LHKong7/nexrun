export interface Project {
  id: string;
  name: string;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface Workspace {
  id: string;
  projectId: string;
  name: string;
  revision: number;
  busy: boolean;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface WorkspaceFile { path: string; content: string; }
export interface WorkspaceFileChange { path: string; content: string | null; }
export interface WorkspaceSnapshot {
  workspaceId: string;
  revision: number;
  files: WorkspaceFile[];
  contentHash: string;
  createdAt: string;
}
export interface WorkspaceWrite {
  expectedRevision: number;
  operationId: string;
  files: WorkspaceFileChange[];
}
export interface WorkspaceLease {
  workspaceId: string;
  runId: string;
  fencingToken: number;
  revision: number;
}
export type ResourceKind = 'knowledge' | 'skill';
export type ResourceScope = 'user' | 'project' | 'workspace';
export type FileToolName = 'file.list' | 'file.read' | 'file.search' | 'file.write';
export interface ResourceItem {
  id: string;
  kind: ResourceKind;
  name: string;
  revision: number;
  content: string;
  source: string;
  scope: ResourceScope;
  projectId: string | null;
  workspaceId: string | null;
  requiredTools: FileToolName[];
  license: string | null;
  licenseEvidence: string | null;
  withdrawnAt: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface ResourceInput {
  name: string;
  content: string;
  source: string;
  scope: ResourceScope;
  projectId?: string | null;
  workspaceId?: string | null;
  requiredTools?: FileToolName[];
  license?: string | null;
  licenseEvidence?: string | null;
}
export interface ResourceUpdate extends ResourceInput { expectedRevision: number; withdrawn?: boolean; }
export interface ResourceReference { id: string; revision: number; }
export interface CheckpointManifest {
  workspaceRevision: number;
  nativeSessionRef: string | null;
  contextEpoch: number;
  profileRevision: number | null;
  resources: ResourceReference[];
  runtimeVersion: string;
  adapterVersion: string;
}
export interface WorkspaceCheckpoint {
  id: string;
  workspaceId: string;
  runId: string;
  manifest: CheckpointManifest;
  createdAt: string;
}
export interface WorkspaceDiff {
  workspaceId: string;
  fromRevision: number;
  toRevision: number;
  changes: Array<{ path: string; before: string | null; after: string | null }>;
}
