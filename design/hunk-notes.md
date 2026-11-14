# hunk-notes design

## Purpose

The `hunk-notes` extension preserves Hunk review comments on disk so people and agents can read them after a review window closes. Hunk normally keeps user notes and agent comments only inside the live process, discarding them on exit.

Once installed, the extension loads into every Hunk process, records comments whenever they change, and adds a `hunk notes` command to query past reviews by repository checkout or list every saved review.

## Assumptions

The extension relies on three behaviors of Hunk 0.25.0 and the host filesystem.

- Hunk emits lifecycle events for startup, changeset loads, comment changes, and normal shutdown (`q`), and passes the comment list through its daemon CLI (`hunk session list --json` and `hunk session comment list <sessionId> --type all --json`).
- A live Hunk session registers with the daemon by process ID within three seconds of the first comment change, and subprocess calls complete within a five-second timeout.
- The local filesystem supports `0700` directory permissions, `0600` file permissions, exclusive file creation, and atomic same-directory `rename`.

## Guarantees

1. Reviews without comment changes leave the filesystem untouched. A Hunk run that emits zero comment-change events creates neither the storage folder nor any review file.
2. Saved review files are private and complete. The storage folder uses mode `0700` and each review file uses mode `0600`. Readers observe either the previous saved JSON or the next saved JSON.
3. Normal exit preserves the latest comments whenever Hunk finishes saving within its shutdown window. Rapid edits collapse into a follow-up write, a background failure retains dirty state for one final shutdown attempt, and deleting the last comment saves an empty `comments` array.
4. Save failures surface once per review without stopping Hunk. When session lookup, comment retrieval, or disk writes fail, Hunk shows one warning notice for that review and continues running.
5. Checkout lookups resolve symbolic links, select the deepest matching repository first and then the newest review by start time, and avoid git or jj subprocesses. Sibling paths that share a prefix, such as `/repo-other` beside `/repo`, never match.

## Implementation

### Pieces

- A live session means one review registered in Hunk's daemon under a `sessionId` and process ID.
- A comment means either a user note or an agent comment returned by Hunk's comment list command.
- The storage directory is `${XDG_STATE_HOME:-$HOME/.local/state}/hunk-notes` when `XDG_STATE_HOME` is absolute, or `$HOME/.local/state/hunk-notes` otherwise.
- A review file is one JSON document named `<YYYY-MM-DDTHH-mm-ss.SSS>-<pid>.json` in local time inside the storage directory.
- The entry point (`index.js`) connects Hunk's `startup`, `changeset_loaded`, `note_changed`, and `shutdown` events to the recorder and registers the `notes` CLI command.
- The recorder (`createRecorder` in `notes.js`) tracks the startup working directory, debounces change events over 250 ms, serializes saves so one write runs at a time, tracks dirty state across failures, and rotates to a new review file if `changeset_loaded` introduces a different `sessionId`.
- The storage helper (`writeReview` in `notes.js`) creates the storage directory with mode `0700`, writes JSON to a unique exclusive `.tmp` sibling file with mode `0600`, and renames it into place.
- The CLI handler (`notesCommand` in `notes.js`) reads saved `.json` review files, sorts them newest first by `startedAt`, and prints either the best matching review, the `--all` summary array, or usage help.

```text
  Comment change ──▶ Debounced recorder (250 ms, one write at a time)
                             │
                             ▼
                  Hunk daemon CLI (5 s timeout)
                             │
                             ▼
                  Exclusive temp file (0600) ──▶ Atomic rename
                                                       │
                                                       ▼
                                        Storage directory (0700)
                                                       ▲
                                                       │
  hunk notes [path | --all] ───────────────────▶ CLI query
```

Figure 1 shows the write and query paths through the storage directory. Saves serialize through one loop, while the CLI reads finished `.json` files directly.

### Walkthrough

Suppose a user opens `hunk diff abc def` in `/tmp/work/repo`, where `/tmp` is a symbolic link to `/private/tmp`.

1. On `startup`, the recorder stores `cwd` (`/tmp/work/repo`) verbatim and initializes a filename from the current local time and `process.pid`, such as `2026-11-14T09-26-44.285-75895.json`.
2. An agent or user adds a comment. Hunk emits `note_changed`, so the recorder increments its change version, marks the review dirty, stores the event context for notifications, and starts a 250 ms timer.
3. When the timer fires, the recorder enters its serial save loop. On the first save, `findSession` polls `hunk session list --json` up to 13 times at 250 ms intervals within a three-second elapsed deadline until it finds the entry matching `process.pid`.
4. The recorder resolves `repo` with `fs.realpath` from `session.repoRoot` (falling back to `cwd` when `repoRoot` is absent, such as in `hunk gh` or `hunk patch`), fetches comments with `hunk session comment list <sessionId> --type all --json`, and calls `writeReview`.
5. `writeReview` writes `{ version: 1, repo, cwd, command, startedAt, updatedAt, comments }` into a new exclusive `.tmp` file with mode `0600` and renames it over the target review file.
6. If another comment change arrives during that write, the change version advances, keeping the review dirty so the loop runs one more save before idling.
7. When the user quits with `q`, Hunk emits `shutdown` and awaits the recorder's flush promise. If a change arrived during the debounce window or a prior background write failed, the recorder attempts one final save before resolving.
8. Later, running `hunk notes` from `/tmp/work/repo/sub` calls `path.resolve(ctx.cwd, ".")`, resolves the target with `fs.realpath` to `/private/tmp/work/repo/sub`, and selects the deepest matching `repo` root (breaking ties by newest `startedAt`).

### Storage Format and CLI

Each review file uses UTF-8 JSON with seven top-level fields.

| Field | Value |
| --- | --- |
| `version` | integer `1` |
| `repo` | real path of `session.repoRoot`, or startup `cwd` when `repoRoot` is absent |
| `cwd` | startup working directory string received from Hunk |
| `command` | `process.argv.slice(2)` |
| `startedAt`, `updatedAt` | UTC ISO-8601 timestamps |
| `comments` | `comments` array from `hunk session comment list <sessionId> --type all --json` |

The `hunk notes` command accepts four input shapes.

- `hunk notes [path]` prints the matching review as JSON, or `No saved review found for this path.` with exit code `0`. The target path must exist on disk for real-path resolution.
- `hunk notes --all` prints a JSON array sorted by `startedAt` descending, with `{ file, startedAt, repo, command, comments }` where `comments` is the comment count.
- `hunk notes --help` prints usage and exits with `0`, even when `HOME` is unset.
- Unknown flags or multiple arguments print usage to stderr and exit with `1`.

## Failures

- Missed registration deadline (tests Guarantee 4). When `findSession` exceeds 13 polls or three seconds, it throws; the recorder issues one warning, exits the background loop, and keeps dirty state for shutdown. Guarantee 3 fails in this case because Assumption 2 did not hold.
- Transient daemon, subprocess timeout, or disk write failure (tests Guarantees 3 and 4). Any failure inside `save` aborts subprocesses at five seconds, shows one warning, and stops background retries while keeping the dirty flag set so `shutdown` tries once more on exit.
- Pre-existing or interrupted temporary files (tests Guarantee 2). Exclusive `wx` creation with a unique process-and-UUID suffix skips stale `.tmp` files, `chmod 0600` enforces private permissions, and `.tmp` cleanup removes failed writes while `readReviews` reads `.json` filenames only.
- Embedded reviews in `hunk status` or `hunk log` (tests Guarantee 4). Clearing the cached session on `changeset_loaded` lets a second review in the same process detect its new `sessionId`, rotate to a new review file and timestamp, and reset the warning flag.
- Corrupt JSON or missing environment variables (tests Guarantees 2 and 4). An unreadable storage directory, a corrupt `.json` file, a missing `HOME` with relative `XDG_STATE_HOME`, or a nonexistent `[path]` target exits `1` on CLI reads with a message naming the error or offending file. Missing `HOME` during a review triggers one warning on the first save attempt.

## Limits

- Hunk 0.25.0 bounds `shutdown` handlers at 250 ms before disconnecting the daemon session, while a single `hunk` CLI subprocess takes roughly 370 ms on macOS. Quitting within 250 ms of a final edit can drop that edit before the subprocess finishes.
- Embedded reviews opened from `hunk status` or `hunk log` close back to the caller list without emitting `shutdown`, so edits within the 250 ms debounce window on return can be lost.
- Reloads via `--watch` or `hunk session reload` drop orphaned comments from Hunk's active diff list, so a subsequent edit overwrites the review file without those dropped comments.
- Line numbers in saved comments refer to the reviewed revisions in `command`. Rewriting jj changes after a review can shift change IDs relative to the current working copy.
- `hunk notes [path]` requires `[path]` to exist on disk; querying a file deleted since the review exits `1`.
- Review files accumulate until removed manually, and saving requires `hunk` on `PATH`.
