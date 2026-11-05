CREATE TABLE agent_profiles (
  id uuid PRIMARY KEY, owner_id text NOT NULL, revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  archived_at timestamptz(3), created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE agent_profile_revisions (
  profile_id uuid NOT NULL REFERENCES agent_profiles(id), revision integer NOT NULL CHECK (revision > 0),
  definition jsonb NOT NULL, created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY (profile_id, revision)
);
CREATE TABLE agent_bindings (
  conversation_id uuid PRIMARY KEY REFERENCES conversations(id), agent_instance_id uuid NOT NULL UNIQUE,
  profile_id uuid, profile_revision integer, workspace_id uuid,
  knowledge_ids jsonb NOT NULL DEFAULT '[]', skill_ids jsonb NOT NULL DEFAULT '[]',
  context_epoch integer NOT NULL DEFAULT 0, session_key uuid NOT NULL,
  scope_signature text, last_workspace_revision integer, updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (profile_id, profile_revision) REFERENCES agent_profile_revisions(profile_id, revision)
);
INSERT INTO agent_bindings (conversation_id, agent_instance_id, session_key) SELECT id, gen_random_uuid(), id FROM conversations;
CREATE TABLE agent_session_epochs (
  session_key uuid PRIMARY KEY, conversation_id uuid NOT NULL REFERENCES conversations(id), agent_instance_id uuid NOT NULL,
  context_epoch integer NOT NULL, native_reference jsonb, created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (agent_instance_id, context_epoch)
);
INSERT INTO agent_session_epochs (session_key, conversation_id, agent_instance_id, context_epoch)
SELECT session_key, conversation_id, agent_instance_id, context_epoch FROM agent_bindings;
ALTER TABLE runs ADD COLUMN execution_snapshot jsonb;
ALTER TABLE runs ADD COLUMN context_manifest jsonb;
ALTER TABLE runs ADD COLUMN native_reference jsonb;
ALTER TABLE agent_sessions ADD COLUMN agent_instance_id uuid;
ALTER TABLE agent_sessions ADD COLUMN context_epoch integer NOT NULL DEFAULT 0;
UPDATE agent_sessions s SET agent_instance_id = b.agent_instance_id FROM agent_bindings b WHERE b.conversation_id = s.conversation_id;
CREATE TABLE run_tool_operations (
  run_id uuid NOT NULL REFERENCES runs(id), operation_id text NOT NULL, name text NOT NULL,
  request_hash text NOT NULL, arguments jsonb NOT NULL, result jsonb, error_code text,
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY (run_id, operation_id)
);
