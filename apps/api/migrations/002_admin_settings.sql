CREATE TABLE admin_settings (
  owner_id text PRIMARY KEY,
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  adapter text NOT NULL CHECK (adapter IN ('mock', 'pi')),
  provider text NOT NULL DEFAULT 'openai' CHECK (provider = 'openai'),
  model text NOT NULL,
  response_language text NOT NULL DEFAULT 'auto' CHECK (response_language IN ('auto', 'en', 'zh-CN')),
  key_mode text NOT NULL DEFAULT 'inherit' CHECK (key_mode IN ('inherit', 'stored', 'disabled')),
  encrypted_api_key text,
  updated_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  CHECK ((key_mode = 'stored' AND encrypted_api_key IS NOT NULL)
    OR (key_mode IN ('inherit', 'disabled') AND encrypted_api_key IS NULL))
);

ALTER TABLE agent_sessions ADD COLUMN provider text CHECK (provider IS NULL OR provider = 'openai');
ALTER TABLE agent_sessions ADD COLUMN model text;
