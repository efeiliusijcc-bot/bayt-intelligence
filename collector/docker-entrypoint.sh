#!/usr/bin/env bash
set -euo pipefail

cleanup() {
  jobs -pr | xargs -r kill 2>/dev/null || true
}
trap cleanup EXIT INT TERM

rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
Xvfb :99 -screen 0 1440x900x24 -nolisten tcp &
for _ in $(seq 1 50); do
  [ -S /tmp/.X11-unix/X99 ] && break
  sleep 0.1
done
fluxbox >/tmp/fluxbox.log 2>&1 &
x11vnc -display :99 -localhost -rfbport 5900 -forever -shared -nopw >/tmp/x11vnc.log 2>&1 &
websockify --web=/usr/share/novnc 6080 localhost:5900 >/tmp/novnc.log 2>&1 &

exec node --experimental-strip-types src/worker.ts
