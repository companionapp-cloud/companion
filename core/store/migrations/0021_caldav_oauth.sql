-- OAuth calendar accounts (PLAN-caldav.md §9). auth_kind 'oauth-google' keeps its refresh token
-- where a password would be (credential_enc / credential_ref). oauth_client_id records which
-- OAuth client the token was issued to: a refresh token is useless with any other, and client ids
-- differ per platform, so a device checks this before trying to sync the account itself.
ALTER TABLE calendar_accounts ADD COLUMN oauth_client_id TEXT NOT NULL DEFAULT '';
