from __future__ import annotations

import hashlib
import hmac
import json
import re
from collections.abc import Iterable
from typing import Any


SEARCH_RESULTS_PATH = re.compile(r"^/v6/cvSearch/[^/]+/results/?$", re.IGNORECASE)
CV_ID_KEYS = {"cvid", "candidateid"}
CANDIDATE_LIST_KEYS = {"results", "cvs", "items", "candidates"}
CLOUDFLARE_MARKERS = (
    "sorry, you have been blocked",
    "cf-chl-",
    "turnstile",
    "challenge-platform",
)


def hmac_fingerprint(key: bytes, values: Iterable[str]) -> str | None:
    material = "\n".join(sorted(value for value in values if value))
    if not material:
        return None
    digest = hmac.new(key, material.encode("utf-8"), hashlib.sha256).hexdigest()
    return f"hmac-sha256:{digest}"


def sha256_text(value: str) -> str:
    return f"sha256:{hashlib.sha256(value.encode('utf-8')).hexdigest()}"


def cookie_names(cookie_header: str) -> list[str]:
    names: set[str] = set()
    for part in cookie_header.split(";"):
        name, separator, _value = part.strip().partition("=")
        if separator and name:
            names.add(name)
    return sorted(names)


def schema_shape(value: Any, depth: int = 0) -> Any:
    if depth >= 8:
        return "depth-limit"
    if isinstance(value, dict):
        return {key: schema_shape(value[key], depth + 1) for key in sorted(value)}
    if isinstance(value, list):
        samples = []
        seen: set[str] = set()
        for item in value[:5]:
            shape = schema_shape(item, depth + 1)
            encoded = json.dumps(shape, sort_keys=True, separators=(",", ":"))
            if encoded not in seen:
                seen.add(encoded)
                samples.append(shape)
        return {"type": "array", "item_shapes": samples}
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    return "string"


def schema_hash(value: Any) -> str:
    encoded = json.dumps(schema_shape(value), sort_keys=True, separators=(",", ":"))
    return sha256_text(encoded)


def _normalized_key(key: str) -> str:
    return re.sub(r"[^a-z0-9]", "", key.lower())


def candidate_id(item: Any) -> str | None:
    if not isinstance(item, dict):
        return None
    for key, value in item.items():
        if _normalized_key(str(key)) in CV_ID_KEYS and isinstance(value, (str, int)):
            text = str(value).strip()
            if text:
                return text
    for value in item.values():
        if isinstance(value, dict):
            nested = candidate_id(value)
            if nested:
                return nested
    return None


def candidate_summary(value: Any) -> dict[str, Any]:
    choices: list[tuple[int, int, list[str]]] = []

    def visit(node: Any, preferred: bool = False) -> None:
        if isinstance(node, dict):
            for key, child in node.items():
                visit(child, _normalized_key(str(key)) in CANDIDATE_LIST_KEYS)
        elif isinstance(node, list) and node and all(isinstance(item, dict) for item in node):
            ids = [found for item in node if (found := candidate_id(item))]
            score = len(ids) * 10 + (5 if preferred else 0) + len(node)
            choices.append((score, len(node), ids))
            for item in node[:5]:
                visit(item)

    visit(value)
    if not choices:
        return {"candidate_count": 0, "unique_cv_id_count": 0, "cv_id_set_hash": None}
    _score, count, ids = max(choices, key=lambda item: item[0])
    unique_ids = sorted(set(ids))
    return {
        "candidate_count": count,
        "unique_cv_id_count": len(unique_ids),
        "cv_id_set_hash": sha256_text("\n".join(unique_ids)) if unique_ids else None,
    }


def cloudflare_blocked(status_code: int, headers: dict[str, str], body: bytes) -> bool:
    if status_code in {403, 429}:
        return True
    server = headers.get("server", "").lower()
    sample = body[:1_000_000].decode("utf-8", errors="ignore").lower()
    return "cloudflare" in server and any(marker in sample for marker in CLOUDFLARE_MARKERS)
