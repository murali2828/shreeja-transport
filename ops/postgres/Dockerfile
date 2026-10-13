# ops-kit Postgres image — the official image (or pgvector's) + pgBackRest for
# continuous WAL archiving and point-in-time recovery. Built by every tier's
# compose file (`build: ./ops/postgres`); only env + mounts differ per tier.
#
# Why a custom image: archive_command runs INSIDE the database container, so
# the backup tool has to live there. pgBackRest gives full/differential/
# incremental base backups, continuous WAL push, retention, verify/check, and
# restore --type=time to any second between the oldest full backup and the last
# archived WAL segment. Repo layout + retention: pgbackrest.conf; per-host
# extras (NAS repo2, S3 repo3, the repository cipher) go in conf.d/ (bind-mounted).
ARG BASE_IMAGE=postgres:16
FROM ${BASE_IMAGE}

# Debian-based images use apt; Alpine-based ones (postgres:16-alpine) use apk —
# keep the base the tier already runs on: moving an existing data directory
# between musl and glibc changes text collation and can corrupt indexes.
RUN if command -v apk >/dev/null 2>&1; then apk add --no-cache pgbackrest; \
    else apt-get update && apt-get install -y --no-install-recommends pgbackrest && rm -rf /var/lib/apt/lists/*; fi \
 && mkdir -p /var/log/pgbackrest /var/lib/pgbackrest /var/spool/pgbackrest /etc/pgbackrest/conf.d /backups /nas \
 && chown -R postgres:postgres /var/log/pgbackrest /var/lib/pgbackrest /var/spool/pgbackrest /etc/pgbackrest /backups /nas

COPY pgbackrest.conf /etc/pgbackrest/pgbackrest.conf
RUN chown postgres:postgres /etc/pgbackrest/pgbackrest.conf && chmod 640 /etc/pgbackrest/pgbackrest.conf
