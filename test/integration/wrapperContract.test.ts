import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  FORBIDDEN_BETA_VARIABLES,
  FORCED_PRIVACY_VARIABLES,
  FOREIGN_OTEL_VARIABLES,
  REQUIRED_COLLECTOR_VARIABLES
} from "../../src/telemetry/otelEnvironment.js";

/**
 * The two native components run outside the extension host: the process wrapper on every Claude
 * launch, and the status-line bridge on every status-line refresh. Their behaviour cannot be
 * asserted from the extension's own tests, so the properties they must never lose are asserted
 * against their source: the wrapper binds a workspace to an account rather than demanding the
 * environment already match, it refuses a launch for exactly one reason, neither component reads a
 * credential store, neither lets content telemetry be emitted, and neither re-enters an interpreter
 * that would re-parse what it was handed.
 */
const SHARED = path.join("native", "Shared");
const WRAPPER = path.join("native", "WrapperLauncher");
const BRIDGE = path.join("native", "StatusLineBridge");

function read(directory: string, name: string): string {
  return readFileSync(path.join(directory, name), "utf8");
}

function sourcesIn(directory: string): string[] {
  return readdirSync(directory).filter((entry) => entry.endsWith(".cs"));
}

const allSource = [SHARED, WRAPPER, BRIDGE]
  .flatMap((directory) => sourcesIn(directory).map((name) => read(directory, name)))
  .join("\n");
const program = read(WRAPPER, "Program.cs");
const bridge = read(BRIDGE, "Program.cs");
const childProcess = read(SHARED, "ChildProcess.cs");
const guardRegistry = read(SHARED, "GuardRegistry.cs");
const core = read(SHARED, "GuardCore.cs");

/** The body of one method, so ordering inside it can be asserted meaningfully. */
function methodBody(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  expect(from).toBeGreaterThan(0);
  expect(to).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe("native component security contract", () => {
  it("keeps every interpreter off the launch and refresh paths", () => {
    expect(sourcesIn(WRAPPER)).toContain("Program.cs");
    expect(sourcesIn(BRIDGE)).toContain("Program.cs");
    // A shell or script host between Claude Code and the CLI re-parses the argument vector, which
    // is how flags such as --verbose and -p got silently consumed.
    for (const interpreter of ["powershell.exe", "pwsh", "ExecutionPolicy", "cscript", "wscript"]) {
      expect(allSource).not.toContain(interpreter);
    }
    expect(allSource).not.toContain(".ps1");
    // The command processor is reachable only to run a batch-file CLI, which CreateProcess cannot
    // execute directly, and to run a status-line command the user themselves wrote as a shell line.
    expect(childProcess).toContain("IsBatchFile(executable)");
    expect(childProcess).toContain("CaptureShellCommand(");
  });

  it("shares one implementation of the things that used to drift", () => {
    // Two copies of path normalization meant a configuration directory at a drive root matched in
    // one component and not the other, and one workspace was recorded under two identities.
    expect(core).toContain("public static string Normalize(");
    expect(core).toContain("public static string WorkspaceHash(");
    expect(core).toContain("public static string LabelFor(");
    expect(guardRegistry).toContain("public static bool CollectionAllowed(");
    for (const source of [program, bridge]) {
      expect(source).toContain("GuardPaths.Normalize(");
      expect(source).toContain("GuardRegistry.");
    }
    // Neither component may reimplement them locally.
    expect(program).not.toContain("private static string NormalizeGuardPath");
    expect(bridge).not.toContain("private static string Normalize");
  });

  it("binds the workspace to an account instead of requiring a matching environment", () => {
    expect(program).toContain("ConfigDirectoryVariable = \"CLAUDE_CONFIG_DIR\"");
    expect(program).toContain(
      "Environment.SetEnvironmentVariable(ConfigDirectoryVariable, binding.ConfigDirectory)"
    );
    // Secure storage is derived from its own variable when set, so an ambient value would send
    // credentials to an account this launch is not bound to.
    expect(program).toContain("SecureStorageDirectoryVariable");
    // The environment is never checked against the binding; the wrapper is what sets it.
    expect(allSource).not.toContain("runtime_profile_mismatch");
  });

  it("verifies the bound account, with the bound configuration directory", () => {
    const resolve = methodBody(
      program,
      "private static GuardResolution Resolve(",
      "private static void ApplyBinding("
    );
    // Applying the binding before probing is what makes the probe report the bound account rather
    // than the ambient one.
    expect(resolve.indexOf("ApplyBinding(binding)")).toBeGreaterThan(0);
    expect(resolve.indexOf("ApplyBinding(binding)")).toBeLessThan(
      resolve.indexOf("Verify(target, binding)")
    );
    expect(resolve.indexOf("ApplyBinding(remembered)")).toBeLessThan(
      resolve.indexOf("Verify(target, remembered)")
    );
    // Claude Code passes `[node.exe, cli.js]` when it falls back to the JavaScript CLI, so a probe
    // against the first token alone would ask the host, not Claude.
    expect(program).toContain("target.Compose(new[] { \"auth\", \"status\" })");
  });

  it("refuses a launch for exactly one reason", () => {
    const thrown = program.match(/new GuardBlockException\(/g) ?? [];
    expect(thrown).toHaveLength(1);
    const site = program.slice(program.indexOf("throw new GuardBlockException("));
    expect(site).toContain("\"identity_mismatch\"");
    expect(program).toContain("outcome == \"identity_mismatch\" && binding.Enforced");
    expect(program).toContain("GuardExitCode = 78");
    expect(program).toContain("\"CLAUDE_WORKSPACE_ACCOUNTS_BLOCKED category=\" + category");
  });

  it("never blocks a user out of signing in, or out of a broken registry", () => {
    const verify = methodBody(
      program,
      "private static string Verify(",
      "private static JsonValue ResolveWorkspaceLock("
    );
    // Being signed out is a reason to let Claude prompt for sign-in, not to refuse.
    expect(verify).toContain("return \"signed_out\";");
    expect(verify).toContain("return \"identity_unverifiable\";");
    expect(verify).not.toContain("GuardBlockException");
    // A registry that cannot be read falls back to the last known binding, never to a block.
    expect(program).toContain("BindingCache.Match(cachePath, currentDirectory)");
    expect(program).toContain("\"registry_unavailable\"");
    // A cached binding is good enough to keep the right account, not to refuse a launch.
    expect(read(SHARED, "GuardStorage.cs")).toContain("public bool FromRegistry");
  });

  it("fails open for anything that is not a deliberate guard decision", () => {
    const main = methodBody(
      program,
      "public static int Main(",
      "private static bool IsGuardDisabled("
    );
    const blockedCatch = main.indexOf("catch (GuardBlockException blocked)");
    const generalCatch = main.indexOf("// Fail open.");
    expect(blockedCatch).toBeGreaterThan(0);
    expect(generalCatch).toBeGreaterThan(blockedCatch);
    // The kill switch is checked before any guard work happens at all.
    expect(main.indexOf("IsGuardDisabled()")).toBeLessThan(main.indexOf("Resolve(target)"));
    expect(program).toContain("DisableVariable = \"CLAUDE_WORKSPACE_ACCOUNTS_DISABLE\"");
    // A forwarded exit code is returned verbatim, so a CLI exit of 78 stays a CLI exit.
    expect(program).toContain("WriteGuardHealth(category, exitCode);");
    expect(program).toContain("return exitCode;");
  });

  it("does not inspect Claude credential files", () => {
    expect(allSource.toLocaleLowerCase()).not.toContain(".credentials");
    // Identity comes from the CLI's own answer, not from stored state.
    expect(program).toContain("expectedIdentity");
    expect(program).toContain("CaptureResult status = ChildProcess.Capture(");
  });

  it("records a launch outcome without recording what was launched", () => {
    const health = methodBody(
      program,
      "private static void WriteGuardHealth(",
      "AtomicFile.Write("
    );
    expect(health).toContain("\\\"category\\\"");
    expect(health).toContain("\\\"exitCode\\\"");
    expect(health).toContain("\\\"pid\\\"");
    expect(health).not.toContain("arguments");
    expect(health).not.toContain("Arguments");
    expect(health).not.toContain("Environment.GetEnvironmentVariable");
  });

  it("contains the CLI it starts in a job object that dies with the wrapper", () => {
    expect(childProcess).toContain("JobObjectLimitKillOnJobClose = 0x00002000");
    expect(childProcess).toContain("AssignProcessToJobObject");
    // Containment is best effort: it must never be a launch precondition.
    expect(childProcess).toContain("catch (Exception)");
  });
});

/**
 * The OpenTelemetry environment contract exists in two languages, so it has to be checked in both.
 * The wrapper's list previously covered four endpoints and three exporter selections; a user with
 * `OTEL_EXPORTER_OTLP_COMPRESSION` or a per-signal protocol override did not trip the guard, was
 * injected over anyway, and then had every export rejected. These assertions fail the build rather
 * than let the two copies drift again.
 */
describe("wrapper OpenTelemetry contract", () => {
  const declared = program.match(
    /private static readonly string\[\] ForeignOtelVariables =\s*\{([\s\S]*?)\};/
  );

  it("checks exactly the foreign variables the extension knows about", () => {
    expect(declared).not.toBeNull();
    const mirrored = [...(declared?.[1] ?? "").matchAll(/"([A-Z0-9_]+)"/g)].map(
      (match) => match[1]
    );
    expect(mirrored).toHaveLength(FOREIGN_OTEL_VARIABLES.length);
    expect([...mirrored].sort()).toEqual([...FOREIGN_OTEL_VARIABLES].sort());
    // Whitespace-only is not a configured exporter, in either language.
    expect(program).toContain(
      "if (!GuardValues.IsBlank(Environment.GetEnvironmentVariable(name)))"
    );
    expect(core).toContain("string.IsNullOrWhiteSpace(value)");
  });

  it("sets every variable the loopback collector needs, with the value it needs", () => {
    for (const [name, value] of Object.entries(REQUIRED_COLLECTOR_VARIABLES)) {
      expect(program).toContain(`Environment.SetEnvironmentVariable("${name}", "${value}");`);
    }
    // The OTEL default is grpc, which the collector cannot read at all.
    expect(REQUIRED_COLLECTOR_VARIABLES.OTEL_EXPORTER_OTLP_PROTOCOL).toBe("http/json");
    // Spans are refused rather than beta-enabled, and `none` is explicit so an inherited `otlp`
    // cannot aim them at a route that returns 404.
    expect(REQUIRED_COLLECTOR_VARIABLES.OTEL_TRACES_EXPORTER).toBe("none");
    expect(program).not.toContain(
      "Environment.SetEnvironmentVariable(\"OTEL_TRACES_EXPORTER\", \"otlp\")"
    );
  });

  it("forces every content-telemetry flag off", () => {
    for (const [name, value] of Object.entries(FORCED_PRIVACY_VARIABLES)) {
      expect(program).toContain(`Environment.SetEnvironmentVariable("${name}", "${value}");`);
    }
    expect(Object.keys(FORCED_PRIVACY_VARIABLES)).toHaveLength(5);
  });

  it("never enables a beta telemetry mode on the user's behalf", () => {
    for (const name of FORBIDDEN_BETA_VARIABLES) {
      expect(allSource).not.toContain(`SetEnvironmentVariable("${name}"`);
    }
  });

  it("keeps collection opt-in and refuses to inject over a user's pipeline", () => {
    expect(guardRegistry).toContain("profile[\"telemetryEnabled\"].IsTrue");
    expect(guardRegistry).toContain("registry[\"integration\"][\"telemetryEnabled\"].IsFalse");
    expect(program).toContain("GuardRegistry.CollectionAllowed(registry, telemetryProfile)");
    expect(program).toContain("HasUserExporterConfiguration()");
    expect(program).toContain("CollectorFreshnessSeconds = 60");
  });

  it("identifies a workspace by hash and label rather than by path", () => {
    expect(program).toContain("claude.account_guard.workspace_hash=");
    expect(program).toContain("claude.account_guard.workspace_label=");
    expect(core).toContain("\"[^A-Za-z0-9_.-]\"");
    expect(program).not.toContain("claude.account_guard.workspace_path");
  });
});

/**
 * The status-line bridge runs many times per session and its stdout *is* the status line, so its
 * whole contract is about never being the reason something is missing.
 */
describe("status-line bridge contract", () => {
  it("reads its payload as bytes and decodes it as UTF-8", () => {
    // `$input | Out-String` applied console-width formatting, wrapping a long single-line payload
    // and turning it into a parse failure nobody ever saw.
    expect(bridge).toContain("Console.OpenStandardInput()");
    expect(bridge).toContain("new UTF8Encoding(false).GetString(");
    expect(bridge).not.toContain("Console.In");
    expect(bridge).not.toContain("ReadLine");
  });

  it("always leaves a visible status line and always exits zero", () => {
    expect(bridge).toContain("[workspace-accounts: status line unavailable]");
    // Every path out of Main goes through Emit or EmitMarker, and Emit reports success.
    const main = methodBody(
      bridge,
      "public static int Main(",
      "private static string ReadStandardInput("
    );
    for (const match of main.matchAll(/^\s*return (.+);$/gm)) {
      expect(match[1]).toMatch(/^(0|Emit\(summary\)|EmitMarker\(\))$/);
    }
    expect(bridge).not.toContain("Environment.Exit");
    expect(methodBody(bridge, "private static int Emit(", "return 0;")).toContain("output.Flush()");
  });

  it("hands a chained command its own quoting, and its payload, untouched", () => {
    expect(bridge).toContain("ChildProcess.CaptureShellCommand(");
    // The command is a shell line the user wrote; it must not be re-quoted or split.
    expect(childProcess).toContain("\"/d /s /v:off /c \\\"\" + command + \"\\\"\"");
    // A payload this bridge cannot parse is still what the user's own status line is given.
    expect(bridge).toContain("payload ?? string.Empty");
  });

  it("falls back to the guard-owned mirror when the profile's backup is unusable", () => {
    expect(bridge).toContain("statusline-backups");
    expect(bridge).toContain("statusline-next.json");
    const resolve = methodBody(
      bridge,
      "private static string ResolveChainedCommand(",
      "private static IEnumerable<string> BackupLocations("
    );
    // A malformed or unreadable primary must continue to the next location, not give up.
    expect(resolve).toContain("continue;");
  });

  it("keeps the snapshot contract and the privacy rules", () => {
    for (const field of [
      "schemaVersion", "capturedAt", "profileId", "sessionId", "sessionName",
      "workspaceHash", "workspaceLabel", "workspacePath", "modelId", "modelDisplayName",
      "contextWindow", "currentUsage", "rateLimits", "fiveHour", "sevenDay"
    ]) {
      expect(bridge).toContain(field);
    }
    // A full workspace path is written only on an explicit opt-in; otherwise a label and a hash.
    expect(bridge).toContain("registry[\"integration\"][\"collectWorkspacePath\"].IsTrue");
    expect(bridge).toContain("GuardPaths.WorkspaceHash(normalizedWorkspace)");
    expect(bridge).toContain("GuardPaths.LabelFor(normalizedWorkspace)");
    // Collection is gated by the same check the wrapper uses, not a second copy of it.
    expect(bridge).toContain("GuardRegistry.CollectionAllowed(registry, profile)");
  });
});
