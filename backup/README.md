# Backup container

Daily Postgres backup → gzip → S3-compatible upload (R2 / B2 / S3) → retention prune.
Runs forever via supercronic; one container is enough.

## Deploy in Coolify

1. **+ New Resource** in the same project as the BD and the scraper.
2. Type: **Application**, source: this repo (`AOcampo93/comboios_scrapper`), branch `main`.
3. **Base Directory**: `backup` (Coolify will use `backup/Dockerfile`).
4. Build Pack: **Dockerfile**.
5. **Connect to the BD network** the same way you did for the scraper, so it can reach `db:5432`.

## Environment variables

| Variable | Required | Example | Notes |
|----------|----------|---------|-------|
| `DATABASE_URL` | yes | `postgres://postgres:PW@db:5432/comboios` | Same value as the scraper. |
| `RCLONE_REMOTE` | yes | `r2:comboios-backups` | rclone remote name + bucket/path. |
| `RETENTION_DAYS` | no (default 30) | `30` | Files older than this are deleted. |
| `BACKUP_PREFIX` | no (default `comboios`) | `comboios` | Filename prefix in the bucket. |
| `TZ` | no | `Europe/Lisbon` | Timezone for cron evaluation; default is UTC. |

### rclone credentials

rclone reads its remote config from env vars too. For Cloudflare R2:

| Variable | Value |
|----------|-------|
| `RCLONE_CONFIG_R2_TYPE` | `s3` |
| `RCLONE_CONFIG_R2_PROVIDER` | `Cloudflare` |
| `RCLONE_CONFIG_R2_ACCESS_KEY_ID` | your R2 access key |
| `RCLONE_CONFIG_R2_SECRET_ACCESS_KEY` | your R2 secret |
| `RCLONE_CONFIG_R2_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` |
| `RCLONE_CONFIG_R2_REGION` | `auto` |

For Backblaze B2:

| Variable | Value |
|----------|-------|
| `RCLONE_CONFIG_R2_TYPE` | `b2` |
| `RCLONE_CONFIG_R2_ACCOUNT` | your B2 keyID |
| `RCLONE_CONFIG_R2_KEY` | your B2 applicationKey |

The remote is named `r2` in both cases by convention (whatever you set in
`RCLONE_REMOTE` must match the suffix in `RCLONE_CONFIG_<NAME>_*` vars).

Mark all credentials as **secret** in Coolify.

## Test the first backup manually

After deploying, exec into the container and trigger the script directly:

```bash
/app/run-backup.sh
```

You should see logs like:

```
[2026-05-01T03:30:00Z] backup: starting pg_dump
[2026-05-01T03:30:04Z] backup: dump complete, 412K (421888 bytes)
[2026-05-01T03:30:05Z] backup: uploading to r2:comboios-backups/
[2026-05-01T03:30:08Z] backup: pruning files older than 30d
[2026-05-01T03:30:08Z] backup: done
```

Verify the file exists in your bucket dashboard.

## Test a restore (do this BEFORE you trust the backup)

```bash
# Download a recent dump
rclone copy r2:comboios-backups/comboios-20260501T033000Z.dump.gz /tmp/

# Decompress
gunzip /tmp/comboios-20260501T033000Z.dump.gz

# Restore into a throwaway database
createdb -U postgres test_restore
pg_restore --dbname=postgres://postgres:PW@db/test_restore --no-owner --no-privileges /tmp/comboios-20260501T033000Z.dump

# Verify
psql -d test_restore -c "SELECT count(*) FROM train_snapshots;"

# Clean up
dropdb test_restore
```

Don't skip this step — an untested backup is not a backup.
