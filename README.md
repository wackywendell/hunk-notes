# hunk-notes

Save Hunk review comments to disk as they change, so people and agents can read them after the review window closes.

## Install

Install the extension with Hunk 0.25.0 or newer (extension API 33). The package is plain JavaScript with no runtime dependencies.

```sh
hunk extension install wackywendell/hunk-notes --yes
```

Once installed, the extension loads into every new Hunk process and records both user notes and agent comments whenever a comment is added, edited, or removed.

## Read saved notes

```sh
hunk notes
hunk notes /path/to/checkout
hunk notes /path/to/checkout/file.txt
hunk notes --all
hunk notes --help
```

`hunk notes [path]` prints as JSON the newest saved review for the deepest repository checkout containing `path`. The target defaults to the current directory, resolves symbolic links, and must exist on disk. When no saved review matches `path`, the command prints a plain message and exits with status `0`.

`hunk notes --all` prints a JSON array of every saved review, newest first. Each entry contains `file`, `startedAt`, `repo`, `command`, and a `comments` count.

## Storage

Saved reviews live under `${XDG_STATE_HOME:-$HOME/.local/state}/hunk-notes/` when `XDG_STATE_HOME` is absolute, or `$HOME/.local/state/hunk-notes/` otherwise. Each filename uses the local start time and Hunk process ID, such as `2026-02-03T04-05-06.007-123.json`.

Readers always see a complete, private JSON file because each update writes to a unique temporary file with mode `0600` inside a `0700` directory and renames it into place. Changes are debounced for about 250 ms, saves run one at a time, and a normal shutdown flushes pending or previously failed changes.

Reviews that receive no comments write no file, while removing the last comment saves a review with an empty `comments` array. Saved files remain until you delete them, and any save failure shows at most one warning per review.

## File format

```json
{
  "version": 1,
  "repo": "/absolute/real/path/to/checkout",
  "cwd": "/path/where/hunk/started",
  "command": ["diff", "abc123", "def456"],
  "startedAt": "2026-02-03T04:05:06.007Z",
  "updatedAt": "2026-02-03T04:06:00.000Z",
  "comments": []
}
```

`repo` is the resolved real path of the Hunk daemon session's repository root, or the startup `cwd` when a review has no repository root (such as `hunk gh` or `hunk patch`). `command` contains the Hunk arguments after the binary, times inside the file use UTC, and `comments` holds the array returned by `hunk session comment list <sessionId> --type all --json`.

## Limits

Line numbers refer to the reviewed revisions in `command`. In jj, change IDs in `command` may move after a rewrite.

Hunk 0.25.0 gives extension `shutdown` handlers 250 ms before disconnecting its daemon session, while a `hunk` CLI subprocess takes roughly 370 ms on macOS, so quitting within 250 ms of a final edit can drop that change. Embedded reviews opened from `hunk status` or `hunk log` return without firing `shutdown`, `--watch` reloads drop comments on files removed from the diff on subsequent edits, and querying `hunk notes [path]` requires `[path]` to exist on disk.

Saving also depends on `hunk` being on `PATH` and registering its daemon session within three seconds of the first comment change. Reopen any existing Hunk window after installing the extension.

## Development

Run the tests with Node.js.

```sh
node --test
```
