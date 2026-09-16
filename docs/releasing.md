# Releasing Pit

Pit is distributed only through tagged GitHub releases. Keep `private: true` in `package.json`; do not publish Pit to npm.

## Prepare

1. Confirm the release tracking issue is current.
2. Confirm the intended Pi version has been tested and documented without overstating compatibility.
3. Review dependency updates and run `npm audit`.
4. Update `CHANGELOG.md`, `README.md`, `package.json`, and `package-lock.json` to the release version.
5. Confirm installation examples reference the exact tag.
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

1. Commit the version and release documentation without a closing keyword.
2. Push `main` and verify CI for that exact commit.
3. Create and push an annotated tag:

   ```sh
   git tag -a vX.Y.Z -m "pit vX.Y.Z"
   git push origin vX.Y.Z
   ```

4. The Release workflow validates the tag and creates the GitHub release.
5. Verify the release targets the tagged commit and contains no unintended assets.

## Install and smoke-test the tag

```sh
pi install git:github.com/cv/pit@vX.Y.Z
```

Run `/reload`, then test:

- a one-shot TypeScript call;
- hashed read and edit behavior;
- shell success, failure, cancellation, and timeout;
- expanded partial and final TUI rendering;
- session, project, and global saved-function behavior;
- model refresh and selection;
- package update from the exact tag.

Correct release-blocking defects in a patch release rather than moving an existing tag.
