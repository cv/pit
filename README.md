# pit

**One typed tool for Pi, instead of a toolbox.**

Pit is an extension for the [Pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent). It swaps Pi's built-in tools for a single `typescript` tool. Rather than reading a file, running a command, and making an edit in three separate turns, the model writes one small TypeScript function that uses the dependencies it needs, and only that function's return value comes back.

```ts
async ({ workspace: { read }, git: { status: gitStatus } }) => {
  const [manifest, status] = await Promise.all([
    read("package.json", { format: "raw" }),
    gitStatus(["--short"]),
  ]);

  const pkg = JSON.parse(manifest.content);
  return {
    package: pkg.name,
    scripts: Object.keys(pkg.scripts ?? {}),
    status: status.stdout,
  };
}
```

That call reads a file and checks Git status in parallel, then returns a three-field summary, not two raw outputs. The agent writes the TypeScript; you don't need to learn the API to use Pit.

## Why try it

- **Fewer round trips.** Related reads, commands, and edits, plus the logic between them, fit in one call.
- **Quieter context.** Intermediate output stays inside the call; only the returned value reaches the model.
- **Earlier feedback.** Each call is type-checked before it runs, so a misspelled method or bad argument is reported with its line and column before anything happens.
- **Reusable workflows.** A call that works can be saved as a typed function and reused later in the session, across a project, or in all your projects.

Each call runs in a fresh Wasmtime/QuickJS sandbox with no direct access to files, the network, or processes. It can affect the host only through the functions it requests, and results are bounded so the context and TUI stay compact.

It's a different way of working, and it won't suit every setup. Pit makes `typescript` the only coding tool the model sees by default. Other tools stay active, so extensions and Pi features that depend on them keep working, but their declarations are hidden. You can [declare specific tools directly](docs/configuration.md#allow-other-tools), but otherwise the agent's coding work goes through TypeScript.

For a longer first-hand account, see [I Wasn't Trying to Build an App](docs/case_study/), a case study of growing a music-recommendation system through everyday Pit use.

## Install and update

Pit needs Node 22.19 or newer and Pi 0.99 or newer, and is tested with Pi 0.99.0. Prebuilt runtimes are available for Linux, macOS, and Windows on ARM64 or x64.

Install the latest version:

```sh
pi install git:github.com/cv/pit
```

This tracks `main`, where releases are cut from; changes land there only after CI passes. To update:

```sh
pi update git:github.com/cv/pit
```

Run `/reload` in Pi after source-only updates. Restart Pi after a native runtime update, because Node caches loaded addons.

To pin a release instead (package updates won't move a pinned install):

```sh
pi install git:github.com/cv/pit@v0.21.1
```

See [configuration](docs/configuration.md) for one-session and project-only installs, and [troubleshooting](docs/troubleshooting.md) if the runtime cannot load. Pit is distributed from GitHub only; it isn't published to npm. [Releases](https://github.com/cv/pit/releases) and the [changelog](CHANGELOG.md) describe what changed.

> [!IMPORTANT]
> Pi extensions run with your user's permissions, so review the source before installing. Pit sandboxes the code the model writes, but the functions it exposes can still change files, run commands, and reach the network. Dependency injection is not an approval boundary. See the [security model](docs/security.md).

## Use it

Start Pi and ask for work as usual—for example, “Inspect this repository and summarize how to run its tests.” Pit supplies the agent with its typed function contract; you don't need to paste the example above.

Calls appear as compact descriptions in the terminal. Press `Ctrl+O` to inspect the submitted code, retained result, and execution details. See the [usage guide](docs/usage.md) for authoring calls and reading their results.

When an operation proves useful, ask the agent to keep it as a named function. For example: “Save that test workflow so we can reuse it.” A successful definition becomes a session function; later calls can compose it with other functions:

```ts
async function runTests({ npm: { test } }, input: { coverage?: boolean } = {}) {
  return test({ coverage: input.coverage, raise: true });
}
```

```ts
async ({ runTests }) => runTests({ coverage: true })
```

Use `/functions` to inspect and manage definitions. Proven functions can be promoted to a trusted project or your user directory; `/pit-reflect` helps identify worthwhile reuse. See [saved functions](docs/saved-functions.md) for scopes, promotion, and overrides.

## Documentation

Start at the [documentation index](docs/README.md), or go directly to:

- [Usage](docs/usage.md): calls, parameters, concurrency, safe edits, and results.
- [Saved functions](docs/saved-functions.md): reusable workflows and their lifecycle.
- [Configuration](docs/configuration.md): installation options, tool exceptions, trust, and runtime settings.
- [Reference](docs/reference.md): tool parameters, global functions, defaults, and limits.
- [Security model](docs/security.md) and [troubleshooting](docs/troubleshooting.md).
- [Contributing](CONTRIBUTING.md): local development and review requirements.
- [Architecture](docs/architecture.md) and [releasing](docs/releasing.md): maintainer guides.

## Support

Use [GitHub Issues](https://github.com/cv/pit/issues) for reproducible bugs and focused feature requests. Support is best effort for the tested Pi and Node.js versions above; other environments may work but are not guaranteed.

Do not report suspected vulnerabilities in public issues. Follow [SECURITY.md](SECURITY.md) instead. Contributions are welcome under [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
