using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace ClaudeAccountGuard.WrapperLauncher
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

        public GuardResolution(
            JsonValue registry,
            WorkspaceBinding binding,
            string telemetryProfileId,
            string category
        )
        {
            this.registry = registry;
            this.binding = binding;
            this.telemetryProfileId = telemetryProfileId;
            this.category = category;
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

        public static GuardResolution Unbound(JsonValue registry, string profileId, string category)
        {
            return new GuardResolution(registry, null, profileId, category);
        }
    }

    /// <summary>
    /// The Claude Account Guard process wrapper.
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
        private const string DisableVariable = "CLAUDE_ACCOUNT_GUARD_DISABLE";
        private const string WorkspaceKeyVariable = "CLAUDE_ACCOUNT_GUARD_WORKSPACE_KEY";
        private const string ConfigDirectoryVariable = "CLAUDE_CONFIG_DIR";
        private const string SecureStorageDirectoryVariable = "CLAUDE_SECURESTORAGE_CONFIG_DIR";
        private const int AuthStatusTimeoutMilliseconds = 60000;
        private const double CollectorFreshnessSeconds = 60;

        private static readonly string SupportRoot = ResolveSupportRoot();

        private static readonly string[] ExistingEndpointVariables =
        {
            "OTEL_EXPORTER_OTLP_ENDPOINT",
            "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
            "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
            "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"
        };

        private static readonly string[] ExistingExporterVariables =
        {
            "OTEL_METRICS_EXPORTER",
            "OTEL_LOGS_EXPORTER",
            "OTEL_TRACES_EXPORTER",
            "OTEL_EXPORTER_OTLP_HEADERS"
        };

        public static int Main(string[] args)
        {
            // An empty vector is the only input with nothing to forward, so it is the only
            // input the wrapper itself can be blamed for.
            if (args.Length == 0 || string.IsNullOrWhiteSpace(args[0]))
            {
                return Block(
                    "binary_missing",
                    "The Claude process wrapper did not receive the bundled Claude executable."
                );
            }

            LaunchTarget target;
            try
            {
                target = LaunchTarget.Resolve(args);
            }
            catch (Exception)
            {
                return Block(
                    "binary_missing",
                    "The Claude process wrapper did not receive the bundled Claude executable."
                );
            }

            // An explicit kill switch: the guard steps aside completely - no binding, no
            // probe, no telemetry - so a user is never one wrapper defect away from being
            // unable to start Claude.
            if (IsGuardDisabled())
            {
                return Forward(target, GuardResolution.Unbound(null, null, null), "launch_failed");
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
            try
            {
                return string.Equals(
                    Environment.GetEnvironmentVariable(DisableVariable),
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
            string currentDirectory = NormalizeGuardPath(Directory.GetCurrentDirectory());
            string registryPath = SupportRoot == null
                ? null
                : Path.Combine(SupportRoot, "registry.json");
            string cachePath = SupportRoot == null
                ? null
                : Path.Combine(SupportRoot, "binding-cache.json");

            if (registryPath == null || !File.Exists(registryPath))
            {
                // A stable launcher outlives an uninstalled extension. With no guard state
                // there is nothing to bind, and Claude Code must keep working.
                return GuardResolution.Unbound(null, null, null);
            }

            JsonValue registry = null;
            try
            {
                registry = JsonReader.Parse(File.ReadAllText(registryPath, new UTF8Encoding(false)));
                ValidateRegistry(registry);
            }
            catch (Exception)
            {
                registry = null;
            }

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

            string ambientProfileId = AmbientProfileId(registry);
            JsonValue workspaceLock = ResolveWorkspaceLock(registry, currentDirectory);
            if (workspaceLock == null)
            {
                // Not bound: leave the environment exactly as Claude Code set it up.
                BindingCache.Forget(cachePath, currentDirectory);
                return GuardResolution.Unbound(registry, ambientProfileId, null);
            }

            JsonValue boundProfile = FindProfileById(registry, Text(workspaceLock, "profileId"));
            if (boundProfile == null)
            {
                BindingCache.Forget(cachePath, currentDirectory);
                return GuardResolution.Unbound(registry, ambientProfileId, "required_profile_missing");
            }
            string configDirectory = Text(boundProfile, "configDir");
            if (IsBlank(configDirectory))
            {
                configDirectory = Text(boundProfile, "configDirNormalized");
            }
            if (IsBlank(configDirectory))
            {
                BindingCache.Forget(cachePath, currentDirectory);
                return GuardResolution.Unbound(registry, ambientProfileId, "required_profile_missing");
            }

            JsonValue expected = boundProfile["expectedIdentity"];
            var binding = new WorkspaceBinding(
                currentDirectory,
                Text(boundProfile, "id"),
                configDirectory,
                Text(workspaceLock, "mode"),
                Text(expected, "accountId"),
                Text(expected, "email"),
                Text(expected, "organizationId"),
                null,
                true
            );
            BindingCache.Remember(cachePath, binding);

            ApplyBinding(binding);
            string outcome = Verify(target, binding);
            if (outcome == "identity_mismatch" && binding.Enforced)
            {
                string displayName = Text(boundProfile, "displayName") ?? binding.ProfileId;
                // The message has to name the way out, or the only remaining block becomes a
                // dead end for the one user it was meant to protect.
                throw new GuardBlockException(
                    "identity_mismatch",
                    "This workspace is bound to '" + displayName + "', but that account's "
                        + "directory is now signed in as a different account, so no Claude "
                        + "request was started. Re-verify the account from Claude Account "
                        + "Guard, or set this workspace's lock mode to 'warn' to launch anyway."
                );
            }
            return new GuardResolution(registry, binding, binding.ProfileId, outcome);
        }

        /// <summary>
        /// Points this launch - and every process it starts - at the bound account's isolated
        /// configuration directory. This is the whole per-workspace account switch: the CLI
        /// reads its credentials from <c>CLAUDE_CONFIG_DIR</c>, so setting it per launch keeps
        /// two workspaces on two accounts without either one switching the other.
        /// </summary>
        private static void ApplyBinding(WorkspaceBinding binding)
        {
            Environment.SetEnvironmentVariable(ConfigDirectoryVariable, binding.ConfigDirectory);
            // Secure storage is derived from its own variable when that is set, so an ambient
            // value would send credentials to the account this launch is not bound to.
            if (!IsBlank(Environment.GetEnvironmentVariable(SecureStorageDirectoryVariable)))
            {
                Environment.SetEnvironmentVariable(
                    SecureStorageDirectoryVariable,
                    binding.ConfigDirectory
                );
            }
            if (!IsBlank(binding.ProfileId))
            {
                Environment.SetEnvironmentVariable(
                    "CLAUDE_ACCOUNT_GUARD_PROFILE_ID",
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
            string actualAccountId = FirstValue(
                auth["accountId"],
                auth["account_id"],
                auth["accountUuid"],
                auth["account_uuid"],
                account["id"],
                account["uuid"]
            );
            string actualEmail = FirstValue(auth["email"], account["email"]);
            string actualOrganizationId = FirstValue(
                auth["organizationId"],
                auth["organization_id"],
                auth["orgId"],
                organization["id"],
                organization["uuid"]
            );

            // Nothing to compare against means the directory is signed in but the CLI told us
            // nothing identifying; that is unverifiable, not a mismatch.
            if (IsBlank(actualAccountId) && IsBlank(actualEmail))
            {
                return "identity_unverifiable";
            }

            bool identityMatches = false;
            if (!IsBlank(binding.ExpectedAccountId) && !IsBlank(actualAccountId))
            {
                identityMatches = Matches(binding.ExpectedAccountId, actualAccountId);
            }
            else if (!IsBlank(binding.ExpectedEmail) && !IsBlank(actualEmail))
            {
                identityMatches = Matches(binding.ExpectedEmail.Trim(), actualEmail.Trim());
            }
            else
            {
                // The CLI answered with a different identifier than the one recorded, so this
                // is not evidence of a mismatch either way.
                return "identity_unverifiable";
            }

            if (identityMatches
                && !IsBlank(binding.ExpectedOrganizationId)
                && !IsBlank(actualOrganizationId))
            {
                identityMatches = Matches(binding.ExpectedOrganizationId, actualOrganizationId);
            }

            return identityMatches ? null : "identity_mismatch";
        }

        private static void ValidateRegistry(JsonValue registry)
        {
            int? schemaVersion = registry["schemaVersion"].AsInteger();
            if (!registry.IsObject
                || schemaVersion == null
                || schemaVersion.Value != 1
                || !registry["profiles"].IsArray
                || !registry["workspaceLocks"].IsArray
                || !registry["collectors"].IsObject
                || !registry["integration"].IsObject)
            {
                throw new JsonMalformedException("Unsupported or incomplete registry schema.");
            }
            foreach (JsonValue profile in registry["profiles"].Elements)
            {
                if (IsBlank(Text(profile, "id")) || IsBlank(Text(profile, "configDirNormalized")))
                {
                    throw new JsonMalformedException("Invalid account profile.");
                }
            }
            foreach (JsonValue workspaceLock in registry["workspaceLocks"].Elements)
            {
                string mode = Text(workspaceLock, "mode");
                if (IsBlank(Text(workspaceLock, "workspaceUri"))
                    || IsBlank(Text(workspaceLock, "profileId"))
                    || !(Matches(mode, "enforce") || Matches(mode, "warn") || Matches(mode, "off")))
                {
                    throw new JsonMalformedException("Invalid workspace lock.");
                }
            }
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
            if (!IsBlank(workspaceKey))
            {
                foreach (JsonValue candidate in registry["workspaceLocks"].Elements)
                {
                    if (Matches(Text(candidate, "workspaceKey"), workspaceKey)
                        && !Matches(Text(candidate, "mode"), "off")
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
                if (Matches(Text(candidate, "mode"), "off"))
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
                if (!IsBlank(value))
                {
                    paths.Add(value);
                }
            }
            if (paths.Count == 0)
            {
                paths.Add(Text(workspaceLock, "workspacePathNormalized") ?? string.Empty);
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
        /// The registered profile the ambient environment already points at, used only to
        /// attribute local usage on an unbound launch. No credential file is ever opened.
        /// </summary>
        private static string AmbientProfileId(JsonValue registry)
        {
            string configured = Environment.GetEnvironmentVariable(ConfigDirectoryVariable);
            if (string.IsNullOrEmpty(configured))
            {
                string userProfile = Environment.GetEnvironmentVariable("USERPROFILE");
                configured = Path.Combine(userProfile ?? string.Empty, ".claude");
            }
            string normalized = NormalizeGuardPath(configured);
            if (IsBlank(normalized))
            {
                return null;
            }
            foreach (JsonValue profile in registry["profiles"].Elements)
            {
                if (Matches(Text(profile, "configDirNormalized"), normalized))
                {
                    return Text(profile, "id");
                }
            }
            return null;
        }

        private static JsonValue FindProfileById(JsonValue registry, string profileId)
        {
            if (IsBlank(profileId))
            {
                return null;
            }
            foreach (JsonValue profile in registry["profiles"].Elements)
            {
                if (Matches(Text(profile, "id"), profileId))
                {
                    return profile;
                }
            }
            return null;
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
                    string candidate = Text(resolution.Registry["integration"], "upstreamWrapper");
                    if (!IsBlank(candidate) && File.Exists(candidate))
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
            Console.Error.WriteLine("Claude Account Guard could not start the Claude executable.");
            return 1;
        }

        /// <summary>
        /// Points Claude Code's OpenTelemetry exporters at this profile's local collector.
        ///
        /// Every guard here exists to keep collection opt-in and local: a registration older
        /// than a minute is treated as dead, the profile and the integration must both have
        /// telemetry enabled, and a user who has configured any exporter of their own keeps
        /// it - the guard will not silently redirect their telemetry. The five content flags
        /// are forced off unconditionally so prompts, responses, tool detail and raw API
        /// bodies are never emitted, whatever else is configured.
        /// </summary>
        private static void ApplyCollectorEnvironment(JsonValue registry, string profileId)
        {
            if (registry == null || IsBlank(profileId))
            {
                return;
            }
            JsonValue collector = registry["collectors"][profileId];
            if (collector.IsAbsent)
            {
                return;
            }
            JsonValue telemetryProfile = FindProfileById(registry, profileId);
            if (telemetryProfile == null || !telemetryProfile["telemetryEnabled"].IsTrue)
            {
                return;
            }
            if (registry["integration"]["telemetryEnabled"].IsFalse)
            {
                return;
            }

            DateTimeOffset updatedAt = DateTimeOffset.Parse(
                Text(collector, "updatedAt"),
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
            string workspacePath = NormalizeGuardPath(Directory.GetCurrentDirectory());
            string workspaceHash = WorkspaceHash(workspacePath);
            string workspaceLabel = Regex.Replace(
                Path.GetFileName(workspacePath.TrimEnd('\\')),
                "[^A-Za-z0-9_.-]",
                "_"
            );
            string guardAttributes = "claude.account_guard.profile_id=" + profileId
                + ",claude.account_guard.workspace_hash=" + workspaceHash
                + ",claude.account_guard.workspace_label=" + workspaceLabel;
            string existingAttributes = Environment.GetEnvironmentVariable(
                "OTEL_RESOURCE_ATTRIBUTES"
            );

            Environment.SetEnvironmentVariable("CLAUDE_ACCOUNT_GUARD_PROFILE_ID", profileId);
            Environment.SetEnvironmentVariable("CLAUDE_CODE_ENABLE_TELEMETRY", "1");
            Environment.SetEnvironmentVariable("OTEL_METRICS_EXPORTER", "otlp");
            Environment.SetEnvironmentVariable("OTEL_LOGS_EXPORTER", "otlp");
            Environment.SetEnvironmentVariable("OTEL_TRACES_EXPORTER", "otlp");
            Environment.SetEnvironmentVariable("OTEL_EXPORTER_OTLP_PROTOCOL", "http/json");
            Environment.SetEnvironmentVariable(
                "OTEL_EXPORTER_OTLP_ENDPOINT",
                "http://127.0.0.1:" + port.Value.ToString(CultureInfo.InvariantCulture)
            );
            Environment.SetEnvironmentVariable(
                "OTEL_EXPORTER_OTLP_HEADERS",
                "Authorization=Bearer " + (Text(collector, "token") ?? string.Empty)
            );
            Environment.SetEnvironmentVariable(
                "OTEL_RESOURCE_ATTRIBUTES",
                IsBlank(existingAttributes)
                    ? guardAttributes
                    : existingAttributes + "," + guardAttributes
            );
            Environment.SetEnvironmentVariable("OTEL_LOG_USER_PROMPTS", "0");
            Environment.SetEnvironmentVariable("OTEL_LOG_ASSISTANT_RESPONSES", "0");
            Environment.SetEnvironmentVariable("OTEL_LOG_TOOL_DETAILS", "0");
            Environment.SetEnvironmentVariable("OTEL_LOG_TOOL_CONTENT", "0");
            Environment.SetEnvironmentVariable("OTEL_LOG_RAW_API_BODIES", "0");
        }

        private static bool HasUserExporterConfiguration()
        {
            foreach (string name in ExistingEndpointVariables)
            {
                if (!IsBlank(Environment.GetEnvironmentVariable(name)))
                {
                    return true;
                }
            }
            foreach (string name in ExistingExporterVariables)
            {
                if (!IsBlank(Environment.GetEnvironmentVariable(name)))
                {
                    return true;
                }
            }
            return false;
        }

        private static int Block(string category, string message)
        {
            WriteGuardHealth(category, GuardExitCode);
            Console.Error.WriteLine("CLAUDE_ACCOUNT_GUARD_BLOCKED category=" + category);
            Console.Error.WriteLine(message);
            return GuardExitCode;
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
            if (SupportRoot == null)
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
                AtomicFile.Write(
                    Path.Combine(SupportRoot, "wrapper-health.json"),
                    builder.ToString()
                );
            }
            catch (Exception)
            {
                // Diagnostics are best effort and never alter Claude launch behaviour.
            }
        }

        private static string ResolveSupportRoot()
        {
            try
            {
                string localAppData = Environment.GetEnvironmentVariable("LOCALAPPDATA");
                if (!string.IsNullOrEmpty(localAppData))
                {
                    return Path.Combine(localAppData, "ClaudeAccountGuard");
                }
                string userProfile = Environment.GetEnvironmentVariable("USERPROFILE");
                if (!string.IsNullOrEmpty(userProfile))
                {
                    return Path.Combine(userProfile, ".claude-account-guard");
                }
            }
            catch (Exception)
            {
                // An unusable support root means the guard has no state and forwards.
            }
            return null;
        }

        /// <summary>
        /// The single path shape the registry is written and compared in: absolute, with
        /// backslash separators, no trailing separator except on a bare drive root, and
        /// lower case.
        /// </summary>
        private static string NormalizeGuardPath(string value)
        {
            if (string.IsNullOrWhiteSpace(value))
            {
                return string.Empty;
            }
            string normalized = Path.GetFullPath(value).Replace("/", "\\").TrimEnd('\\');
            if (normalized.Length == 2
                && normalized[1] == ':'
                && ((normalized[0] >= 'A' && normalized[0] <= 'Z')
                    || (normalized[0] >= 'a' && normalized[0] <= 'z')))
            {
                normalized += "\\";
            }
            return normalized.ToLowerInvariant();
        }

        private static string WorkspaceHash(string normalizedPath)
        {
            using (SHA256 algorithm = SHA256.Create())
            {
                byte[] digest = algorithm.ComputeHash(Encoding.UTF8.GetBytes(normalizedPath));
                var builder = new StringBuilder(digest.Length * 2);
                foreach (byte value in digest)
                {
                    builder.Append(value.ToString("x2", CultureInfo.InvariantCulture));
                }
                return builder.ToString().Substring(0, 16);
            }
        }

        private static string FirstValue(params JsonValue[] candidates)
        {
            foreach (JsonValue candidate in candidates)
            {
                string value = candidate.AsText();
                if (!IsBlank(value))
                {
                    return value;
                }
            }
            return null;
        }

        private static string Text(JsonValue value, string name)
        {
            return value[name].AsText();
        }

        private static bool IsBlank(string value)
        {
            return string.IsNullOrWhiteSpace(value);
        }

        private static bool Matches(string left, string right)
        {
            return left != null
                && right != null
                && string.Equals(left, right, StringComparison.OrdinalIgnoreCase);
        }
    }
}
