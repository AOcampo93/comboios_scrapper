# syntax=docker/dockerfile:1.7

# Daily Postgres backup container. Dumps the comboios database, gzips it, uploads
# to an S3-compatible bucket via rclone (R2 / B2 / S3 / etc.), and prunes old files
# according to RETENTION_DAYS. Runs forever via supercronic so a single Coolify
# Application resource is enough.

FROM alpine:3.20

# Postgres 16 client matches the timescale/timescaledb-ha:pg16 BD image. tzdata is
# needed for cron timezone handling. ca-certificates is required by rclone for HTTPS.
RUN apk add --no-cache \
    bash \
    postgresql16-client \
    rclone \
    tzdata \
    ca-certificates \
    curl

# supercronic: a cron implementation that respects container env vars (busybox crond
# does not by default), exits cleanly on SIGTERM, and logs to stdout.
ARG SUPERCRONIC_VERSION=0.2.29
RUN curl -fsSL "https://github.com/aptible/supercronic/releases/download/v${SUPERCRONIC_VERSION}/supercronic-linux-amd64" \
    -o /usr/local/bin/supercronic && \
    chmod +x /usr/local/bin/supercronic

WORKDIR /app
COPY run-backup.sh /app/run-backup.sh
COPY crontab /app/crontab
RUN chmod +x /app/run-backup.sh

CMD ["supercronic", "/app/crontab"]
