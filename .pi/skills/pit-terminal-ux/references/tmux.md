# Agent-driven Pi acceptance with tmux

Use tmux when available to exercise the **real Pi TUI**, rather than asking the user to perform checks the agent can automate. This complements component tests: a PTY exposes expansion, scroll anchoring, redraws, real cancellation, and selection behavior that `render(width)` snapshots cannot establish.

The [offline fixture provider](../assets/fixture-provider.ts) emits deterministic calls to Pit's real `typescript` tool. It does not contact a model service. It is a test extension, not a production provider or a replacement renderer. Read it before use and recheck the installed Pi provider/extension contracts when updating it.

## Isolation and setup

1. Resolve the installed `tmux`, `pi`, and Node executables. Create a private temporary directory and a uniquely named tmux socket/session for this run.
2. Start the test server with an empty tmux configuration (`-f /dev/null`) and a clean environment (`env -i`). Retain only the executable search path and necessary locale/terminal variables. Point `HOME` and `PI_CODING_AGENT_DIR` at temporary directories. Do not inherit API keys, auth files, settings, or extension discovery from the user's session.
3. Use a repository working directory, and explicitly load only `src/index.ts` and the fixture provider with `-e`. Pass `--no-extensions`, `--no-skills`, `--no-context-files`, `--no-prompt-templates`, `--no-themes`, `--no-builtin-tools`, `--offline`, and the per-run project trust flag `--approve`. Disable telemetry for the fixture process.
4. Select `--provider pit-ux-fixture --model fixture --api-key fixture-not-a-real-key --thinking off`. Store sessions under the temporary directory. Select the initial theme and TUI mode explicitly with `--use-theme dark|light` and `--tui-mode regular|fullscreen`.
5. On the isolated server only, enable `extended-keys` for modified keys. For clipboard checks, enable `set-clipboard on`; with no attached client, this exercises OSC 52 into a test tmux buffer without altering the user's desktop clipboard.
6. Verify the fixture model appears in the footer before sending a case name. `--offline` alone only disables startup networking; isolation and the deterministic provider are what prevent real model requests.

Use the project functions. `ux.manageSession` performs steps 1-6 and returns the run's root, socket, and target. `ux.runCase` sends a prompt or tmux keys and captures rows once a new completion appears, or after `delayMs` for states without one, such as a running command. `ux.runFixtures` runs fixtures in new sessions and reports their status rows. `ux.inspectRowStyle` reports a row's SGR codes. They refuse sockets outside `/tmp/pit-ux-*`, and stopping removes only the run's own server and directory. For checks they do not cover, such as mouse selection, use `shell.execFile` with argument arrays against the same socket and target. **Never send keys to the active conversation pane, load the fixture provider in a normal session, or issue a bare `tmux kill-server`.** Do not modify the user's tmux configuration.

## Fixtures and controls

Submit one fixture name as ordinary prompt text:

| Fixture             | Expected behavior                                                                                                      |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `trace-a`–`trace-e` | Pure value, one/two small reads, `bc` sum, and concurrent `wc` counts followed by `bc`; require `bc` and `wc` on PATH. |
| `success`           | Exit 0, separate stdout/stderr, no duplicated retained logs.                                                           |
| `nested`            | Two returned process results; outcomes, identity, and indentation survive composition.                                 |
| `read`              | Real params-based, paged file read with visible source, params, revision, and incompleteness.                          |
| `failure`           | Intentional exit 2, not a successful-looking result.                                                                   |
| `error`             | Thrown multiline error with the final diagnostic still inspectable.                                                    |
| `invalid`           | Validation failure whose source mentions `timeoutMs`; must not become a timeout.                                       |
| `timeout`           | Actual subprocess deadline, with clear cause and retained output.                                                      |
| `progress`          | Several real partial updates followed by a stable final result.                                                        |
| `cancel`            | Long-running subprocess that prints `CANCEL_PID`; Escape should cancel it and terminate that child.                    |
| `cancel-tree`       | Shell pipeline `sleep 3001 \| cat`; after Escape, no `sleep 3001` may remain.                                          |
| `cancel-silent`     | Quiet direct child `sleep 3003`, for exit and `/new` checks without output-driven failures.                            |
| `timeout-tree`      | Pipeline `sleep 3002 \| cat` with a 1 s deadline; no `sleep 3002` may remain after the timeout.                        |
| `dialog-timeout`    | `ui.confirm` left unanswered past a 3 s deadline; the dialog must close when the call times out.                       |
| `tty-probe`         | Writes to `/dev/tty`; the command must fail without drawing `PIT_TTY_PROBE` into Pi's screen.                          |
| `save-probe`        | Saves the session function `probeSaved`, for `promote-timeout`.                                                        |
| `promote-timeout`   | User promotion whose confirmation outlives its 3 s call; the dialog closes and no `probeSaved.ts` is written.          |
| `json`              | Heterogeneous fields and multiline patch content without field loss.                                                   |
| `batch`             | Real settled read batch with one deliberate missing-file failure.                                                      |
| `calls`             | Sixty interleaved call groups, then a slow subprocess; live and settled dashboards stay honest and usable.             |
| `http`              | Synthetic HTTP 503 data exercises domain-error presentation without a network request.                                 |
| `transport`         | Simulated provider-stream error before arguments complete; the call must be identified as not executed.                |
| `npm-pack`          | Real JSON dry run: tarball identity, sizes, and file count lead the complete JSON inventory.                           |
| `npm-audit`         | Synthetic report (no registry request): severity counts and findings lead the complete JSON report.                    |
| `npm-outdated`      | Synthetic report (no registry request): per-package versions lead the complete JSON report.                            |

Use `/new` between cases when independent captures are useful. Expansion state persists across new sessions: track it rather than blindly toggling twice. Use the configured expand action (the isolated default is Ctrl+O).

Resize to 60, 80, and 120 columns with `resize-window`. Capture both the initially visible expanded viewport and the top of the entry. In fullscreen mode, Home/End navigate the transcript; in regular mode they control the editor, so inspect terminal scrollback with `capture-pane -S` instead. Long expanded entries may extend above the initial viewport because Pi follows the bottom; do not confuse off-screen data with missing data, and do not mistake correct document order for good initial viewport placement.

## Evidence to collect

- Plain `capture-pane -p` output for collapsed, expanded, partial, and final states; retain ANSI captures (`-e`) when comparing theme/style changes.
- Two partial captures showing actual advancement, then two settled captures showing no continued spinner or elapsed-time drift.
- Cancellation through a real Escape key, the resulting UI state, and a process-existence probe using the observed fixture PID. Verify the child is gone; a label alone is not cancellation evidence. Probe descendants too (`cancel-tree`), not only the direct child.
- For exit checks, start with `ux.manageSession({ action: "start", keepShell: true })`. Otherwise Pi's exit closes the pane, and its hang-up kills Pi's descendants whatever Pit did, which hides leaks that a real terminal would keep running.
- Live dark/light switching through `/settings`, not just constructing separate theme objects. Confirm existing tool rows change their ANSI styles while retaining content.
- Fullscreen transcript search for a sentinel, with correct match navigation and visible result text.
- Drag-selection of an output sentinel and the resulting tmux buffer. SGR mouse reports can be sent to the isolated pane: press `ESC[<0;x;yM`, drag `ESC[<32;x2;y2M`, release `ESC[<0;x2;y2m`. Derive coordinates from the current capture, not fixed assumptions. Read back `show-buffer` and compare the actual copied text.

The mouse/OSC 52 check verifies Pi's selection-to-terminal-buffer path. It does **not** certify integration with every desktop clipboard, terminal emulator, font, or colour profile. Record that boundary explicitly.

Save bounded captures and a short finding ledger. Separate observations from assumptions: a returned process result verifies execution; a terminal capture verifies the visible state; inspecting raw ANSI validates style changes, not subjective colour preference. Include deliberate failures in the evidence rather than reporting all nonzero fixture exits as test failures.

## Fix, rerun, and clean up

When a capture exposes a defect, add a focused regression, fix the responsible layer, and rerun the affected fixtures after reloading the isolated Pi. Follow `pit-delivery` for standard gates, a non-closing push, exact-commit CI, and final reload acceptance. Keep the normal user session untouched; only ask the user about subjective preferences or interactions the isolated test cannot exercise.

Before teardown, cancel any active fixtures and verify their subprocesses have stopped. Exit the test Pi instances and remove only the run's isolated server. Keep useful captures until the review record is written; do not copy credentials or unrelated terminal history into repository artifacts. Document remaining limitations before marking live acceptance complete or requesting a merge.
