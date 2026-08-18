# Operations

## Repository settings

Create a GitHub App installed on `flighthq/flight` and `flighthq/flight-reference-images`, then configure these Actions secrets:

- `ORACLE_APP_ID`
- `ORACLE_APP_PRIVATE_KEY`

The app needs Actions read and Contents read on Flight for intake. The PR writer requests Contents write and Pull requests write only for `flight-reference-images`; the completion job requests those write permissions only for Flight. Keep approval for elevated installation permissions enabled at the organization level.

`FLIGHT_BASE_BRANCH` is an optional repository variable used by completion. It defaults to `develop`, matching the branch that currently carries Flight's reference-image contract.

Protect `main` with the `Quality and repository integrity` and `Replay reviewed candidate` checks and require human review for oracle approval PRs. Do not grant Actions permission to bypass that protection.

## Dispatch

Flight sends a `repository_dispatch` event of type `flight-reference-image-candidate` with this camel-case payload:

```json
{
  "repository": "flighthq/flight",
  "flightCommit": "<40-hex landed commit>",
  "requestPath": "oracle-requests/<id>.json",
  "requestSha256": "<64-hex>",
  "artifactId": 123,
  "workflowRunId": 456,
  "artifactDigest": "sha256:<64-hex>"
}
```

The same values are available as manual workflow inputs for recovery. Manual dispatch does not weaken validation: the request is still fetched from the exact commit, and artifact ownership, run id, and digest are checked through GitHub's API.

Oracle intake adds the landed commit's GitHub-reported committer time and applies `intake-policy.json`. Flight CI should mirror the same 336-hour bound when reporting pending requests so an expired request fails on both sides of the boundary.

## Review

Download the `oracle-review-*` artifact linked by the approval PR and open `index.html`. Rows are sorted by mismatch magnitude and show old, new, and per-channel delta images. Missing and dimension-changed rows are visually distinct. `within policy` is diagnostic in the approval report; an intentional re-bless may exceed the current regression threshold and still be approved by merging.

If the Oracle-owned candidate artifact expires before merge, close the PR and redispatch. Release never recaptures or substitutes bytes. Increase `retention-days` if ordinary review time approaches the configured 30 days.

The candidate locator remains as current-release audit metadata after publishing, but CI replays it only when `manifest.json`, `oracles/**`, or a candidate locator changes. Unrelated future PRs therefore do not become dependent on an expired artifact.

## Release recovery

Release tags and assets are immutable. If release creation fails before the tag exists, rerun the workflow. If a tag exists, the workflow deliberately fails rather than clobbering it; inspect the existing release and create a new commissioning request for any correction.

If the release succeeds but the Flight completion PR fails, rerun only after confirming the outstanding Flight request still has the hash recorded in `manifest.json`. The completion tool refuses a moved or missing request.

## Pack routing

`pack-config.json` keeps common independent domains separate so a scene3d-only update does not force text and shape consumers to download unrelated images. Rules are evaluated in order; unmatched entries use the subject's explicit default pack. Changing routing rebuilds complete packs and should be reviewed as a storage and download-boundary change.
