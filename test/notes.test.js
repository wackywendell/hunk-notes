import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { createRecorder, findSession, latestReview, notesCommand, readReviews, reviewFilename, runHunk, stateDirectory, writeReview } from "../notes.js";
import extension from "../index.js";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hunk-notes-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  await fs.mkdir(repo);
  return { root, rawRepo: repo, repo: await fs.realpath(repo), directory: path.join(root, "state") };
}

const started = new Date("2026-02-03T04:05:06.007Z");
const updated = new Date("2026-02-03T04:06:00.000Z");
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
  return { recorder, calls, warnings, ctx: { cwd: options.repo, notify: (...args) => warnings.push(args) } };
}

test("state location uses absolute XDG or HOME and rejects unset/relative env", () => {
  assert.equal(stateDirectory({ HOME: "/home/a" }), "/home/a/.local/state/hunk-notes");
  assert.equal(stateDirectory({ HOME: "/home/a", XDG_STATE_HOME: "/state" }), "/state/hunk-notes");
  assert.equal(stateDirectory({ HOME: "/home/a", XDG_STATE_HOME: "relative/state" }), "/home/a/.local/state/hunk-notes");
  assert.throws(() => stateDirectory({}), /HOME is not set/);
  assert.throws(() => stateDirectory({ HOME: "" }), /HOME is not set/);
});

test("local filename, full content, permissions, cached session, updatedAt, and empty comments after removal", async t => {
  const f = await fixture(t);
  await fs.symlink(f.rawRepo, path.join(f.root, "repo-link"));
  let current = comments;
  let lookups = 0;
  let clock = updated;
  const r = recording({
    ...f,
    command: ["diff", "abc", "def"],
    now: () => clock,
    run: async args => {
      if (args[1] === "list") {
        lookups++;
        return { sessions: [{ sessionId: "s1", pid: 123, repoRoot: path.join(f.root, "repo-link") }] };
      }
      assert.deepEqual(args, ["session", "comment", "list", "s1", "--type", "all", "--json"]);
      return { comments: current };
    },
  });
  r.recorder.changed(r.ctx);
  await r.recorder.shutdown();
  const [saved] = await readReviews(f.directory);
  assert.equal(path.basename(saved.file), reviewFilename(started, 123));
  const local = new Date(2026, 1, 3, 4, 5, 6, 7);
  assert.equal(reviewFilename(local, 123), "2026-02-03T04-05-06.007-123.json");
  assert.deepEqual(saved.review, {
    version: 1,
    repo: f.repo,
    cwd: f.repo,
    command: ["diff", "abc", "def"],
    startedAt: started.toISOString(),
    updatedAt: updated.toISOString(),
    comments,
  });
  assert.equal((await fs.stat(f.directory)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(saved.file)).mode & 0o777, 0o600);
  current = [];
  clock = new Date("2026-02-03T04:07:00.000Z");
  r.recorder.changed(r.ctx);
  await r.recorder.shutdown();
  assert.deepEqual((await readReviews(f.directory))[0].review.comments, []);
  assert.equal((await readReviews(f.directory))[0].review.updatedAt, clock.toISOString());
  assert.equal(lookups, 1);
});

test("falls back to cwd realpath when session repoRoot is undefined", async t => {
  const f = await fixture(t);
  await fs.symlink(f.rawRepo, path.join(f.root, "alias"));
  const r = recording({
    ...f,
    command: ["gh", "pr", "123"],
    run: async args => args[1] === "list"
      ? { sessions: [{ sessionId: "s1", pid: 123 }] }
      : { comments },
  });
  r.recorder.start(path.join(f.root, "alias"));
  r.recorder.changed(r.ctx);
  await r.recorder.shutdown();
  const [saved] = await readReviews(f.directory);
  assert.equal(saved.review.repo, f.repo);
  assert.equal(saved.review.cwd, path.join(f.root, "alias"));
  assert.deepEqual(r.warnings, []);
});

test("resetSession keeps file on same sessionId reload and rotates on new sessionId", async t => {
  const f = await fixture(t);
  let activeSession = "s1";
  let currentTime = started;
  const r = recording({
    ...f,
    now: () => currentTime,
    run: async args => args[1] === "list"
      ? { sessions: [{ sessionId: activeSession, pid: 123, repoRoot: f.repo }] }
      : { comments: [{ ...comments[0], body: activeSession }] },
  });
  r.recorder.changed(r.ctx);
  await r.recorder.shutdown();

  r.recorder.resetSession();
  currentTime = updated;
  r.recorder.changed(r.ctx);
  await r.recorder.shutdown();
  assert.equal((await readReviews(f.directory)).length, 1);

  activeSession = "s2";
  currentTime = new Date("2026-02-03T04:08:00.000Z");
  r.recorder.resetSession();
  r.recorder.changed(r.ctx);
  await r.recorder.shutdown();
  const reviews = await readReviews(f.directory);
  assert.equal(reviews.length, 2);
  assert.equal(reviews[0].review.comments[0].body, "s2");
  assert.equal(reviews[1].review.comments[0].body, "s1");
});

test("no notes creates no state directory", async t => {
  const f = await fixture(t);
  const r = recording(f);
  await r.recorder.shutdown();
  assert.deepEqual(r.calls, []);
  await assert.rejects(fs.stat(f.directory), { code: "ENOENT" });
});

test("atomic replacement uses fresh 0600 temp files and ignores leftover .tmp files", async t => {
  const f = await fixture(t);
  await fs.mkdir(f.directory, { mode: 0o755 });
  await fs.writeFile(path.join(f.directory, "one.json.tmp"), "partial", { mode: 0o644 });
  await writeReview(f.directory, "one.json", { version: 1, repo: f.repo, startedAt: started.toISOString(), comments: [] });
  let renamed = false;
  await writeReview(f.directory, "one.json", { version: 1, repo: f.repo, startedAt: started.toISOString(), comments }, {
    ...fs,
    async rename(from, to) {
      assert.match(path.basename(from), /^one\.json\..+\.tmp$/);
      assert.equal(JSON.parse(await fs.readFile(to, "utf8")).comments.length, 0);
      assert.equal(JSON.parse(await fs.readFile(from, "utf8")).comments.length, 1);
      assert.equal((await fs.stat(from)).mode & 0o777, 0o600);
      renamed = true;
      await fs.rename(from, to);
    },
  });
  assert.equal(renamed, true);
  assert.equal((await fs.stat(path.join(f.directory, "one.json"))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(f.directory)).mode & 0o777, 0o700);
  const reviews = await readReviews(f.directory);
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].review.comments.length, 1);
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
  const r = recording({
    ...f,
    debounceMs: 5,
    run: async args => {
      if (args[1] === "list") return { sessions: [{ sessionId: "s1", pid: 123, repoRoot: f.repo }] };
      count++;
      maximum = Math.max(maximum, ++active);
      if (count === 1) { entered(); await blocked; }
      active--;
      return { comments: [{ ...comments[0], body: String(count) }] };
    },
  });
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

test("failed background save retains dirty state and saves on recovered shutdown", async t => {
  const f = await fixture(t);
  let fail = true;
  const r = recording({
    ...f,
    debounceMs: 10,
    run: async args => {
      if (fail) throw new Error("temporary daemon error");
      return args[1] === "list"
        ? { sessions: [{ sessionId: "s1", pid: 123, repoRoot: f.repo }] }
        : { comments };
    },
  });
  r.recorder.changed(r.ctx);
  await delay(40);
  assert.equal(r.warnings.length, 1);
  fail = false;
  await r.recorder.shutdown();
  const reviews = await readReviews(f.directory);
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].review.comments.length, 1);
});

test("session lookup retries by pid with elapsed deadline", async () => {
  let calls = 0;
  const waits = [];
  const session = await findSession(async args => {
    assert.deepEqual(args, ["session", "list", "--json"]);
    return { sessions: [{ pid: 999 }, ...(++calls === 3 ? [{ pid: 123, sessionId: "mine" }] : [])] };
  }, 123, async ms => { waits.push(ms); });
  assert.equal(session.sessionId, "mine");
  assert.deepEqual(waits, [250, 250]);
  await assert.rejects(findSession(async () => ({ sessions: [] }), 123, async () => {}), /within 3 seconds/);

  let fakeNow = 0;
  let elapsedCalls = 0;
  await assert.rejects(
    findSession(async () => {
      elapsedCalls++;
      fakeNow += 1500;
      return { sessions: [] };
    }, 123, async () => { fakeNow += 250; }, { timeoutMs: 3000, nowMs: () => fakeNow }),
    /within 3 seconds/,
  );
  assert.equal(elapsedCalls, 2);
});

test("save failures warn once per review and recover when resolved later", async t => {
  const f = await fixture(t);
  let fail = true;
  const r = recording({
    ...f,
    run: async args => {
      if (fail) throw "disk or daemon unavailable";
      return args[1] === "list"
        ? { sessions: [{ sessionId: "s1", pid: 123, repoRoot: f.repo }] }
        : { comments };
    },
  });
  for (let i = 0; i < 2; i++) {
    r.recorder.changed(r.ctx);
    await r.recorder.shutdown();
  }
  assert.deepEqual(r.warnings, [["Notes may not be saved: disk or daemon unavailable", "warning"]]);
  fail = false;
  r.recorder.changed(r.ctx);
  await r.recorder.shutdown();
  assert.equal((await readReviews(f.directory)).length, 1);
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

test("runHunk parses JSON and rejects on missing binary or timeout", async () => {
  await assert.rejects(runHunk(["--definitely-not-a-valid-command"], { timeoutMs: 200 }));
});

test("path containment resolves symlinks, excludes sibling prefixes, and prefers deepest repo", async t => {
  const f = await fixture(t);
  const nested = path.join(f.repo, "worktree");
  await fs.mkdir(path.join(nested, "sub"), { recursive: true });
  await fs.writeFile(path.join(nested, "sub", "f.txt"), "");
  await fs.symlink(f.repo, path.join(f.root, "alias"));
  const outerNewest = { repo: f.repo, startedAt: "2026-02-02T00:00:00.000Z" };
  const innerOlder = { repo: nested, startedAt: "2026-02-01T00:00:00.000Z" };
  const reviews = [{ review: outerNewest }, { review: innerOlder }];
  assert.equal(await latestReview(reviews, path.join(f.root, "alias", "worktree", "sub", "f.txt")), innerOlder);
  assert.equal(await latestReview(reviews, f.repo), outerNewest);
  await fs.mkdir(f.repo + "-other");
  assert.equal(await latestReview(reviews, f.repo + "-other"), undefined);
});

function cli(cwd) {
  const output = { stdout: "", stderr: "" };
  return { output, ctx: { cwd, stdout: { async write(text) { output.stdout += text; } }, stderr: { async write(text) { output.stderr += text; } } } };
}

test("--all orders newest first with tie-breaker, latest filters by repo and positional path, missing reviews exit zero", async t => {
  const f = await fixture(t);
  const other = path.join(f.root, "other");
  await fs.mkdir(path.join(f.repo, "sub"), { recursive: true });
  await fs.mkdir(other);
  const realOther = await fs.realpath(other);
  const base = { version: 1, repo: f.repo, cwd: f.repo, command: ["diff", "a", "b"], comments };
  await writeReview(f.directory, "z.json", { ...base, startedAt: "2026-01-01T00:00:00.000Z" });
  await writeReview(f.directory, "a.json", { ...base, startedAt: "2026-02-01T00:00:00.000Z" });
  await writeReview(f.directory, "b.json", { ...base, startedAt: "2026-02-01T00:00:00.000Z" });
  await writeReview(f.directory, "c.json", { ...base, repo: realOther, cwd: realOther, startedAt: "2026-03-01T00:00:00.000Z" });

  const all = cli(f.repo);
  assert.deepEqual(await notesCommand(["--all"], all.ctx, f.directory), { kind: "exit", code: 0 });
  const result = JSON.parse(all.output.stdout);
  assert.deepEqual(result.map(item => path.basename(item.file)), ["c.json", "b.json", "a.json", "z.json"]);
  assert.deepEqual(result[1], { file: path.join(f.directory, "b.json"), startedAt: "2026-02-01T00:00:00.000Z", repo: f.repo, command: base.command, comments: 1 });

  const latest = cli(f.repo);
  await notesCommand([], latest.ctx, f.directory);
  assert.equal(JSON.parse(latest.output.stdout).repo, f.repo);
  assert.equal(JSON.parse(latest.output.stdout).startedAt, "2026-02-01T00:00:00.000Z");

  const positional = cli(f.root);
  assert.equal((await notesCommand(["repo/sub"], positional.ctx, f.directory)).code, 0);
  assert.equal(JSON.parse(positional.output.stdout).repo, f.repo);

  const missing = cli(f.root);
  assert.equal((await notesCommand([], missing.ctx, f.directory)).code, 0);
  assert.match(missing.output.stdout, /No saved review/);

  const empty = cli(f.repo);
  await notesCommand(["--all"], empty.ctx, path.join(f.root, "absent"));
  assert.deepEqual(JSON.parse(empty.output.stdout), []);
});

test("help, invalid arguments, nonexistent path, and corrupt JSON errors", async t => {
  const f = await fixture(t);
  const help = cli(f.repo);
  assert.equal((await notesCommand(["--help"], help.ctx, f.directory)).code, 0);
  assert.match(help.output.stdout, /Usage: hunk notes/);

  const invalidFlag = cli(f.repo);
  assert.equal((await notesCommand(["--unknown"], invalidFlag.ctx, f.directory)).code, 1);

  const extraArgs = cli(f.repo);
  assert.equal((await notesCommand(["a", "b"], extraArgs.ctx, f.directory)).code, 1);
  assert.match(extraArgs.output.stderr, /Usage: hunk notes/);

  const missingTarget = cli(f.repo);
  assert.equal((await notesCommand(["does-not-exist"], missingTarget.ctx, f.directory)).code, 1);
  assert.match(missingTarget.output.stderr, /hunk notes:/);

  await fs.mkdir(f.directory, { recursive: true });
  await fs.writeFile(path.join(f.directory, "bad.json"), "{");
  const corrupt = cli(f.repo);
  assert.equal((await notesCommand([], corrupt.ctx, f.directory)).code, 1);
  assert.match(corrupt.output.stderr, /bad\.json/);
});

test("extension registers and invokes the native event and command API", async t => {
  const f = await fixture(t);
  const events = new Map();
  let command;
  extension({
    on: (event, handler) => events.set(event, handler),
    registerCliCommand: (spec, handler) => { command = { spec, handler }; },
  });
  assert.deepEqual([...events.keys()], ["startup", "changeset_loaded", "note_changed", "shutdown"]);
  assert.equal(command.spec.name, "notes");
  assert.equal(command.handler, notesCommand);

  await events.get("startup")({ cwd: f.repo }, { cwd: f.repo, notify: () => {} });
  await events.get("changeset_loaded")({}, { cwd: f.repo, notify: () => {} });
  await events.get("shutdown")({}, { cwd: f.repo, notify: () => {} });
});
