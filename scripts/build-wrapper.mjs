import { execFile } from "node:child_process";
import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);

const SHARED_DIRECTORY = path.join("native", "Shared");
const OUTPUT_DIRECTORY = path.join("bin", "native", "win-x64");

/**
 * The two native components, each compiled with the shared guard sources.
 *
 * They are separate executables on purpose. The wrapper's argument vector is a contract with
 * Claude Code and its first argument is the CLI, so it must never have to inspect argv to work out
 * which mode it is running in. Sharing the source instead of the binary is what keeps them from
 * drifting: the status-line bridge used to reimplement the registry lookup and path normalization
 * in PowerShell, and the two copies disagreed.
 */
const COMPONENTS = [
  { directory: path.join("native", "WrapperLauncher"), output: "claude-workspace-accounts-wrapper.exe" },
  { directory: path.join("native", "StatusLineBridge"), output: "statusline-bridge.exe" }
];

async function sourcesIn(directory) {
  const entries = (await readdir(directory))
    .filter((entry) => entry.endsWith(".cs"))
    .sort()
    .map((entry) => path.join(directory, entry));
  if (entries.length === 0) {
    throw new Error(`No C# sources found in ${directory}.`);
  }
  return entries;
}

/**
 * Compile the native components.
 *
 * Both must be self-contained: they sit between Claude Code and the Claude CLI on every launch and
 * every status-line refresh, so they carry no interpreter hop and no sidecar files that could be
 * missing or stale. They are built with the in-box .NET Framework compiler, which means C# 5 and
 * only assemblies that ship with Windows.
 */
export async function buildWrapper() {
  // Emptied rather than overwritten. `package.json` ships `bin/**` verbatim, so an executable
  // left behind by an earlier build — a wrapper under its previous name, for instance — would
  // be packaged into the VSIX and installed alongside the real one.
  await rm(OUTPUT_DIRECTORY, { recursive: true, force: true });
  await mkdir(OUTPUT_DIRECTORY, { recursive: true });
  const compiler = path.join(
    process.env.WINDIR ?? "C:\\Windows",
    "Microsoft.NET",
    "Framework64",
    "v4.0.30319",
    "csc.exe"
  );
  const shared = await sourcesIn(SHARED_DIRECTORY);

  for (const component of COMPONENTS) {
    const { stdout, stderr } = await run(compiler, [
      "/nologo",
      "/target:exe",
      "/platform:x64",
      "/optimize+",
      "/debug-",
      "/warnaserror+",
      `/out:${path.join(OUTPUT_DIRECTORY, component.output)}`,
      ...shared,
      ...(await sourcesIn(component.directory))
    ], { windowsHide: true });
    if (stdout) {
      process.stdout.write(stdout);
    }
    if (stderr) {
      process.stderr.write(stderr);
    }
  }
}

if (process.argv[1]
  && fileURLToPath(import.meta.url).toLocaleLowerCase() === process.argv[1].toLocaleLowerCase()) {
  await buildWrapper();
}
