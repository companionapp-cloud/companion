-- Dynamic, per-chat model selection (PLAN §6.8). A provider config is now just an endpoint
-- plus credentials; the model is chosen at chat time (from a list fetched live from the
-- provider) and remembered on the chat itself. So drop the baked-in model from llm_configs
-- and record the picked model per chat.
ALTER TABLE llm_configs DROP COLUMN model;
ALTER TABLE chats ADD COLUMN model TEXT;
