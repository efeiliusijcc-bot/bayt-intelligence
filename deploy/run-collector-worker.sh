#!/usr/bin/env bash
set -euo pipefail

release_tag="${1:?usage: run-collector-worker.sh <image-tag>}"
app_root="${BAYT_APP_ROOT:-/opt/bayt-intelligence}"
container_name="bayt-collector-worker"
network_name="bayt-intelligence-net"
project_label="bayt-intelligence"
image_name="bayt-collector:${release_tag}"
profile_volume="bayt-intelligence-collector-profile"
control_volume="bayt-intelligence-collector-control"

test -f "${app_root}/.env"
test -d "${app_root}/data/work"
test -d "${app_root}/data/published"
docker image inspect "${image_name}" >/dev/null
chown -R 1000:1000 "${app_root}/data/work" "${app_root}/data/published"

if ! docker network inspect "${network_name}" >/dev/null 2>&1; then
  docker network create --label "com.bayt.project=${project_label}" "${network_name}" >/dev/null
elif [ "$(docker network inspect -f '{{ index .Labels "com.bayt.project" }}' "${network_name}")" != "${project_label}" ]; then
  printf 'refusing to reuse unowned network: %s\n' "${network_name}" >&2
  exit 3
fi

for volume in "${profile_volume}" "${control_volume}"; do
  if ! docker volume inspect "${volume}" >/dev/null 2>&1; then
    docker volume create --label "com.bayt.project=${project_label}" "${volume}" >/dev/null
  elif [ "$(docker volume inspect -f '{{ index .Labels "com.bayt.project" }}' "${volume}")" != "${project_label}" ]; then
    printf 'refusing to reuse unowned volume: %s\n' "${volume}" >&2
    exit 3
  fi
done

if docker container inspect "${container_name}" >/dev/null 2>&1; then
  if [ "$(docker inspect -f '{{ index .Config.Labels "com.bayt.project" }}' "${container_name}")" != "${project_label}" ]; then
    printf 'refusing to replace unowned container: %s\n' "${container_name}" >&2
    exit 3
  fi
  docker stop --time 30 "${container_name}" >/dev/null
  docker rm "${container_name}" >/dev/null
fi

docker run -d \
  --name "${container_name}" \
  --hostname "${container_name}" \
  --network "${network_name}" \
  --label "com.bayt.project=${project_label}" \
  --restart unless-stopped \
  --init \
  --memory 3g \
  --memory-swap 3g \
  --cpus 1.50 \
  --pids-limit 512 \
  --shm-size 1g \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --env-file "${app_root}/.env" \
  -v "${app_root}/data/work:/data/work" \
  -v "${app_root}/data/published:/published" \
  -v "${profile_volume}:/profile" \
  -v "${control_volume}:/control" \
  "${image_name}"
