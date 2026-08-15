# Comparison policies

Policy records version the pixel comparison predicate. A policy is added only after a calibration run against repeated captures from a registered canonical environment. Fingerprint-space tolerances are not pixel-space tolerances and are never copied here.

`calibration.corpusSha256` identifies the calibrated source corpus. It is the SHA-256 of the repository's canonical JSON encoding of an object with `flightCommit` and a lexically sorted `identities` array. The trailing newline emitted by `canonicalJson` is part of the bytes. Binding the Flight commit makes the identities reproduce the exact source and per-cell provenance without copying Flight-owned records here.
