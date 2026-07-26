using System;
using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace ClaudeAccountGuard
{
    /// <summary>
    /// Reading values out of a registry or payload the same way everywhere.
    ///
    /// Both native components navigate documents written by the extension host, and both used to
    /// carry their own copies of these coercions. Where those copies differed - one lower-casing,
    /// one not - the same workspace ended up recorded under two identities.
    /// </summary>
    internal static class GuardValues
    {
        /// <summary>
        /// A named member's text, or null when it is absent, null, or not a scalar.
        ///
        /// Tolerating a null container matters: lookups that find nothing return null, and a
        /// caller that then asks it a question should get "no value" rather than an exception it
        /// will catch and turn into a worse outcome than the missing value would have been.
        /// </summary>
        public static string Text(JsonValue value, string name)
        {
            return value == null ? null : value[name].AsText();
        }

        public static bool IsBlank(string value)
        {
            return string.IsNullOrWhiteSpace(value);
        }

        /// <summary>
        /// Case-insensitive equality where a missing value never matches. Windows paths, profile
        /// identifiers and lock modes are all compared this way.
        /// </summary>
        public static bool Matches(string left, string right)
        {
            return left != null
                && right != null
                && string.Equals(left, right, StringComparison.OrdinalIgnoreCase);
        }

        /// <summary>The first candidate that carries a usable value.</summary>
        public static string FirstValue(params JsonValue[] candidates)
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
    }

    /// <summary>
    /// The one path shape the product compares and records in.
    ///
    /// A workspace is identified by a hash of its normalized path and labelled by its sanitized
    /// leaf, and usage rows are keyed on both. Two producers that normalize differently split one
    /// workspace's history in half, so there is exactly one implementation and both the wrapper and
    /// the status-line bridge call it.
    /// </summary>
    internal static class GuardPaths
    {
        private static readonly Regex UnsafeLabelCharacters = new Regex(
            "[^A-Za-z0-9_.-]",
            RegexOptions.CultureInvariant
        );

        /// <summary>
        /// Absolute, backslash-separated, no trailing separator except on a bare drive root, lower
        /// case. Returns an empty string for input that cannot be a path.
        /// </summary>
        public static string Normalize(string value)
        {
            if (string.IsNullOrWhiteSpace(value))
            {
                return string.Empty;
            }
            string normalized;
            try
            {
                normalized = Path.GetFullPath(value);
            }
            catch (Exception)
            {
                // A value that is not a usable path still has to normalize to something stable,
                // or a status snapshot would be dropped over a cosmetic detail.
                normalized = value;
            }
            normalized = normalized.Replace("/", "\\").TrimEnd('\\');
            if (normalized.Length == 2
                && normalized[1] == ':'
                && ((normalized[0] >= 'A' && normalized[0] <= 'Z')
                    || (normalized[0] >= 'a' && normalized[0] <= 'z')))
            {
                // A bare drive root keeps its separator, so `D:\` never normalizes to `d:` and
                // then fails to match the `d:\` the registry recorded.
                normalized += "\\";
            }
            return normalized.ToLowerInvariant();
        }

        /// <summary>The first 16 hex characters of the SHA-256 of an already-normalized path.</summary>
        public static string WorkspaceHash(string normalizedPath)
        {
            using (SHA256 algorithm = SHA256.Create())
            {
                byte[] digest = algorithm.ComputeHash(
                    Encoding.UTF8.GetBytes(normalizedPath ?? string.Empty)
                );
                var builder = new StringBuilder(digest.Length * 2);
                foreach (byte value in digest)
                {
                    builder.Append(value.ToString("x2", CultureInfo.InvariantCulture));
                }
                return builder.ToString().Substring(0, 16);
            }
        }

        /// <summary>
        /// A workspace's display label: its leaf directory with everything outside
        /// <c>A-Za-z0-9_.-</c> replaced. Sanitizing matters because the label is emitted as an
        /// OpenTelemetry resource attribute and stored as a usage dimension.
        /// </summary>
        public static string LabelFor(string normalizedPath)
        {
            if (string.IsNullOrEmpty(normalizedPath))
            {
                return string.Empty;
            }
            string leaf;
            try
            {
                leaf = Path.GetFileName(normalizedPath.TrimEnd('\\'));
            }
            catch (Exception)
            {
                leaf = normalizedPath;
            }
            return UnsafeLabelCharacters.Replace(leaf ?? string.Empty, "_");
        }
    }
}
