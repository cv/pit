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

1. Commit the version and release documentation on a `release-X.Y.Z` branch, without a closing keyword, and open a pull request. `main` is protected: it requires a pull request and up-to-date checks, including for administrators.
2. After its checks pass, rebase-merge the pull request and verify CI for the resulting `main` commit.
3. Create and push an annotated tag on that merged `main` commit:

   ```sh
   git tag -a vX.Y.Z -m "pit vX.Y.Z"
   git push origin vX.Y.Z
   ```

4. The Release workflow validates the package and tag, then publishes a release with generated notes and no assets: Pit installs from the tagged source.
5. Verify the release targets the tagged commit and has no assets. Then, before declaring delivery complete, install the tag's runtime dependencies from a fresh clone and run the sandbox:

   ```sh
   git clone --depth 1 --branch vX.Y.Z https://github.com/cv/pit.git /tmp/pit-vX.Y.Z
   cd /tmp/pit-vX.Y.Z
   npm ci --omit=dev
   node --input-type=module -e "const { CodemodeSandbox } = await import('@earendil-works/pi-codemode'); console.log(await new CodemodeSandbox().execute('return 1 + 1'))"
   ```

In Pit, `release.verifyPublished({ tag: "vX.Y.Z" })` performs step 5 and reports every problem it finds.

## Install and smoke-test the tag

Install the exact tag into a throwaway agent directory so the check does not change your own configuration. Call the Pi binary you intend to test by path: an older `pi` earlier on `PATH` may not support `install` and instead starts a session.

```sh
HOME=/tmp/pit-smoke/home PI_CODING_AGENT_DIR=/tmp/pit-smoke/agent \
  /path/to/pi install git:github.com/cv/pit@vX.Y.Z < /dev/null
```

The installed package is under `/tmp/pit-smoke/agent/git/github.com/cv/pit`. Pass that directory as `cwd` to `ux.manageSession` to exercise the installed tag in an isolated Pi, or install it in your own Pi with `pi install git:github.com/cv/pit@vX.Y.Z`.

Run `/reload` after installing or updating the tag, then test:

- a one-shot TypeScript call;
- hashed read and edit behavior;
- shell success, failure, cancellation, and timeout;
- expanded partial and final TUI rendering;
- session, project, and user saved-function behavior, plus read-only global inspection;
- model refresh and selection;
- package update from the exact tag.

Correct release-blocking defects in a patch release rather than moving an existing tag.
