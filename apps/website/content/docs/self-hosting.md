---
title: Hosting your own cloud
group: Companion Cloud & sync
groupIcon: refresh
groupOrder: 3
order: 2
excerpt: Self-host sync on your own server.
badge: Companion Cloud
readTime: 4 min read
updated: Jul 2026
related: [using-our-cloud, getting-the-apps]
---

Because Companion is open source, you can run the sync server yourself and keep your data entirely under your own control.

## Run the server

The sync server ships as a single binary and a Docker image. Point it at a directory for storage, set a secret, and start it — no external database required.

```
docker run -p 8787:8787 -v ./data:/data companion/sync
```

## Connect your devices

In **Settings → Sync**, choose **Custom server** and enter your server's URL. Sign in, and every device syncs against your instance instead of Companion Cloud.

Everything else — encryption, offline support, conflict resolution — works identically. You're just the host now.

## Next steps

Not ready to self-host? [Companion Cloud](/docs/using-our-cloud) gets you syncing in a click.
