# Contributing to Pit

Thank you for helping improve Pit. Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Prerequisites

- Node.js 22.19 or newer
- npm 11.17.0
- Pi 1.1.0 for interactive testing, the version `package-lock.json` pins
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
pi --no-extensions -e ./src/index.ts
```

`--no-extensions` disables discovered and configured extensions while the explicit `-e` loads this checkout. This avoids accidentally testing an installed copy alongside local source. See the [native runtime guide](native/wasmtime-executor/README.md) if you need to build or smoke-test the addon itself.

## Make changes

Read [docs/architecture.md](docs/architecture.md) before changing source boundaries. Keep implementation in the domain that owns the behavior and avoid general-purpose utility modules.

Project-persisted workflow helpers live in `.pi/functions/`; their location determines scope. Their [local guide](.pi/functions/README.md) explains the repository's helper boundaries. They are optional conveniences: the commands below work without enabling project functions.

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

`npm run check` checks the generated contract and source boundaries, runs TypeScript and Oxlint, and checks Oxfmt output. `quality:audit` reports file, function, and complexity limits. CI tests supported Node.js versions and runs static, package, dependency-audit, and coverage gates; protected `main` requires checks before merge.

Format only files you changed with `npx oxfmt --write <files>`. Use `npx oxlint --fix <files>` for targeted safe lint fixes; avoid broad fixers when unrelated changes are present.

Test observable behavior rather than implementation tokens or copied prose. Prefer named `it.each` cases when setup and assertions are shared; keep lifecycle, concurrency, and ordering workflows explicit.

For TUI, extension loading, saved functions, sandbox execution, partial updates, or renderer behavior, also reload Pi and exercise the changed behavior interactively. Inspect collapsed and expanded views, running and final states, relevant failures, and realistic terminal widths. Headless tests do not replace this acceptance. Restart Pi instead of reloading after a native addon change.

## Documentation ownership

Keep one canonical home for each detailed contract; summarize and link elsewhere.

- `README.md`: what Pit is, why to try it, installation, first use, and navigation.
- `docs/usage.md`, `docs/saved-functions.md`, and `docs/configuration.md`: task-oriented user guides.
- `docs/reference.md`: public tool parameters, global methods, defaults, and limits; exact declarations derive from the global definitions, not manually edited generated files.
- `docs/security.md`: threat model and runtime guarantees; `SECURITY.md` owns reporting and supported-release policy.
- `docs/architecture.md`: internal components, invariants, and source ownership.
- `CONTRIBUTING.md`: the human contributor path; `docs/releasing.md` owns release procedure.
- `AGENTS.md` and `.pi/skills/`: agent instructions and detailed workflows, not the sole home of essential human contribution requirements.
- Subsystem READMEs: local build instructions and subsystem-specific conventions.
- `CHANGELOG.md`: release changes; case studies: historical experience, clearly separated from current reference.

Add new pages to the [documentation index](docs/README.md), check relative links and moved heading links, and avoid duplicating version numbers or method signatures unnecessarily. See the [release guide](docs/releasing.md) for publication and installed-tag verification.

## Pull requests

- Keep each pull request focused and explain user-visible behavior.
- Include tests for success, failure, cancellation, and boundary cases where applicable.
- Update the relevant user guide, reference, architecture, or security document when behavior changes.
- Do not edit `src/generated/global-contract.d.ts` manually.
- Keep generated files, dependency changes, and lockfile changes intentional.
- Confirm that no secrets, credentials, private paths, or unsanitized session data are included.

Report vulnerabilities privately according to [SECURITY.md](SECURITY.md), not through a pull request or public issue.
