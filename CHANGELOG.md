# Changelog

Notable changes to Pit are documented here. GitHub release notes remain the authoritative detailed record for each tagged release.

## [Unreleased]

## [0.14.1] - 2026-09-16

### Fixed

- Report timed-out streaming processes with exit code 124 and aborted processes with exit code 130 instead of treating signal termination as success.
- Add bounded timeout and abort diagnostics to process results.
- Escalate to SIGKILL when a child ignores SIGTERM.

## [0.14.0] - 2026-09-16

### Added

- Added an adaptive-music case study with a sanitized session transcript.
- Added bounded model-catalog refresh diagnostics and provider-scoped refresh cancellation.
- Added public project governance, security, contribution, and release documentation.
- Added Node.js 22 and 24 CI coverage, runtime dependency auditing, and automated tagged GitHub releases.

### Changed

- Upgraded the tested Pi integration to 0.85.1 and Vitest to 4.1.11.
- Simplified execution dashboard model construction and reduced maintainability-audit findings.
- Reworked public installation guidance around tagged GitHub distribution while keeping npm publication disabled.

### Fixed

- Rebuilt saved-function viewer highlighting after theme changes.
- Preserved multiline syntax colors across hashed prefixes and TUI line boundaries.
- Resolved all reported npm dependency advisories.

## [0.13.3] - 2026-08-06

- Completed the feature-oriented source reorganization and strengthened architecture boundary checks.

## [0.13.2] - 2026-08-06

- Organized source modules around feature boundaries and reduced root-level coupling.

## [0.13.1] - 2026-08-06

- Simplified saved-function internals while preserving project and session behavior.

## [0.13.0] - 2026-08-05

- Added user-global saved functions and scoped function management.

Earlier release history is available on the [GitHub Releases](https://github.com/cv/pit/releases) page.

[Unreleased]: https://github.com/cv/pit/compare/v0.14.1...HEAD
[0.14.1]: https://github.com/cv/pit/compare/v0.14.0...v0.14.1
[0.14.0]: https://github.com/cv/pit/compare/v0.13.3...v0.14.0
[0.13.3]: https://github.com/cv/pit/releases/tag/v0.13.3
[0.13.2]: https://github.com/cv/pit/releases/tag/v0.13.2
[0.13.1]: https://github.com/cv/pit/releases/tag/v0.13.1
[0.13.0]: https://github.com/cv/pit/releases/tag/v0.13.0
