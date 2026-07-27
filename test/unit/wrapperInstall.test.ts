import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  workspace: { getConfiguration: () => ({ get: () => undefined, update: async () => undefined }) },
  window: {},
  ConfigurationTarget: { Global: 1 }
}));

const { WrapperIntegrationService } = await import("../../src/wrapper/wrapperIntegrationService.js");
const { OBSOLETE_SUPPORT_FILES, STATUSLINE_EXE, WRAPPER_EXE } = await import(
  "../../src/wrapper/wrapperPaths.js"
);

/**
 * Installing support files sits on the activation path, so its failure mode is the whole feature.
 * A `--force` reinstall followed by a window reload while a wrapped Claude was still running threw
 * `EBUSY: resource busy or locked` out of `activate()` and left the extension with no commands, no
 * status bar and no dashboard — the fail-open rule broken in the one place that disables everything.
 */

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

interface Harness {
  service: InstanceType<typeof WrapperIntegrationService>;
  extensionRoot: string;
  wrapperDirectory: string;
}

async function harness(): Promise<Harness> {
  const root = await mkdtemp(path.join(os.tmpdir(), "wrapper-install-"));
  const extensionRoot = path.join(root, "extension");
  const wrapperDirectory = path.join(root, "support", "wrapper");
  const built = path.join(extensionRoot, "bin", "native", "win-x64");
  await mkdir(built, { recursive: true });
  await writeFile(path.join(built, WRAPPER_EXE), "wrapper-build-2");
  await writeFile(path.join(built, STATUSLINE_EXE), "bridge-build-2");

  const context = {
    asAbsolutePath: (relative: string) => path.join(extensionRoot, relative),
    extension: { packageJSON: { version: "0.2.0" } }
  };
  const registry = { paths: { wrapperDirectory } };
  return {
    service: new WrapperIntegrationService(
      context as never,
      registry as never
    ),
    extensionRoot,
    wrapperDirectory
  };
}

describe("installSupportFiles", () => {
  it("reports a locked executable instead of throwing", async () => {
    const { service, wrapperDirectory } = await harness();
    const destination = path.join(wrapperDirectory, WRAPPER_EXE);
    await mkdir(wrapperDirectory, { recursive: true });
    await writeFile(destination, "wrapper-build-1");
    // A running exe cannot be overwritten on Windows. Read-only reproduces the refusal on every
    // platform, which is what matters here: the copy fails and activation must survive it.
    await chmod(destination, 0o444);
    cleanups.push(async () => {
      await chmod(destination, 0o644);
    });

    const installed = await service.installSupportFiles();

    expect(installed.failures.map((failure) => failure.name)).toContain(WRAPPER_EXE);
    expect(installed.wrapperPath).toBe(destination);
    // The previously installed build is untouched, so Claude Code keeps launching.
    expect(await readFile(destination, "utf8")).toBe("wrapper-build-1");
    // One locked file must not stop the others being refreshed.
    expect(await readFile(path.join(wrapperDirectory, STATUSLINE_EXE), "utf8")).toBe("bridge-build-2");
  });

  it("does not rewrite a destination that already matches", async () => {
    const { service, wrapperDirectory } = await harness();
    const first = await service.installSupportFiles();
    expect(first.failures).toEqual([]);

    const destination = path.join(wrapperDirectory, WRAPPER_EXE);
    const before = (await stat(destination)).mtimeMs;
    // Overwriting an identical file is what walks into the lock, so the second pass must skip it.
    await chmod(destination, 0o444);
    cleanups.push(async () => {
      await chmod(destination, 0o644);
    });

    const second = await service.installSupportFiles();

    expect(second.failures).toEqual([]);
    expect((await stat(destination)).mtimeMs).toBe(before);
  });

  it("installs a changed build over an existing one", async () => {
    const { service, extensionRoot, wrapperDirectory } = await harness();
    await service.installSupportFiles();
    await writeFile(
      path.join(extensionRoot, "bin", "native", "win-x64", WRAPPER_EXE),
      "wrapper-build-3"
    );

    const installed = await service.installSupportFiles();

    expect(installed.failures).toEqual([]);
    expect(await readFile(path.join(wrapperDirectory, WRAPPER_EXE), "utf8")).toBe("wrapper-build-3");
  });

  it("reports an undeletable obsolete file rather than failing the install", async () => {
    const { service, wrapperDirectory } = await harness();
    await mkdir(wrapperDirectory, { recursive: true });
    // A directory standing where an obsolete file is expected makes rm() refuse, standing in for
    // the superseded wrapper still being run by an older Claude session.
    const blocked = OBSOLETE_SUPPORT_FILES[0]!;
    await mkdir(path.join(wrapperDirectory, blocked, "occupied"), { recursive: true });

    const installed = await service.installSupportFiles();

    expect(installed.failures.map((failure) => failure.name)).toContain(blocked);
    expect(await readFile(path.join(wrapperDirectory, WRAPPER_EXE), "utf8")).toBe("wrapper-build-2");
  });
});
