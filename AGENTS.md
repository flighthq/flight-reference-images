# Flight Oracles agent map

Read [README.md](README.md) and [docs/contract.md](docs/contract.md) before changing schemas, intake, pack construction, or workflows.

## Ground rules

- Use npm and Node.js 20 or newer.
- Run `npm run fix` after editing, then `npm run check` before committing.
- Keep commit messages single-line Conventional Commits with no body or co-author trailer.
- Never commit PNGs, tarballs, downloaded packs, review output, or candidate artifacts. Git stores the JSON audit trail; GitHub releases and Actions artifacts store image bytes.
- Never invent a capture environment or tolerance. Environment descriptors and comparison policies are measured evidence and must include the calibration fields enforced by their schemas.
- Keep `artifactSha256` and `pixelSha256` distinct. The first hashes encoded PNG bytes; the second hashes decoded top-down RGBA8 bytes.
- Treat merging an approval PR as the blessing. Do not add an approval boolean or recapture during release.
- Preserve the credential split. Candidate-controlled bytes are decoded only in jobs with read-only contents permission. Privileged writers accept fixed, schema-validated metadata and allowlisted paths.
- Preserve the pre-decode size and dimension bounds in `intake-policy.json`; candidate PNG headers are untrusted input.
- A new gate needs a defeating test that observes it fail. Required cases include zero comparisons, missing capture, unexpected candidate scope, corrupt pack, and dimension mismatch.

## Layout

- `src/intake.ts` owns request binding, candidate validation, staged artifact production, allowlisted apply, and exact replay.
- `src/pack.ts` owns verified downloads, safe extraction, deterministic construction, and release verification.
- `src/png.ts` owns decoded-pixel hashing and mismatch calculation.
- `src/repository.ts` owns cross-record referential integrity.
- `schemas/` is the public machine-readable boundary; update schemas and runtime validation together.
- `.github/workflows/` implements intake, approval replay, immutable release, and Flight completion.
