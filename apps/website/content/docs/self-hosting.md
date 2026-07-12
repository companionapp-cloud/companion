---
title: Hosting your own cloud
group: Companion Cloud & sync
groupIcon: refresh
groupOrder: 3
order: 2
excerpt: Run the sync server yourself.
badge: Companion Cloud
readTime: 4 min read
updated: Jul 2026
related: [using-our-cloud, app-wont-sync]
---

Companion is open source, and the sync server is a single Go binary. Run it yourself and the apps behave exactly as they do against our cloud — same encryption, same offline support, same everything. You're just the host.

## Run the server

The server ships as a container image:

```
docker run -p 8080:8080 \
  -e DATABASE_URL=postgres://user:pass@host:5432/companion \
  ghcr.io/chrisdmacrae/companion-server:latest
```

It listens on **8080** by default (`COMPANION_ADDR` to change it). For anything real, point `DATABASE_URL` at Postgres. Without it the server falls back to a local SQLite file, which is fine for a try-out on your laptop and not much else.

## File attachments

Attachments are stored as blobs, and by default they're held in memory — meaning they vanish when the container restarts. Give the server somewhere to put them:

- **S3-compatible** (S3, R2, B2, MinIO): set `BLOB_S3_BUCKET`, `BLOB_S3_ACCESS_KEY`, `BLOB_S3_SECRET_KEY`, `BLOB_S3_REGION`, and `BLOB_S3_ENDPOINT` for non-AWS providers.
- **Local disk**: set `BLOB_FS_DIR` to a mounted volume.

If you never attach files, you can skip this.

## Point your devices at it

In **Settings → Sync**, set the **Server URL** to your instance, then register an account there. That account is separate from any Companion Cloud account — it's your server, your users.

## What you don't get

Password reset lives in the hosted cloud, not the open-core server: there's no "forgot password" email flow on a self-hosted instance. Combined with end-to-end encryption, that means a lost password plus a lost [recovery code](/docs/using-our-cloud) is unrecoverable data. Tell your users to keep the code.

Billing, of course, is also absent. That one you're welcome to.

## Next steps

Not ready to run infrastructure? [Companion Cloud](/docs/using-our-cloud) gets you syncing in a click.
