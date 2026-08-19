# Candidate locators

The current JSON file identifies the Oracle-owned Actions artifact that deterministically materialized one or more independently reviewed approvals. A locator is release audit metadata, not an approval flag; blessing occurs when each `approvals/<request-id>.json` PR merges.

The release workflow refuses to recapture. It downloads this immutable batch artifact, replays pack construction from the exact approved candidates, and requires the resulting manifest and pack hashes to match the committed publication PR.
