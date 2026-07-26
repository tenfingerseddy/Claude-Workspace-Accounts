using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text;

namespace ClaudeAccountGuard
{
    /// <summary>
    /// Replaces a file in one step.
    ///
    /// Both files the wrapper writes are read by the extension while Claude is launching, so a
    /// partially written document must never be observable. Writing to a private temporary name
    /// and renaming over the target makes every reader see either the old file or the new one.
    /// </summary>
    internal static class AtomicFile
    {
        public static void Write(string target, string content)
        {
            string directory = Path.GetDirectoryName(target);
            if (!string.IsNullOrEmpty(directory))
            {
                Directory.CreateDirectory(directory);
            }
            string temporary = target
                + "." + Process.GetCurrentProcess().Id.ToString(CultureInfo.InvariantCulture)
                + "." + Guid.NewGuid().ToString("n") + ".tmp";
            try
            {
                File.WriteAllText(temporary, content, new UTF8Encoding(false));
                if (!NativeMethods.MoveFileEx(
                    temporary,
                    target,
                    NativeMethods.MoveFileReplaceExisting))
                {
                    File.Copy(temporary, target, true);
                }
            }
            finally
            {
                try
                {
                    if (File.Exists(temporary))
                    {
                        File.Delete(temporary);
                    }
                }
                catch (Exception)
                {
                    // A leftover temporary file is harmless.
                }
            }
        }
    }

    /// <summary>
    /// Which account a workspace is bound to.
    ///
    /// The binding is the whole point of the wrapper: it sets <c>CLAUDE_CONFIG_DIR</c> for the
    /// launch, so one workspace can run as one account while another runs as a different one
    /// without either switching the other. The expected identity is carried alongside so a
    /// directory that has since been re-authenticated as somebody else can be detected.
    /// </summary>
    internal sealed class WorkspaceBinding
    {
        private readonly string workspace;
        private readonly string profileId;
        private readonly string configDirectory;
        private readonly string mode;
        private readonly string expectedAccountId;
        private readonly string expectedEmail;
        private readonly string expectedOrganizationId;
        private readonly string updatedAt;
        private readonly bool fromRegistry;

        public WorkspaceBinding(
            string workspace,
            string profileId,
            string configDirectory,
            string mode,
            string expectedAccountId,
            string expectedEmail,
            string expectedOrganizationId,
            string updatedAt,
            bool fromRegistry
        )
        {
            this.workspace = workspace;
            this.profileId = profileId;
            this.configDirectory = configDirectory;
            this.mode = mode;
            this.expectedAccountId = expectedAccountId;
            this.expectedEmail = expectedEmail;
            this.expectedOrganizationId = expectedOrganizationId;
            this.updatedAt = updatedAt;
            this.fromRegistry = fromRegistry;
        }

        /// <summary>The normalized workspace directory this binding was recorded for.</summary>
        public string Workspace
        {
            get { return workspace; }
        }

        public string ProfileId
        {
            get { return profileId; }
        }

        /// <summary>The isolated configuration directory to launch Claude against.</summary>
        public string ConfigDirectory
        {
            get { return configDirectory; }
        }

        public string Mode
        {
            get { return mode; }
        }

        public string ExpectedAccountId
        {
            get { return expectedAccountId; }
        }

        public string ExpectedEmail
        {
            get { return expectedEmail; }
        }

        public string ExpectedOrganizationId
        {
            get { return expectedOrganizationId; }
        }

        public string UpdatedAt
        {
            get { return updatedAt; }
        }

        /// <summary>
        /// False for a binding recovered from the cache. A cached binding is good enough to
        /// keep a workspace on the right account, but not good enough to refuse a launch over.
        /// </summary>
        public bool FromRegistry
        {
            get { return fromRegistry; }
        }

        /// <summary>Only an enforcing binding may refuse a launch, and only on a real mismatch.</summary>
        public bool Enforced
        {
            get { return string.Equals(mode, "enforce", StringComparison.OrdinalIgnoreCase); }
        }

        /// <summary>
        /// A profile with no recorded identity is bound without verification: there is nothing
        /// to compare the CLI's answer against.
        /// </summary>
        public bool HasExpectedIdentity
        {
            get
            {
                return !string.IsNullOrWhiteSpace(expectedAccountId)
                    || !string.IsNullOrWhiteSpace(expectedEmail);
            }
        }

        public WorkspaceBinding WithUpdatedAt(string value)
        {
            return new WorkspaceBinding(
                workspace,
                profileId,
                configDirectory,
                mode,
                expectedAccountId,
                expectedEmail,
                expectedOrganizationId,
                value,
                fromRegistry
            );
        }

        /// <summary>True when nothing a launch depends on has changed.</summary>
        public bool Equivalent(WorkspaceBinding other)
        {
            return other != null
                && string.Equals(workspace, other.workspace, StringComparison.OrdinalIgnoreCase)
                && string.Equals(profileId, other.profileId, StringComparison.Ordinal)
                && string.Equals(configDirectory, other.configDirectory, StringComparison.OrdinalIgnoreCase)
                && string.Equals(mode, other.mode, StringComparison.OrdinalIgnoreCase)
                && string.Equals(expectedAccountId ?? string.Empty, other.expectedAccountId ?? string.Empty, StringComparison.Ordinal)
                && string.Equals(expectedEmail ?? string.Empty, other.expectedEmail ?? string.Empty, StringComparison.OrdinalIgnoreCase)
                && string.Equals(expectedOrganizationId ?? string.Empty, other.expectedOrganizationId ?? string.Empty, StringComparison.Ordinal);
        }

        public string ToJson()
        {
            var builder = new StringBuilder();
            builder.Append("{\"workspace\":").Append(JsonText.Quote(workspace));
            builder.Append(",\"profileId\":").Append(JsonText.Quote(profileId));
            builder.Append(",\"configDir\":").Append(JsonText.Quote(configDirectory));
            builder.Append(",\"mode\":").Append(JsonText.Quote(mode));
            builder.Append(",\"accountId\":").Append(JsonText.Quote(expectedAccountId));
            builder.Append(",\"email\":").Append(JsonText.Quote(expectedEmail));
            builder.Append(",\"organizationId\":").Append(JsonText.Quote(expectedOrganizationId));
            builder.Append(",\"updatedAt\":").Append(JsonText.Quote(updatedAt));
            builder.Append('}');
            return builder.ToString();
        }

        public static WorkspaceBinding FromJson(JsonValue value)
        {
            string workspace = value["workspace"].AsText();
            string configDirectory = value["configDir"].AsText();
            if (string.IsNullOrWhiteSpace(workspace) || string.IsNullOrWhiteSpace(configDirectory))
            {
                return null;
            }
            return new WorkspaceBinding(
                workspace,
                value["profileId"].AsText(),
                configDirectory,
                value["mode"].AsText() ?? "enforce",
                value["accountId"].AsText(),
                value["email"].AsText(),
                value["organizationId"].AsText(),
                value["updatedAt"].AsText(),
                false
            );
        }
    }

    /// <summary>
    /// The last binding each workspace resolved to.
    ///
    /// A registry that cannot be read must not silently drop every workspace back onto the
    /// ambient account - that is the failure that looks like the guard doing nothing while
    /// quietly using the wrong account. The cache is written only when a workspace's binding
    /// actually changes, so the steady state costs no writes, and it is read only when the
    /// registry itself is unusable.
    /// </summary>
    internal static class BindingCache
    {
        private const int MaximumEntries = 32;

        /// <summary>The longest workspace prefix that covers the current directory.</summary>
        public static WorkspaceBinding Match(string cachePath, string normalizedWorkspace)
        {
            try
            {
                WorkspaceBinding best = null;
                foreach (WorkspaceBinding candidate in Read(cachePath))
                {
                    if (!Covers(candidate.Workspace, normalizedWorkspace))
                    {
                        continue;
                    }
                    if (best == null || candidate.Workspace.Length > best.Workspace.Length)
                    {
                        best = candidate;
                    }
                }
                return best;
            }
            catch (Exception)
            {
                return null;
            }
        }

        public static void Remember(string cachePath, WorkspaceBinding binding)
        {
            try
            {
                List<WorkspaceBinding> entries = Read(cachePath);
                WorkspaceBinding existing = Find(entries, binding.Workspace);
                if (existing != null && existing.Equivalent(binding))
                {
                    return;
                }
                entries.RemoveAll(delegate(WorkspaceBinding candidate)
                {
                    return string.Equals(
                        candidate.Workspace,
                        binding.Workspace,
                        StringComparison.OrdinalIgnoreCase
                    );
                });
                entries.Add(binding.WithUpdatedAt(
                    DateTimeOffset.UtcNow.ToString("o", CultureInfo.InvariantCulture)
                ));
                Write(cachePath, entries);
            }
            catch (Exception)
            {
                // The cache is an availability aid, never a launch precondition.
            }
        }

        public static void Forget(string cachePath, string normalizedWorkspace)
        {
            try
            {
                List<WorkspaceBinding> entries = Read(cachePath);
                int removed = entries.RemoveAll(delegate(WorkspaceBinding candidate)
                {
                    return string.Equals(
                        candidate.Workspace,
                        normalizedWorkspace,
                        StringComparison.OrdinalIgnoreCase
                    );
                });
                if (removed > 0)
                {
                    Write(cachePath, entries);
                }
            }
            catch (Exception)
            {
                // Nothing here can be allowed to affect a launch.
            }
        }

        private static WorkspaceBinding Find(List<WorkspaceBinding> entries, string workspace)
        {
            foreach (WorkspaceBinding candidate in entries)
            {
                if (string.Equals(candidate.Workspace, workspace, StringComparison.OrdinalIgnoreCase))
                {
                    return candidate;
                }
            }
            return null;
        }

        private static bool Covers(string candidate, string normalizedWorkspace)
        {
            if (string.IsNullOrEmpty(candidate) || string.IsNullOrEmpty(normalizedWorkspace))
            {
                return false;
            }
            string prefix = candidate.TrimEnd('\\') + "\\";
            return string.Equals(candidate, normalizedWorkspace, StringComparison.OrdinalIgnoreCase)
                || normalizedWorkspace.StartsWith(prefix, StringComparison.OrdinalIgnoreCase);
        }

        private static List<WorkspaceBinding> Read(string cachePath)
        {
            var entries = new List<WorkspaceBinding>();
            if (cachePath == null || !File.Exists(cachePath))
            {
                return entries;
            }
            JsonValue document = JsonReader.Parse(
                File.ReadAllText(cachePath, new UTF8Encoding(false))
            );
            foreach (JsonValue candidate in document["bindings"].Elements)
            {
                WorkspaceBinding binding = WorkspaceBinding.FromJson(candidate);
                if (binding != null)
                {
                    entries.Add(binding);
                }
            }
            return entries;
        }

        private static void Write(string cachePath, List<WorkspaceBinding> entries)
        {
            entries.Sort(delegate(WorkspaceBinding left, WorkspaceBinding right)
            {
                return string.CompareOrdinal(right.UpdatedAt ?? string.Empty, left.UpdatedAt ?? string.Empty);
            });
            var builder = new StringBuilder();
            builder.Append("{\"schemaVersion\":1,\"bindings\":[");
            int written = 0;
            foreach (WorkspaceBinding entry in entries)
            {
                if (written >= MaximumEntries)
                {
                    break;
                }
                if (written > 0)
                {
                    builder.Append(',');
                }
                builder.Append(entry.ToJson());
                written += 1;
            }
            builder.Append("]}");
            AtomicFile.Write(cachePath, builder.ToString());
        }
    }
}
