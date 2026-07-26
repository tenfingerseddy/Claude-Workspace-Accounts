import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The process wrapper is the one component that runs outside the extension host, on the path
 * of every Claude launch including background ones. Its behaviour cannot be asserted from the
 * extension's own tests, so the properties it must never lose are asserted against its source:
 * it binds a workspace to an account rather than demanding the environment already match, it
 * refuses a launch for exactly one reason, it never reads a credential store, it never lets
 * content telemetry be emitted, and it never re-enters an interpreter that would re-parse the
 * argument vector.
 */
const SOURCE_DIRECTORY = path.join("native", "WrapperLauncher");

function read(name: string): string {
  return readFileSync(path.join(SOURCE_DIRECTORY, name), "utf8");
}

const sources = readdirSync(SOURCE_DIRECTORY).filter((entry) => entry.endsWith(".cs"));
const allSource = sources.map(read).join("\n");
const program = read("Program.cs");

/** The body of one method, so ordering inside it can be asserted meaningfully. */
function methodBody(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  expect(from).toBeGreaterThan(0);
  expect(to).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe("process-wrapper security contract", () => {
  it("is a single native process with no interpreter on the launch path", () => {
    expect(sources).toContain("Program.cs");
    // A shell or script host between Claude Code and the CLI re-parses the argument vector,
    // which is how flags such as --verbose and -p get silently consumed.
    for (const interpreter of ["powershell.exe", "pwsh", "ExecutionPolicy", "cscript", "wscript"]) {
      expect(allSource).not.toContain(interpreter);
    }
    expect(allSource).not.toContain(".ps1");
    // The command processor is reachable only to run a batch-file CLI, which CreateProcess
    // cannot execute directly.
    expect(read("ChildProcess.cs")).toContain("IsBatchFile(executable)");
  });

  it("binds the workspace to an account instead of requiring a matching environment", () => {
    expect(program).toContain("ConfigDirectoryVariable = \"CLAUDE_CONFIG_DIR\"");
    expect(program).toContain(
      "Environment.SetEnvironmentVariable(ConfigDirectoryVariable, binding.ConfigDirectory)"
    );
    // Secure storage is derived from its own variable when set, so an ambient value would
    // send credentials to an account this launch is not bound to.
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
    // Applying the binding before probing is what makes the probe report the bound account
    // rather than the ambient one.
    expect(resolve.indexOf("ApplyBinding(binding)")).toBeGreaterThan(0);
    expect(resolve.indexOf("ApplyBinding(binding)")).toBeLessThan(
      resolve.indexOf("Verify(target, binding)")
    );
    expect(resolve.indexOf("ApplyBinding(remembered)")).toBeLessThan(
      resolve.indexOf("Verify(target, remembered)")
    );
    // Claude Code passes `[node.exe, cli.js]` when it falls back to the JavaScript CLI, so a
    // probe against the first token alone would ask the host, not Claude.
    expect(program).toContain("target.Compose(new[] { \"auth\", \"status\" })");
  });

  it("refuses a launch for exactly one reason", () => {
    const thrown = program.match(/new GuardBlockException\(/g) ?? [];
    expect(thrown).toHaveLength(1);
    const site = program.slice(program.indexOf("throw new GuardBlockException("));
    expect(site).toContain("\"identity_mismatch\"");
    expect(program).toContain("outcome == \"identity_mismatch\" && binding.Enforced");
    expect(program).toContain("GuardExitCode = 78");
    expect(program).toContain("\"CLAUDE_ACCOUNT_GUARD_BLOCKED category=\" + category");
  });

  it("never blocks a user out of signing in, or out of a broken registry", () => {
    const verify = methodBody(
      program,
      "private static string Verify(",
      "private static void ValidateRegistry("
    );
    // Being signed out is a reason to let Claude prompt for sign-in, not to refuse.
    expect(verify).toContain("return \"signed_out\";");
    expect(verify).toContain("return \"identity_unverifiable\";");
    expect(verify).not.toContain("GuardBlockException");
    // A registry that cannot be read falls back to the last known binding, never to a block.
    expect(program).toContain("BindingCache.Match(cachePath, currentDirectory)");
    expect(program).toContain("\"registry_unavailable\"");
    // A cached binding is good enough to keep the right account, not to refuse a launch.
    expect(read("GuardStorage.cs")).toContain("public bool FromRegistry");
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
    expect(program).toContain("DisableVariable = \"CLAUDE_ACCOUNT_GUARD_DISABLE\"");
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

  it("forces every content-telemetry flag off", () => {
    for (const flag of [
      "OTEL_LOG_USER_PROMPTS",
      "OTEL_LOG_ASSISTANT_RESPONSES",
      "OTEL_LOG_TOOL_DETAILS",
      "OTEL_LOG_TOOL_CONTENT",
      "OTEL_LOG_RAW_API_BODIES"
    ]) {
      expect(program).toContain(`Environment.SetEnvironmentVariable("${flag}", "0");`);
    }
  });

  it("keeps telemetry opt-in and never redirects an exporter the user configured", () => {
    expect(program).toContain("registry[\"integration\"][\"telemetryEnabled\"].IsFalse");
    expect(program).toContain("telemetryProfile[\"telemetryEnabled\"].IsTrue");
    expect(program).toContain("HasUserExporterConfiguration()");
    for (const name of [
      "OTEL_EXPORTER_OTLP_ENDPOINT",
      "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
      "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
      "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
      "OTEL_METRICS_EXPORTER",
      "OTEL_LOGS_EXPORTER",
      "OTEL_TRACES_EXPORTER",
      "OTEL_EXPORTER_OTLP_HEADERS"
    ]) {
      expect(program).toContain(name);
    }
    expect(program).toContain("CollectorFreshnessSeconds = 60");
  });

  it("records a launch outcome without recording what was launched", () => {
    const health = methodBody(
      program,
      "private static void WriteGuardHealth(",
      "private static string ResolveSupportRoot("
    );
    expect(health).toContain("\\\"category\\\"");
    expect(health).toContain("\\\"exitCode\\\"");
    expect(health).toContain("\\\"pid\\\"");
    expect(health).not.toContain("arguments");
    expect(health).not.toContain("Arguments");
    expect(health).not.toContain("Environment.GetEnvironmentVariable");
  });

  it("identifies a workspace by hash and label rather than by path", () => {
    expect(program).toContain("claude.account_guard.workspace_hash=");
    expect(program).toContain("claude.account_guard.workspace_label=");
    expect(program).toContain("\"[^A-Za-z0-9_.-]\"");
    expect(program).not.toContain("claude.account_guard.workspace_path");
  });

  it("contains the CLI it starts in a job object that dies with the wrapper", () => {
    const child = read("ChildProcess.cs");
    expect(child).toContain("JobObjectLimitKillOnJobClose = 0x00002000");
    expect(child).toContain("AssignProcessToJobObject");
    // Containment is best effort: it must never be a launch precondition.
    expect(child).toContain("catch (Exception)");
  });
});
