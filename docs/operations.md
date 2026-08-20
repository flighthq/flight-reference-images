# Operations

## Repository settings

Create a GitHub App installed on `flighthq/flight` and `flighthq/flight-reference-images`, then configure these Actions secrets:

- `ORACLE_APP_ID`
- `ORACLE_APP_PRIVATE_KEY`

The app needs Actions read and Contents read on Flight for intake. Approval, migration, and publication writers request Contents write and Pull requests write only for `flight-reference-images`; the completion job requests those write permissions only for Flight. Keep approval for elevated installation permissions enabled at the organization level.

`FLIGHT_BASE_BRANCH` is an optional repository variable used by completion. It defaults to `develop`, matching the branch that currently carries Flight's reference-image contract.

Protect `main` with the `Quality and repository integrity`, `Approval artifact integrity`, and `Replay reviewed candidate` checks. Require human review for approval PRs and do not grant Actions permission to bypass that protection. Publication PRs cross the same protected boundary, but their image decisions have already occurred in the approval PRs.

## Dispatch

Flight normally sends one `repository_dispatch` event of type `flight-reference-image-candidate-batch` after the source capture run completes:

```json
{
  "schemaVersion": 2,
  "repository": "flighthq/flight",
  "flightCommit": "<40-hex landed commit>",
  "workflowRunId": 456,
  "candidates": [
    {
      "requestPath": "reference-image-requests/<id>.json",
      "requestSha256": "<64-hex>",
      "artifactId": 123,
      "artifactDigest": "sha256:<64-hex>"
    }
  ]
}
```

The array is the complete membership for that Flight run. It must contain 1–256 candidates with unique request paths and artifact ids. The serialized GitHub `client_payload` must also remain within GitHub's 65,535-character limit. Batch intake validates the whole envelope before starting any candidate, then processes candidates independently with `fail-fast: false` and at most 12 concurrent reusable intake calls.

The legacy `flight-reference-image-candidate` event remains available during migration and has this version-1 camel-case payload:

```json
{
  "repository": "flighthq/flight",
  "flightCommit": "<40-hex landed commit>",
  "requestPath": "reference-image-requests/<id>.json",
  "requestSha256": "<64-hex>",
  "artifactId": 123,
  "workflowRunId": 456,
  "artifactDigest": "sha256:<64-hex>"
}
```

The same version-1 values are available as manual workflow inputs for single-candidate recovery. **Reference image candidate batch intake** accepts the complete version-2 JSON as its manual `payload` input. Manual dispatch does not weaken validation: each request is still fetched from the exact commit, and artifact ownership, run id, and digest are checked through GitHub's API.

For rollout, land batch support here first while Flight continues sending version 1. After the workflow is present on the default branch, switch Flight to one version-2 batch event per completed capture run. Retire version 1 only after in-flight old bridge runs no longer need recovery.

Oracle intake adds the landed commit's GitHub-reported committer time and applies `intake-policy.json`. Flight CI should mirror the same 336-hour bound when reporting pending requests so an expired request fails on both sides of the boundary.

## Review

Download the `oracle-review-*` artifact linked by the approval PR and open `index.html`. Rows are sorted by mismatch magnitude and show old, new, and per-channel delta images. Missing and dimension-changed rows are visually distinct. `within policy` is diagnostic in the approval report; an intentional re-bless may exceed the current regression threshold and still be approved by merging.

Each approval PR changes only `approvals/<request-id>.json`, so merge the reviewed approvals in any order. No refresh, draft promotion, special ordering, or textual conflict resolution is part of the normal path. Merged approvals accumulate in one `publication/*` PR. Merge that mechanical PR whenever the desired group is ready; its CI reconstructs and verifies the complete release.

If the compact Oracle-owned candidate artifact expires before the approval is published, redispatch and review the replacement approval. Release never recaptures or substitutes bytes. Increase `retention-days` if ordinary review plus publication time approaches the configured 30 days. The rolling batch artifact is also retained for 30 days and is replaced whenever **Stage approved reference image release** runs.

The batch locator remains as current-release audit metadata after publishing, but CI replays it only when `manifest.json`, `oracles/**`, or a candidate locator changes. Unrelated future PRs therefore do not become dependent on an expired artifact.

## Approval and publication recovery

**Migrate queued approvals** runs once when the independent-approval contract lands and converts open legacy `oracle/*` PRs to approval-only diffs. Rerun it manually if a transient API or branch update failure leaves a legacy locator PR open. It ignores PRs already converted.

**Stage approved reference image release** runs on every merged approval. Rerun it manually if staging fails or if the rolling publication PR's batch artifact expires. It deterministically rebuilds the PR from every merged approval not yet named by `manifest.json`; it does not depend on approval merge order.

## Release recovery

Release tags and assets are immutable. If release creation fails before the tag exists, rerun the workflow. A manual rerun against an existing tag downloads every published asset and continues only when the asset names and bytes exactly equal the reconstructed release; it never replaces an asset. Any difference fails and requires a new commissioning request.

If the release succeeds but the Flight completion PR fails, run **Release blessed reference images** manually from the current default branch. The workflow verifies the existing immutable release, resolves its original Oracle commit, and reconstructs the rolling Flight PR from the current Flight base. Historical requests are removed only while their bytes still match the released checksum; changed historical requests remain pending. Every request newly fulfilled by the current batch must still exist and match exactly. Do not rerun the old failed job: GitHub reruns it with the workflow definition from the original release commit.

## Pack routing

`pack-config.json` keeps common independent domains separate so a scene3d-only update does not force text and shape consumers to download unrelated images. Rules are evaluated in order; unmatched entries use the subject's explicit default pack. Changing routing rebuilds complete packs and should be reviewed as a storage and download-boundary change.
