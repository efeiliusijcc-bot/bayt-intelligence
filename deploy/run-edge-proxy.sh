#!/usr/bin/env bash
set -euo pipefail

app_root="${BAYT_APP_ROOT:-/opt/bayt-intelligence}"
public_port="${BAYT_EDGE_PORT:-8443}"
container_name="bayt-intelligence-edge"
network_name="bayt-intelligence-net"
edge_image="${BAYT_EDGE_IMAGE:-nginxinc/nginx-unprivileged@sha256:c97ff0bf7cbae369953c6da1232ec14ad9f971d66360c5698db0856a4cd657a0}"
project_label="bayt-intelligence"

test -f "${app_root}/current/deploy/edge-nginx.conf"
test -f "${app_root}/edge/certs/cert.pem"
test -f "${app_root}/edge/certs/key.pem"
docker network inspect "${network_name}" >/dev/null
docker container inspect bayt-intelligence >/dev/null
docker container inspect bayt-collector-worker >/dev/null
docker image inspect "${edge_image}" >/dev/null

if docker container inspect "${container_name}" >/dev/null 2>&1; then
  if [ "$(docker inspect -f '{{ index .Config.Labels "com.bayt.project" }}' "${container_name}")" != "${project_label}" ]; then
    printf 'refusing to replace unowned container: %s\n' "${container_name}" >&2
    exit 3
  fi
  docker stop --time 20 "${container_name}" >/dev/null
  docker rm "${container_name}" >/dev/null
fi

if ss -ltnH | awk '{print $4}' | grep -Eq ":${public_port}$"; then
  printf 'public port is already in use: %s\n' "${public_port}" >&2
  exit 4
fi

docker run -d \
  --name "${container_name}" \
  --hostname "${container_name}" \
  --network "${network_name}" \
  --label "com.bayt.project=${project_label}" \
  --memory 128m \
  --memory-swap 128m \
  --cpus 0.20 \
  --restart unless-stopped \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=32m,uid=101,gid=101 \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --health-cmd "wget --no-check-certificate -qO- https://127.0.0.1:8443/api/health >/dev/null || exit 1" \
  --health-interval 30s \
  --health-timeout 5s \
  --health-start-period 10s \
  --health-retries 3 \
  -p "${public_port}:8443" \
  -v "${app_root}/current/deploy/edge-nginx.conf:/etc/nginx/nginx.conf:ro" \
  -v "${app_root}/edge/certs:/etc/nginx/edge-certs:ro" \
  --entrypoint nginx \
  "${edge_image}" \
  -g "daemon off;"
