CREATE TABLE projects (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  name text NOT NULL,
  archived_at timestamptz(3),
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX projects_owner ON projects(owner_id, created_at, id);

CREATE TABLE workspaces (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  project_id uuid NOT NULL REFERENCES projects(id),
  name text NOT NULL,
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  leased_run_id uuid REFERENCES runs(id),
  fencing_token integer NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  archived_at timestamptz(3),
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX workspaces_owner ON workspaces(owner_id, created_at, id);
CREATE TABLE workspace_revisions (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  revision integer NOT NULL CHECK (revision >= 0),
  files jsonb NOT NULL CHECK (jsonb_typeof(files) = 'array'),
  content_hash text NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, revision)
);
CREATE TABLE workspace_operations (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  operation_id text NOT NULL,
  request_hash text NOT NULL,
  result_revision integer NOT NULL,
  run_id uuid REFERENCES runs(id),
  fencing_token integer,
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, operation_id),
  FOREIGN KEY (workspace_id, result_revision) REFERENCES workspace_revisions(workspace_id, revision)
);
CREATE TABLE workspace_checkpoints (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  run_id uuid NOT NULL REFERENCES runs(id),
  revision integer NOT NULL,
  manifest jsonb NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (workspace_id, revision) REFERENCES workspace_revisions(workspace_id, revision)
);
CREATE INDEX workspace_checkpoints_latest ON workspace_checkpoints(workspace_id, created_at DESC, id DESC);

CREATE TABLE resource_items (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('knowledge', 'skill')),
  revision integer NOT NULL CHECK (revision >= 1),
  withdrawn_at timestamptz(3),
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX resource_items_owner ON resource_items(owner_id, kind, created_at, id);
CREATE TABLE resource_revisions (
  resource_id uuid NOT NULL REFERENCES resource_items(id),
  revision integer NOT NULL CHECK (revision >= 1),
  name text NOT NULL,
  content text NOT NULL,
  source text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('user', 'project', 'workspace')),
  project_id uuid REFERENCES projects(id),
  workspace_id uuid REFERENCES workspaces(id),
  required_tools jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(required_tools) = 'array'),
  license text,
  license_evidence text,
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (resource_id, revision),
  CHECK ((scope = 'user' AND project_id IS NULL AND workspace_id IS NULL)
    OR (scope = 'project' AND project_id IS NOT NULL AND workspace_id IS NULL)
    OR (scope = 'workspace' AND workspace_id IS NOT NULL AND project_id IS NULL))
);
