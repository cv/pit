# Context-management evaluation

This harness measures whether Pit's model-directed context editing (`session.outline`, `inspectEntry`, `elide`, `summarize`, `setNote`, `notes`, and pressure notices) beats Pi's compaction on accuracy and cost ([#205](https://github.com/cv/pit/issues/205)). It calls real models, so it is not part of `npm test` or CI. Generators, scorers, and the runner live here; results and raw sessions stay in the ignored `results/` directory.

## Design

Each run streams a deterministic task through two feed tools under context pressure: the stream is about twice the evaluation window, so the model must retain, note, or offload what matters.

- `feed_next` returns the next chunk. The data exists only in the worker process, so the model sees each chunk once, in a tool result that context editing and compaction can remove. When a chunk ends with questions, `feed_next` refuses to continue until they are answered.
- `feed_answer` records answers. The first answer to each question is final.

| Task     | Stream                                                             | Questions                                        |
| -------- | ------------------------------------------------------------------ | ------------------------------------------------ |
| `needle` | Prose with two museum catalog codes per chunk                      | Exact codes, at mid-stream and at the end        |
| `kv`     | `PUT <key>` JSON inventory records among prose                     | One field of a stored record, every fourth chunk |
| `logs`   | One service log with a few ERROR lines                             | Counts, order, services, request IDs, and codes  |
| `ledger` | Opening balances, then transfers, deposits, withdrawals, and VOIDs | Current balances, every sixth chunk              |

Scoring is exact after normalizing case, surrounding quotes and whitespace, a trailing period, and digit-group commas. Each answer records its distance: the chunks between the deciding information and the question.

| Condition | Context management                                                                           |
| --------- | -------------------------------------------------------------------------------------------- |
| A         | Pi's auto-compaction only. Pi's built-in tools; Pit is not loaded.                           |
| B         | A plus `compact_context`, which runs the same manual compaction as Pit's `session.compact()` |
| C         | Pit from this checkout, with its context tools, guideline, and 50%/75% notices               |
| D         | C plus the draft [`pit-context` skill](skills/pit-context/SKILL.md)                          |
| E         | C plus a Pit-style notice at an absolute token count, 20% of the window by default           |

Every condition gets the same task prompt, which names the feed tools, the task, and the approximate window, but not any context tool. A run that stops early is nudged to continue up to three times.

`--memory` selects where the model may keep data. With `files`, the default, it may use workspace files, as in a real session; in the pilot, models in every condition offloaded facts to files, so accuracy mostly measured file use. With `context`, the prompt also tells the model to keep everything in the conversation, which isolates context management. The prompt is the only enforcement, so the summary counts external writes.

Pressure comes from an evaluation model entry whose `contextWindow` is reduced, by default to 32,000 tokens, not from truncating inputs. Pi's compaction uses that window, with `reserveTokens` and `keepRecentTokens` each set to a quarter of it. The worker loads only Pit (when the condition uses it) and the feed extension: no other extensions, skills, prompt templates, or context files, and an empty temporary agent directory, so user and global saved functions do not change the prompt. Model definitions and credentials are read from your agent directory.

## Repository task

The synthetic tasks isolate retention; `--tasks repo` checks that their results transfer to coding work. In a repository the model can re-read almost anything from disk, so what lives only in the conversation is what the user said, the decisions made, and progress. Re-reading becomes a cost to measure.

The generator ([`repo/`](repo/)) writes "shopline", a seeded, dependency-free Node.js library (`node --test`) with about 20 modules, docs, a 20K-token CI log, and a 300-order export, and commits it to a fresh Git repository. Eight tickets arrive one at a time as user messages; the model calls `ticket_done` to receive the next. A ticket the model does not report done after `--max-nudges` reminders is skipped.

| Ticket | Work                                                                    | Long-range dependency                                                                  |
| ------ | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 1      | Fix the CSV parser from the two failing rows in a CI log                | Log triage                                                                             |
| 2      | Convert `applyDiscount` to integer cents; halves round by a seeded rule | Sets a standing rule: no `parseFloat` or `toFixed` in `src/money/` and `src/billing/`  |
| 3      | Implement shipping from the zone table in `docs/SHIPPING.md`            |                                                                                        |
| 4      | Add `refundCents`                                                       | Sets two standing rules: never modify `src/legacy/`, and new exports need `@since 2.4` |
| 5      | Round tax to the nearest cent                                           | "The same rule we agreed for discounts in ticket 2"                                    |
| 6      | Fix a disputed order from the export                                    | Only the best discount code applies                                                    |
| 7      | Rename `calcTotal` to `orderTotal`, keeping an alias                    | The legacy and `@since` rules                                                          |
| 8      | Changelog entries for every ticket, and a passing suite                 | Progress across the session                                                            |

Scoring copies the final workspace, runs the visible suite, then hidden tests kept outside the workspace. Twelve checks pass or fail: each ticket's hidden tests (ticket 7 also needs no `calcTotal` left in `src/` outside `total.js` and `src/legacy/`; tests may still exercise the alias; ticket 8 needs the changelog lines and a passing suite), the three standing rules checked statically, and a regression suite for modules no ticket touches. The `@since` rule applies only to exports added after ticket 4 arrived. Accuracy is the share of checks passed. The task's own tests confirm that the shipped repository fails every ticket and that a reference solution passes all twelve checks for both rounding rules.

Run it with a 64K window, where condition A compacts repeatedly, and once at the model's full window as a ceiling.

## Run

Requires `jq` on `PATH` (for the session audit) and credentials for the evaluated providers. For a provider whose stored key comes from an interactive helper such as a password manager, run from your terminal or pass the key for this process only:

```sh
export PIT_EVAL_API_KEY=...   # optional; applies to every model in the run
```

Preview the matrix, then run it:

```sh
npm run eval:context -- --models provider/model-a,provider/model-b --dry-run
npm run eval:context -- --models provider/model-a,provider/model-b --seeds 1,2,3 --concurrency 2
```

The repository task needs a larger window and more time:

```sh
npm run eval:context -- --models provider/model --tasks repo --window 64000 --seeds 1,2 --timeout-minutes 180
```

`--conditions`, `--tasks`, `--window`, `--chunks`, `--chunk-tokens`, `--notice-tokens`, `--thinking`, `--max-nudges`, and `--timeout-minutes` adjust the matrix; `--help` lists them. `--thinking` defaults to `off`; models that require reasoning, such as recent Claude models, need `--thinking low` or higher. Results go to `eval/context/results/<timestamp>/` unless `--out` names a directory. Rerunning with the same `--out` skips finished runs, so an interrupted evaluation resumes.

Each results directory holds:

- `runs/<id>.json`: the spec, status, score with every answer, the base prompt size, and the `sessions.analyze()` telemetry for the session.
- `sessions/<id>/`: the raw Pi session.
- `logs/<id>.log`: worker output.
- `summary.md`: tables by model and condition. Regenerate it with `node --import tsx eval/context/report.ts <results-directory>`.

## Metrics

The summary reports means with sample standard deviations over runs:

- Accuracy, overall, by task, and by question distance.
- Input tokens: the prompt side (`input + cacheRead + cacheWrite`) of every provider request, including compaction summaries; cache reads; weighted tokens, which price uncached input at 1, cache reads at 0.1, cache writes at 1.25, and output at 5 (Anthropic's published ratios), because an edit re-writes the prompt cache from its earliest target onward; cost when the provider reports prices; wall time; and the base prompt, the first request's prompt size.
- Compactions, split into automatic and model-requested.
- Context edits by operation, estimated tokens freed, and summed `reprefillTokens`.
- Pressure notices and how many were followed by an elide or summarize within three model turns.
- Churn: literal `inspectEntry("id")` reads of entries an earlier edit removed, and entries removed more than once.
- External writes: tool calls that could store data outside the conversation, namely `bash`, `write`, `edit`, and Pit programs that use the shell or edit workspace files. In `context` mode these are instruction violations.
- Refusals: assistant messages the provider ended as refusals. Claude models on Bedrock intermittently refused requests while the filler prose was random word salad, which likely resembles adversarial noise; the generators now write grammatical filler, which stopped the refusals in testing. Pi's own retries recover most refusals, and the worker continues after a refusal up to ten more times per run and reports the count.

The same telemetry is available for any recorded session through `sessions.analyze()` and `sessions.analyzeRecent()`.

## Limits

- Conditions A and B use Pi's built-in tools because Pit cannot run without its context tools. The base-prompt column shows the prompt overhead this adds to C–E.
- Condition E's notice uses Pit's wording. Its level is the whole percentage at which it fired, so a count past 50% of the window also stands in for Pit's 50% notice.
- In `files` mode a model can keep data in workspace files, which is a legitimate strategy that bypasses context management. Pit programs can also call the feed tools and return only what they extract, in either mode; that is part of what condition C measures.
