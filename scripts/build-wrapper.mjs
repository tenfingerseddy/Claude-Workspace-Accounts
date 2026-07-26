import { execFile } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);

export async function buildWrapper() {
  await mkdir("bin/native/win-x64", { recursive: true });
  const compiler = path.join(
    process.env.WINDIR ?? "C:\\Windows",
    "Microsoft.NET",
    "Framework64",
    "v4.0.30319",
    "csc.exe"
  );
  const { stdout, stderr } = await run(compiler, [
    "/nologo",
    "/target:exe",
    "/platform:x64",
    "/optimize+",
    "/out:bin/native/win-x64/claude-account-guard-wrapper.exe",
    "native\\WrapperLauncher\\Program.cs"
  ], { windowsHide: true });
  if (stdout) {
    process.stdout.write(stdout);
  }
  if (stderr) {
    process.stderr.write(stderr);
  }
  await copyFile(
    "bin/claude-account-guard-wrapper.ps1",
    "bin/native/win-x64/claude-account-guard-wrapper.ps1"
  );
}

if (process.argv[1]
  && fileURLToPath(import.meta.url).toLocaleLowerCase() === process.argv[1].toLocaleLowerCase()) {
  await buildWrapper();
}
