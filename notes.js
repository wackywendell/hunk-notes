import * as fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export function stateDirectory(env = process.env) {
  return path.join(env.XDG_STATE_HOME || path.join(env.HOME, ".local", "state"), "hunk-notes");
}

export async function runHunk(args) {
  const { stdout } = await exec("hunk", args, { maxBuffer: 16 * 1024 * 1024 });
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
  const temporary = destination + ".tmp";
  await io.writeFile(temporary, JSON.stringify(review, null, 2) + "\n", { mode: 0o600 });
  await io.rename(temporary, destination);
}

export async function findSession(run, pid, pause = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  for (let attempt = 0; attempt < 13; attempt++) {
    const { sessions } = await run(["session", "list", "--json"]);
    const session = sessions.find(session => session.pid === pid);
    if (session) return session;
    if (attempt < 12) await pause(250);
  }
  throw new Error("Hunk session was not registered within 3 seconds");
}

export function createRecorder({
  directory = stateDirectory(),
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
  let timer;
  let pending = false;
  let running;
  let warned = false;
  let context;
  const file = reviewFilename(started, pid);

  async function save() {
    session ??= await findSession(run, pid, pause);
    const repo = await fs.realpath(session.repoRoot);
    const { comments } = await run(["session", "comment", "list", session.sessionId, "--type", "all", "--json"]);
    await writeReview(directory, file, {
      version: 1, repo, cwd, command,
      startedAt: started.toISOString(), updatedAt: now().toISOString(), comments,
    });
  }

  async function flush() {
    clearTimeout(timer);
    timer = undefined;
    if (running) return running;
    if (!pending) return;
    running = (async () => {
      while (pending) {
        pending = false;
        clearTimeout(timer);
        timer = undefined;
        try {
          await save();
        } catch (error) {
          if (!warned) {
            warned = true;
            context.notify(`Notes may not be saved: ${error.message}`, "warning");
          }
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
    changed(ctx) {
      context = ctx;
      pending = true;
      clearTimeout(timer);
      timer = setTimeout(() => { void flush(); }, debounceMs);
    },
    async shutdown() {
      await flush();
      if (pending) await flush();
    },
  };
}

export async function readReviews(directory) {
  let files;
  try {
    files = await fs.readdir(directory);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const reviews = await Promise.all(files.filter(file => file.endsWith(".json")).map(async file => ({
    file: path.join(directory, file),
    review: JSON.parse(await fs.readFile(path.join(directory, file), "utf8")),
  })));
  return reviews.sort((a, b) => b.review.startedAt.localeCompare(a.review.startedAt) || b.file.localeCompare(a.file));
}

export async function latestReview(reviews, target) {
  const realTarget = await fs.realpath(target);
  return reviews.find(({ review }) => {
    // Saved roots were resolved when the review was written.
    const relative = path.relative(review.repo, realTarget);
    return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep));
  })?.review;
}

export const usage = `Usage: hunk notes [path]
       hunk notes --all
       hunk notes --help

Print the newest saved review containing path (default: current directory).
--all lists every saved review, newest first.
`;

export async function notesCommand(args, ctx, directory = stateDirectory()) {
  try {
    if (args.length === 1 && args[0] === "--help") {
      await ctx.stdout.write(usage);
      return { kind: "exit", code: 0 };
    }
    if (args.length > 1 || (args[0]?.startsWith("-") && args[0] !== "--all")) {
      await ctx.stderr.write(usage);
      return { kind: "exit", code: 1 };
    }
    const reviews = await readReviews(directory);
    const result = args[0] === "--all"
      ? reviews.map(({ file, review }) => ({
          file, startedAt: review.startedAt, repo: review.repo, command: review.command, comments: review.comments.length,
        }))
      : await latestReview(reviews, path.resolve(ctx.cwd, args[0] || "."));
    await ctx.stdout.write(result ? JSON.stringify(result, null, 2) + "\n" : "No saved review found for this path.\n");
    return { kind: "exit", code: 0 };
  } catch (error) {
    await ctx.stderr.write(`hunk notes: ${error.message}\n`);
    return { kind: "exit", code: 1 };
  }
}
