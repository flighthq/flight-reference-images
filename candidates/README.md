# Candidate locators

Each JSON file identifies the Oracle-owned Actions artifact whose exact candidate bytes were reviewed for one approval PR. A locator is audit metadata, not an approval flag; merging the PR is the blessing.

The release workflow refuses to recapture. It downloads this immutable artifact, replays pack construction, and requires the resulting manifest and pack hashes to match the reviewed commit.
