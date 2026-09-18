-- Agents (PLAN-agents.md §1.1). A "provider" becomes an "agent": something you install.
-- llm_configs keeps its table name but gains the columns that describe how an agent runs
-- (runtime), which desktop hosts it (host_device_id, NULL for cloud/manual), where its CLI
-- binary lives, whether it may write, and — for cloud agents on an E2EE account — the API
-- key as an encrypted synced field. The table also starts syncing (entity type "agent").
ALTER TABLE llm_configs ADD COLUMN runtime        TEXT NOT NULL DEFAULT 'openai-compatible';
ALTER TABLE llm_configs ADD COLUMN host_device_id TEXT;
ALTER TABLE llm_configs ADD COLUMN host_name      TEXT;
ALTER TABLE llm_configs ADD COLUMN binary_path    TEXT;
ALTER TABLE llm_configs ADD COLUMN binary_version TEXT;
ALTER TABLE llm_configs ADD COLUMN allow_write    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE llm_configs ADD COLUMN api_key_enc    TEXT;
ALTER TABLE llm_configs ADD COLUMN settings_json  TEXT NOT NULL DEFAULT '{}';

-- Backfill the runtime from the legacy provider/base_url pair.
UPDATE llm_configs SET runtime = 'anthropic-api' WHERE provider = 'anthropic';
UPDATE llm_configs SET runtime = 'openai-api'
  WHERE provider = 'openai-compatible' AND base_url LIKE 'https://api.openai.com%';
UPDATE llm_configs SET runtime = 'ollama'
  WHERE provider = 'openai-compatible'
    AND (base_url LIKE 'http://localhost:11434%' OR base_url LIKE 'http://127.0.0.1:11434%');
-- Legacy device-scoped rows are claimed by this device on first launch (the bridge does it,
-- since SQL does not know the device id): see AgentsRepo.ClaimUnhosted.

-- Chats remember the CLI runtime's own session id so multi-turn resumes across processes.
ALTER TABLE chats ADD COLUMN agent_session_id TEXT;

-- Device identity persists across restarts and is shown in Settings › Sync.
ALTER TABLE sync_state ADD COLUMN device_name TEXT;
ALTER TABLE sync_state ADD COLUMN device_platform TEXT;
