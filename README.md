# Open Archiver AIO for Unraid

A single-container build of [Open Archiver](https://github.com/LogicLabs-OU/OpenArchiver), the self-hosted email archive, for Unraid. Everything Open Archiver needs runs inside one container under s6-overlay v3:

| Component | Version | Notes |
|---|---|---|
| Open Archiver (web UI, API, ingestion/indexing/scheduler workers) | latest upstream release | Built on the official `logiclabshq/open-archiver` image |
| PostgreSQL | 17 | scram-sha-256, loopback only |
| Valkey | Alpine package | Password protected, AOF persistence, `noeviction` (required by BullMQ) |
| Meilisearch | whatever upstream pins in its `docker-compose.yml` | Full-text search |
| Apache Tika | whatever upstream pins (server jar, no OCR) | Text from PDF, Office and other attachments |

## How updates work

A GitHub Actions workflow runs every day at 04:17 UTC. It builds a new image when:

- Open Archiver publishes a new release (the Meilisearch and Tika versions are read from that release's `docker-compose.yml`),
- the upstream image for the current release is rebuilt (for example a Node.js security rebuild), or
- it is Sunday (weekly refresh for Alpine security updates).

Each build is started, checked for a healthy status, restarted, and checked again before it is pushed. A broken build is never published.

Tags: `latest` and the Open Archiver version (for example `v0.6.2`). Pin the version tag if you want to update by hand.

## Install on Unraid

1. **Add the template.** In the Unraid terminal:
   ```bash
   mkdir -p /boot/config/plugins/dockerMan/templates-user
   curl -fsSL -o /boot/config/plugins/dockerMan/templates-user/my-open-archiver-aio.xml \
     https://raw.githubusercontent.com/SomeoneLis/open-archiver-aio-unraid/main/templates/open-archiver-aio.xml
   ```
2. **Create the container.** Docker > Add Container > Template: pick `open-archiver-aio`.
3. **Set APP_URL** to the exact address you will open, for example `http://192.168.1.10:3000`. Sign-in and uploads fail if it does not match.
4. **Check the three paths:**
   - Appdata (`/config`): database, search index, queue and keys. Keep it on the cache pool.
   - Archive Storage (`/data`): the archived mail itself. A user share on the array is fine.
   - Import Folder (`/imports`, read-only): where your PST files live.
5. **Apply**, wait for the container to show healthy (the first start takes a minute or two), open the Web UI and create the admin account.

## Importing PST files

1. Copy the PSTs into the import share (for example `/mnt/user/PST`).
2. In Open Archiver: Ingestion Sources > Create > **PST Import** > **Local Path**, and enter `/imports/<file>.pst`.
3. Import one small PST first and check that search finds text inside attachments before starting the rest.

Password-protected PSTs are not supported; remove the password in Outlook first.

## Back up `/config/keys`

The container generates its secrets on first start and keeps them in `/config/keys`:

| File | Used for |
|---|---|
| `storage-encryption.key` | Encrypting archived files. **Lose this and the archive cannot be read.** |
| `encryption.key` | Encrypting stored ingestion credentials |
| `jwt.secret`, `meili.key`, `pg.password`, `pg-super.password`, `valkey.password` | Internal services |

Copy this folder somewhere safe after the first start. To provide your own values instead, set `JWT_SECRET`, `ENCRYPTION_KEY`, `STORAGE_ENCRYPTION_KEY` or `MEILI_MASTER_KEY` before the first start.

## Meilisearch upgrades

A Meilisearch index only opens with the version that wrote it. When a new image ships a newer Meilisearch, the container handles it on start:

- `MEILI_UPGRADE_MODE=dumpless` (default): copies the index to `data.ms.backup-<old version>` and runs Meilisearch's dumpless upgrade.
- `MEILI_UPGRADE_MODE=rebuild`: moves the old index aside and starts empty. Then run **Admin > Index > Full rebuild** to rebuild it from the archive.

The search index can always be rebuilt from the archive, so neither path risks your mail. If a dumpless upgrade fails, switch to `rebuild` and restart.

## Settings

All Open Archiver environment variables can be added to the container as extra variables. The template exposes the common ones:

| Variable | Default | Purpose |
|---|---|---|
| `APP_URL` | (required) | Public URL; also used as `ORIGIN` |
| `STORAGE_ENCRYPTION` | `true` | Encrypt archived files at rest |
| `INGESTION_WORKER_CONCURRENCY` | `5` | Mailbox jobs at once |
| `INDEXING_WORKER_MAX_OLD_SPACE_MB` | `2048` | Indexing worker memory ceiling |
| `MEILI_MAX_INDEXING_MEMORY` | Meilisearch default | Cap Meilisearch indexing memory, e.g. `2GiB` |
| `MEILI_SCHEDULE_SNAPSHOT` | `86400` | Seconds between index snapshots |
| `TIKA_ENABLED` | `true` | Use Tika for attachment text |
| `TIKA_JAVA_OPTS` | `-Xmx1g` | Tika JVM options |
| `ENABLE_DELETION` | `false` | Allow deleting emails and sources |

The template sets `--stop-timeout 60` so PostgreSQL and Meilisearch shut down cleanly.

## Layout

```
Dockerfile                      Official Open Archiver image + PostgreSQL, Valkey, Meilisearch, Tika, s6
rootfs/etc/cont-init.d/         Secrets, PostgreSQL init and hardening, Meilisearch upgrade handling
rootfs/etc/services.d/          postgres, valkey, meilisearch, tika, open-archiver
rootfs/usr/local/bin/oa-healthcheck
.github/workflows/build.yml     Daily upstream check, build, smoke test, push to GHCR
templates/open-archiver-aio.xml Unraid template
```

## License

Open Archiver is licensed under AGPL-3.0 by LogicLabs OÜ. The packaging in this repository is also AGPL-3.0.
