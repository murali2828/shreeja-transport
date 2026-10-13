# Tiny helper image used by ops/bin/backup.sh to copy Docker VOLUMES
# (the uploads volume) to the NAS incrementally, to run the off-box copies
# (rsync to an NFS NAS / lftp mirror to an FTP NAS — as root, because the
# pgBackRest repository is owned by the Postgres container's user and not
# readable by the deploy login), and to (de)crypt the config bundle — without
# needing rsync/openssl/lftp as root on the host. Built once by the script
# (`docker build -t <slug>-backup-tools ops/tools`); rebuilt
# automatically when this file changes (the script tags the image with a hash).
FROM alpine:3.20
RUN apk add --no-cache rsync openssl tar coreutils lftp
