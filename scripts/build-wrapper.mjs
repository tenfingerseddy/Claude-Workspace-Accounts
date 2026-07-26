import { execFile } from "node:child_process";
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);

const SOURCE_DIRECTORY = path.join("native", "WrapperLauncher");

/**
 * Compile the Claude process wrapper.
 *
 * The wrapper must be a single self-contained native executable: it sits between Claude Code
 * and the Claude CLI on every launch, including background ones, so it carries no interpreter
 * hop and no sidecar files that could be missing or stale. It is built with the in-box .NET
 * Framework compiler, which means C# 5 and only assemblies that ship with Windows.
 */
export async function buildWrapper() {
  await mkdir("bin/native/win-x64", { recursive: true });
  const compiler = path.join(
    process.env.WINDIR ?? "C:\\Windows",
    "Microsoft.NET",
    "Framework64",
    "v4.0.30319",
    "csc.exe"
  );
  const sources = (await readdir(SOURCE_DIRECTORY))
    .filter((entry) => entry.endsWith(".cs"))
    .sort()
    .map((entry) => path.join(SOURCE_DIRECTORY, entry));
  if (sources.length === 0) {
    throw new Error(`No wrapper sources found in ${SOURCE_DIRECTORY}.`);
  }
  const { stdout, stderr } = await run(compiler, [
    "/nologo",
    "/target:exe",
    "/platform:x64",
    "/optimize+",
    "/debug-",
    "/warnaserror+",
    "/out:bin/native/win-x64/claude-account-guard-wrapper.exe",
    ...sources
  ], { windowsHide: true });
  if (stdout) {
    process.stdout.write(stdout);
  }
  if (stderr) {
    process.stderr.write(stderr);
  }
}

if (process.argv[1]
  && fileURLToPath(import.meta.url).toLocaleLowerCase() === process.argv[1].toLocaleLowerCase()) {
  await buildWrapper();
}
