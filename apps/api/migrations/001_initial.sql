CREATE TABLE conversations (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  kind text NOT NULL DEFAULT 'direct' CHECK (kind = 'direct'),
  title text NOT NULL DEFAULT 'New chat',
  custom_title boolean NOT NULL DEFAULT false,
  archived_at timestamptz(3),
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  next_message_order integer NOT NULL DEFAULT 0,
  event_sequence bigint NOT NULL DEFAULT 0
);
CREATE INDEX conversations_recent ON conversations (owner_id, updated_at DESC, id DESC) WHERE archived_at IS NULL;

CREATE TABLE runs (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  user_message_id uuid NOT NULL,
  assistant_message_id uuid NOT NULL,
  adapter text NOT NULL CHECK (adapter IN ('mock', 'pi')),
  status text NOT NULL CHECK (status IN ('queued', 'running', 'cancelling', 'completed', 'failed', 'cancelled', 'interrupted')),
  request_key text NOT NULL,
  request_hash text NOT NULL,
  attempt_id uuid,
  error_code text,
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (conversation_id, request_key)
);
CREATE UNIQUE INDEX runs_one_active ON runs (conversation_id) WHERE status IN ('queued', 'running', 'cancelling');

CREATE TABLE messages (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  run_id uuid NOT NULL REFERENCES runs(id) DEFERRABLE INITIALLY DEFERRED,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL DEFAULT '',
  status text NOT NULL CHECK (status IN ('pending', 'streaming', 'completed', 'failed', 'cancelled', 'interrupted')),
  order_no integer NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (conversation_id, order_no)
);
ALTER TABLE runs ADD CONSTRAINT runs_user_message_fk FOREIGN KEY (user_message_id) REFERENCES messages(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE runs ADD CONSTRAINT runs_assistant_message_fk FOREIGN KEY (assistant_message_id) REFERENCES messages(id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE conversation_events (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  sequence bigint NOT NULL,
  type text NOT NULL CHECK (type IN ('message.accepted', 'message.updated', 'run.updated')),
  payload jsonb NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (conversation_id, sequence)
);

CREATE TABLE agent_sessions (
  conversation_id uuid PRIMARY KEY REFERENCES conversations(id),
  adapter text NOT NULL CHECK (adapter IN ('mock', 'pi')),
  native_session_ref text NOT NULL,
  persistence_location text,
  runtime_version text NOT NULL DEFAULT 'adapter-managed',
  state text NOT NULL DEFAULT 'idle' CHECK (state IN ('idle', 'running', 'interrupted')),
  updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE command_outbox (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL UNIQUE REFERENCES runs(id),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'dispatched', 'retired')),
  attempt_id uuid,
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp()
);
