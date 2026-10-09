# pit

**One typed tool for Pi, instead of a toolbox.**

Pit is an extension for the [Pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent). It replaces Pi's built-in coding tools with a single `typescript` tool, so the agent can read files, run commands, and act on the results in one call:

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

- **Fewer round trips.** Related reads, commands, and edits, plus the logic between them, fit in one call. Independent work can [run in parallel](docs/usage.md#control-concurrency).
- **Quieter context.** Only what the call returns reaches the model, so intermediate output never fills the conversation.
- **Sandboxed execution.** Each call runs in a fresh Wasmtime/QuickJS sandbox with no direct access to files, the network, or processes. It reaches the host only through the functions it requests, and results are bounded to keep the context and TUI compact.
- **Earlier feedback.** Calls are [type-checked before they run](docs/usage.md#build-a-call), catching misspelled methods and bad arguments before anything happens.
- **Reusable workflows.** A useful call can become a [saved function](docs/saved-functions.md), ready to reuse in the session, share with a project, or carry across your projects.

Pit makes `typescript` the only coding tool the model sees by default. Extension and MCP tools remain available through it; if your setup needs them visible directly, you can [allow selected tools alongside it](docs/configuration.md#allow-other-tools).

Want to see what that looks like over time? [I Wasn't Trying to Build an App](docs/case_study/) follows a music-recommendation system growing through everyday Pit use.

## Install and update

Pit needs Node 22.19 or newer. It supports the Pi version it pins in `package-lock.json`, currently Pi 1.1.0; other Pi versions are not supported. Prebuilt runtimes are available for Linux, macOS, and Windows on ARM64 or x64.

Install the latest version:

```sh
pi install git:github.com/cv/pit
```

This tracks `main`, where changes land after CI passes. To update:

```sh
pi update git:github.com/cv/pit
```

Run `/reload` after source-only updates; restart Pi after a native runtime update. Prefer a fixed release? Use `pi install git:github.com/cv/pit@v0.28.0` instead; package updates won't move a pinned install.

For a one-session trial or a project-only install, see [installation options](docs/configuration.md#installation-scope). Pit is distributed from GitHub, not npm; [releases](https://github.com/cv/pit/releases) and the [changelog](CHANGELOG.md) cover what's new.

> [!IMPORTANT]
> Pi extensions run with your user's permissions, so review the source before installing. Pit sandboxes the code the model writes, but the functions it exposes can still change files, run commands, and reach the network. Dependency injection is not an approval boundary. See the [security model](docs/security.md).

## Use it

Start Pi and ask for work as usual: “Inspect this repository and summarize how to run its tests.” The agent writes the calls; you don't need to paste the example above or learn the API.

Calls appear as compact descriptions in the terminal. Press `Ctrl+O` to see the code, result, and execution details. The [usage guide](docs/usage.md#read-results-in-the-tui) shows how to follow the work without wading through every intermediate output.

From there, try a workflow that fits your project:

- **Work with more than text.** Ask the agent to compare local screenshots or inspect a generated chart. [Image viewing](docs/usage.md#view-workspace-images) brings those files into the same workflow as code and commands.
- **Keep your existing tools.** Tools from other extensions and MCP servers can join the same calls, so the agent can [combine their results with local work](docs/usage.md#call-other-pi-tools).
- **Keep what works.** Ask, “Save that test workflow so we can reuse it,” and the agent turns the call into a [saved function](docs/saved-functions.md).
- **Manage and share functions.** Use `/functions` to inspect saved functions, and promote proven ones to a trusted project or your user directory. `/pit-reflect` helps spot opportunities for reuse.

## Documentation

Start at the [documentation index](docs/README.md), or go directly to:

- [Understand a call](docs/usage.md): how the agent combines operations, edits safely, and handles results.
- [Make Pit fit your setup](docs/configuration.md): installation options, tool visibility, and trusted project functions.
- [Look up an API](docs/reference.md): available functions, parameters, and limits.
- [Resolve a problem](docs/troubleshooting.md): installation and runtime diagnostics.
- [Saved functions](docs/saved-functions.md): reusable workflows and their lifecycle.
- [Security model](docs/security.md): the sandbox, injected capabilities, and trust boundaries.
- [Contributing](CONTRIBUTING.md): local development and review requirements.
- [Architecture](docs/architecture.md) and [releasing](docs/releasing.md): maintainer guides.

## Support

Use [GitHub Issues](https://github.com/cv/pit/issues) for reproducible bugs and focused feature requests. Support is best effort for the tested Pi and Node.js versions above; other environments may work but are not guaranteed.

Do not report suspected vulnerabilities in public issues. Follow [SECURITY.md](SECURITY.md) instead. Contributions are welcome under [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
