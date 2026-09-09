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

## Email: password reset and verification

The server sends two kinds of email: an address-confirmation link after sign-up, and the "forgot password" reset link. Both go out over SMTP; point it at any provider (or your own relay):

```
-e SMTP_HOST=smtp.example.com \
-e SMTP_PORT=587 \
-e SMTP_USERNAME=… \
-e SMTP_PASSWORD=… \
-e SMTP_FROM=no-reply@example.com \
-e COMPANION_PUBLIC_URL=https://sync.example.com
```

Port 465 uses implicit TLS; 587 and 25 upgrade with STARTTLS when the relay offers it. Set `COMPANION_PUBLIC_URL` to the address your users type into the app — the emailed links are built from it. Leave `SMTP_HOST` unset and nothing is sent; the server logs each link instead, which is handy while you're setting up.

The reset link opens a small page on your server that hands off to the Companion app, because an encrypted account's password can only be changed where the recovery code is: on the device. If you host the web app somewhere, set `COMPANION_APP_URL` to it so that hand-off opens your instance instead of the desktop or mobile app.

## Point your devices at it

In **Settings → Sync**, set the **Server URL** to your instance, then register an account there. That account is separate from any Companion Cloud account — it's your server, your users.

## What you don't get

Billing, the account portal, and the admin back-office are the hosted cloud's — the open-core server has no concept of plans or subscriptions, and no web UI; accounts are created from the app.

One thing worth telling your users: a password reset still needs the [recovery code](/docs/using-our-cloud). The server never holds the encryption key, so a lost password plus a lost recovery code is unrecoverable data, on your server exactly as on ours.

## Next steps

Not ready to run infrastructure? [Companion Cloud](/docs/using-our-cloud) gets you syncing in a click.
