using System;
using System.IO;
using System.Text;

namespace ClaudeAccountGuard
{
    /// <summary>Where the guard keeps the state both native components read.</summary>
    internal static class GuardSupport
    {
        private static readonly string ResolvedRoot = Resolve();

        /// <summary>
        /// The support directory, or null when the environment gives no usable location. A null
        /// root means the guard has no state, which is always a reason to do nothing rather than a
        /// reason to fail.
        /// </summary>
        public static string Root
        {
            get { return ResolvedRoot; }
        }

        public static string RegistryPath
        {
            get { return Combine("registry.json"); }
        }

        public static string Combine(string name)
        {
            try
            {
                return ResolvedRoot == null ? null : Path.Combine(ResolvedRoot, name);
            }
            catch (Exception)
            {
                return null;
            }
        }

        private static string Resolve()
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
                // An unusable support root means the guard has no state to act on.
            }
            return null;
        }
    }

    /// <summary>
    /// Reading and gating on the shared registry.
    ///
    /// The wrapper and the status-line bridge both need to answer "which registered account is this
    /// process running as, and is it allowed to collect usage". Two independent implementations of
    /// that question drifted: one of them never matched a profile whose configuration directory was
    /// a bare drive root, and it failed silently inside a blanket catch. There is one now.
    /// </summary>
    internal static class GuardRegistry
    {
        /// <summary>
        /// The parsed registry, or null when there is none or it is unusable. Validation is
        /// deliberately part of loading: a document that does not have the shape the guard expects
        /// is no more usable than one that does not parse.
        /// </summary>
        public static JsonValue Load(string registryPath)
        {
            try
            {
                if (registryPath == null || !File.Exists(registryPath))
                {
                    return null;
                }
                JsonValue registry = JsonReader.Parse(
                    File.ReadAllText(registryPath, new UTF8Encoding(false))
                );
                return IsValid(registry) ? registry : null;
            }
            catch (Exception)
            {
                return null;
            }
        }

        public static bool IsValid(JsonValue registry)
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
                return false;
            }
            foreach (JsonValue profile in registry["profiles"].Elements)
            {
                if (GuardValues.IsBlank(GuardValues.Text(profile, "id"))
                    || GuardValues.IsBlank(GuardValues.Text(profile, "configDirNormalized")))
                {
                    return false;
                }
            }
            foreach (JsonValue workspaceLock in registry["workspaceLocks"].Elements)
            {
                string mode = GuardValues.Text(workspaceLock, "mode");
                if (GuardValues.IsBlank(GuardValues.Text(workspaceLock, "workspaceUri"))
                    || GuardValues.IsBlank(GuardValues.Text(workspaceLock, "profileId"))
                    || !(GuardValues.Matches(mode, "enforce")
                        || GuardValues.Matches(mode, "warn")
                        || GuardValues.Matches(mode, "off")))
                {
                    return false;
                }
            }
            return true;
        }

        /// <summary>
        /// The configuration directory this process is running against: the account in play. The
        /// wrapper sets it for the launch, so everything downstream - including Claude's status-line
        /// hook - inherits the bound account and agrees about which one it is.
        /// </summary>
        public static string RuntimeConfigDirectory()
        {
            string configured = Environment.GetEnvironmentVariable("CLAUDE_CONFIG_DIR");
            if (!string.IsNullOrEmpty(configured))
            {
                return configured;
            }
            string userProfile = Environment.GetEnvironmentVariable("USERPROFILE");
            return Path.Combine(userProfile ?? string.Empty, ".claude");
        }

        public static JsonValue FindProfileById(JsonValue registry, string profileId)
        {
            if (registry == null || GuardValues.IsBlank(profileId))
            {
                return null;
            }
            foreach (JsonValue profile in registry["profiles"].Elements)
            {
                if (GuardValues.Matches(GuardValues.Text(profile, "id"), profileId))
                {
                    return profile;
                }
            }
            return null;
        }

        /// <summary>
        /// The registered profile whose isolated configuration directory matches a normalized path.
        /// No credential file is opened: the directory is the whole identity signal here.
        /// </summary>
        public static JsonValue FindProfileByConfigDirectory(
            JsonValue registry,
            string normalizedConfigDirectory
        )
        {
            if (registry == null || GuardValues.IsBlank(normalizedConfigDirectory))
            {
                return null;
            }
            foreach (JsonValue profile in registry["profiles"].Elements)
            {
                if (GuardValues.Matches(
                    GuardValues.Text(profile, "configDirNormalized"),
                    normalizedConfigDirectory))
                {
                    return profile;
                }
            }
            return null;
        }

        /// <summary>
        /// Whether local usage collection is allowed for a profile. Collection is opt-in twice
        /// over: the profile must have it enabled, and the integration must not have it turned off
        /// globally.
        /// </summary>
        public static bool CollectionAllowed(JsonValue registry, JsonValue profile)
        {
            return registry != null
                && profile != null
                && profile["telemetryEnabled"].IsTrue
                && !registry["integration"]["telemetryEnabled"].IsFalse;
        }
    }
}
