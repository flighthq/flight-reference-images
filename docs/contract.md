# Flight ↔ flight-reference-images contract

## Flight request

Flight commits `reference-image-requests/<id>.json`, validated by [`request.schema.json`](../schemas/request.schema.json). Each version-3 target binds one exact cell to the decoded pixels, reproducible build, host, and registered capture environment that a reviewer selected. Duplicate cells fail, every cell must appear in the candidate, and no extra cell is accepted.

The UUID `id` is the request's sole identity. Approval workflows derive a display label from the unique `targets[].entry` values and show every cell in the Actions summary and PR body. The label is never accepted as a request field or used in a path, branch, locator, or release tag. Two requests for the same entry may therefore display the same label without colliding.

```json
{
  "schemaVersion": 3,
  "id": "1850c447-117b-4fce-bc0b-804fb5210d0e",
  "subject": "functional",
  "targets": [
    {
      "entry": "shape-fill-solid",
      "renderer": "webgl",
      "pixelSha256": "1111111111111111111111111111111111111111111111111111111111111111",
      "build": {
        "commit": "2222222222222222222222222222222222222222",
        "dirty": [],
        "dirtyOmitted": 0
      },
      "capture": {
        "hostInstanceId": "review-host",
        "environmentId": "sha256-3333333333333333333333333333333333333333333333333333333333333333"
      }
    }
  ],
  "frames": 1,
  "reason": "add the first full-resolution reference for the solid-fill scene"
}
```

The trusted Flight bridge dispatches only the source repository, landed 40-character Flight SHA, request path and SHA-256, Actions artifact id, workflow run id, and artifact digest. Oracle intake fetches the request again from that exact commit and verifies the hash before trusting its scope. It also queries GitHub for that commit's authoritative committer time and adds `flightCommittedAt` to its internal envelope. `intake-policy.json` rejects a request older than 336 hours, so pending work cannot become a permanent skip list. Exact release replay does not reapply this wall-clock check; it proves the already-admitted artifact instead.

## Candidate bundle

The Flight artifact contains `candidate.json` plus captured images. [`candidate.schema.json`](../schemas/candidate.schema.json) defines the format.

```text
candidate.json
request-image-differences.json
images/functional/shape-fill-solid/webgl.png
```

Flight records every decoded-pixel difference between the reviewed request and the later commissioned capture in `request-image-differences.json`. Intake validates its request, identity, requested hash, and captured hash bindings, preserves it in the prepared artifact, and rejects an unrecorded or fabricated difference.

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

Read-only intake creates this prepared working set:

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

The retained Oracle-owned candidate artifact contains `prepared-intake.json`, `candidate/`, `request.json`, `envelope.json`, `base/`, and `expected/`. The report is uploaded separately for human review, and the per-candidate prospective packs are not retained because batch publication reconstructs the complete pack set once. `prepared-intake.json` hashes every premise and result. The privileged approval writer revalidates the retained inputs and writes only `approvals/<request-id>.json`. That record binds the request, candidate, source artifact, Oracle-owned prepared artifact, approved record hashes, and the prior hash (or absence) of every target record. It does not decode PNGs or change the manifest, oracle records, packs, or current-release locator.

Approval PR CI downloads the exact prepared artifact, verifies its GitHub id, run, name, digest, and expiry, and requires its content to reproduce the committed approval record.

### Independent approvals and batch publication

Approval PRs do not edit shared release state. Disjoint requests can therefore be reviewed and merged in any order without rebasing or refreshing each other. Staleness is scoped to the records a request actually changes: publication requires each target's current hash to equal the prior hash recorded at approval. Two approvals for the same target are rejected as overlapping and must be published sequentially, because their order changes the meaning of the second review.

Every approval merge triggers **Stage approved reference image release**. Its read-only preparation job gathers all approved request ids absent from the current manifest in lexical UUID order, verifies and downloads their immutable prepared artifacts, checks their per-target bases and approval hashes, and builds the complete pack set once. The resulting batch artifact contains the exact inputs, approved records, prior release state, fixed manifest, and packs.

A scoped writer then opens or lease-replaces one `publication/*` PR containing only the materialized manifest, oracle records, and batch locator. More approvals merged while that PR is open are accumulated into the same PR; the latest concurrency run supersedes earlier staging runs. Human image review remains on the independent approval PRs, while the publication PR is a deterministic, replay-checked aggregation boundary. It can be merged after any desired group of approvals, and no approval merge order is prescribed.

**Migrate queued approvals** converts open legacy `oracle/*` PRs that still contain a single candidate locator into approval-only changes when this contract first lands. It ignores already migrated heads, so rerunning it is safe. The former refresh queue and its automatic post-release workflow are removed.

## Release and Flight reference-image lock

Merging the publication PR changes `manifest.json` and triggers release automation. CI and release both download the immutable batch artifact, reconstruct the complete packs once from approved candidate bytes plus the prior release, and require the result to equal the committed manifest and records. Candidate-locator-only maintenance does not republish an unchanged release. A separate contents-write job verifies the resulting fixed manifest and pack SHA-256 values, refuses an existing tag, and publishes the files without decoding images.

The completion job writes Flight's version-2 [`reference-image-lock.schema.json`](../schemas/reference-image-lock.schema.json) shape to `scripts/reference-image-lock.json` and removes every request fulfilled by the batch in the same PR. If a Flight lock-update PR is already open, later releases advance that branch and accumulate their fulfilled-request removals instead of opening conflicting siblings. Each pack entry pins both the encoded pack and an identity-keyed `images` map of decoded `pixelSha256` values, so Flight can decide whether a captured image is already represented without downloading the pack. Required `referenceImage` coverage stays in Flight throughout.

Flight resolves each required identity with these states:

| Pinned image | Matching request | Result                                            |
| ------------ | ---------------- | ------------------------------------------------- |
| yes          | no               | compare and gate                                  |
| yes          | yes              | compare prior image; in-scope mismatch is pending |
| no           | yes              | pending, never reported as compared               |
| no           | no               | hard missing-evidence failure                     |

Pinned images without live Flight targets are orphans and fail. Dimension changes are named verdicts, not exceptions that abort later comparisons. A gated run with zero comparisons fails.
