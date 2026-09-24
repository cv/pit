# Releasing Pit

Pit is distributed only through GitHub: `main` for the latest changes and tags for pinned releases. Keep `private: true` in `package.json`; do not publish Pit to npm.

## Prepare

1. Confirm the release tracking issue is current.
2. Confirm the intended Pi version has been tested and documented without overstating compatibility.
3. Review dependency updates and run `npm audit`.
4. Update `CHANGELOG.md`, `package.json`, and `package-lock.json` to the release version, and point the README's pinned install example at the new tag.
5. Keep the README's primary install command unpinned (`pi install git:github.com/cv/pit`); `npm run package:check` enforces both.
6. Run a full-history secret scan before the first public release or after adding substantial generated/session artifacts.
7. Review the dry-run package file list and size.
8. Confirm the reusable Wasmtime prebuild workflow has successfully built and smoke-tested Linux, macOS, and Windows on ARM64/x64 before tagging.

## Validate

```sh
npm run check
npm test
npm run coverage
npm run package:check
npm run quality:audit
npm pack --dry-run
```

Review the final diff and confirm a clean worktree. Changes to TUI, extension loading, saved functions, sandboxing, progress, or rendering require an interactive reload smoke test before the tracking issue is closed.

## Publish

1. Commit the version and release documentation without a closing keyword.
2. Push `main` and verify CI for that exact commit.
3. Create and push an annotated tag:

   ```sh
   git tag -a vX.Y.Z -m "pit vX.Y.Z"
   git push origin vX.Y.Z
   ```

4. The Release workflow builds and smoke-tests all six addons and the shared QuickJS component, validates the package/tag, and publishes them with a versioned SHA-256 manifest.
5. Verify the release targets the tagged commit and contains exactly six `.node` assets, one `.wasm` component, and `pit-wasmtime-checksums.json`.
6. Test the installer against the published release with strict checksum verification before declaring delivery complete.

## Install and smoke-test the tag

```sh
pi install git:github.com/cv/pit@vX.Y.Z
```

Restart Pi after a native addon update (Node caches loaded `.node` modules). For source-only updates, `/reload` is sufficient. Then test:

- a one-shot TypeScript call;
- hashed read and edit behavior;
- shell success, failure, cancellation, and timeout;
- expanded partial and final TUI rendering;
- session, project, and user saved-function behavior, plus read-only global inspection;
- model refresh and selection;
- package update from the exact tag.

Correct release-blocking defects in a patch release rather than moving an existing tag.
