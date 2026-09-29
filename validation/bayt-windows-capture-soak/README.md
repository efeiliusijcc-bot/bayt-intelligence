# Bayt Windows capture validation

This harness performs one authorized, serial validation on Windows Server 2022:

- a normal Google Chrome process uses a per-process loopback proxy;
- the proxy writes only sanitized response metadata and HMAC fingerprints;
- the first captured search-results request is replayed once in memory;
- candidate details, exports and attachments are out of scope;
- no raw HAR, Cookie, token, response body or CV ID is persisted.

Runtime files belong under `runtime/bayt-windows-capture-soak/` and must not be committed.
