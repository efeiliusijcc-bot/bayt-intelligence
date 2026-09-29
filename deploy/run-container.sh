#!/usr/bin/env bash
set -euo pipefail

release_tag="${1:?usage: run-container.sh <image-tag>}"
app_root="${BAYT_APP_ROOT:-/opt/bayt-intelligence}"
container_name="bayt-intelligence"
network_name="bayt-intelligence-net"
image_name="bayt-intelligence:${release_tag}"
project_label="bayt-intelligence"

test -f "${app_root}/.env"
test -d "${app_root}/data/published"
test -d "${app_root}/data/incoming"
install -d -m 0700 -o 1000 -g 1000 "${app_root}/runtime"
docker image inspect "${image_name}" >/dev/null

if ! docker network inspect "${network_name}" >/dev/null 2>&1; then
  docker network create --label "com.bayt.project=${project_label}" "${network_name}" >/dev/null 2>&1 \
    || docker network inspect "${network_name}" >/dev/null
elif [ "$(docker network inspect -f '{{ index .Labels "com.bayt.project" }}' "${network_name}")" != "${project_label}" ]; then
  printf 'refusing to reuse unowned network: %s\n' "${network_name}" >&2
  exit 3
fi

if docker container inspect "${container_name}" >/dev/null 2>&1; then
  if [ "$(docker inspect -f '{{ index .Config.Labels "com.bayt.project" }}' "${container_name}")" != "${project_label}" ]; then
    printf 'refusing to replace unowned container: %s\n' "${container_name}" >&2
    exit 3
  fi
  docker stop --time 20 "${container_name}" >/dev/null
  docker rm "${container_name}" >/dev/null
fi

docker run -d \
  --name "${container_name}" \
  --hostname "${container_name}" \
  --network "${network_name}" \
  --label "com.bayt.project=${project_label}" \
  --memory 512m \
  --memory-swap 512m \
  --cpus 0.50 \
  --restart unless-stopped \
  --init \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --env-file "${app_root}/.env" \
  -v "${app_root}/runtime:/app/runtime" \
  -v "${app_root}/data/published:/data:ro" \
  -v "${app_root}/data/incoming:/incoming:ro" \
  "${image_name}"
