# hunk-notes

Save Hunk review comments to disk as they change, so people and agents can read them after the review window closes.

## Install

Requires Hunk 0.25.0 with extension API 33. The extension is plain JavaScript and has no runtime dependencies.

```sh
hunk extension install wackywendell/hunk-notes --yes
```

The installed extension loads into every new Hunk process. It saves user notes and agent comments when a saved note is created, edited or removed.

## Read saved notes

```sh
hunk notes
hunk notes /path/to/checkout
hunk notes /path/to/checkout/file.txt
hunk notes --all
hunk notes --help
```

`hunk notes [path]` prints the newest saved review containing the path as JSON. The default path is the current directory. It resolves symbolic links and uses the repository roots recorded in saved reviews. A path with no saved review produces a message and exit status 0.

`hunk notes --all` prints a JSON array of every saved review, newest first. Each entry contains `file`, `startedAt`, `repo`, `command` and a `comments` count.

## Storage

Reviews are stored in `${XDG_STATE_HOME:-$HOME/.local/state}/hunk-notes/`. Each filename contains the local start time and Hunk process ID, such as `2026-02-03T04-05-06.007-123.json`.

The directory has mode 0700 and files have mode 0600 because notes can quote code. Each update writes a temporary file and renames it into place, so readers see a complete JSON file. Changes are debounced for about 250 ms, saves run one at a time, and a normal shutdown flushes pending changes.

A review with no notes creates no file. Removing the last note leaves a review with an empty comments array. Saved files are kept until you remove them. A failed save shows one warning per review.

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

`repo` is the resolved real path of the live session's repository root. `command` contains the Hunk arguments after the binary. Times inside the file use UTC. The `comments` array is saved unchanged from `hunk session comment list <sessionId> --type all --json`, including file paths, line ranges, authors and bodies.

## Limits

Line numbers refer to the reviewed revisions in `command`. In jj, change IDs in `command` may move after a rewrite.

Hunk must keep its session available while comments are saved. The extension waits up to three seconds for a new session to register. Forced termination can lose changes within the debounce interval or during a save. An existing Hunk window needs to be reopened after installation.

## Development

Run the tests with Node.js.

```sh
node --test
```
