-- Runs once on first Postgres init (docker-entrypoint-initdb.d). Creates a separate
-- database for the server's e2e test suite so tests never touch the dev database.
-- Re-created by `make db-reset` (down -v). Owned by POSTGRES_USER.
CREATE DATABASE companion_test;
