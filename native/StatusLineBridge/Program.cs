using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Text;

namespace ClaudeWorkspaceAccounts.StatusLineBridge
{
    /// <summary>
    /// The status-line bridge: Claude's <c>statusLine</c> hook, wearing two hats.
    ///
    /// Claude runs this on every status-line refresh with the session JSON on stdin and takes its
    /// stdout as the line to display. It does two things with that: it records a privacy-minimized
    /// usage snapshot for the account this process is bound to, and it hands the refresh on to
    /// whatever status-line command the user had before Workspace Accounts was installed.
    ///
    /// Two constraints shape everything here. It runs many times per session, so it must be a
    /// single native process - the PowerShell version it replaces paid roughly a second of
    /// interpreter start-up on every single refresh. And it must never leave the status line blank:
    /// the previous implementation wrapped its whole body in a bare <c>catch {}</c> and exited 0, so
    /// a payload it could not parse produced an empty status line and no explanation anywhere.
    /// Every failure path here emits a visible marker instead.
    /// </summary>
    internal static class Program
    {
        private const string FailureMarker = "[workspace-accounts: status line unavailable]";
        private const int ChainTimeoutMilliseconds = 10000;

        public static int Main(string[] args)
        {
            string payload = null;
            try
            {
                payload = ReadStandardInput();
            }
            catch (Exception)
            {
                // Reading stdin is the one thing that cannot be worked around.
            }

            JsonValue session = null;
            if (!string.IsNullOrWhiteSpace(payload))
            {
                try
                {
                    session = JsonReader.Parse(payload.Trim());
                }
                catch (Exception)
                {
                    session = null;
                }
            }

            JsonValue registry = GuardRegistry.Load(GuardSupport.RegistryPath);
            // An unregistered account is an ordinary state, not a fault: this is what a user sees
            // before they add their first profile. Absent rather than null, so every lookup below
            // reads as "no value" instead of throwing and demoting a working status line to an
            // error marker.
            JsonValue profile = JsonValue.Absent;
            try
            {
                profile = GuardRegistry.FindProfileByConfigDirectory(
                    registry,
                    GuardPaths.Normalize(GuardRegistry.RuntimeConfigDirectory())
                ) ?? JsonValue.Absent;
            }
            catch (Exception)
            {
                profile = JsonValue.Absent;
            }

            // Snapshot collection is entirely optional and must never affect what is displayed.
            if (session != null && GuardRegistry.CollectionAllowed(registry, profile))
            {
                try
                {
                    WriteSnapshot(registry, profile, session);
                }
                catch (Exception)
                {
                    // A snapshot that cannot be written is lost usage data, never a broken
                    // status line.
                }
            }

            // Hand the refresh on to the user's own status-line command, if they had one.
            try
            {
                string chained = ResolveChainedCommand(profile);
                if (!string.IsNullOrWhiteSpace(chained))
                {
                    if (RunChainedCommand(chained, payload))
                    {
                        return 0;
                    }
                    // The user's command produced nothing usable. Saying so is better than
                    // displaying the blank line it just produced.
                    return EmitMarker();
                }
            }
            catch (Exception)
            {
                return EmitMarker();
            }

            // No command to chain. Claude's own default status line was replaced by this bridge,
            // so emitting nothing here is what left people staring at an empty line: describe the
            // bound account instead.
            if (session != null)
            {
                string summary = Summarize(profile, session);
                if (!string.IsNullOrWhiteSpace(summary))
                {
                    return Emit(summary);
                }
            }
            return EmitMarker();
        }

        /// <summary>
        /// Reads the session payload as raw bytes and decodes it as UTF-8.
        ///
        /// The PowerShell version used <c>$input | Out-String</c>, which applies console-width
        /// formatting: a long single-line payload came back with line breaks inserted into it, and
        /// the resulting parse failure was swallowed. Bytes in, UTF-8 out, no console encoding
        /// anywhere near it.
        /// </summary>
        private static string ReadStandardInput()
        {
            using (Stream input = Console.OpenStandardInput())
            using (var buffer = new MemoryStream())
            {
                var chunk = new byte[8192];
                int read;
                while ((read = input.Read(chunk, 0, chunk.Length)) > 0)
                {
                    buffer.Write(chunk, 0, read);
                }
                byte[] bytes = buffer.ToArray();
                int offset = 0;
                if (bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF)
                {
                    offset = 3;
                }
                return new UTF8Encoding(false).GetString(bytes, offset, bytes.Length - offset);
            }
        }

        /// <summary>
        /// Records one usage snapshot in the collector's inbox.
        ///
        /// The field names are a contract with <c>usageRepository</c> and must not drift. The
        /// privacy rules are the ones in docs/privacy.md: a workspace is a sanitized label plus a
        /// SHA-256 prefix, and its full path is written only when the user has explicitly opted in.
        /// </summary>
        private static void WriteSnapshot(JsonValue registry, JsonValue profile, JsonValue session)
        {
            string sessionId = GuardValues.Text(session, "session_id");
            if (GuardValues.IsBlank(sessionId))
            {
                return;
            }
            string inbox = GuardSupport.Combine("snapshots");
            if (inbox == null)
            {
                return;
            }

            JsonValue workspace = session["workspace"];
            JsonValue model = session["model"];
            JsonValue cost = session["cost"];
            JsonValue contextWindow = session["context_window"];
            JsonValue currentUsage = contextWindow["current_usage"];
            JsonValue rateLimits = session["rate_limits"];

            string workspacePath = GuardValues.Text(workspace, "current_dir");
            if (GuardValues.IsBlank(workspacePath))
            {
                workspacePath = GuardValues.Text(session, "cwd");
            }
            string normalizedWorkspace = GuardValues.IsBlank(workspacePath)
                ? string.Empty
                : GuardPaths.Normalize(workspacePath);
            bool collectWorkspacePath = registry["integration"]["collectWorkspacePath"].IsTrue;

            var snapshot = new StringBuilder();
            snapshot.Append("{\"schemaVersion\":1");
            Member(snapshot, "capturedAt", Text(
                DateTimeOffset.UtcNow.ToString("o", CultureInfo.InvariantCulture)
            ));
            Member(snapshot, "profileId", Text(GuardValues.Text(profile, "id")));
            Member(snapshot, "sessionId", Text(sessionId));
            Member(snapshot, "sessionName", Text(GuardValues.Text(session, "session_name")));
            Member(snapshot, "workspaceHash", Text(
                normalizedWorkspace.Length == 0
                    ? string.Empty
                    : GuardPaths.WorkspaceHash(normalizedWorkspace)
            ));
            Member(snapshot, "workspaceLabel", Text(GuardPaths.LabelFor(normalizedWorkspace)));
            Member(
                snapshot,
                "workspacePath",
                collectWorkspacePath && !GuardValues.IsBlank(workspacePath)
                    ? Text(workspacePath)
                    : "null"
            );
            Member(snapshot, "modelId", Text(GuardValues.Text(model, "id")));
            Member(snapshot, "modelDisplayName", Text(GuardValues.Text(model, "display_name")));
            Member(snapshot, "effort", Text(GuardValues.Text(session["effort"], "level")));
            Member(snapshot, "thinkingEnabled", Raw(session["thinking"]["enabled"]));
            Member(snapshot, "fastMode", Raw(session["fast_mode"]));
            Member(snapshot, "costUsd", Raw(cost["total_cost_usd"]));
            Member(snapshot, "durationMs", Raw(cost["total_duration_ms"]));
            Member(snapshot, "apiDurationMs", Raw(cost["total_api_duration_ms"]));
            Member(snapshot, "linesAdded", Raw(cost["total_lines_added"]));
            Member(snapshot, "linesRemoved", Raw(cost["total_lines_removed"]));

            snapshot.Append(",\"contextWindow\":{\"usedPercentage\":");
            snapshot.Append(Raw(contextWindow["used_percentage"]));
            Member(snapshot, "remainingPercentage", Raw(contextWindow["remaining_percentage"]));
            Member(snapshot, "size", Raw(contextWindow["context_window_size"]));
            Member(snapshot, "totalInputTokens", Raw(contextWindow["total_input_tokens"]));
            Member(snapshot, "totalOutputTokens", Raw(contextWindow["total_output_tokens"]));
            snapshot.Append(",\"currentUsage\":{\"input\":");
            snapshot.Append(Raw(currentUsage["input_tokens"]));
            Member(snapshot, "output", Raw(currentUsage["output_tokens"]));
            Member(snapshot, "cacheRead", Raw(currentUsage["cache_read_input_tokens"]));
            Member(snapshot, "cacheCreation", Raw(currentUsage["cache_creation_input_tokens"]));
            snapshot.Append("}}");

            snapshot.Append(",\"rateLimits\":{\"fiveHour\":{\"usedPercentage\":");
            snapshot.Append(Raw(rateLimits["five_hour"]["used_percentage"]));
            Member(snapshot, "resetsAt", Raw(rateLimits["five_hour"]["resets_at"]));
            snapshot.Append("},\"sevenDay\":{\"usedPercentage\":");
            snapshot.Append(Raw(rateLimits["seven_day"]["used_percentage"]));
            Member(snapshot, "resetsAt", Raw(rateLimits["seven_day"]["resets_at"]));
            snapshot.Append("}}}");

            string name = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
                .ToString(CultureInfo.InvariantCulture)
                + "-" + Guid.NewGuid().ToString("n") + ".json";
            // The collector watches this directory, so the file has to appear complete or not
            // at all; the temporary name ends in .tmp and is never picked up.
            AtomicFile.Write(Path.Combine(inbox, name), snapshot.ToString());
        }

        private static void Member(StringBuilder builder, string name, string value)
        {
            builder.Append(",\"").Append(name).Append("\":").Append(value);
        }

        /// <summary>A JSON string, using the empty string for an absent value.</summary>
        private static string Text(string value)
        {
            return "\"" + JsonText.Escape(value ?? string.Empty) + "\"";
        }

        /// <summary>
        /// A number or boolean passed through as-is, or <c>null</c> when absent. Absent data is
        /// reported as absent: a missing quota window must never be recorded as zero.
        /// </summary>
        private static string Raw(JsonValue value)
        {
            switch (value.Kind)
            {
                case JsonKind.Number:
                    return value.AsText();
                case JsonKind.Boolean:
                    return value.IsTrue ? "true" : "false";
                default:
                    return "null";
            }
        }

        /// <summary>
        /// The status-line command Workspace Accounts replaced.
        ///
        /// The record inside the profile's own Claude directory is the primary copy, but a user who
        /// clears that directory would lose their status line permanently, so the installer keeps a
        /// guard-owned mirror beside this executable. A missing or malformed primary falls through
        /// to the mirror rather than silently giving up.
        /// </summary>
        private static string ResolveChainedCommand(JsonValue profile)
        {
            foreach (string candidate in BackupLocations(profile))
            {
                if (candidate == null || !File.Exists(candidate))
                {
                    continue;
                }
                JsonValue backup;
                try
                {
                    backup = JsonReader.Parse(
                        File.ReadAllText(candidate, new UTF8Encoding(false))
                    );
                }
                catch (Exception)
                {
                    continue;
                }
                if (backup["schemaVersion"].AsInteger() != 1)
                {
                    continue;
                }
                string command = GuardValues.FirstValue(
                    backup["nextStatusLine"]["command"],
                    backup["nextCommand"]
                );
                if (!GuardValues.IsBlank(command))
                {
                    return command;
                }
                // Parsed and genuinely empty: this profile had no status line before, and the
                // mirror will not say otherwise.
                return null;
            }
            return null;
        }

        private static IEnumerable<string> BackupLocations(JsonValue profile)
        {
            var locations = new List<string>();
            string configDirectory = GuardValues.Text(profile, "configDir");
            if (GuardValues.IsBlank(configDirectory))
            {
                configDirectory = Environment.GetEnvironmentVariable("CLAUDE_CONFIG_DIR");
            }
            if (!GuardValues.IsBlank(configDirectory))
            {
                locations.Add(SafeCombine(
                    configDirectory,
                    ".claude-workspace-accounts",
                    "statusline-next.json"
                ));
                // The same file under the name v0.1.0 wrote it. The rename migration moves this
                // directory, but it records "failed" when it can neither rename nor copy - and in
                // that state the legacy directory is the only copy of the user's previous status
                // line. Read-only, and last of the per-profile locations, so a migrated directory
                // always wins.
                locations.Add(SafeCombine(
                    configDirectory,
                    ".claude-account-guard",
                    "statusline-next.json"
                ));
            }
            string profileId = GuardValues.Text(profile, "id");
            if (!GuardValues.IsBlank(profileId))
            {
                locations.Add(SafeCombine(
                    ExecutableDirectory(),
                    "statusline-backups",
                    profileId + ".json"
                ));
            }
            return locations;
        }

        private static string SafeCombine(params string[] parts)
        {
            try
            {
                string combined = parts[0];
                for (int index = 1; index < parts.Length; index++)
                {
                    combined = Path.Combine(combined, parts[index]);
                }
                return combined;
            }
            catch (Exception)
            {
                return null;
            }
        }

        private static string ExecutableDirectory()
        {
            try
            {
                string location = Assembly.GetExecutingAssembly().Location;
                string directory = string.IsNullOrEmpty(location)
                    ? null
                    : Path.GetDirectoryName(location);
                return string.IsNullOrEmpty(directory)
                    ? AppDomain.CurrentDomain.BaseDirectory
                    : directory;
            }
            catch (Exception)
            {
                return AppDomain.CurrentDomain.BaseDirectory;
            }
        }

        /// <summary>
        /// Runs the user's own status-line command and passes its output through untouched.
        ///
        /// A status-line command is a shell command line, not an argument vector, so it goes to the
        /// command processor with its own quoting intact. The PowerShell version passed it as a
        /// single argument to <c>cmd.exe</c>, and PowerShell 5.1 stripped the quotes on the way -
        /// so <c>node "C:\my scripts\line.js"</c> arrived as two broken arguments. Here the string
        /// is placed between the outer quotes that <c>/s</c> strips, and nothing else touches it.
        ///
        /// Returns false when the command produced nothing usable, so the caller can say so rather
        /// than display an empty line.
        /// </summary>
        private static bool RunChainedCommand(string command, string payload)
        {
            CaptureResult result = ChildProcess.CaptureShellCommand(
                command,
                payload ?? string.Empty,
                ChainTimeoutMilliseconds
            );
            if (result.StandardOutputBytes == null || result.StandardOutputBytes.Length == 0)
            {
                return false;
            }
            using (Stream output = Console.OpenStandardOutput())
            {
                output.Write(result.StandardOutputBytes, 0, result.StandardOutputBytes.Length);
                output.Flush();
            }
            return true;
        }

        /// <summary>
        /// A minimal status line describing the bound account, for users who had no status-line
        /// command of their own. Which account a workspace is running as is the one thing this
        /// product exists to make explicit, so that is what it leads with.
        /// </summary>
        private static string Summarize(JsonValue profile, JsonValue session)
        {
            var parts = new List<string>();
            string displayName = GuardValues.Text(profile, "displayName");
            if (!GuardValues.IsBlank(displayName))
            {
                parts.Add(displayName);
            }
            string model = GuardValues.FirstValue(
                session["model"]["display_name"],
                session["model"]["id"]
            );
            if (!GuardValues.IsBlank(model))
            {
                parts.Add(model);
            }
            string context = Percentage(session["context_window"]["used_percentage"]);
            if (context != null)
            {
                parts.Add("ctx " + context);
            }
            string fiveHour = Percentage(session["rate_limits"]["five_hour"]["used_percentage"]);
            string sevenDay = Percentage(session["rate_limits"]["seven_day"]["used_percentage"]);
            if (sevenDay != null)
            {
                parts.Add("7d " + sevenDay);
            }
            else if (fiveHour != null)
            {
                parts.Add("5h " + fiveHour);
            }
            return parts.Count == 0 ? null : string.Join(" | ", parts.ToArray());
        }

        private static string Percentage(JsonValue value)
        {
            if (value.Kind != JsonKind.Number)
            {
                return null;
            }
            int? rounded = value.AsInteger();
            return rounded == null
                ? null
                : rounded.Value.ToString(CultureInfo.InvariantCulture) + "%";
        }

        private static int EmitMarker()
        {
            return Emit(FailureMarker);
        }

        /// <summary>
        /// Writes one line of UTF-8 to stdout and always reports success. Claude reads stdout as
        /// the status line, so a non-zero exit here buys nothing and risks the host treating the
        /// hook as broken.
        /// </summary>
        private static int Emit(string line)
        {
            try
            {
                byte[] bytes = new UTF8Encoding(false).GetBytes(line + "\n");
                using (Stream output = Console.OpenStandardOutput())
                {
                    output.Write(bytes, 0, bytes.Length);
                    output.Flush();
                }
            }
            catch (Exception)
            {
                // Even the marker failing is not worth a non-zero exit.
            }
            return 0;
        }
    }
}
