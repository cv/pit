# I Wasn't Trying to Build an App

> How asking an agent for a playlist grew into an adaptive music-recommendation system—and why Pit made the software-building step disappear.

_About a 20-minute read._

## I wanted a playlist

I wasn't trying to build music-recommendation software. I was trying to get a music recommendation.

The conversation began with an ordinary question: what had I listened to in Apple Music? The first answer was wrong. AppleScript reported no recent plays because it could see playback metadata for tracks in my local library, but not the catalog tracks I had streamed throughout the day.

The agent did what a coding agent does when its first approach fails. It inspected the computer. It searched macOS's unified logs, found events emitted by Music's playback subsystem, distinguished track changes from tracks that actually reached a playing state, associated content identifiers with Apple catalog albums, and enriched the results with artist and album metadata. The logs showed 113 track starts from the previous day.

At this point I did something that sounds more like software development: I asked it to save a function that could do this efficiently next time. The investigation became a typed operation:

```ts
getAppleMusicListeningHistory(input?: {
  date?: string;
  includeMetadata?: boolean;
  minObservedSeconds?: number;
})
```

I could then ask for yesterday's top tracks or artists, and the agent could answer with one call instead of rediscovering how Music's logs worked.

From there I asked for ten artists with a similar sound. Then I asked for roughly three hours of representative tracks in a new Apple Music playlist. Then I listened. I came back with reactions: one track was my favourite, another artist was too atonal, another was repetitive but had a great beat. The agent made another playlist, then another. It learned to balance duration, recover from unavailable releases, remember why tracks had been selected, publish explanatory notes, and use my feedback in the next edition.

By the end of the session, the repository contained 18 project functions, nine recommendation manifests, 334 tracks from 99 credited artists, 63 explicit feedback records, a recency-weighted taste profile, a visual journal, and a guarded publication workflow. The session had produced 22 commits.

That list makes this sound like an ambitious coding project. It did not feel like one. I was mostly talking about music.

## The productization step

When a coding agent helps me with an isolated task, there is usually a moment when I have to decide that the result deserves to become software.

A regular Pi session could have found the playback logs and produced the same answer. Pi could also have written an excellent script, extension, or application for me. But I would have needed to notice the repetition, stop pursuing the immediate goal, and say something like:

> These recommendations are useful. Let's turn this into a thing I can call again.

That sentence marks a change of mode. I am no longer using the computer to get a result; I am specifying a product. I need to think about the interface, persistence, error handling, and how a later agent will discover the new capability. None of this is especially difficult for a coding agent, but it requires deliberate intent from me.

Pit changed where that boundary sat. Its tool calls were already programs. A successful program could be named and retained. Retained functions could call one another. A session function could be promoted into readable, versioned project code without changing how it was invoked.

The sequence became:

```text
ask for a result
    ↓
program what is needed
    ↓
retain the useful operation
    ↓
refine it through real use
    ↓
compose it into larger operations
    ↓
keep pursuing the original goal
```

I wrote Pit, so none of those mechanisms surprised me individually. What was reassuring was the better-than-the-sum-of-the-parts effect. I had expected saved TypeScript functions to reduce repeated work. I had not expected them to remove almost all of the psychological shift from using software to building it.

The application emerged without a productization meeting, even an internal one.

## When every tool call is a program

Pi normally gives a model a small toolbox: `read`, `write`, `edit`, and `bash`, with other built-ins available. Pit replaces the active tools with one `typescript` tool. The model submits an ordinary TypeScript expression against typed capabilities:

```ts
async ({ workspace, git }) => {
  const [manifest, status] = await Promise.all([
    workspace.read("package.json", { format: "raw" }),
    git.status(["--short"]),
  ]);

  const pkg = JSON.parse(manifest.content);
  return {
    package: pkg.name,
    scripts: Object.keys(pkg.scripts ?? {}),
    status: status.stdout,
  };
}
```

This is more than changing the syntax of a tool call. The model can use normal programming constructs inside the boundary: concurrency, loops, conditionals, maps, parsing, filtering, aggregation, and explicit sequencing. Intermediate data stays in the restricted process. Only the returned value enters the model's context.

That property mattered immediately in the music experiment. The playback investigation combined a bounded log query, a Python parser, catalog lookups, deduplication, and summary calculations. The Apple catalog searches handled many albums and tracks but returned only plausible matches. Playlist verification reduced the contents of Music to counts, duration, order, and duplicates. The model did not need every raw log line or HTTP response in its conversation.

Under the covers, a Pit call takes this path:

```text
submitted TypeScript
        ↓
contextual type checking
        ↓
resolve referenced saved functions
        ↓
compile a scoped runtime program
        ↓
fresh permission-restricted Node process
        ↓
capability calls over bounded RPC
        ↓
trusted host operations
        ↓
bounded result
```

Pit builds an in-memory TypeScript program containing the generated capability contract, declarations for available saved functions, the submitted source, and any top-level input. It reports semantic errors with source locations before execution.

The validated program is compiled and sent to a fresh Node process started with the permission model enabled. The child cannot directly read the workspace, access the network, or launch subprocesses. When code invokes `workspace.read`, `http.request`, or `shell.execFile`, a lazy proxy sends a bounded request to the trusted Pit extension process, which validates and performs the operation.

This is not an approval boundary. Host capabilities can still change files, run commands, and operate applications with the permissions of Pi. I was using a trusted project and a model I was comfortable allowing to act on my computer. The restriction is nevertheless useful: submitted code cannot bypass the capability layer, and its effects remain attributable and bounded.

The crucial implementation detail for this story is what happens after execution. The tool adapter effectively does this:

```ts
const source = await formatTypeScriptSource(params.code);
const prepared = savedFunctionService.prepare({ source, ... });
const value = await executeSandboxValue(prepared);
await savedFunctionService.commit(prepared, context);
return buildToolResult(value);
```

Preparation and validation happen first. Persistence happens after successful execution. A failed experiment does not normally become part of the agent's future toolbox. `saveOnly` is the explicit exception: it retains a named function after static validation without running its side effects.

This ordering made the music system cumulative without making every attempt permanent.

## The capability ratchet

An anonymous Pit call is disposable. A named top-level function is a candidate for reuse:

```ts
async function getAppleMusicListeningHistory(
  { shell, http },
  input: {
    date?: string;
    includeMetadata?: boolean;
    minObservedSeconds?: number;
  } = {},
) {
  // Query and summarize Music's playback logs.
}
```

Once retained, the function becomes a lexical binding in later TypeScript calls:

```ts
const history = await getAppleMusicListeningHistory({
  date: "2026-08-12",
  includeMetadata: false,
});
```

Session functions are stored as branch-local entries in Pi's session tree. Navigating to another branch reconstructs the function registry for that branch. A function can remain experimental there, override an existing project function, or disappear when the branch changes.

When a function has survived representative use, it can be promoted. Project functions are written as ordinary TypeScript files under `.pi/pit/functions/`, marked with `@pit project`, and checked into Git. Their signatures and summaries are added to future agent prompts, while their full source is injected only when referenced.

This creates a ratchet:

```text
explore
  → save
    → use
      → refine
        → compose
          → promote
```

The listening-history function went through this sequence in miniature. The first attempt used the wrong persistence marker. The next was saved as a session function without execution. A real invocation exposed an error in macOS date handling. The duration calculation was then improved: instead of using the highest playback position, it accumulated plausible wall-clock and playback-position advances between nearby log samples. The final test reported 113 starts and 28,579 sampled playback seconds across two sessions.

Project functions were disabled at the beginning, intentionally. Enabling them required an explicit trusted-project configuration and a reload. Only then did the four initial Apple Music functions move from session state into source files and Git.

Pit also understands dependencies between saved functions. It uses TypeScript's symbol analysis rather than text matching, computes direct and transitive references, and generates a runtime containing only the required closure. Scope constrains what may be referenced: global functions can use global dependencies, project functions can use project and global dependencies, and session functions can use all three scopes.

Later, a complete feedback cycle could be expressed as a function with no direct host capabilities:

```ts
async function runMusicFeedbackCycle({}, input) {
  const before = await updateMusicTasteProfile({ write: false });

  const evaluation = await evaluateRecommendedPlaylistListening({
    manifestId: input.manifestId,
    startDate: input.startDate,
    endDate: input.endDate,
    write: !input.dryRun,
  });

  const after = await updateMusicTasteProfile({ write: true });

  return { evaluation, profileBefore: before, profileAfter: after };
}
```

Its dependency graph was itself an application structure:

```text
runMusicFeedbackCycle
├── evaluateRecommendedPlaylistListening
│   └── getMusicRecommendationManifest
└── updateMusicTasteProfile
```

This was not prose telling a future agent to remember three steps. It was executable composition.

## From 57 calls to a domain operation

Playlist population provided the clearest example of the ratchet being driven by operational failure.

Researching and planning the first playlist took 11 top-level Pit calls. Getting the selected catalog tracks into Music took another 46. The agent checked Accessibility permission, inspected Music's UI hierarchy, tested AppleScript insertion, debugged storefront URLs, navigated contextual menus, and verified the result.

At one point it intended to add “Fantasia” by Grupo Medusa but added “Yoo Doo Right” by Can instead. It detected the mismatch, removed the wrong track, found the correct contextual-menu route, and then populated the 33-track playlist.

The first saved population function encoded what had worked. Internally, it opened each catalog album, located the track row through Accessibility, opened its “More” menu, selected “Add to Playlist,” and verified the playlist afterward. It was useful, but it had inherited the fragility of the investigation.

One positional assumption looked like this:

```applescript
set sg to UI element 2 of front window
```

When Music's layout changed, that became a role-based lookup:

```applescript
set sg to first UI element of front window whose role is "AXSplitGroup"
```

That was more resilient, but it was still automating a menu separately for every track. A later edition exposed the deeper weakness. Music opened with a Lyrics pane, album pages rendered differently, operations timed out after several minutes, and the agent eventually restarted the application while trying to recover.

A reflection pass compared the repeated failures with the function registry. Rather than adding another population helper, it replaced the implementation of the existing intent.

The new strategy used the UI only where Music offered no better interface:

1. Resolve exact title, artist, album, duration, and track URLs through the catalog API.
2. Open one track from each selected album.
3. Press the album-level **Add to Library** button through Accessibility.
4. Wait until Music's scriptable library could find the album.
5. Search the library for an exact title, artist, and album match.
6. Duplicate that library track into the playlist with AppleScript.
7. Skip existing tracks and report missing ones.
8. Compose the playlist-summary function to verify duration and duplicates.

The function kept its name and intent:

```ts
populateAppleMusicCatalogPlaylist({
  name,
  description,
  albums,
  ifExists,
  dryRun,
  country,
  addAlbumsToLibrary,
})
```

But its return value had become an operational checkpoint:

```ts
{
  strategy: "library",
  albumsAddedToLibrary,
  albumsAlreadyInLibrary,
  albumsFailed,
  added,
  skipped,
  missing,
  trackCount,
  uniqueTrackCount,
  duplicateCount,
  duration,
}
```

Retries used `ifExists: "reuse"`. Already-added tracks were skipped. A timeout no longer meant starting over or risking duplicates.

The top-level call counts tell a non-linear story:

| Edition               |     Top-level calls |
| --------------------- | ------------------: |
| First playlist        |                  57 |
| Second playlist       |                  33 |
| Peel Three            |                  71 |
| Peel Sessions 4       |                  13 |
| Peel Sessions 5       |                  10 |
| Peel Sessions 6       |                  10 |
| São Paulo special     |                  13 |
| Rio special           |                   8 |
| Jorge Ben Jor network | 29 across two turns |

Peel Three's 71 calls were not evidence that the abstraction had failed. They were the evidence needed to replace a brittle implementation. Ordinary editions then stabilized around 8–13 calls. The Jorge Ben Jor network became expensive again because it introduced a genuinely new problem: specific historical recordings and interpretations were discoverable in the catalog API but unavailable to the Music library. That exploration produced an alternate-release finder for future editions.

Abstraction reduced the cost of known work. New domain problems still required exploration, and successful exploration could become the next abstraction.

## I was mostly talking about music

The repository history makes the session look like concentrated software development. My experience was different.

I kept detailed tool output collapsed with `Ctrl+O`. I mostly followed Pit's short call descriptions:

- “Record mixed African Head Charge feedback”
- “Balance Peel Sessions 4 to three hours”
- “Create and populate Peel Sessions 5”
- “Publish São Paulo special to lixo.org”
- “Find alternate releases for unavailable connection tracks”

I did not review the generated TypeScript. I did not intervene in its implementation choices. A few times Music itself crashed and macOS displayed a dialog asking permission to restart it; I clicked the button. Otherwise my attention stayed on the playlist and the conversation.

I talked about how repetition can feel static in one track and propulsive in another. I said that Tortoise was experimental but still felt composed, unlike a jam where everyone brought a different idea. I explained that Nala Sinephro after This Heat felt like a warm bath after working outside in the snow. I mentioned records I owned and concerts I had attended. Halfway through one playlist I impulse-bought a Maserati record on vinyl.

The agent was doing substantial programming behind these exchanges, but I was not in a coding frame of mind. The high-level descriptions gave me enough visibility to know what kind of action was happening without requiring me to inspect its mechanics.

The most successful agentic programming may be the programming that leaves the user's attention on the domain.

## A more humane feedback model

Apple Music can observe plays, skips, replays, and explicit favourites. Those signals are valuable; the system used local playback logs to infer completion and early skips when available. But they are a narrow representation of why a piece of music works.

My comments contained qualifications that do not fit naturally into a positive or negative score:

- Arrigo Barnabé was interesting, but not for me: too atonal, too much operatic singing and screaming, too many instruments fighting inside the same arrangement.
- African Head Charge had interesting textures and beats, but some pieces felt as if three minutes of development had been stretched much further.
- Goat was repetitive too, but a tremendous bassline made the repetition physical and cumulative.
- Broadcast was not working for me at that moment, perhaps because of my mood.
- Kelly Lee Owens was too club-oriented at lunch but would be good at 2am.
- M83, New Order, and Depeche Mode were directional coordinates, not destinations.
- A particular transition from This Heat into Nala Sinephro was excellent even though simultaneous internal contrast was often a negative.
- A small amount of rap worked because of sentimental value, clever lines, and its place in a São Paulo playlist.

The agent translated those comments into durable feedback at the narrowest useful scope: artist, track, or trait. It preserved uncertainty and context in notes. Explicit comments outweighed inferred playback. Clarifications replaced a stable record instead of adding duplicate evidence. Foundational favourites could be recorded even when they were not part of a recommendation manifest.

This was not an attempt to turn natural language into a perfect numerical model. The generated profile remained deliberately simple: recency-weighted preferences, confidence, evidence counts, and separate artist and trait lists. The notes preserved meaning that the numeric layer could not represent, such as time of day or why a transition worked.

The division of labour mattered:

```text
functions
  store events
  find manifests
  prevent duplicates
  weight evidence
  rebuild profiles
  report changes

model
  interprets qualifications
  distinguishes curiosity from enjoyment
  chooses the feedback scope
  relates comments to musical traits
  applies context during curation
```

The system did not ask me to translate my taste into its vocabulary. It translated my language into an evolving software model while retaining the original nuance.

That model changed how later playlists were assembled. The duration planner chose a balanced set near three hours, but intentionally did not choose the final order. Sequencing remained editorial judgement. A typical arc moved through ignition, rhythmic release, pressure, warm decompression, long-form development, and a melodic or bodily landing.

One of the most useful learned distinctions was that I could dislike too much contrast occurring simultaneously inside a track while enjoying dramatic contrast between adjacent tracks. That is difficult to infer from completion percentages. It was easy to explain in conversation.

## The application is not Apple Music

By the end of the session, Apple Music was the current technical substrate, not the conceptual boundary of the system.

The durable vocabulary looked like this:

```text
listening history
recommendation manifest
explicit feedback
taste profile
catalog candidates
balanced track selection
editorial sequence
playlist population
published explanation
```

Those concepts formed layers:

```text
conversation
    │
    ├── preferences, corrections, premises
    ▼
recommendation and feedback workflows
    │
    ├── manifests
    ├── explicit feedback
    ├── inferred listening feedback
    └── taste profile
    │
    ├── Apple Music adapters
    │     ├── playback logs
    │     ├── catalog lookup
    │     └── playlist population
    │
    └── publication adapters
          ├── HTML journal
          └── public Git repository
```

If I switched to Spotify, I would need new history, catalog, and playlist adapters. The manifest, explicit-feedback, profile, planning, and editorial concepts could remain. Higher-level composed functions would continue to express the same intent against replacement low-level functions.

The output was similarly replaceable. The 255-character limit on Apple Music descriptions led to a visual HTML journal with one editorial entry per playlist. Later I mentioned that I had been copying the generated page into another repository and publishing it at `lixo.org/music`; that repeated operation became a guarded publication function. It validated the source, required the public repository to be clean and on the expected branch, changed only `music/index.html`, committed, and pushed.

A newsletter could become another renderer and publisher. Preparing a radio programme might add scripts, timings, and spoken links. Becoming a DJ might add energy and tempo transitions. Asking for an all-Japanese lineup for a trip is a new editorial premise, not necessarily a feature request requiring an application release.

This flexibility comes from the semantic level at which the saved functions accumulated. The system grew around what I was trying to accomplish, while Apple Music and HTML remained replaceable implementation choices.

## Where it still broke

This was an experience report, not a controlled benchmark, and the resulting system was not magically reliable.

The main session contained 26 Pit calls that threw errors: nine TypeScript or capability-contract failures, six execution timeouts, four configuration or precondition failures, two host-application failures, one domain-data failure, and four other data or catalog failures. That count does not include every AppleScript operation that returned a non-zero result and was handled inside an otherwise successful TypeScript call.

Music's accessibility hierarchy changed with open panes. Catalog pages sometimes stopped rendering. The application crashed. An album visible through Apple's API could refuse to enter the local library. Exact historical recordings were not always available. Local macOS logs could not account for listening on another device, so zero observed plays could not be interpreted as dislike.

Data growth created another class of failure. Early functions assumed that JSONL manifests and generated HTML could be read in one bounded operation. As the journal grew, later editions fell outside those prefixes. The fix was not to remove the bounds but to introduce paginated manifest lookup and a renderer that composed bounded reads.

Six reflection passes examined the work completed so far and compared repeated operations with the function registry. They preferred extending or composing an existing intent over adding another helper. Proven improvements were promoted. An unreliable research override remained session-scoped rather than becoming project infrastructure.

The process worked because failure was allowed to shape the functions. It did not make failure disappear.

Nor does this imply that every one-off operation should become a saved function. Persistence has a cost: another name, another interface, another dependency, and another behaviour a future agent may rely upon. Pit's ratchet works best when promotion follows representative use rather than enthusiasm after the first success.

## Applications as a byproduct of use

The key moment for me was noticing that I had inadvertently built something that went well beyond the software I was operating.

Apple Music supplied playback and a place to put tracks. The emergent system supplied an explanation of why I should care about a song in this particular playlist. It remembered that I loved one solo but found the rest of an artist inconsistent. It distinguished music suited to lunch from music suited to 2am. It could organize a city special, follow a collaboration network, or turn a favourite bassline into the compass for another three hours of listening.

More importantly, it could continue changing. A new technical substrate would replace adapters. A radical change in preference would become new evidence. A newsletter or radio show would become another output composition. None of those changes requires the original “music recommendation app” to have anticipated them as product features.

This pattern seems broader than music.

A researcher might begin by asking for help finding and comparing papers. Successful searches, extraction rules, provenance checks, and synthesis formats could accumulate into a research system without a separate decision to build one. Someone managing personal finances might begin with a question about one statement; reconciliation, categorization, anomaly checks, and reports could emerge around repeated use. A maintainer might start by investigating one production incident and gradually acquire project-specific diagnostic and recovery functions.

The common shape is:

1. The user pursues a domain goal.
2. The agent writes a bounded program to make progress.
3. A useful operation is retained after it works.
4. Reality refines its interface and implementation.
5. Functions compose into domain workflows.
6. Proven workflows become durable project capabilities.
7. The user's attention remains on the domain.

A conventional coding agent can build every one of these systems. The difference is when the user must decide that system-building has begun.

Pit made that decision optional. It did not make me better at specifying a music application. It let me avoid specifying one.

I talked about music, corrected bad recommendations, asked for new directions, and occasionally requested that useful work be saved, promoted, or committed. Behind the conversation, the agent accumulated typed, executable capabilities. By the time I noticed the system, Apple Music had become one implementation detail inside it.

The strongest validation was not the number of functions or playlists. It was that I became excited to return to the Pit session window and say what I thought of the music.
