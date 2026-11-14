import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function stateDirectory(env = process.env) {
  const xdg = env.XDG_STATE_HOME;
  if (xdg && path.isAbsolute(xdg)) {
    return path.join(xdg, "hunk-notes");
  }
  const home = env.HOME || (env === process.env ? os.homedir() : "");
  if (!home) {
    throw new Error("HOME is not set");
  }
  return path.join(home, ".local", "state", "hunk-notes");
}

export async function runHunk(args, { timeoutMs = 5000 } = {}) {
  const { stdout } = await exec("hunk", args, { maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs });
  return JSON.parse(stdout);
}

export function reviewFilename(date, pid) {
  const pad = (value, width = 2) => String(value).padStart(width, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}-${pid}.json`;
}

export async function writeReview(directory, file, review, io = fs) {
  await io.mkdir(directory, { recursive: true, mode: 0o700 });
  await io.chmod(directory, 0o700);
  const destination = path.join(directory, file);
  const temporary = `${destination}.${process.pid}-${crypto.randomUUID()}.tmp`;
  try {
    await io.writeFile(temporary, JSON.stringify(review, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await io.chmod(temporary, 0o600);
    await io.rename(temporary, destination);
  } catch (error) {
    await io.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export async function findSession(
  run,
  pid,
  pause = ms => new Promise(resolve => setTimeout(resolve, ms)),
  { timeoutMs = 3000, nowMs = Date.now } = {},
) {
  const deadline = nowMs() + timeoutMs;
  for (let attempt = 0; attempt < 13; attempt++) {
    const { sessions } = await run(["session", "list", "--json"]);
    const session = sessions.find(entry => entry.pid === pid);
    if (session) return session;
    if (attempt < 12 && nowMs() < deadline) {
      await pause(250);
    } else {
      break;
    }
  }
  throw new Error("Hunk session was not registered within 3 seconds");
}

function diffIdentity(session, repo) {
  return JSON.stringify({
    sessionId: session.sessionId,
    repo,
    title: session.title ?? null,
    review: session.review ?? null,
  });
}

export function createRecorder({
  directory,
  run = runHunk,
  pid = process.pid,
  command = process.argv.slice(2),
  started = new Date(),
  now = () => new Date(),
  pause,
  debounceMs = 250,
} = {}) {
  let cwd;
  let session;
  let activeIdentity;
  let currentCommand = command;
  let currentStarted = started;
  let file = reviewFilename(currentStarted, pid);
  let timer;
  let version = 0;
  let dirty = false;
  let running;
  let warned = false;
  let context;

  async function save() {
    const found = session ?? await findSession(run, pid, pause);
    const effectiveCwd = (activeIdentity !== undefined ? found.cwd : undefined) ?? cwd ?? found.cwd ?? context?.cwd ?? process.cwd();
    const repo = await fs.realpath(found.repoRoot ?? effectiveCwd);
    const identity = diffIdentity(found, repo);
    const rotated = activeIdentity !== undefined && identity !== activeIdentity;
    if (rotated) {
      currentStarted = now();
      file = reviewFilename(currentStarted, pid);
      currentCommand = null;
      warned = false;
    }
    activeIdentity = identity;
    session = found;
    const { comments } = await run(["session", "comment", "list", session.sessionId, "--type", "all", "--json"]);
    const targetDirectory = directory ?? stateDirectory();
    const payload = {
      version: 1,
      repo,
      cwd: effectiveCwd,
      command: currentCommand,
      ...(session.title !== undefined ? { title: session.title } : {}),
      ...(session.review !== undefined ? { review: session.review } : {}),
      startedAt: currentStarted.toISOString(),
      updatedAt: now().toISOString(),
      comments,
    };
    await writeReview(targetDirectory, file, payload);
  }

  async function flush() {
    clearTimeout(timer);
    timer = undefined;
    if (running) {
      await running;
      if (!dirty) return;
    }
    if (!dirty) return;
    running = (async () => {
      while (dirty) {
        const targetVersion = version;
        clearTimeout(timer);
        timer = undefined;
        try {
          await save();
          if (version === targetVersion) {
            dirty = false;
          }
        } catch (error) {
          if (!warned) {
            warned = true;
            context?.notify?.(`Notes may not be saved: ${errorMessage(error)}`, "warning");
          }
          break;
        }
      }
    })();
    try {
      await running;
    } finally {
      running = undefined;
    }
  }

  return {
    start(startCwd) { cwd = startCwd; },
    resetSession() { session = undefined; },
    changed(ctx) {
      context = ctx;
      version++;
      dirty = true;
      clearTimeout(timer);
      timer = setTimeout(() => { void flush(); }, debounceMs);
    },
    async shutdown() {
      await flush();
    },
  };
}

function compareDesc(a, b) {
  return a < b ? 1 : a > b ? -1 : 0;
}

export async function readReviews(directory) {
  let files;
  try {
    files = await fs.readdir(directory);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const reviews = [];
  for (const file of files.filter(entry => entry.endsWith(".json"))) {
    const fullPath = path.join(directory, file);
    let review;
    try {
      review = JSON.parse(await fs.readFile(fullPath, "utf8"));
    } catch (error) {
      throw new Error(`Invalid review file ${fullPath}: ${errorMessage(error)}`);
    }
    if (!review || typeof review.startedAt !== "string" || typeof review.repo !== "string" || !Array.isArray(review.comments)) {
      throw new Error(`Invalid review file ${fullPath}: missing required review fields`);
    }
    reviews.push({ file: fullPath, review });
  }
  return reviews.sort((a, b) => compareDesc(a.review.startedAt, b.review.startedAt) || compareDesc(a.file, b.file));
}

export async function latestReview(reviews, target) {
  const realTarget = await fs.realpath(target);
  let best;
  for (const { review } of reviews) {
    // Saved roots were resolved when the review was written.
    const relative = path.relative(review.repo, realTarget);
    const inside = relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep));
    if (inside && (!best || review.repo.length > best.repo.length)) {
      best = review;
    }
  }
  return best;
}

export const usage = `Usage: hunk notes [path]
       hunk notes --all
       hunk notes --help

Print the newest saved review containing path (default: current directory).
--all lists every saved review, newest first.
`;

export async function notesCommand(args, ctx, directory) {
  try {
    if (args.length === 1 && args[0] === "--help") {
      await ctx.stdout.write(usage);
      return { kind: "exit", code: 0 };
    }
    if (args.length > 1 || (args[0]?.startsWith("-") && args[0] !== "--all")) {
      await ctx.stderr.write(usage);
      return { kind: "exit", code: 1 };
    }
    const targetDirectory = directory ?? stateDirectory();
    const reviews = await readReviews(targetDirectory);
    const result = args[0] === "--all"
      ? reviews.map(({ file, review }) => ({
          file,
          startedAt: review.startedAt,
          repo: review.repo,
          command: review.command,
          comments: review.comments.length,
        }))
      : await latestReview(reviews, path.resolve(ctx.cwd, args[0] || "."));
    await ctx.stdout.write(result ? JSON.stringify(result, null, 2) + "\n" : "No saved review found for this path.\n");
    return { kind: "exit", code: 0 };
  } catch (error) {
    await ctx.stderr.write(`hunk notes: ${errorMessage(error)}\n`);
    return { kind: "exit", code: 1 };
  }
}
