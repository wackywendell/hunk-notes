import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { createRecorder, findSession, latestReview, notesCommand, readReviews, reviewFilename, stateDirectory, writeReview } from "../notes.js";
import extension from "../index.js";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hunk-notes-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  await fs.mkdir(repo);
  return { root, repo: await fs.realpath(repo), directory: path.join(root, "state") };
}

const started = new Date("2026-02-03T04:05:06.007Z");
const comments = [{ noteId: "n1", source: "agent", filePath: "f.txt", newRange: [1, 1], body: "Keep this", author: "agent", createdAt: started.toISOString() }];

function recording(options) {
  const calls = [];
  const warnings = [];
  const run = async args => {
    calls.push(args);
    return args[1] === "list"
      ? { sessions: [{ sessionId: "s1", pid: 123, repoRoot: options.repo }] }
      : { comments };
  };
  const recorder = createRecorder({ run, pid: 123, started, now: () => started, ...options });
  recorder.start(options.repo);
  return { recorder, calls, warnings, ctx: { notify: (...args) => warnings.push(args) } };
}

test("state location uses XDG or HOME", () => {
  assert.equal(stateDirectory({ HOME: "/home/a" }), "/home/a/.local/state/hunk-notes");
  assert.equal(stateDirectory({ HOME: "/home/a", XDG_STATE_HOME: "/state" }), "/state/hunk-notes");
});

test("local filename, full content, permissions, cached session and empty comments after removal", async t => {
  const f = await fixture(t);
  let current = comments;
  let lookups = 0;
  const r = recording({ ...f, command: ["diff", "abc", "def"], run: async args => {
    if (args[1] === "list") {
      lookups++;
      return { sessions: [{ sessionId: "s1", pid: 123, repoRoot: f.repo }] };
    }
    assert.deepEqual(args, ["session", "comment", "list", "s1", "--type", "all", "--json"]);
    return { comments: current };
  } });
  r.recorder.changed(r.ctx);
  await r.recorder.shutdown();
  const [saved] = await readReviews(f.directory);
  assert.equal(path.basename(saved.file), reviewFilename(started, 123));
  const local = new Date(2026, 1, 3, 4, 5, 6, 7);
  assert.equal(reviewFilename(local, 123), "2026-02-03T04-05-06.007-123.json");
  assert.deepEqual(saved.review, {
    version: 1, repo: f.repo, cwd: f.repo, command: ["diff", "abc", "def"],
    startedAt: started.toISOString(), updatedAt: started.toISOString(), comments,
  });
  assert.equal((await fs.stat(f.directory)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(saved.file)).mode & 0o777, 0o600);
  current = [];
  r.recorder.changed(r.ctx);
  await r.recorder.shutdown();
  assert.deepEqual((await readReviews(f.directory))[0].review.comments, []);
  assert.equal(lookups, 1);
});

test("no notes creates no state directory", async t => {
  const f = await fixture(t);
  const r = recording(f);
  await r.recorder.shutdown();
  assert.deepEqual(r.calls, []);
  await assert.rejects(fs.stat(f.directory), { code: "ENOENT" });
});

test("atomic replacement exposes old complete JSON until rename", async t => {
  const f = await fixture(t);
  await fs.mkdir(f.directory, { mode: 0o755 });
  await writeReview(f.directory, "one.json", { value: "old" });
  let renamed = false;
  await writeReview(f.directory, "one.json", { value: "new" }, {
    ...fs,
    async rename(from, to) {
      assert.equal(from, path.join(f.directory, "one.json.tmp"));
      assert.deepEqual(JSON.parse(await fs.readFile(to, "utf8")), { value: "old" });
      assert.deepEqual(JSON.parse(await fs.readFile(from, "utf8")), { value: "new" });
      assert.equal((await fs.stat(from)).mode & 0o777, 0o600);
      renamed = true;
      await fs.rename(from, to);
    },
  });
  assert.equal(renamed, true);
  assert.deepEqual(await fs.readdir(f.directory), ["one.json"]);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.directory, "one.json"), "utf8")), { value: "new" });
  assert.equal((await fs.stat(f.directory)).mode & 0o777, 0o700);
});

test("debounces changes before saving", async t => {
  const f = await fixture(t);
  const r = recording({ ...f, debounceMs: 20 });
  r.recorder.changed(r.ctx);
  r.recorder.changed(r.ctx);
  assert.equal(r.calls.length, 0);
  await delay(70);
  await r.recorder.shutdown();
  assert.equal(r.calls.length, 2);
});

test("serializes changes during an in-flight save and flushes on shutdown", async t => {
  const f = await fixture(t);
  let release;
  let entered;
  const firstSave = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  let count = 0;
  let active = 0;
  let maximum = 0;
  const r = recording({ ...f, debounceMs: 5, run: async args => {
    if (args[1] === "list") return { sessions: [{ sessionId: "s1", pid: 123, repoRoot: f.repo }] };
    count++;
    maximum = Math.max(maximum, ++active);
    if (count === 1) { entered(); await blocked; }
    active--;
    return { comments: [{ ...comments[0], body: String(count) }] };
  } });
  r.recorder.changed(r.ctx);
  await firstSave;
  r.recorder.changed(r.ctx);
  await delay(20);
  const shutdown = r.recorder.shutdown();
  release();
  await shutdown;
  assert.equal(maximum, 1);
  assert.equal(count, 2);
  assert.equal((await readReviews(f.directory))[0].review.comments[0].body, "2");
});

test("session lookup retries by pid until registered", async () => {
  let calls = 0;
  const waits = [];
  const session = await findSession(async args => {
    assert.deepEqual(args, ["session", "list", "--json"]);
    return { sessions: [{ pid: 999 }, ...(++calls === 3 ? [{ pid: 123, sessionId: "mine" }] : [])] };
  }, 123, async ms => { waits.push(ms); });
  assert.equal(session.sessionId, "mine");
  assert.deepEqual(waits, [250, 250]);
  await assert.rejects(findSession(async () => ({ sessions: [] }), 123, async () => {}), /within 3 seconds/);
});

test("save failures warn once per review", async t => {
  const f = await fixture(t);
  const r = recording({ ...f, run: async () => { throw new Error("disk or daemon unavailable"); } });
  for (let i = 0; i < 2; i++) {
    r.recorder.changed(r.ctx);
    await r.recorder.shutdown();
  }
  assert.deepEqual(r.warnings, [["Notes may not be saved: disk or daemon unavailable", "warning"]]);
});

test("filesystem failures also warn once", async t => {
  const f = await fixture(t);
  await fs.writeFile(f.directory, "not a directory");
  const r = recording(f);
  r.recorder.changed(r.ctx);
  await r.recorder.shutdown();
  assert.equal(r.warnings.length, 1);
  assert.equal(r.warnings[0][1], "warning");
});

test("path containment resolves symlinks and excludes sibling prefixes", async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.repo, "sub"));
  await fs.writeFile(path.join(f.repo, "sub", "f.txt"), "");
  await fs.symlink(f.repo, path.join(f.root, "alias"));
  const review = { repo: f.repo };
  assert.equal(await latestReview([{ review }], path.join(f.root, "alias", "sub", "f.txt")), review);
  assert.equal(await latestReview([{ review }], f.repo), review);
  await fs.mkdir(f.repo + "-other");
  assert.equal(await latestReview([{ review }], f.repo + "-other"), undefined);
});

function cli(cwd) {
  const output = { stdout: "", stderr: "" };
  return { output, ctx: { cwd, stdout: { async write(text) { output.stdout += text; } }, stderr: { async write(text) { output.stderr += text; } } } };
}

test("--all orders newest first, latest respects path, missing reviews exit zero", async t => {
  const f = await fixture(t);
  const base = { version: 1, repo: f.repo, cwd: f.repo, command: ["diff", "a", "b"], comments };
  await writeReview(f.directory, "z.json", { ...base, startedAt: "2026-01-01T00:00:00.000Z" });
  await writeReview(f.directory, "a.json", { ...base, startedAt: "2026-02-01T00:00:00.000Z" });
  const all = cli(f.repo);
  assert.deepEqual(await notesCommand(["--all"], all.ctx, f.directory), { kind: "exit", code: 0 });
  const result = JSON.parse(all.output.stdout);
  assert.deepEqual(result.map(item => path.basename(item.file)), ["a.json", "z.json"]);
  assert.deepEqual(result[0], { file: path.join(f.directory, "a.json"), startedAt: "2026-02-01T00:00:00.000Z", repo: f.repo, command: base.command, comments: 1 });
  const latest = cli(f.repo);
  await notesCommand([], latest.ctx, f.directory);
  assert.equal(JSON.parse(latest.output.stdout).startedAt, result[0].startedAt);
  const missing = cli(f.root);
  assert.equal((await notesCommand([], missing.ctx, f.directory)).code, 0);
  assert.match(missing.output.stdout, /No saved review/);
  const empty = cli(f.repo);
  await notesCommand(["--all"], empty.ctx, path.join(f.root, "absent"));
  assert.deepEqual(JSON.parse(empty.output.stdout), []);
});

test("help, invalid arguments and clear read errors", async t => {
  const f = await fixture(t);
  const help = cli(f.repo);
  assert.equal((await notesCommand(["--help"], help.ctx, f.directory)).code, 0);
  assert.match(help.output.stdout, /Usage: hunk notes/);
  const invalid = cli(f.repo);
  assert.equal((await notesCommand(["--unknown"], invalid.ctx, f.directory)).code, 1);
  await fs.writeFile(f.directory, "not a directory");
  const broken = cli(f.repo);
  assert.equal((await notesCommand([], broken.ctx, f.directory)).code, 1);
  assert.match(broken.output.stderr, /hunk notes:/);
});

test("extension registers the native event and command API", () => {
  const events = new Map();
  let command;
  extension({ on: (event, handler) => events.set(event, handler), registerCliCommand: (spec, handler) => { command = { spec, handler }; } });
  assert.deepEqual([...events.keys()], ["startup", "note_changed", "shutdown"]);
  assert.equal(command.spec.name, "notes");
  assert.equal(command.handler, notesCommand);
});
