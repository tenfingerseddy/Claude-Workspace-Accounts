// A stand-in for the bundled JavaScript Claude CLI.
//
// Claude Code falls back to `[<host>, cli.js, ...args]` when no native binary exists for the
// platform, so the wrapper receives a two-token CLI prefix. This fixture proves the wrapper
// treats the prefix as the CLI: it answers `auth status` the way the real CLI does, and it
// records the trailing argument vector so fidelity can be compared byte for byte.
//
// It also reports the CLAUDE_CONFIG_DIR it was launched with, in both its `auth status`
// answer and its captured environment, because the account a launch runs as is exactly that
// directory - the wrapper setting it correctly is the product's central promise.
//
// Every behaviour is selected by environment variable so a single fixture can stand in for a
// signed-in CLI, a signed-out one, one that answers with unparseable output, and a
// long-running session used to prove process containment.
import fs from "node:fs";
import process from "node:process";

const args = process.argv.slice(2);
const configDir = process.env.CLAUDE_CONFIG_DIR ?? "";

if (args[0] === "auth" && args[1] === "status") {
  if (process.env.FAKE_AUTH_LOG) {
    fs.appendFileSync(process.env.FAKE_AUTH_LOG, `${configDir}\n`, "utf8");
  }
  const failure = Number(process.env.FAKE_AUTH_EXIT ?? "0");
  if (failure !== 0) {
    process.stderr.write("the CLI could not report auth status");
    process.exit(failure);
  }
  if (process.env.FAKE_AUTH_GARBAGE) {
    process.stdout.write("this is not json");
    process.exit(0);
  }
  if (process.env.FAKE_SIGNED_OUT) {
    // The shape the real CLI returns for a configuration directory with no credentials.
    process.stdout.write(JSON.stringify({
      loggedIn: false,
      authMethod: "none",
      apiProvider: "firstParty",
      configDir
    }));
    process.exit(0);
  }
  process.stdout.write(JSON.stringify({
    loggedIn: true,
    configDir,
    email: process.env.FAKE_EMAIL ?? "work@example.com",
    account: { id: process.env.FAKE_ACCOUNT_ID ?? "acct-work" },
    organization: { id: process.env.FAKE_ORG_ID ?? "org-work" }
  }));
  process.exit(0);
}

if (process.env.ARGDUMP_OUT) {
  fs.writeFileSync(process.env.ARGDUMP_OUT, JSON.stringify(args), "utf8");
}

// Only the variables the wrapper is responsible for. A blanket CLAUDE_* capture would copy
// unrelated secrets out of the ambient environment and into a test artefact.
const REPORTED_VARIABLES = [
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_SECURESTORAGE_CONFIG_DIR",
  "CLAUDE_WORKSPACE_ACCOUNTS_PROFILE_ID",
  "CLAUDE_WORKSPACE_ACCOUNTS_DISABLE",
  "CLAUDE_CODE_ENABLE_TELEMETRY"
];

if (process.env.GUARD_ENVIRONMENT_OUT) {
  const captured = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith("OTEL_") || REPORTED_VARIABLES.includes(name)) {
      captured[name] = value;
    }
  }
  fs.writeFileSync(process.env.GUARD_ENVIRONMENT_OUT, JSON.stringify(captured), "utf8");
}

// Announce the live process, then stay alive, so a test can kill the wrapper and observe
// whether the CLI was left orphaned.
if (process.env.FAKE_HOLD_PID_OUT) {
  fs.writeFileSync(process.env.FAKE_HOLD_PID_OUT, String(process.pid), "utf8");
  setInterval(() => {}, 1000);
} else {
  process.stdout.write("FAKE_CLAUDE_LAUNCHED");
  if (args.includes("--echo-stdin")) {
    process.stdin.pipe(process.stdout);
  } else if (process.env.FAKE_EXIT_CODE !== undefined) {
    process.exit(Number(process.env.FAKE_EXIT_CODE));
  }
}
