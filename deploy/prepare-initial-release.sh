#!/usr/bin/env bash
set -euo pipefail

source_root="${1:?usage: prepare-initial-release.sh <source-data-root>}"
app_root="${BAYT_APP_ROOT:-/opt/bayt-intelligence}"
published_root="${app_root}/data/published"
work_root="${app_root}/data/work"
release_id="initial-$(date -u +%Y%m%dT%H%M%SZ)"
release_root="${published_root}/releases/${release_id}"

test -f "${source_root}/collection.db"
test -d "${source_root}/candidates"
install -d -m 0700 "${work_root}" "${published_root}/releases" "${release_root}"
if [ ! -e "${work_root}/collection.db" ]; then
  sqlite3 "${source_root}/collection.db" ".backup '${work_root}/collection.db'"
fi
if [ ! -e "${work_root}/candidates" ]; then
  cp -a "${source_root}/candidates" "${work_root}/candidates"
fi
sqlite3 "${work_root}/collection.db" "PRAGMA journal_mode=WAL; PRAGMA integrity_check; SELECT 'work_candidates',COUNT(*) FROM candidates; SELECT 'work_documents',COUNT(*) FROM documents;"
sqlite3 "${source_root}/collection.db" ".backup '${release_root}/collection.db'"
cp -a "${source_root}/candidates" "${release_root}/candidates"
sqlite3 "${release_root}/collection.db" "PRAGMA journal_mode=DELETE; PRAGMA integrity_check; SELECT 'candidates',COUNT(*) FROM candidates; SELECT 'documents',COUNT(*) FROM documents;"
rm -f "${release_root}/collection.db-wal" "${release_root}/collection.db-shm"
sha256sum "${release_root}/collection.db" > "${release_root}/SHA256SUMS"
chown -R 1000:1000 "${work_root}" "${published_root}"
ln -sfn "releases/${release_id}" "${published_root}/current"
printf 'release_id=%s\n' "${release_id}"
