#!/usr/bin/env bash
set -euo pipefail

public_ip="${1:?usage: create-edge-certificate.sh <public-ip>}"
app_root="${BAYT_APP_ROOT:-/opt/bayt-intelligence}"
script_directory=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
certificate_directory="${app_root}/edge/certs"

if [[ ! "${public_ip}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
  printf 'invalid IPv4 address\n' >&2
  exit 2
fi

install -d -m 0700 "${certificate_directory}"

if [ "${BAYT_ROTATE_CERT:-0}" != "1" ] \
  && [ -s "${certificate_directory}/cert.pem" ] \
  && [ -s "${certificate_directory}/key.pem" ]; then
  exit 0
fi

sed "s/__PUBLIC_IP__/${public_ip}/g" \
  "${script_directory}/edge-openssl.cnf" \
  > "${certificate_directory}/openssl.cnf"

openssl req -x509 -nodes -newkey rsa:3072 -days 365 \
  -config "${certificate_directory}/openssl.cnf" \
  -keyout "${certificate_directory}/key.pem" \
  -out "${certificate_directory}/cert.pem"

chown 101:101 "${certificate_directory}" \
  "${certificate_directory}/key.pem" \
  "${certificate_directory}/cert.pem"
chmod 0700 "${certificate_directory}"
chmod 0600 "${certificate_directory}/key.pem"
chmod 0644 "${certificate_directory}/cert.pem"
