using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text;

namespace ClaudeWorkspaceAccounts
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
        private readonly string workspaceHash;
        private readonly string workspaceLabel;
        private readonly string profileId;
        private readonly string configDirectory;
        private readonly string mode;
        private readonly string expectedAccountId;
        private readonly string expectedEmail;
        private readonly string expectedOrganizationId;
        private readonly string updatedAt;
        private readonly bool fromRegistry;

        /// <summary>
        /// A binding resolved for a live launch. The workspace directory it was resolved for is
        /// reduced to a hash and a sanitized label here and is not kept: this object is the one that
        /// gets serialized, so the path it can never write down is the path it never holds.
        /// </summary>
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
            : this(
                HashFor(workspace),
                GuardPaths.LabelFor(workspace),
                profileId,
                configDirectory,
                mode,
                expectedAccountId,
                expectedEmail,
                expectedOrganizationId,
                updatedAt,
                fromRegistry
            )
        {
        }

        private WorkspaceBinding(
            string workspaceHash,
            string workspaceLabel,
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
            this.workspaceHash = workspaceHash;
            this.workspaceLabel = workspaceLabel;
            this.profileId = profileId;
            this.configDirectory = configDirectory;
            this.mode = mode;
            this.expectedAccountId = expectedAccountId;
            this.expectedEmail = expectedEmail;
            this.expectedOrganizationId = expectedOrganizationId;
            this.updatedAt = updatedAt;
            this.fromRegistry = fromRegistry;
        }

        /// <summary>
        /// The key a remembered binding is stored and looked up under: the first 16 hex characters
        /// of the SHA-256 of the normalized workspace directory. Null when there was no usable
        /// directory, which is what stops an unresolvable workspace matching every other one
        /// through the hash of the empty string.
        /// </summary>
        public static string HashFor(string normalizedWorkspace)
        {
            return string.IsNullOrWhiteSpace(normalizedWorkspace)
                ? null
                : GuardPaths.WorkspaceHash(normalizedWorkspace);
        }

        /// <summary>The hash the cache keys this binding on.</summary>
        public string WorkspaceHash
        {
            get { return workspaceHash; }
        }

        /// <summary>The sanitized leaf directory name, so the cache is readable in diagnostics.</summary>
        public string WorkspaceLabel
        {
            get { return workspaceLabel; }
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
                workspaceHash,
                workspaceLabel,
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

        /// <summary>
        /// True when nothing a launch depends on has changed. Workspaces are compared by hash,
        /// because an entry read back from the cache has no path to compare - and if this reported
        /// every cached entry as different, the cache would be rewritten on every single launch.
        /// </summary>
        public bool Equivalent(WorkspaceBinding other)
        {
            return other != null
                && string.Equals(workspaceHash, other.workspaceHash, StringComparison.OrdinalIgnoreCase)
                && string.Equals(profileId, other.profileId, StringComparison.Ordinal)
                && string.Equals(configDirectory, other.configDirectory, StringComparison.OrdinalIgnoreCase)
                && string.Equals(mode, other.mode, StringComparison.OrdinalIgnoreCase)
                && string.Equals(expectedAccountId ?? string.Empty, other.expectedAccountId ?? string.Empty, StringComparison.Ordinal)
                && string.Equals(expectedEmail ?? string.Empty, other.expectedEmail ?? string.Empty, StringComparison.OrdinalIgnoreCase)
                && string.Equals(expectedOrganizationId ?? string.Empty, other.expectedOrganizationId ?? string.Empty, StringComparison.Ordinal);
        }

        /// <summary>
        /// The on-disk form.
        ///
        /// The workspace is written as a hash and a sanitized label, never as a path. This file used
        /// to carry the literal directory for every workspace that had ever been bound, which broke
        /// the promise that a workspace path is stored only as a label plus a SHA-256 prefix unless
        /// the user opts in - and it outlives an uninstall, so nothing later could take it back.
        /// </summary>
        public string ToJson()
        {
            var builder = new StringBuilder();
            builder.Append("{\"workspaceHash\":").Append(JsonText.Quote(workspaceHash));
            builder.Append(",\"workspaceLabel\":").Append(JsonText.Quote(workspaceLabel));
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
            string hash = value["workspaceHash"].AsText();
            string label = value["workspaceLabel"].AsText();
            if (string.IsNullOrWhiteSpace(hash))
            {
                // An entry written before the workspace was hashed. It is still usable: hashing the
                // path it recorded produces exactly the key this version looks it up under, so the
                // user keeps the binding, and rewriting the file is what gets the path off disk.
                string legacyPath = GuardPaths.Normalize(value["workspace"].AsText());
                hash = HashFor(legacyPath);
                label = GuardPaths.LabelFor(legacyPath);
            }
            string configDirectory = value["configDir"].AsText();
            if (string.IsNullOrWhiteSpace(hash) || string.IsNullOrWhiteSpace(configDirectory))
            {
                return null;
            }
            return new WorkspaceBinding(
                hash,
                label,
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

        /// <summary>
        /// True for a document member that still carries a literal workspace path, which is the
        /// signal that the file has to be replaced rather than left as it is.
        /// </summary>
        public static bool CarriesLiteralPath(JsonValue value)
        {
            return value != null && !string.IsNullOrWhiteSpace(value["workspace"].AsText());
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

        /// <summary>
        /// How far the ancestor walk will climb. A path deeper than this is pathological rather
        /// than real, and the walk hashes once per level.
        /// </summary>
        private const int MaximumDepth = 64;

        /// <summary>What the cache currently holds, and whether the file itself has to be replaced.</summary>
        private sealed class CacheDocument
        {
            private readonly List<WorkspaceBinding> entries;
            private readonly bool carriesLiteralPaths;

            public CacheDocument(List<WorkspaceBinding> entries, bool carriesLiteralPaths)
            {
                this.entries = entries;
                this.carriesLiteralPaths = carriesLiteralPaths;
            }

            public List<WorkspaceBinding> Entries
            {
                get { return entries; }
            }

            /// <summary>
            /// True for a cache written by a version that recorded literal workspace paths. Its
            /// entries are still usable, but the file must be rewritten rather than left holding
            /// them.
            /// </summary>
            public bool CarriesLiteralPaths
            {
                get { return carriesLiteralPaths; }
            }
        }

        /// <summary>
        /// The remembered binding whose workspace is the closest ancestor of a directory.
        ///
        /// Hashes cannot be compared for containment, so the lookup walks the launch directory's own
        /// ancestors from the deepest upwards and asks for each hash in turn. That yields exactly the
        /// longest-prefix answer comparing literal paths used to yield - a nested workspace bound to
        /// one account still wins over the tree it sits in - without the cache holding a path.
        /// </summary>
        public static WorkspaceBinding Match(string cachePath, string normalizedWorkspace)
        {
            try
            {
                CacheDocument document = Read(cachePath);
                foreach (string hash in AncestorHashes(normalizedWorkspace))
                {
                    foreach (WorkspaceBinding candidate in document.Entries)
                    {
                        if (SameWorkspace(candidate, hash))
                        {
                            return candidate;
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

        public static void Remember(string cachePath, WorkspaceBinding binding)
        {
            try
            {
                string hash = binding.WorkspaceHash;
                if (string.IsNullOrEmpty(hash))
                {
                    return;
                }
                CacheDocument document = Read(cachePath);
                List<WorkspaceBinding> entries = document.Entries;
                WorkspaceBinding existing = Find(entries, hash);
                if (existing != null
                    && existing.Equivalent(binding)
                    && !document.CarriesLiteralPaths)
                {
                    return;
                }
                entries.RemoveAll(delegate(WorkspaceBinding candidate)
                {
                    return SameWorkspace(candidate, hash);
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
                string hash = WorkspaceBinding.HashFor(normalizedWorkspace);
                CacheDocument document = Read(cachePath);
                int removed = document.Entries.RemoveAll(delegate(WorkspaceBinding candidate)
                {
                    return SameWorkspace(candidate, hash);
                });
                if (removed > 0 || document.CarriesLiteralPaths)
                {
                    Write(cachePath, document.Entries);
                }
            }
            catch (Exception)
            {
                // Nothing here can be allowed to affect a launch.
            }
        }

        /// <summary>
        /// Replaces a cache that still records literal workspace paths.
        ///
        /// Called on every launch, before anything decides whether the cache will be read or written
        /// at all, because the paths that need removing were written by a release that is no longer
        /// running and some launches touch the cache on no other code path. An unparseable file is
        /// deleted rather than kept: it cannot be rewritten, it may still hold paths, and unlike the
        /// registry it is regenerated from the next bound launch and is never the only copy of
        /// anything.
        /// </summary>
        public static void PurgeLiteralPaths(string cachePath)
        {
            if (cachePath == null || !File.Exists(cachePath))
            {
                return;
            }
            try
            {
                CacheDocument document = Read(cachePath);
                if (document.CarriesLiteralPaths)
                {
                    Write(cachePath, document.Entries);
                }
            }
            catch (Exception)
            {
                // A cache that cannot be parsed cannot be rewritten either, so it is deleted - but
                // only once its bytes are seen to still record a literal path. A transient read
                // failure, two launches racing over the same file, must not throw away a cache that
                // was already in the hashed form.
                if (RecordsLiteralPath(cachePath))
                {
                    Delete(cachePath);
                }
            }
        }

        /// <summary>
        /// Whether the file's bytes still contain a <c>workspace</c> member. Deliberately textual:
        /// it is asked only about a document that would not parse. <c>"workspaceHash"</c> does not
        /// match, because the quote after the name is part of what is searched for.
        /// </summary>
        private static bool RecordsLiteralPath(string cachePath)
        {
            try
            {
                return File.ReadAllText(cachePath, new UTF8Encoding(false))
                    .IndexOf("\"workspace\"", StringComparison.OrdinalIgnoreCase) >= 0;
            }
            catch (Exception)
            {
                return false;
            }
        }

        /// <summary>
        /// The hash of a directory and of every directory above it, deepest first. Deepest first is
        /// what makes the first hit the longest matching prefix.
        /// </summary>
        private static List<string> AncestorHashes(string normalizedWorkspace)
        {
            var hashes = new List<string>();
            string current = normalizedWorkspace;
            while (!string.IsNullOrWhiteSpace(current) && hashes.Count < MaximumDepth)
            {
                hashes.Add(GuardPaths.WorkspaceHash(current));
                string parent = ParentOf(current);
                if (parent == null || string.Equals(parent, current, StringComparison.Ordinal))
                {
                    break;
                }
                current = parent;
            }
            return hashes;
        }

        private static string ParentOf(string normalizedPath)
        {
            string trimmed = normalizedPath.TrimEnd('\\');
            int separator = trimmed.LastIndexOf('\\');
            if (separator <= 0)
            {
                return null;
            }
            string parent = trimmed.Substring(0, separator);
            if (parent.Length == 2 && parent[1] == ':')
            {
                // A bare drive root keeps its separator, the way Normalize records it, or `d:`
                // would never match the `d:\` an entry was written under.
                parent += "\\";
            }
            return parent;
        }

        private static bool SameWorkspace(WorkspaceBinding candidate, string hash)
        {
            return candidate != null
                && !string.IsNullOrEmpty(hash)
                && string.Equals(
                    candidate.WorkspaceHash,
                    hash,
                    StringComparison.OrdinalIgnoreCase
                );
        }

        private static WorkspaceBinding Find(List<WorkspaceBinding> entries, string hash)
        {
            foreach (WorkspaceBinding candidate in entries)
            {
                if (SameWorkspace(candidate, hash))
                {
                    return candidate;
                }
            }
            return null;
        }

        private static void Delete(string cachePath)
        {
            try
            {
                if (File.Exists(cachePath))
                {
                    File.Delete(cachePath);
                }
            }
            catch (Exception)
            {
                // A cache that cannot be removed is still never read for anything but a binding.
            }
        }

        private static CacheDocument Read(string cachePath)
        {
            var entries = new List<WorkspaceBinding>();
            if (cachePath == null || !File.Exists(cachePath))
            {
                return new CacheDocument(entries, false);
            }
            JsonValue document = JsonReader.Parse(
                File.ReadAllText(cachePath, new UTF8Encoding(false))
            );
            bool carriesLiteralPaths = false;
            foreach (JsonValue candidate in document["bindings"].Elements)
            {
                if (WorkspaceBinding.CarriesLiteralPath(candidate))
                {
                    carriesLiteralPaths = true;
                }
                WorkspaceBinding binding = WorkspaceBinding.FromJson(candidate);
                if (binding != null)
                {
                    entries.Add(binding);
                }
            }
            return new CacheDocument(entries, carriesLiteralPaths);
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
