import { createRecorder, notesCommand } from "./notes.js";

export default function (hunk) {
  const recorder = createRecorder();
  hunk.on("startup", ({ cwd }) => recorder.start(cwd));
  hunk.on("note_changed", (_event, ctx) => recorder.changed(ctx));
  hunk.on("shutdown", () => recorder.shutdown());
  hunk.registerCliCommand({
    name: "notes",
    summary: "Read saved review comments",
    usage: "[path] | --all | --help",
  }, notesCommand);
}
