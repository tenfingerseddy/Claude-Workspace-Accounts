using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;

namespace ClaudeWorkspaceAccounts.WrapperLauncher
{
    /// <summary>
    /// A deliberate refusal to launch Claude.
    ///
    /// Exactly one condition throws this: an enforcing workspace whose bound configuration
    /// directory has been re-authenticated as a different account than the one recorded for it.
    /// Binding would otherwise hand that workspace the wrong account silently. It is caught
    /// separately from every other error so no incidental fault can be mistaken for it.
    /// </summary>
    internal sealed class GuardBlockException : Exception
    {
        private readonly string category;

        public GuardBlockException(string category, string message)
            : base(message)
        {
            this.category = category;
        }

        public string Category
        {
            get { return category; }
        }
    }

    /// <summary>
    /// How to invoke the Claude CLI, split into the invocation prefix and Claude's own
    /// arguments.
    ///
    /// Claude Code does not always pass a single executable. It composes
    /// <c>[executableArgs..., claudeArgs...]</c>, and <c>executableArgs</c> is either the
    /// bundled native binary (<c>[claude.exe]</c>) or a host plus the bundled JavaScript CLI
    /// (<c>[node.exe, cli.js]</c>) when no native binary exists for the platform. Treating the
    /// first token as the whole CLI works by accident when forwarding and fails badly when
    /// probing identity, because <c>node.exe auth status</c> is not a Claude invocation.
    /// Everything downstream therefore uses the prefix, never a single token.
    /// </summary>
    internal sealed class LaunchTarget
    {
        private static readonly string[] ScriptExtensions = { ".js", ".mjs", ".cjs" };

        private readonly IList<string> prefix;
        private readonly IList<string> arguments;
        private readonly string resolvedExecutable;

        private LaunchTarget(
            IList<string> prefix,
            IList<string> arguments,
            string resolvedExecutable
        )
        {
            this.prefix = prefix;
            this.arguments = arguments;
            this.resolvedExecutable = resolvedExecutable;
        }

        /// <summary>The tokens that name the CLI: one for a binary, two for a hosted script.</summary>
        public IList<string> Prefix
        {
            get { return prefix; }
        }

        /// <summary>Claude's own argument vector, which must be forwarded untouched.</summary>
        public IList<string> Arguments
        {
            get { return arguments; }
        }

        /// <summary>
        /// The full path of the executable to start, or null when it could not be found on
        /// disk or on PATH.
        /// </summary>
        public string ResolvedExecutable
        {
            get { return resolvedExecutable; }
        }

        public static LaunchTarget Resolve(string[] args)
        {
            var invocation = new List<string>();
            invocation.Add(args[0]);
            int firstArgument = 1;

            // The host of the JavaScript CLI is node.exe from a terminal but, inside the VS
            // Code extension host, whatever `process.execPath` happens to be - so the host
            // name is not something worth allowlisting. What identifies the shape is that the
            // second token is a JavaScript file that exists and the first token is not the
            // Claude CLI itself.
            if (args.Length >= 2 && IsExistingScript(args[1]) && !IsClaudeCliName(args[0]))
            {
                invocation.Add(args[1]);
                firstArgument = 2;
            }

            var claudeArguments = new List<string>();
            for (int index = firstArgument; index < args.Length; index++)
            {
                claudeArguments.Add(args[index]);
            }
            return new LaunchTarget(invocation, claudeArguments, ResolveExecutable(args[0]));
        }

        /// <summary>The CLI invocation followed by extra arguments, as one command.</summary>
        public IList<string> Compose(IEnumerable<string> extraArguments)
        {
            var command = new List<string>(prefix);
            foreach (string argument in extraArguments)
            {
                command.Add(argument);
            }
            return command;
        }

        private static bool IsExistingScript(string token)
        {
            try
            {
                string extension = Path.GetExtension(token);
                foreach (string candidate in ScriptExtensions)
                {
                    if (string.Equals(extension, candidate, StringComparison.OrdinalIgnoreCase))
                    {
                        return File.Exists(token);
                    }
                }
                return false;
            }
            catch (Exception)
            {
                return false;
            }
        }

        private static bool IsClaudeCliName(string token)
        {
            try
            {
                return string.Equals(
                    Path.GetFileNameWithoutExtension(token),
                    "claude",
                    StringComparison.OrdinalIgnoreCase
                );
            }
            catch (Exception)
            {
                return false;
            }
        }

        /// <summary>
        /// Finds the executable the way a shell would: an explicit path must exist, and a
        /// bare command name is looked up across PATH using PATHEXT. Returning null means the
        /// wrapper has nothing it can verify or start.
        /// </summary>
        private static string ResolveExecutable(string token)
        {
            try
            {
                if (string.IsNullOrWhiteSpace(token))
                {
                    return null;
                }
                if (token.IndexOf('\\') >= 0
                    || token.IndexOf('/') >= 0
                    || (token.Length > 1 && token[1] == ':'))
                {
                    return File.Exists(token) ? Path.GetFullPath(token) : null;
                }

                var extensions = new List<string>();
                bool hasExtension = Path.GetExtension(token).Length > 0;
                if (hasExtension)
                {
                    extensions.Add(string.Empty);
                }
                string configured = Environment.GetEnvironmentVariable("PATHEXT");
                foreach (string extension in (configured ?? ".COM;.EXE;.BAT;.CMD").Split(';'))
                {
                    if (extension.Trim().Length > 0)
                    {
                        extensions.Add(extension.Trim());
                    }
                }
                if (!hasExtension)
                {
                    extensions.Add(string.Empty);
                }

                string searchPath = Environment.GetEnvironmentVariable("PATH") ?? string.Empty;
                foreach (string directory in searchPath.Split(';'))
                {
                    string trimmed = directory.Trim().Trim('"');
                    if (trimmed.Length == 0)
                    {
                        continue;
                    }
                    foreach (string extension in extensions)
                    {
                        string candidate;
                        try
                        {
                            candidate = Path.Combine(trimmed, token + extension);
                        }
                        catch (ArgumentException)
                        {
                            continue;
                        }
                        if (File.Exists(candidate))
                        {
                            return Path.GetFullPath(candidate);
                        }
                    }
                }
                return null;
            }
            catch (Exception)
            {
                return null;
            }
        }
    }

    /// <summary>What the guard concluded, and therefore how the launch should be prepared.</summary>
    internal sealed class GuardResolution
    {
        private readonly JsonValue registry;
        private readonly WorkspaceBinding binding;
        private readonly string telemetryProfileId;
        private readonly string category;
        private readonly bool bypassed;

        public GuardResolution(
            JsonValue registry,
            WorkspaceBinding binding,
            string telemetryProfileId,
            string category
        )
            : this(registry, binding, telemetryProfileId, category, false)
        {
        }

        private GuardResolution(
            JsonValue registry,
            WorkspaceBinding binding,
            string telemetryProfileId,
            string category,
            bool bypassed
        )
        {
            this.registry = registry;
            this.binding = binding;
            this.telemetryProfileId = telemetryProfileId;
            this.category = category;
            this.bypassed = bypassed;
        }

        /// <summary>The validated registry, or null when there was none to read.</summary>
        public JsonValue Registry
        {
            get { return registry; }
        }

        /// <summary>The account this workspace was bound to, or null when it is unbound.</summary>
        public WorkspaceBinding Binding
        {
            get { return binding; }
        }

        /// <summary>The profile local usage should be attributed to.</summary>
        public string TelemetryProfileId
        {
            get { return telemetryProfileId; }
        }

        /// <summary>
        /// What to record for diagnostics: null for an ordinary launch, otherwise the reason
        /// the guard could not do its job or the mismatch it tolerated.
        /// </summary>
        public string Category
        {
            get { return category; }
        }

        /// <summary>
        /// True only for the kill switch. <c>CLAUDE_WORKSPACE_ACCOUNTS_DISABLE=1</c> - or the name
        /// v0.1.0 shipped - has to make the wrapper a pure passthrough: no binding, no probe, and
        /// not one environment variable of ours, including the content-telemetry flags forced off on
        /// every other path. An escape hatch that still edits the environment cannot be used to
        /// escape a defect in the way this wrapper edits the environment.
        /// </summary>
        public bool Bypassed
        {
            get { return bypassed; }
        }

        public static GuardResolution Unbound(JsonValue registry, string profileId, string category)
        {
            return new GuardResolution(registry, null, profileId, category);
        }

        public static GuardResolution KillSwitch()
        {
            return new GuardResolution(null, null, null, null, true);
        }
    }

    /// <summary>
    /// The Claude Workspace Accounts process wrapper.
    ///
    /// Claude Code launches <c>wrapper.exe &lt;claude-cli...&gt; &lt;args...&gt;</c>. The
    /// wrapper works out which account this workspace should run as, points the launch at that
    /// account's isolated configuration directory by setting <c>CLAUDE_CONFIG_DIR</c>, and then
    /// execs the CLI as a direct child with the argument vector, standard streams and exit code
    /// passed through untouched. Binding per launch is what lets one workspace run as one
    /// account while another runs as a different one, with neither switching the other.
    ///
    /// Three properties are load bearing. First, argument fidelity: the wrapper is a single
    /// native process, so the vector Claude Code spawned is the vector the CLI receives - no
    /// shell, no script host, nothing that re-parses. Second, binding rather than refusing: the
    /// wrapper sets the account instead of demanding the environment already match, because a
    /// guard that refuses is a guard that stops people working. Third, failing open: the only
    /// thing that can refuse a launch is a genuine identity mismatch on an enforcing binding,
    /// and every other fault - I/O, parsing, telemetry, process containment - forwards the
    /// launch with the ambient environment untouched. The wrapper is on the path of background
    /// Claude calls as well as the interactive session, so all three are paid for many times
    /// per session.
    /// </summary>
    internal static class Program
    {
        private const int GuardExitCode = 78;

        /// <summary>
        /// Nothing to launch: a usage error in how the wrapper itself was invoked. Deliberately not
        /// the guard's own exit code, because <c>78</c> and the blocked marker mean one thing - an
        /// identity mismatch a user has to resolve - and a diagnostics reader that saw them here
        /// would report a refusal the guard never made.
        /// </summary>
        private const int InvocationExitCode = 64;

        private const string DisableVariable = "CLAUDE_WORKSPACE_ACCOUNTS_DISABLE";

        /// <summary>
        /// The kill switch v0.1.0 documented and shipped, under the product's old name.
        ///
        /// A permanent alias, not a courtesy. A persistent <c>setx</c> value or a checked-in
        /// workspace <c>terminal.integrated.env.windows</c> entry survives a rename and no migration
        /// can reach either, so honouring only the new name left a user who had set the documented
        /// escape hatch believing the wrapper was bypassed while binding and telemetry were quietly
        /// active again. Either name, set to <c>1</c>, bypasses everything.
        /// </summary>
        private const string LegacyDisableVariable = "CLAUDE_ACCOUNT_GUARD_DISABLE";
        private const string WorkspaceKeyVariable = "CLAUDE_WORKSPACE_ACCOUNTS_WORKSPACE_KEY";
        private const string ConfigDirectoryVariable = "CLAUDE_CONFIG_DIR";
        private const string SecureStorageDirectoryVariable = "CLAUDE_SECURESTORAGE_CONFIG_DIR";
        private const int AuthStatusTimeoutMilliseconds = 60000;
        private const double CollectorFreshnessSeconds = 60;

        /// <summary>
        /// Any of these being set means the user already has an OpenTelemetry pipeline, or has
        /// chosen a wire format the loopback collector cannot read. Injection is refused outright,
        /// because a partial override produces a collector that listens and rejects everything.
        ///
        /// This is the C# half of a contract. The authoritative copy is
        /// <c>FOREIGN_OTEL_VARIABLES</c> in <c>src/telemetry/otelEnvironment.ts</c>, and
        /// <c>wrapperContract.test.ts</c> fails the build if the two ever disagree. It used to check
        /// only the four endpoints and three exporter selections, so a user with
        /// <c>OTEL_EXPORTER_OTLP_METRICS_PROTOCOL=http/protobuf</c> or
        /// <c>OTEL_EXPORTER_OTLP_COMPRESSION=gzip</c> set did not trip the guard, was injected over,
        /// and then had every single export rejected.
        /// </summary>
        private static readonly string[] ForeignOtelVariables =
        {
            "OTEL_EXPORTER_OTLP_ENDPOINT",
            "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
            "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
            "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
            "OTEL_EXPORTER_OTLP_PROTOCOL",
            "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL",
            "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL",
            "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
            "OTEL_EXPORTER_OTLP_COMPRESSION",
            "OTEL_EXPORTER_OTLP_METRICS_COMPRESSION",
            "OTEL_EXPORTER_OTLP_LOGS_COMPRESSION",
            "OTEL_EXPORTER_OTLP_TRACES_COMPRESSION",
            "OTEL_EXPORTER_OTLP_HEADERS",
            "OTEL_EXPORTER_OTLP_METRICS_HEADERS",
            "OTEL_EXPORTER_OTLP_LOGS_HEADERS",
            "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
            "OTEL_METRICS_EXPORTER",
            "OTEL_LOGS_EXPORTER",
            "OTEL_TRACES_EXPORTER",
            "OTEL_EXPORTER_OTLP_CERTIFICATE",
            "OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE",
            "OTEL_EXPORTER_OTLP_CLIENT_KEY",
            "CLAUDE_CODE_CLIENT_CERT",
            "CLAUDE_CODE_CLIENT_KEY",
            "CLAUDE_CODE_CLIENT_KEY_PASSPHRASE"
        };

        public static int Main(string[] args)
        {
            // An empty vector is the only input with nothing to forward, so it is the only
            // input the wrapper itself can be blamed for. Reported as an ordinary launch failure:
            // the guard has made no decision here and must not appear to have made one.
            if (args.Length == 0 || string.IsNullOrWhiteSpace(args[0]))
            {
                return InvalidInvocation();
            }

            LaunchTarget target;
            try
            {
                target = LaunchTarget.Resolve(args);
            }
            catch (Exception)
            {
                return InvalidInvocation();
            }

            // An explicit kill switch: the guard steps aside completely - no binding, no
            // probe, no telemetry, not one environment variable of ours - so a user is never one
            // wrapper defect away from being unable to start Claude.
            if (IsGuardDisabled())
            {
                return Forward(target, GuardResolution.KillSwitch(), "launch_failed");
            }

            // Claude Code also configures the wrapper with no CLI at all, in which case the
            // first token is a Claude flag rather than an executable. There is nothing to bind
            // or verify and nothing the guard should take the blame for: attempt the launch and
            // let the real failure surface with its real exit code.
            if (target.ResolvedExecutable == null)
            {
                return Forward(
                    target,
                    GuardResolution.Unbound(null, null, "binary_missing"),
                    "binary_missing"
                );
            }

            GuardResolution resolution;
            try
            {
                resolution = Resolve(target);
            }
            catch (GuardBlockException blocked)
            {
                return Block(blocked.Category, blocked.Message);
            }
            catch (Exception)
            {
                // Fail open. Anything that is not a deliberate guard decision forwards the
                // launch as though no guard state existed.
                resolution = GuardResolution.Unbound(null, null, "registry_unavailable");
            }
            return Forward(target, resolution, "launch_failed");
        }

        private static bool IsGuardDisabled()
        {
            return IsSetToOne(DisableVariable) || IsSetToOne(LegacyDisableVariable);
        }

        private static bool IsSetToOne(string name)
        {
            try
            {
                return string.Equals(
                    Environment.GetEnvironmentVariable(name),
                    "1",
                    StringComparison.Ordinal
                );
            }
            catch (Exception)
            {
                return false;
            }
        }

        /// <summary>
        /// Works out which account this workspace runs as, applies it, and checks that the
        /// account it applied is the one that was expected.
        /// </summary>
        private static GuardResolution Resolve(LaunchTarget target)
        {
            string currentDirectory = GuardPaths.Normalize(Directory.GetCurrentDirectory());
            string registryPath = GuardSupport.RegistryPath;
            string cachePath = GuardSupport.Combine("binding-cache.json");
            // Before anything decides whether the cache will be read or written at all: a cache
            // written by an earlier release recorded literal workspace directories, and several of
            // the paths below - a missing registry above all - touch the cache nowhere else, so a
            // purge anywhere later would leave those paths on disk indefinitely.
            BindingCache.PurgeLiteralPaths(cachePath);

            if (registryPath == null || !File.Exists(registryPath))
            {
                // A stable launcher outlives an uninstalled extension. With no guard state
                // there is nothing to bind, and Claude Code must keep working.
                return GuardResolution.Unbound(null, null, null);
            }

            JsonValue registry = GuardRegistry.Load(registryPath);
            if (registry == null)
            {
                // A registry that cannot be read must not quietly drop this workspace back
                // onto the ambient account. The last binding it resolved to is a far better
                // answer, and it is never grounds for refusing a launch.
                WorkspaceBinding remembered = BindingCache.Match(cachePath, currentDirectory);
                if (remembered == null)
                {
                    return GuardResolution.Unbound(null, null, "registry_unavailable");
                }
                ApplyBinding(remembered);
                string cachedOutcome = Verify(target, remembered);
                return new GuardResolution(
                    null,
                    remembered,
                    remembered.ProfileId,
                    cachedOutcome ?? "registry_unavailable"
                );
            }

            // Which registered account the ambient environment already points at. Used only to
            // attribute local usage when this workspace turns out not to be bound.
            string ambientProfileId = GuardValues.Text(
                GuardRegistry.FindProfileByConfigDirectory(
                    registry,
                    GuardPaths.Normalize(GuardRegistry.RuntimeConfigDirectory())
                ) ?? JsonValue.Absent,
                "id"
            );

            JsonValue workspaceLock = ResolveWorkspaceLock(registry, currentDirectory);
            if (workspaceLock == null)
            {
                // Not bound: leave the environment exactly as Claude Code set it up.
                BindingCache.Forget(cachePath, currentDirectory);
                return GuardResolution.Unbound(registry, ambientProfileId, null);
            }

            JsonValue boundProfile = GuardRegistry.FindProfileById(
                registry,
                GuardValues.Text(workspaceLock, "profileId")
            );
            if (boundProfile == null)
            {
                BindingCache.Forget(cachePath, currentDirectory);
                return GuardResolution.Unbound(
                    registry,
                    ambientProfileId,
                    "required_profile_missing"
                );
            }
            string configDirectory = GuardValues.Text(boundProfile, "configDir");
            if (GuardValues.IsBlank(configDirectory))
            {
                configDirectory = GuardValues.Text(boundProfile, "configDirNormalized");
            }
            if (GuardValues.IsBlank(configDirectory))
            {
                BindingCache.Forget(cachePath, currentDirectory);
                return GuardResolution.Unbound(
                    registry,
                    ambientProfileId,
                    "required_profile_missing"
                );
            }

            JsonValue expected = boundProfile["expectedIdentity"];
            var binding = new WorkspaceBinding(
                currentDirectory,
                GuardValues.Text(boundProfile, "id"),
                configDirectory,
                GuardValues.Text(workspaceLock, "mode"),
                GuardValues.Text(expected, "accountId"),
                GuardValues.Text(expected, "email"),
                GuardValues.Text(expected, "organizationId"),
                null,
                true
            );
            BindingCache.Remember(cachePath, binding);

            ApplyBinding(binding);
            string outcome = Verify(target, binding);
            if (outcome == "identity_mismatch" && binding.Enforced)
            {
                string displayName = GuardValues.Text(boundProfile, "displayName")
                    ?? binding.ProfileId;
                // The message has to name the way out, or the only remaining block becomes a
                // dead end for the one user it was meant to protect.
                throw new GuardBlockException(
                    "identity_mismatch",
                    "This workspace is bound to '" + displayName + "', but that account's "
                        + "directory is now signed in as a different account, so no Claude "
                        + "request was started. Re-verify the account from Claude Workspace "
                        + "Accounts, or set this workspace's binding to 'warn' to launch anyway."
                );
            }
            return new GuardResolution(registry, binding, binding.ProfileId, outcome);
        }

        /// <summary>
        /// Points this launch - and every process it starts - at the bound account's isolated
        /// configuration directory. This is the whole per-workspace account switch: the CLI
        /// reads its credentials from <c>CLAUDE_CONFIG_DIR</c>, so setting it per launch keeps
        /// two workspaces on two accounts without either one switching the other. Claude's
        /// status-line hook inherits it too, which is how the status-line bridge attributes
        /// usage to the bound account instead of guessing.
        /// </summary>
        private static void ApplyBinding(WorkspaceBinding binding)
        {
            Environment.SetEnvironmentVariable(ConfigDirectoryVariable, binding.ConfigDirectory);
            // Secure storage is derived from its own variable when that is set, so an ambient
            // value would send credentials to the account this launch is not bound to.
            if (!GuardValues.IsBlank(
                Environment.GetEnvironmentVariable(SecureStorageDirectoryVariable)))
            {
                Environment.SetEnvironmentVariable(
                    SecureStorageDirectoryVariable,
                    binding.ConfigDirectory
                );
            }
            if (!GuardValues.IsBlank(binding.ProfileId))
            {
                Environment.SetEnvironmentVariable(
                    "CLAUDE_WORKSPACE_ACCOUNTS_PROFILE_ID",
                    binding.ProfileId
                );
            }
        }

        /// <summary>
        /// Asks the CLI which account the bound directory is actually signed in as.
        ///
        /// Returns null when there is nothing to disagree about, otherwise the category to
        /// record. Being signed out is not a disagreement: with binding, a signed-out directory
        /// means Claude should offer to sign in there, and refusing the launch would be exactly
        /// what stops the user ever doing so.
        /// </summary>
        private static string Verify(LaunchTarget target, WorkspaceBinding binding)
        {
            if (!binding.HasExpectedIdentity
                || string.Equals(binding.Mode, "off", StringComparison.OrdinalIgnoreCase))
            {
                return null;
            }

            JsonValue auth;
            try
            {
                // The probe inherits the environment ApplyBinding just set, so it reports the
                // bound account rather than the ambient one.
                CaptureResult status = ChildProcess.Capture(
                    target.Compose(new[] { "auth", "status" }),
                    target.ResolvedExecutable,
                    AuthStatusTimeoutMilliseconds
                );
                if (status.ExitCode != 0)
                {
                    return "signed_out";
                }
                auth = JsonReader.Parse(status.StandardOutput.Trim());
            }
            catch (Exception)
            {
                return "identity_unverifiable";
            }

            if (auth["loggedIn"].IsFalse)
            {
                return "signed_out";
            }

            JsonValue account = auth["account"];
            JsonValue organization = auth["organization"];
            string actualAccountId = GuardValues.FirstValue(
                auth["accountId"],
                auth["account_id"],
                auth["accountUuid"],
                auth["account_uuid"],
                account["id"],
                account["uuid"]
            );
            string actualEmail = GuardValues.FirstValue(auth["email"], account["email"]);
            string actualOrganizationId = GuardValues.FirstValue(
                auth["organizationId"],
                auth["organization_id"],
                auth["orgId"],
                organization["id"],
                organization["uuid"]
            );

            // Nothing to compare against means the directory is signed in but the CLI told us
            // nothing identifying; that is unverifiable, not a mismatch.
            if (GuardValues.IsBlank(actualAccountId) && GuardValues.IsBlank(actualEmail))
            {
                return "identity_unverifiable";
            }

            bool identityMatches = false;
            if (!GuardValues.IsBlank(binding.ExpectedAccountId)
                && !GuardValues.IsBlank(actualAccountId))
            {
                identityMatches = GuardValues.Matches(binding.ExpectedAccountId, actualAccountId);
            }
            else if (!GuardValues.IsBlank(binding.ExpectedEmail)
                && !GuardValues.IsBlank(actualEmail))
            {
                identityMatches = GuardValues.Matches(
                    binding.ExpectedEmail.Trim(),
                    actualEmail.Trim()
                );
            }
            else
            {
                // The CLI answered with a different identifier than the one recorded, so this
                // is not evidence of a mismatch either way.
                return "identity_unverifiable";
            }

            if (identityMatches
                && !GuardValues.IsBlank(binding.ExpectedOrganizationId)
                && !GuardValues.IsBlank(actualOrganizationId))
            {
                identityMatches = GuardValues.Matches(
                    binding.ExpectedOrganizationId,
                    actualOrganizationId
                );
            }

            return identityMatches ? null : "identity_mismatch";
        }

        /// <summary>
        /// Picks the binding that governs this directory.
        ///
        /// An explicit workspace key wins, but only when its lock also covers the current
        /// directory, so a stale key from another window cannot bind the wrong account here.
        /// Otherwise the longest matching workspace root wins, which is what lets a nested
        /// folder be bound to a different account than the tree it sits in.
        /// </summary>
        private static JsonValue ResolveWorkspaceLock(JsonValue registry, string currentDirectory)
        {
            string workspaceKey = Environment.GetEnvironmentVariable(WorkspaceKeyVariable);
            if (!GuardValues.IsBlank(workspaceKey))
            {
                foreach (JsonValue candidate in registry["workspaceLocks"].Elements)
                {
                    if (GuardValues.Matches(
                            GuardValues.Text(candidate, "workspaceKey"),
                            workspaceKey)
                        && !GuardValues.Matches(GuardValues.Text(candidate, "mode"), "off")
                        && LockMatchLength(candidate, currentDirectory) > 0)
                    {
                        return candidate;
                    }
                }
            }

            JsonValue selected = null;
            int longest = 0;
            foreach (JsonValue candidate in registry["workspaceLocks"].Elements)
            {
                if (GuardValues.Matches(GuardValues.Text(candidate, "mode"), "off"))
                {
                    continue;
                }
                int length = LockMatchLength(candidate, currentDirectory);
                if (length > longest)
                {
                    longest = length;
                    selected = candidate;
                }
            }
            return selected;
        }

        private static int LockMatchLength(JsonValue workspaceLock, string currentDirectory)
        {
            var paths = new List<string>();
            foreach (JsonValue candidate in workspaceLock["workspaceRootPathsNormalized"].Elements)
            {
                string value = candidate.AsText();
                if (!GuardValues.IsBlank(value))
                {
                    paths.Add(value);
                }
            }
            if (paths.Count == 0)
            {
                paths.Add(
                    GuardValues.Text(workspaceLock, "workspacePathNormalized") ?? string.Empty
                );
            }
            int longest = 0;
            foreach (string candidate in paths)
            {
                string prefix = candidate.TrimEnd('\\') + "\\";
                if (string.Equals(currentDirectory, candidate, StringComparison.OrdinalIgnoreCase)
                    || currentDirectory.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                {
                    longest = Math.Max(longest, candidate.Length);
                }
            }
            return longest;
        }

        /// <summary>
        /// Runs the CLI and returns its exit code verbatim, including 78: a Claude failure
        /// that happens to collide with the guard's own blocked code is still a Claude
        /// failure, and is never reported as a block.
        /// </summary>
        private static int Forward(
            LaunchTarget target,
            GuardResolution resolution,
            string launchFailureCategory
        )
        {
            // First, and outside the injection path entirely. The five content flags used to be set
            // only where a collector registration was successfully injected, so every early return
            // out of that method - no registry, no registration, a stale one, telemetry off for the
            // profile or globally - forwarded whatever the environment happened to carry. With an
            // inherited CLAUDE_CODE_ENABLE_TELEMETRY=1 and no endpoint configured, OTLP falls back
            // to its default localhost endpoint, so an inherited OTEL_LOG_USER_PROMPTS=1 exported
            // prompt and response content to whatever was listening there.
            if (!resolution.Bypassed)
            {
                ForceContentTelemetryOff();
            }

            try
            {
                ApplyCollectorEnvironment(resolution.Registry, resolution.TelemetryProfileId);
            }
            catch (Exception)
            {
                // A stale or malformed collector registration disables collection, not Claude.
            }

            string upstream = null;
            try
            {
                if (resolution.Registry != null)
                {
                    string candidate = GuardValues.Text(
                        resolution.Registry["integration"],
                        "upstreamWrapper"
                    );
                    if (!GuardValues.IsBlank(candidate) && File.Exists(candidate))
                    {
                        upstream = candidate;
                    }
                }
            }
            catch (Exception)
            {
                upstream = null;
            }

            string category = resolution.Category ?? "forwarded";
            int exitCode;
            if (upstream != null)
            {
                // A chained wrapper receives the same contract this one did: the whole CLI
                // invocation followed by Claude's arguments.
                var chained = new List<string>();
                chained.Add(upstream);
                foreach (string token in target.Compose(target.Arguments))
                {
                    chained.Add(token);
                }
                if (ChildProcess.TryRun(chained, upstream, out exitCode))
                {
                    WriteGuardHealth(category, exitCode);
                    return exitCode;
                }
                // A chained third-party wrapper that will not start must not take Claude
                // down with it.
            }

            if (ChildProcess.TryRun(
                target.Compose(target.Arguments),
                target.ResolvedExecutable,
                out exitCode))
            {
                WriteGuardHealth(category, exitCode);
                return exitCode;
            }

            // Not a guard decision, so deliberately not reported as one.
            WriteGuardHealth(launchFailureCategory, 1);
            Console.Error.WriteLine("Claude Workspace Accounts could not start the Claude executable.");
            return 1;
        }

        /// <summary>
        /// Points Claude Code's OpenTelemetry exporters at this profile's local collector.
        ///
        /// Every guard here exists to keep collection opt-in and local: a registration older
        /// than a minute is treated as dead, the profile and the integration must both have
        /// telemetry enabled, and a user who has configured any part of their own OTEL pipeline
        /// keeps all of it - the guard will not silently redirect their telemetry, and will not
        /// inject half a configuration over a wire format it cannot satisfy.
        ///
        /// The five content flags are deliberately not set here. They belong to every launch, not
        /// to the one path that reaches the end of this method: see
        /// <see cref="ForceContentTelemetryOff"/>.
        ///
        /// Spans are deliberately not collected: they require
        /// <c>CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1</c>, and opting a user into a beta collection
        /// mode they did not ask for is worse than dropping the signal. The traces exporter is set
        /// to <c>none</c> explicitly rather than left alone, so an <c>otlp</c> value inherited from
        /// the user's shell cannot aim spans at a collector route that refuses them. Nothing here
        /// may ever set a beta telemetry variable.
        /// </summary>
        private static void ApplyCollectorEnvironment(JsonValue registry, string profileId)
        {
            if (registry == null || GuardValues.IsBlank(profileId))
            {
                return;
            }
            JsonValue collector = registry["collectors"][profileId];
            if (collector.IsAbsent)
            {
                return;
            }
            JsonValue telemetryProfile = GuardRegistry.FindProfileById(registry, profileId);
            if (!GuardRegistry.CollectionAllowed(registry, telemetryProfile))
            {
                return;
            }

            DateTimeOffset updatedAt = DateTimeOffset.Parse(
                GuardValues.Text(collector, "updatedAt"),
                CultureInfo.InvariantCulture,
                DateTimeStyles.RoundtripKind
            );
            TimeSpan age = DateTimeOffset.UtcNow - updatedAt;
            int? port = collector["port"].AsInteger();
            if (age.TotalSeconds > CollectorFreshnessSeconds || port == null || port.Value <= 0)
            {
                return;
            }
            if (HasUserExporterConfiguration())
            {
                return;
            }

            // Everything that can fail is computed before a single variable is set, so a
            // failure here can never leave a half-configured exporter behind.
            string workspacePath = GuardPaths.Normalize(Directory.GetCurrentDirectory());
            string guardAttributes = "claude.account_guard.profile_id=" + profileId
                + ",claude.account_guard.workspace_hash=" + GuardPaths.WorkspaceHash(workspacePath)
                + ",claude.account_guard.workspace_label=" + GuardPaths.LabelFor(workspacePath);
            string existingAttributes = Environment.GetEnvironmentVariable(
                "OTEL_RESOURCE_ATTRIBUTES"
            );

            Environment.SetEnvironmentVariable("CLAUDE_WORKSPACE_ACCOUNTS_PROFILE_ID", profileId);
            Environment.SetEnvironmentVariable("CLAUDE_CODE_ENABLE_TELEMETRY", "1");
            Environment.SetEnvironmentVariable("OTEL_METRICS_EXPORTER", "otlp");
            Environment.SetEnvironmentVariable("OTEL_LOGS_EXPORTER", "otlp");
            Environment.SetEnvironmentVariable("OTEL_TRACES_EXPORTER", "none");
            Environment.SetEnvironmentVariable("OTEL_EXPORTER_OTLP_PROTOCOL", "http/json");
            Environment.SetEnvironmentVariable(
                "OTEL_EXPORTER_OTLP_ENDPOINT",
                "http://127.0.0.1:" + port.Value.ToString(CultureInfo.InvariantCulture)
            );
            Environment.SetEnvironmentVariable(
                "OTEL_EXPORTER_OTLP_HEADERS",
                "Authorization=Bearer " + (GuardValues.Text(collector, "token") ?? string.Empty)
            );
            Environment.SetEnvironmentVariable(
                "OTEL_RESOURCE_ATTRIBUTES",
                GuardValues.IsBlank(existingAttributes)
                    ? guardAttributes
                    : existingAttributes + "," + guardAttributes
            );
        }

        /// <summary>
        /// Turns Claude Code's five content-logging flags off for this launch, so prompts,
        /// responses, tool detail and raw API bodies cannot be exported by anything downstream of
        /// the wrapper.
        ///
        /// Applied on every forward and before any other environment work. The ordering is load
        /// bearing in one direction: the check for a user's own pipeline reads the very variables
        /// collector injection writes, so running this afterwards would decide that the wrapper's own
        /// loopback exporter was somebody else's and skip the flags entirely.
        ///
        /// Two cases are exempt, both deliberately.
        ///
        /// The kill switch, because an escape hatch has to be total to be worth documenting.
        ///
        /// And a user who has configured their own OpenTelemetry pipeline: on that path the wrapper
        /// injects nothing, so no Workspace Accounts collector can receive content, and the
        /// destination is a collector the user chose. Their content flags are part of a configuration
        /// they wrote on purpose - an enterprise pipeline that logs prompts is a legitimate thing to
        /// have - and quietly turning it off would be the wrapper overriding an explicit choice
        /// rather than protecting anything of ours. <c>docs/privacy.md</c> states the guarantee at
        /// exactly that strength, and no higher.
        /// </summary>
        private static void ForceContentTelemetryOff()
        {
            try
            {
                if (HasUserExporterConfiguration())
                {
                    return;
                }
                Environment.SetEnvironmentVariable("OTEL_LOG_USER_PROMPTS", "0");
                Environment.SetEnvironmentVariable("OTEL_LOG_ASSISTANT_RESPONSES", "0");
                Environment.SetEnvironmentVariable("OTEL_LOG_TOOL_DETAILS", "0");
                Environment.SetEnvironmentVariable("OTEL_LOG_TOOL_CONTENT", "0");
                Environment.SetEnvironmentVariable("OTEL_LOG_RAW_API_BODIES", "0");
            }
            catch (Exception)
            {
                // Fail open: an environment the wrapper cannot write to is never a reason to
                // refuse a launch.
            }
        }

        /// <summary>
        /// True when the user has set any part of their own OTEL pipeline. Whitespace does not
        /// count: an exported-but-blank variable is not a configured exporter.
        /// </summary>
        private static bool HasUserExporterConfiguration()
        {
            foreach (string name in ForeignOtelVariables)
            {
                if (!GuardValues.IsBlank(Environment.GetEnvironmentVariable(name)))
                {
                    return true;
                }
            }
            return false;
        }

        /// <summary>
        /// The guard's one refusal. The only caller is the handler for
        /// <see cref="GuardBlockException"/>, which is the only place the refusal is constructed, so
        /// the blocked marker and exit <see cref="GuardExitCode"/> cannot be reached by anything
        /// except a genuine identity mismatch on an enforcing binding.
        /// </summary>
        private static int Block(string category, string message)
        {
            WriteGuardHealth(category, GuardExitCode);
            Console.Error.WriteLine("CLAUDE_WORKSPACE_ACCOUNTS_BLOCKED category=" + category);
            Console.Error.WriteLine(message);
            return GuardExitCode;
        }

        /// <summary>
        /// The wrapper was handed nothing it could launch.
        ///
        /// This is a usage error, not a guard decision, and it used to report itself as one: it
        /// emitted the blocked marker and exited 78, so a malformed invocation was indistinguishable
        /// from the single refusal the product is allowed to make. It now fails the way any launch
        /// failure fails, with its own exit code and a message that says where the invocation comes
        /// from, because the person reading it is not the person a block is written for.
        /// </summary>
        private static int InvalidInvocation()
        {
            WriteGuardHealth("invalid_invocation", InvocationExitCode);
            Console.Error.WriteLine(
                "Claude Workspace Accounts received no Claude executable to launch. This program is "
                    + "started by the Claude Code extension through its "
                    + "claudeCode.claudeProcessWrapper setting, which passes the Claude CLI as its "
                    + "first argument; it does nothing useful when run on its own."
            );
            return InvocationExitCode;
        }

        /// <summary>
        /// Records the last launch outcome for diagnostics, atomically and best effort.
        ///
        /// The record carries an outcome and nothing else: no arguments, no environment, no
        /// prompt. A diagnostics file that captured a command line would turn every launch
        /// into a durable copy of whatever the user typed.
        /// </summary>
        private static void WriteGuardHealth(string category, int exitCode)
        {
            string target = GuardSupport.Combine("wrapper-health.json");
            if (target == null)
            {
                return;
            }
            try
            {
                int processId = System.Diagnostics.Process.GetCurrentProcess().Id;
                var builder = new StringBuilder();
                builder.Append("{\"schemaVersion\":1,\"updatedAt\":\"");
                builder.Append(DateTimeOffset.UtcNow.ToString("o", CultureInfo.InvariantCulture));
                builder.Append("\",\"category\":\"");
                builder.Append(JsonText.Escape(category));
                builder.Append("\",\"exitCode\":");
                builder.Append(exitCode.ToString(CultureInfo.InvariantCulture));
                builder.Append(",\"pid\":");
                builder.Append(processId.ToString(CultureInfo.InvariantCulture));
                builder.Append('}');
                AtomicFile.Write(target, builder.ToString());
            }
            catch (Exception)
            {
                // Diagnostics are best effort and never alter Claude launch behaviour.
            }
        }
    }
}
