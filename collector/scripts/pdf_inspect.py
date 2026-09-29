#!/usr/bin/env python3
import json
import re
import sys
from pathlib import Path

from pypdf import PdfReader


def main() -> int:
    if len(sys.argv) != 2:
        print(json.dumps({"ok": False, "error": "usage: pdf_inspect.py FILE"}))
        return 2

    pdf_path = Path(sys.argv[1])
    try:
        reader = PdfReader(str(pdf_path))
        text_parts = []
        text_extraction_errors = []
        for page_number, page in enumerate(reader.pages[:5], start=1):
            try:
                text_parts.append(page.extract_text() or "")
            except Exception as exc:  # Some valid PDFs contain unsupported text geometry.
                text_extraction_errors.append(
                    {"page": page_number, "error": str(exc)}
                )
        text = "\n".join(text_parts)
        refs = sorted(set(re.findall(r"\bCV\s*([0-9]{5,})\b", text, flags=re.I)))
        print(
            json.dumps(
                {
                    "ok": True,
                    "pages": len(reader.pages),
                    "refs": refs,
                    "text_chars": len(text),
                    "encrypted": bool(reader.is_encrypted),
                    "text_extraction_errors": text_extraction_errors,
                },
                ensure_ascii=False,
            )
        )
        return 0
    except Exception as exc:  # noqa: BLE001 - command reports structured failure
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
