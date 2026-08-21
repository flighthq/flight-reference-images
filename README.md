# flight-reference-images

`flight-reference-images` is the durable store for Flight's blessed full-resolution render references. Git contains compact, reviewable JSON records; immutable GitHub releases contain the encoded PNG bytes in deterministic packs.

This repository implements the cross-repository contract proposed in Flight's [`agents/render-oracle-repository.md`](https://github.com/flighthq/flight/blob/develop/agents/render-oracle-repository.md): exact request binding, separate transport and pixel hashes, old/new/delta review, exact-byte promotion, and an immutable consumer lock.

The repository intentionally starts with no blessed images, capture environment, or comparison policy. Those are measured evidence, not scaffold defaults. The first policy must be calibrated from repeated captures on independent clean hosts before the first candidate can enter intake.

## Lifecycle

```mermaid
flowchart LR
  A[Flight request lands] --> B[Flight captures requested cells]
  B --> C[Read-only Oracle intake]
  C --> D[Oracle-owned candidate artifacts]
  D --> E[One batch approval PR]
  E -->|merge blesses exact bytes| F[Rolling publication PR]
  F -->|merge materializes batch| G[Rebuild exact deterministic packs]
  G --> H[Immutable GitHub release]
  H --> I[Flight lock-bump PR]
```

The capture job never receives an Oracle write credential. Intake processes candidate-controlled PNGs with read-only repository permissions. The first privileged writer can add only `approvals/<request-id>.json`; a version-2 batch writes all validated members into one approval PR. A separate staging workflow verifies every merged approval and its immutable artifact, then updates one rolling publication PR with only `manifest.json`, `oracles/**`, and `candidates/**`. Release reconstruction also runs without contents-write permission; a separate publisher receives already-verified pack bytes and checks their fixed hashes without decoding candidate images.

## Stored records

- `manifest.json` names the current immutable release and maps each complete pack to its SHA-256.
- `oracles/<subject>/<entry>/<renderer>.json` records stable identity, Flight request and commit, capture provenance, environment and policy, dimensions, `artifactSha256`, `pixelSha256`, and pack.
- `approvals/<request-id>.json` binds a human-approved request and candidate to immutable source and prepared artifacts. These records do not change shared release state, so disjoint approvals merge in any order.
- `candidates/<release-tag>.json` locates the Oracle-owned batch artifact from which the current release is exactly replayed.
- `environments/*.json` describes a canonical capture environment. Its content-derived id prevents silent environment drift.
- `comparison-policies/*.json` contains independently calibrated pixel thresholds.
- `pack-config.json` assigns identities to independently downloadable packs.
- `intake-policy.json` bounds how long a Flight request may remain pending and how long its candidate artifact is retained.
- `schemas/*.schema.json` is the machine-readable contract used on both sides of the boundary.

Within a pack, the PNG for a record is `images/<subject>/<entry>/<renderer>.png`. Every pack includes `pack-manifest.json`, so transport verification does not depend on trusting an extracted directory listing.

## Local checks

Use Node.js 20 or newer and npm.

```sh
npm ci
npm run check
```

`npm run check` runs formatting, linting, strict TypeScript checking, the firing tests, and repository relationship validation. The individual operational commands are:

```sh
npm run repository:check
npm run dispatch:expand -- --file <dispatch-batch.json>
npm run packs:download -- --output .artifacts/previous-packs [--attempts 60 --retry-delay-ms 10000]
npm run intake:prepare -- --candidate <dir> --request <request.json> --envelope <envelope.json> --previous-packs <dir> --output <new-dir>
npm run intake:approve -- --prepared <dir> --artifact-id <id> --artifact-digest sha256:<hash> --workflow-run-id <id>
npm run batch:prepare -- --prepared-root <dir> --previous-packs <dir> --output <new-dir>
npm run batch:apply -- --prepared <dir> --artifact-id <id> --artifact-digest sha256:<hash> --workflow-run-id <id>
npm run batch:replay -- --prepared <dir> --previous-packs <dir> --output <new-dir>
npm run release:verify -- --packs <dir>
npm run flight:reconcile -- --flight-root <flight-dir> --oracle-commit <40-hex> --request-ids <id,id,...>
```

Generated output directories must not already exist. This makes accidental reuse or partial overlay a hard error.

## First commissioning

Before dispatching the first candidate:

1. Measure a canonical environment across at least two independent clean hosts and commit its descriptor under `environments/`. Use a digest-pinned container profile when available; a native profile is valid only when the calibration demonstrates portability and records its CPU boundary.
2. Compute the descriptor id with `npm run environment:id -- --file <descriptor.json>`; use that id both in the record and filename.
3. Calibrate full-resolution pixel thresholds from repeated captures and commit a matching policy under `comparison-policies/`.
4. Add the `referenceImage` identity and request to Flight. The request remains in Flight until the release completion PR removes it.

Do not copy Flight's fingerprint tolerances. They are mean differences over a 16×16 averaged grid and have different units from per-pixel mismatch fraction and channel delta.

The candidate bundle format and dispatch envelope are specified in [docs/contract.md](docs/contract.md). Repository setup and workflow recovery are in [docs/operations.md](docs/operations.md).

## License

MIT. See [LICENSE.md](LICENSE.md).
