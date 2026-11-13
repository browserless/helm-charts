# GitHub Actions security maintenance

## Tool update procedure

Security tool pins live in `.github/workflows/ci.yml`. Dependabot updates action
references and existing `.github/workflows/actions.lock` entries, not shell
download URLs or checksums.

- **gh-actions-lock v0.4.1:** review the release and update `--pin`. Use the same
  version locally. v0.4.1 is a GitHub immutable release: its tag and published
  assets cannot change. Confirm replacement releases are immutable before
  updating the pin; extension installation has no separate checksum step.
- **zizmor 1.32.0, actionlint 1.7.12, ShellCheck 0.11.0:** review the release and
  verify the Linux x86-64 archive against publisher checksums/signatures where
  available. Update version, URL, extraction path and literal SHA-256 together.
  Verification must precede extraction/execution. Keep zizmor at least 1.32.0
  for lockfile support. Update actionlint's `tools/go.mod` pin and CI version
  together; `tests/chart.test.ts` rejects a mismatch.

After workflow changes, regenerate the lockfile last. With the pinned tools and
ShellCheck on PATH, run from the repository root:

```sh
gh actions-lock
gh actions-lock --verify
zizmor .
actionlint
shellcheck scripts/*.sh tests/e2e/*.sh
npm run typecheck
npm test
```

Review resolved commits and repository/owner identities. Commit workflow edits
and generated lockfile together; never hand-edit the lockfile. Review action
inputs against each locked action's `action.yml` and revisit exceptions when
upgrading analyzers. These checks run in PR CI, without local pre-commit hooks.

## Exceptions

- `.github/zizmor.yml` sets the approved three-day minimum instead of seven.
  Every updater, including Docker, has an explicit cooldown. Keep the permanent
  test guard for all entries, SemVer overrides and unsupported keys (including
  include/exclude and YAML merge keys). zizmor 1.32.0 stops after its first
  compliant entry, assumes three days for missing cooldowns/defaults, and does
  not check overrides or filters. Fixing its early return alone is insufficient.
- `dependabot-app-version.yml` suppresses only `bot-conditions` on its existing
  actor restriction. The trust boundary also requires PR author Dependabot and
  a same-repository head, on `pull_request` only. Preserve all three conditions;
  revisit the exception if the trigger or guards change. The command-scoped
  Git helper's SC2016 exception permits deferred expansion in Git's helper
  shell; no credential is stored in Git configuration.
- `.github/actionlint.yaml` allows only `ubuntu-26.04` and `ubuntu-26.04-arm`
  because actionlint 1.7.12 predates those labels. Remove it once the pinned
  version recognizes them. This version also skips remote-action input schemas
  for full-semver references; manual input review remains necessary. No input
  diagnostics are globally suppressed.
