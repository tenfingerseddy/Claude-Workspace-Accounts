import { mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
await mkdir("artifacts", { recursive: true });

const { stdout, stderr } = await run(process.execPath, [
  "node_modules/@vscode/vsce/vsce",
  "package",
  "--target",
  "win32-x64",
  "--out",
  "artifacts/claude-workspace-accounts.vsix"
], { windowsHide: true });

if (stdout) {
  process.stdout.write(stdout);
}
if (stderr) {
  process.stderr.write(stderr);
}
