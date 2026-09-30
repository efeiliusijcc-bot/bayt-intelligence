#!/usr/bin/env bash
set -euo pipefail

# HTTPS domain entry for an existing edge proxy. All deployment-specific values
# must be provided by the operator; no public host or server path is embedded.
: "${BAYT_PUBLIC_HOST:?set BAYT_PUBLIC_HOST}"
: "${BAYT_EDGE_UPSTREAM:?set BAYT_EDGE_UPSTREAM as an https URL}"
: "${BAYT_EDGE_TLS_NAME:?set BAYT_EDGE_TLS_NAME to the upstream certificate name}"
: "${BAYT_CADDYFILE:?set BAYT_CADDYFILE to the absolute Caddyfile path}"
: "${BAYT_EDGE_CA_CERT:?set BAYT_EDGE_CA_CERT to the upstream CA certificate path}"
: "${BAYT_CADDY_STATE_DIR:?set BAYT_CADDY_STATE_DIR to an absolute writable directory}"
: "${BAYT_DOCKER_NETWORK:?set BAYT_DOCKER_NETWORK}"
: "${BAYT_CADDY_IMAGE:?set BAYT_CADDY_IMAGE to a pinned Caddy image}"

container_name="${BAYT_CADDY_CONTAINER:-bayt-domain-edge}"
project_label="bayt-intelligence"

[[ "$BAYT_PUBLIC_HOST" =~ ^[A-Za-z0-9.-]+$ ]] || { echo 'invalid BAYT_PUBLIC_HOST' >&2; exit 2; }
[[ "$BAYT_EDGE_UPSTREAM" =~ ^https://[A-Za-z0-9._:-]+$ ]] || { echo 'BAYT_EDGE_UPSTREAM must be an https origin without a path' >&2; exit 2; }
[[ "$BAYT_EDGE_TLS_NAME" =~ ^[A-Za-z0-9.-]+$ ]] || { echo 'invalid BAYT_EDGE_TLS_NAME' >&2; exit 2; }
for value in "$BAYT_CADDYFILE" "$BAYT_EDGE_CA_CERT" "$BAYT_CADDY_STATE_DIR"; do
  [[ "$value" = /* ]] || { echo 'Caddy file, CA certificate and state directory must use absolute paths' >&2; exit 2; }
done
test -f "$BAYT_CADDYFILE"
test -f "$BAYT_EDGE_CA_CERT"
docker network inspect "$BAYT_DOCKER_NETWORK" >/dev/null
docker image inspect "$BAYT_CADDY_IMAGE" >/dev/null
install -d -m 0700 "$BAYT_CADDY_STATE_DIR/data" "$BAYT_CADDY_STATE_DIR/config"

# Validate configuration before touching an existing managed container.
docker run --rm \
  -e BAYT_PUBLIC_HOST -e BAYT_EDGE_UPSTREAM -e BAYT_EDGE_TLS_NAME \
  -v "$BAYT_CADDYFILE:/etc/caddy/Caddyfile:ro" \
  -v "$BAYT_EDGE_CA_CERT:/etc/caddy/edge-ca.pem:ro" \
  "$BAYT_CADDY_IMAGE" validate --config /etc/caddy/Caddyfile >/dev/null

previous_name=""
restore_previous() {
  if docker container inspect "$container_name" >/dev/null 2>&1; then
    owner="$(docker inspect -f '{{ index .Config.Labels "com.bayt.project" }}' "$container_name")"
    [[ "$owner" == "$project_label" ]] || { echo 'replacement name is occupied by an unowned container' >&2; return 1; }
    docker rm -f "$container_name" >/dev/null
  fi
  if [[ -n "$previous_name" ]]; then
    docker rename "$previous_name" "$container_name"
    docker start "$container_name" >/dev/null
  fi
}

if docker container inspect "$container_name" >/dev/null 2>&1; then
  owner="$(docker inspect -f '{{ index .Config.Labels "com.bayt.project" }}' "$container_name")"
  if [[ "$owner" != "$project_label" ]]; then
    printf 'refusing to replace unowned container: %s\n' "$container_name" >&2
    exit 3
  fi
  previous_name="${container_name}-previous-$(date +%Y%m%d%H%M%S)"
  docker stop --time 20 "$container_name" >/dev/null
  docker rename "$container_name" "$previous_name"
fi

if ! docker run -d \
  --name "$container_name" \
  --network "$BAYT_DOCKER_NETWORK" \
  --label "com.bayt.project=$project_label" \
  --restart unless-stopped \
  --memory 128m --memory-swap 128m --cpus 0.20 \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=32m \
  --cap-drop ALL --cap-add NET_BIND_SERVICE \
  -p 80:80 -p 443:443 \
  -e BAYT_PUBLIC_HOST -e BAYT_EDGE_UPSTREAM -e BAYT_EDGE_TLS_NAME \
  -v "$BAYT_CADDYFILE:/etc/caddy/Caddyfile:ro" \
  -v "$BAYT_EDGE_CA_CERT:/etc/caddy/edge-ca.pem:ro" \
  -v "$BAYT_CADDY_STATE_DIR/data:/data" \
  -v "$BAYT_CADDY_STATE_DIR/config:/config" \
  "$BAYT_CADDY_IMAGE"; then
  restore_previous
  exit 4
fi

sleep 2
if [[ "$(docker inspect -f '{{ .State.Running }}' "$container_name")" != "true" ]]; then
  restore_previous
  echo 'new Caddy container exited during startup' >&2
  exit 5
fi

if [[ -n "$previous_name" ]]; then
  printf 'previous container retained for rollback: %s\n' "$previous_name"
fi
