import json
import unittest

from capture_core import (
    candidate_summary,
    cloudflare_blocked,
    cookie_names,
    hmac_fingerprint,
    schema_hash,
)


class CaptureCoreTest(unittest.TestCase):
    def test_cookie_names_do_not_return_values(self) -> None:
        self.assertEqual(cookie_names("session=secret; csrf=other"), ["csrf", "session"])

    def test_hmac_is_stable_without_raw_value(self) -> None:
        result = hmac_fingerprint(b"local-test-key", ["secret-value"])
        self.assertTrue(result.startswith("hmac-sha256:"))
        self.assertNotIn("secret-value", result)

    def test_candidate_summary_keeps_only_counts_and_hash(self) -> None:
        result = candidate_summary({"results": [{"cvId": "100"}, {"cvId": "200"}]})
        self.assertEqual(result["candidate_count"], 2)
        self.assertEqual(result["unique_cv_id_count"], 2)
        self.assertNotIn("100", json.dumps(result))

    def test_schema_hash_ignores_values(self) -> None:
        first = schema_hash({"results": [{"cvId": "100", "title": "A"}]})
        second = schema_hash({"results": [{"cvId": "200", "title": "B"}]})
        self.assertEqual(first, second)

    def test_cloudflare_block_is_detected(self) -> None:
        self.assertTrue(cloudflare_blocked(403, {"server": "cloudflare"}, b"blocked"))
        self.assertTrue(
            cloudflare_blocked(
                200,
                {"server": "cloudflare"},
                b"Sorry, you have been blocked",
            )
        )


if __name__ == "__main__":
    unittest.main()
