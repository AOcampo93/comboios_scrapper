#!/bin/bash
# Daily Postgres backup → gzip → rclone upload → retention prune.
# Idempotent: if any step fails, exit non-zero so supercronic logs it as a failure.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL not set}"
: "${RCLONE_REMOTE:?RCLONE_REMOTE not set, e.g. r2:comboios-backups}"

RETENTION_DAYS="${RETENTION_DAYS:-30}"
BACKUP_PREFIX="${BACKUP_PREFIX:-comboios}"
TMP_DIR="${TMP_DIR:-/tmp}"

ts=$(date -u +%Y%m%dT%H%M%SZ)
dump_file="${TMP_DIR}/${BACKUP_PREFIX}-${ts}.dump.gz"

echo "[$(date -u +%FT%TZ)] backup: starting pg_dump"

# --format=custom is the binary, compressed, parallel-restorable format. We still
# gzip the result because custom format is only mildly compressed (~level 1).
pg_dump \
    --dbname="$DATABASE_URL" \
    --format=custom \
    --compress=1 \
    --no-owner \
    --no-privileges \
    | gzip -9 > "$dump_file"

size=$(stat -c %s "$dump_file" 2>/dev/null || stat -f %z "$dump_file")
size_human=$(du -h "$dump_file" | cut -f1)
echo "[$(date -u +%FT%TZ)] backup: dump complete, ${size_human} (${size} bytes)"

if [[ "$size" -lt 1024 ]]; then
    echo "[$(date -u +%FT%TZ)] backup: dump suspiciously small (<1 KiB) — aborting upload"
    rm -f "$dump_file"
    exit 1
fi

echo "[$(date -u +%FT%TZ)] backup: uploading to ${RCLONE_REMOTE}/"
rclone copy "$dump_file" "${RCLONE_REMOTE}/" --s3-no-check-bucket --quiet

echo "[$(date -u +%FT%TZ)] backup: pruning files older than ${RETENTION_DAYS}d"
rclone delete "${RCLONE_REMOTE}/" \
    --min-age "${RETENTION_DAYS}d" \
    --include "${BACKUP_PREFIX}-*.dump.gz" \
    --quiet

rm -f "$dump_file"
echo "[$(date -u +%FT%TZ)] backup: done"
