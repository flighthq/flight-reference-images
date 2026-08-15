# Flight ↔ flight-oracles contract

## Flight request

Flight commits `oracle-requests/<id>.json`, validated by [`request.schema.json`](../schemas/request.schema.json). The Cartesian product of `targets[].entry` and `targets[].renderers` is exact: duplicate cells fail, every cell must appear in the candidate, and no extra cell is accepted.

```json
{
  "schemaVersion": 1,
  "id": "shape-fill-solid-webgl-2026-08-14",
  "subject": "functional",
  "targets": [{ "entry": "shape-fill-solid", "renderers": ["webgl"] }],
  "frames": 1,
  "reason": "add the first full-resolution reference for the solid-fill scene"
}
```

The trusted Flight bridge dispatches only the source repository, landed 40-character Flight SHA, request path and SHA-256, Actions artifact id, workflow run id, and artifact digest. Oracle intake fetches the request again from that exact commit and verifies the hash before trusting its scope. It also queries GitHub for that commit's authoritative committer time and adds `flightCommittedAt` to its internal envelope. `intake-policy.json` rejects a request older than 336 hours, so pending work cannot become a permanent skip list. Exact release replay does not reapply this wall-clock check; it proves the already-admitted artifact instead.

## Candidate bundle

The Flight artifact contains `candidate.json` plus captured images. [`candidate.schema.json`](../schemas/candidate.schema.json) defines the format.

```text
candidate.json
images/functional/shape-fill-solid/webgl.png
```

Each capture is explicitly either:

- `captured`, with its exact image path and Flight `CaptureBaselineProvenance` fields; or
- `missing`, with a non-empty error.

A missing row is written to `report.json` and the intake fails. Absence is never interpreted as success. Captured provenance `frames` must equal the request. Undeclared files, omitted cells, duplicate cells, and out-of-scope cells fail before metadata is authored. `intake-policy.json` bounds encoded size, dimensions, and total pixels before PNG decoding allocates the image buffer.

## Oracle record

[`oracle-record.schema.json`](../schemas/oracle-record.schema.json) requires:

- stable `subject`, `entry`, and `renderer` identity;
- request id/hash and landed Flight commit;
- environment and comparison-policy ids;
- capture provenance (`frames`, `sourceHash`, `targetKind`, `verifyPublished`, `warmupFrames`);
- width, height, `rgba8`, and `srgb`;
- SHA-256 of encoded PNG bytes and decoded top-down RGBA bytes; and
- pack assignment.

The path is derived from identity, and pack assignment is derived from `pack-config.json`; neither can be chosen by candidate input.

## Capture environment and comparison policy

An environment descriptor binds the browser build and Playwright revision, renderer implementation and complete argument list, dependent fonts, locale, timezone, viewport, device-pixel ratio, and color profile. Execution is either a digest-pinned container or a native architecture/vector-ISA class demonstrated portable by repeated captures. The descriptor's canonical content derives `environmentId`; a candidate cannot introduce an environment.

A comparison policy belongs to exactly one environment. Its calibration binds a landed Flight commit and the lexical set of measured identities through `corpusSha256`, and records independent-host and per-host run counts. Zero observed noise produces an exact policy; a non-zero tolerance is never inferred from hypothetical future variance.

## Prepared candidate

Read-only intake creates one Oracle-owned artifact containing:

```text
prepared-intake.json
candidate/                 exact candidate manifest and PNGs
request.json               exact Flight request bytes
envelope.json              fixed dispatch binding
base/                      prior manifest and JSON records
expected/                  allowlisted new manifest and records
prospective-packs/         complete deterministic release packs
report/                    report.json, index.html, old/new/delta images
```

`prepared-intake.json` hashes every premise and result. The privileged PR writer revalidates those hashes, requires the repository still equal the staged base, copies only the expected manifest and listed oracle records, and writes one candidate locator. It does not decode PNGs.

PR CI downloads the locator's immutable artifact, verifies its GitHub digest, downloads the prior release, reconstructs every complete pack from the staged candidate, and requires the result to equal both the PR metadata and committed manifest.

## Release and Flight lock

After approval, release automation repeats reconstruction from candidate bytes and the prior complete release. A separate contents-write job verifies the resulting fixed manifest and pack SHA-256 values, refuses an existing tag, and publishes the files without decoding images.

The completion job writes Flight's [`oracle-lock.schema.json`](../schemas/oracle-lock.schema.json) shape and removes the fulfilled request in the same PR. Required `referenceImage` coverage stays in Flight throughout.

Flight resolves each required identity with these states:

| Pinned image | Matching request | Result                                            |
| ------------ | ---------------- | ------------------------------------------------- |
| yes          | no               | compare and gate                                  |
| yes          | yes              | compare prior image; in-scope mismatch is pending |
| no           | yes              | pending, never reported as compared               |
| no           | no               | hard missing-evidence failure                     |

Pinned images without live Flight targets are orphans and fail. Dimension changes are named verdicts, not exceptions that abort later comparisons. A gated run with zero comparisons fails.
