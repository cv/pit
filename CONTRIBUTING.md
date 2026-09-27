# Contributing to Pit

Thank you for helping improve Pit. Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Prerequisites

- Node.js 22.19 or newer
- npm 11.17.0
- Pi 0.87.1 for interactive testing
- jq on `PATH` for the saved-function query tests, which are skipped locally without it and
  required in CI

Pit is distributed from GitHub (`main` and tagged releases) and is intentionally not published to npm.

## Set up

```sh
git clone https://github.com/cv/pit.git
cd pit
npm install
```

Load local source for interactive development:

```sh
pi -e ./src/index.ts
```

## Make changes

Read [docs/architecture.md](docs/architecture.md) before changing source boundaries. Keep implementation in the domain that owns the behavior and avoid general-purpose utility modules.

Project-persisted workflow helpers live in `.pi/functions/`; their location determines scope.

Pit is 0.x. A breaking change removes the old name, field, path, or behavior outright: do not add deprecated aliases, compatibility shims, dual readers, or migration code. Record the break in `CHANGELOG.md`.

When changing global function definitions, regenerate the contract:

```sh
npm run globals:generate
```

Prefer focused tests during development. Before requesting review, run:

```sh
npm run check
npm test
npm run coverage
npm run package:check
npm run quality:audit
```

For TUI, extension loading, saved functions, sandbox execution, partial updates, or renderer behavior, also reload Pi and exercise the changed behavior interactively.

## Pull requests

- Keep each pull request focused and explain user-visible behavior.
- Include tests for success, failure, cancellation, and boundary cases where applicable.
- Update README, architecture, security, or global function documentation when behavior changes.
- Do not edit `src/generated/global-contract.d.ts` manually.
- Keep generated files, dependency changes, and lockfile changes intentional.
- Confirm that no secrets, credentials, private paths, or unsanitized session data are included.

Report vulnerabilities privately according to [SECURITY.md](SECURITY.md), not through a pull request or public issue.
