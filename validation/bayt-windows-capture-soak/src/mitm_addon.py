from __future__ import annotations

import json
import os
import threading
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any

from mitmproxy import http

from capture_core import (
    SEARCH_RESULTS_PATH,
    candidate_summary,
    cloudflare_blocked,
    cookie_names,
    hmac_fingerprint,
    schema_hash,
    sha256_text,
)


OUTPUT_DIR = Path(os.environ["BAYT_VALIDATION_OUTPUT"])
HMAC_KEY = Path(os.environ["BAYT_HMAC_KEY_FILE"]).read_bytes()
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
_replay_started = False
_write_lock = threading.Lock()


def now_iso() -> str:
    import datetime

    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def write_json(name: str, payload: dict[str, Any]) -> None:
    target = OUTPUT_DIR / name
    temporary = target.with_suffix(target.suffix + ".tmp")
    with _write_lock:
        temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temporary, target)


def sanitized_headers(headers: Any) -> dict[str, str]:
    return {str(key).lower(): str(value) for key, value in headers.items()}


def session_metadata(headers: dict[str, str]) -> dict[str, Any]:
    cookie = headers.get("cookie", "")
    csrf_values = [value for name, value in headers.items() if "csrf" in name or "xsrf" in name]
    signature_values = [
        value
        for name, value in headers.items()
        if any(marker in name for marker in ("token", "signature", "action"))
    ]
    return {
        "cookie_names": cookie_names(cookie),
        "session_fingerprint": hmac_fingerprint(HMAC_KEY, [cookie]),
        "csrf_present": bool(csrf_values),
        "csrf_fingerprint": hmac_fingerprint(HMAC_KEY, csrf_values),
        "signature_header_names": sorted(
            name
            for name in headers
            if any(marker in name for marker in ("token", "signature", "action"))
        ),
        "signature_fingerprint": hmac_fingerprint(HMAC_KEY, signature_values),
        "raw_value_logged": False,
    }


def response_manifest(
    operation: str,
    status: int,
    content_type: str,
    headers: dict[str, str],
    body: bytes,
    request_headers: dict[str, str],
    started_at: float,
) -> dict[str, Any]:
    blocked = cloudflare_blocked(status, headers, body)
    payload: dict[str, Any] = {
        "experiment_id": "bayt-windows-capture-soak-v1",
        "run_id": str(uuid.uuid4()),
        "host": "windows-agent",
        "operation": operation,
        "finished_at": now_iso(),
        "http_status": status,
        "content_type": content_type,
        "latency_ms": max(0, round((time.monotonic() - started_at) * 1000)),
        "response_bytes": len(body),
        "cloudflare_blocked": blocked,
        "cloudflare_ray_id": headers.get("cf-ray"),
        "pii_written_to_log": False,
        "raw_credentials_written_to_log": False,
        "result": "STOPPED" if blocked else "PASS",
    }
    payload.update(session_metadata(request_headers))
    return payload


def parse_search_payload(body: bytes, manifest: dict[str, Any]) -> None:
    try:
        parsed = json.loads(body)
        manifest.update(candidate_summary(parsed))
        manifest["response_schema_hash"] = schema_hash(parsed)
        manifest["response_parseable"] = True
    except (UnicodeDecodeError, json.JSONDecodeError):
        manifest.update({"candidate_count": 0, "unique_cv_id_count": 0, "cv_id_set_hash": None})
        manifest["response_schema_hash"] = None
        manifest["response_parseable"] = False
        manifest["result"] = "STOPPED"


def replay_once(url: str, method: str, request_headers: dict[str, str], request_body: bytes) -> None:
    started = time.monotonic()
    headers = {
        name: value
        for name, value in request_headers.items()
        if name not in {"host", "content-length", "connection", "proxy-connection", "accept-encoding"}
    }
    headers["accept-encoding"] = "identity"
    status = 0
    response_headers: dict[str, str] = {}
    body = b""
    error_class = None
    try:
        request = urllib.request.Request(url, data=request_body or None, headers=headers, method=method)
        with urllib.request.urlopen(request, timeout=45) as response:
            status = response.status
            response_headers = {name.lower(): value for name, value in response.headers.items()}
            body = response.read()
    except urllib.error.HTTPError as error:
        status = error.code
        response_headers = {name.lower(): value for name, value in error.headers.items()}
        body = error.read()
        error_class = "HTTPError"
    except Exception as error:  # noqa: BLE001 - the failure class is evidence; message may contain secrets.
        error_class = type(error).__name__

    manifest = response_manifest(
        "SEARCH_FIRST_PAGE_REPLAY",
        status,
        response_headers.get("content-type", ""),
        response_headers,
        body,
        request_headers,
        started,
    )
    manifest["retry_count"] = 0
    manifest["error_class"] = error_class
    manifest["request_contract_hash"] = sha256_text(
        json.dumps(
            {
                "method": method,
                "endpoint": "/v6/cvSearch/{searchId}/results",
                "header_names": sorted(request_headers),
            },
            separators=(",", ":"),
        )
    )
    if body:
        parse_search_payload(body, manifest)
    else:
        manifest.update(
            {
                "candidate_count": 0,
                "unique_cv_id_count": 0,
                "cv_id_set_hash": None,
                "response_schema_hash": None,
                "response_parseable": False,
                "result": "STOPPED",
            }
        )
    write_json("g2-replay.json", manifest)


class BaytValidationAddon:
    def request(self, flow: http.HTTPFlow) -> None:
        if flow.request.pretty_host == "bayt.com" or flow.request.pretty_host.endswith(".bayt.com"):
            flow.metadata["bayt_started"] = time.monotonic()

    def response(self, flow: http.HTTPFlow) -> None:
        global _replay_started

        host = flow.request.pretty_host.lower()
        if host != "bayt.com" and not host.endswith(".bayt.com"):
            return
        path = flow.request.path.split("?", 1)[0]
        request_headers = sanitized_headers(flow.request.headers)
        response_headers = sanitized_headers(flow.response.headers)
        # mitmproxy exposes raw_content as the wire representation, which may be
        # Brotli/gzip encoded. content is the decoded payload required for JSON
        # validation and Cloudflare marker checks.
        body = flow.response.content or b""
        started = float(flow.metadata.get("bayt_started", time.monotonic()))
        content_type = response_headers.get("content-type", "")

        if path in {"/", "/en/"} and "text/html" in content_type:
            write_json(
                "g1-home.json",
                response_manifest(
                    "HOME_PAGE",
                    flow.response.status_code,
                    content_type,
                    response_headers,
                    body,
                    request_headers,
                    started,
                ),
            )
            return

        if "/employers/" in path and "text/html" in content_type:
            manifest = response_manifest(
                "EMPLOYER_PAGE",
                flow.response.status_code,
                content_type,
                response_headers,
                body,
                request_headers,
                started,
            )
            manifest["auth_state"] = "AUTH_REQUIRED" if "/login/" in path else "SESSION_PRESENT"
            write_json("g1-employer.json", manifest)
            return

        if not SEARCH_RESULTS_PATH.match(path):
            return

        manifest = response_manifest(
            "SEARCH_FIRST_PAGE_BROWSER",
            flow.response.status_code,
            content_type,
            response_headers,
            body,
            request_headers,
            started,
        )
        manifest["query_parameter_names"] = sorted(flow.request.query.keys())
        manifest["request_contract_hash"] = sha256_text(
            json.dumps(
                {
                    "method": flow.request.method,
                    "endpoint": "/v6/cvSearch/{searchId}/results",
                    "query_parameter_names": manifest["query_parameter_names"],
                    "header_names": sorted(request_headers),
                },
                separators=(",", ":"),
            )
        )
        parse_search_payload(body, manifest)
        write_json("g2-browser.json", manifest)

        if not _replay_started and manifest["result"] == "PASS":
            _replay_started = True
            threading.Thread(
                target=replay_once,
                args=(flow.request.pretty_url, flow.request.method, request_headers, flow.request.raw_content or b""),
                daemon=True,
            ).start()


addons = [BaytValidationAddon()]
