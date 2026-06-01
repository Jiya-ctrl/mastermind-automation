#!/usr/bin/env bash
# ----------------------------------------------------------------------
# backup-data.sh — snapshot the operator data/ directory.
#
# Backs up everything stateful (auth.json, deliveries.json, recipients,
# audit log, template config override) as a single timestamped tarball.
# Generated media in output/ is NOT included — those are reproducible
# from the connected sheet + templates, and would balloon the backup.
#
# Designed to be called from cron on the production VPS:
#     0 3 * * * /opt/mastermind-automation/scripts/backup-data.sh
#
# Tunables via environment variables:
#     BACKUP_DIR     — where to write tarballs (default /root/backups)
#     RETAIN_DAYS    — delete tarballs older than this (default 30)
#     PROJECT_ROOT   — repo location (default /opt/mastermind-automation)
# ----------------------------------------------------------------------
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/root/backups}"
RETAIN_DAYS="${RETAIN_DAYS:-30}"
PROJECT_ROOT="${PROJECT_ROOT:-/opt/mastermind-automation}"

mkdir -p "$BACKUP_DIR"

if [ ! -d "$PROJECT_ROOT/data" ]; then
  echo "[backup-data] ERROR: $PROJECT_ROOT/data not found" >&2
  exit 1
fi

STAMP="$(date +%Y-%m-%d-%H%M)"
ARCHIVE="$BACKUP_DIR/mm-data-$STAMP.tar.gz"

# Tar the data dir relative to the repo root so restore is `tar xzf ... -C repo/`
tar czf "$ARCHIVE" -C "$PROJECT_ROOT" data/

SIZE=$(du -h "$ARCHIVE" | awk '{print $1}')
echo "[backup-data] wrote $ARCHIVE ($SIZE)"

# Prune old backups
DELETED=$(find "$BACKUP_DIR" -name 'mm-data-*.tar.gz' -mtime "+$RETAIN_DAYS" -print -delete | wc -l)
[ "$DELETED" -gt 0 ] && echo "[backup-data] pruned $DELETED tarballs older than $RETAIN_DAYS days"

# Optional: log to syslog so cron output isn't lost
command -v logger >/dev/null && logger -t mm-backup "wrote $ARCHIVE ($SIZE), pruned $DELETED"
