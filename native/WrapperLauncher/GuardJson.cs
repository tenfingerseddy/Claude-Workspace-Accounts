using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace ClaudeAccountGuard.WrapperLauncher
{
    internal enum JsonKind
    {
        Null,
        Boolean,
        Number,
        String,
        Array,
        Object
    }

    /// <summary>Thrown for input that is not well-formed JSON.</summary>
    internal sealed class JsonMalformedException : Exception
    {
        public JsonMalformedException(string message)
            : base(message)
        {
        }
    }

    /// <summary>
    /// The smallest JSON document model that can read the Account Guard registry and a
    /// <c>claude auth status</c> response.
    ///
    /// The wrapper is compiled by the in-box .NET Framework compiler and must run with no
    /// package dependencies, so the reader is hand written. Member lookup is total: asking
    /// for a missing member yields an absent value rather than throwing, which keeps guard
    /// logic free of null checks and mirrors how the PowerShell implementation navigated a
    /// partially populated registry.
    /// </summary>
    internal sealed class JsonValue
    {
        private static readonly JsonValue AbsentValue = new JsonValue(JsonKind.Null);
        private static readonly List<JsonValue> NoElements = new List<JsonValue>();

        private readonly JsonKind kind;
        private readonly bool boolean;
        private readonly double number;
        private readonly string text;
        private readonly List<JsonValue> elements;
        private readonly Dictionary<string, JsonValue> members;

        private JsonValue(JsonKind kind)
        {
            this.kind = kind;
        }

        private JsonValue(bool value)
            : this(JsonKind.Boolean)
        {
            boolean = value;
        }

        private JsonValue(double value)
            : this(JsonKind.Number)
        {
            number = value;
        }

        private JsonValue(string value)
            : this(JsonKind.String)
        {
            text = value;
        }

        private JsonValue(List<JsonValue> value)
            : this(JsonKind.Array)
        {
            elements = value;
        }

        private JsonValue(Dictionary<string, JsonValue> value)
            : this(JsonKind.Object)
        {
            members = value;
        }

        /// <summary>The value returned for any member or element that does not exist.</summary>
        public static JsonValue Absent
        {
            get { return AbsentValue; }
        }

        public static JsonValue FromBoolean(bool value)
        {
            return new JsonValue(value);
        }

        public static JsonValue FromNumber(double value)
        {
            return new JsonValue(value);
        }

        public static JsonValue FromString(string value)
        {
            return new JsonValue(value);
        }

        public static JsonValue FromArray(List<JsonValue> value)
        {
            return new JsonValue(value);
        }

        public static JsonValue FromObject(Dictionary<string, JsonValue> value)
        {
            return new JsonValue(value);
        }

        public JsonKind Kind
        {
            get { return kind; }
        }

        public bool IsObject
        {
            get { return kind == JsonKind.Object; }
        }

        public bool IsArray
        {
            get { return kind == JsonKind.Array; }
        }

        public bool IsAbsent
        {
            get { return kind == JsonKind.Null; }
        }

        /// <summary>
        /// Case-insensitive member access, matching how the PowerShell implementation read
        /// properties off a <c>ConvertFrom-Json</c> object.
        /// </summary>
        public JsonValue this[string name]
        {
            get
            {
                if (members == null || name == null)
                {
                    return AbsentValue;
                }
                JsonValue value;
                return members.TryGetValue(name, out value) ? value : AbsentValue;
            }
        }

        /// <summary>Array elements, or nothing at all for any other kind.</summary>
        public IList<JsonValue> Elements
        {
            get { return elements ?? NoElements; }
        }

        /// <summary>
        /// The value as text, using the same coercions the PowerShell <c>[string]</c> cast
        /// applied. Absent members, nulls, arrays and objects all read as null so callers can
        /// treat "no value" uniformly.
        /// </summary>
        public string AsText()
        {
            switch (kind)
            {
                case JsonKind.String:
                    return text;
                case JsonKind.Number:
                    return number.ToString("R", CultureInfo.InvariantCulture);
                case JsonKind.Boolean:
                    return boolean ? "True" : "False";
                default:
                    return null;
            }
        }

        /// <summary>True only for an explicit JSON <c>true</c>.</summary>
        public bool IsTrue
        {
            get { return kind == JsonKind.Boolean && boolean; }
        }

        /// <summary>True only for an explicit JSON <c>false</c>.</summary>
        public bool IsFalse
        {
            get { return kind == JsonKind.Boolean && !boolean; }
        }

        /// <summary>
        /// The value as an integer, or null when it is not numeric. A numeric string is
        /// accepted because the registry is written by more than one component.
        /// </summary>
        public int? AsInteger()
        {
            if (kind == JsonKind.Number)
            {
                if (number > int.MaxValue || number < int.MinValue || double.IsNaN(number))
                {
                    return null;
                }
                return (int)number;
            }
            if (kind == JsonKind.String)
            {
                int parsed;
                if (int.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out parsed))
                {
                    return parsed;
                }
            }
            return null;
        }
    }

    /// <summary>Writing side of the reader: just enough to emit the guard's own small files.</summary>
    internal static class JsonText
    {
        public static string Escape(string value)
        {
            var builder = new StringBuilder();
            foreach (char character in value ?? string.Empty)
            {
                if (character == '"' || character == '\\')
                {
                    builder.Append('\\').Append(character);
                    continue;
                }
                if (character < ' ')
                {
                    builder.Append("\\u").Append(((int)character).ToString("x4", CultureInfo.InvariantCulture));
                    continue;
                }
                builder.Append(character);
            }
            return builder.ToString();
        }

        /// <summary>A quoted JSON string, or <c>null</c> for a value that is absent.</summary>
        public static string Quote(string value)
        {
            return value == null ? "null" : "\"" + Escape(value) + "\"";
        }
    }

    /// <summary>A strict, allocation-light JSON reader with a bounded nesting depth.</summary>
    internal static class JsonReader
    {
        private const int MaximumDepth = 64;

        public static JsonValue Parse(string content)
        {
            if (content == null)
            {
                throw new JsonMalformedException("The document was empty.");
            }
            int index = 0;
            SkipWhitespace(content, ref index);
            JsonValue value = ReadValue(content, ref index, 0);
            SkipWhitespace(content, ref index);
            if (index != content.Length)
            {
                throw new JsonMalformedException("Unexpected trailing content.");
            }
            return value;
        }

        private static JsonValue ReadValue(string content, ref int index, int depth)
        {
            if (depth > MaximumDepth)
            {
                throw new JsonMalformedException("The document is nested too deeply.");
            }
            if (index >= content.Length)
            {
                throw new JsonMalformedException("The document ended unexpectedly.");
            }
            char current = content[index];
            switch (current)
            {
                case '{':
                    return ReadObject(content, ref index, depth);
                case '[':
                    return ReadArray(content, ref index, depth);
                case '"':
                    return JsonValue.FromString(ReadString(content, ref index));
                case 't':
                    Expect(content, ref index, "true");
                    return JsonValue.FromBoolean(true);
                case 'f':
                    Expect(content, ref index, "false");
                    return JsonValue.FromBoolean(false);
                case 'n':
                    Expect(content, ref index, "null");
                    return JsonValue.Absent;
                default:
                    return JsonValue.FromNumber(ReadNumber(content, ref index));
            }
        }

        private static JsonValue ReadObject(string content, ref int index, int depth)
        {
            index += 1;
            var members = new Dictionary<string, JsonValue>(StringComparer.OrdinalIgnoreCase);
            SkipWhitespace(content, ref index);
            if (Peek(content, index) == '}')
            {
                index += 1;
                return JsonValue.FromObject(members);
            }
            while (true)
            {
                SkipWhitespace(content, ref index);
                if (Peek(content, index) != '"')
                {
                    throw new JsonMalformedException("Expected a member name.");
                }
                string name = ReadString(content, ref index);
                SkipWhitespace(content, ref index);
                if (Peek(content, index) != ':')
                {
                    throw new JsonMalformedException("Expected ':' after a member name.");
                }
                index += 1;
                SkipWhitespace(content, ref index);
                // A duplicate name keeps the last value, which is what every mainstream
                // JSON reader does and what the registry writer would round-trip.
                members[name] = ReadValue(content, ref index, depth + 1);
                SkipWhitespace(content, ref index);
                char separator = Peek(content, index);
                if (separator == ',')
                {
                    index += 1;
                    continue;
                }
                if (separator == '}')
                {
                    index += 1;
                    return JsonValue.FromObject(members);
                }
                throw new JsonMalformedException("Expected ',' or '}' in an object.");
            }
        }

        private static JsonValue ReadArray(string content, ref int index, int depth)
        {
            index += 1;
            var elements = new List<JsonValue>();
            SkipWhitespace(content, ref index);
            if (Peek(content, index) == ']')
            {
                index += 1;
                return JsonValue.FromArray(elements);
            }
            while (true)
            {
                SkipWhitespace(content, ref index);
                elements.Add(ReadValue(content, ref index, depth + 1));
                SkipWhitespace(content, ref index);
                char separator = Peek(content, index);
                if (separator == ',')
                {
                    index += 1;
                    continue;
                }
                if (separator == ']')
                {
                    index += 1;
                    return JsonValue.FromArray(elements);
                }
                throw new JsonMalformedException("Expected ',' or ']' in an array.");
            }
        }

        private static string ReadString(string content, ref int index)
        {
            index += 1;
            var builder = new StringBuilder();
            while (true)
            {
                if (index >= content.Length)
                {
                    throw new JsonMalformedException("An unterminated string was found.");
                }
                char current = content[index];
                if (current == '"')
                {
                    index += 1;
                    return builder.ToString();
                }
                if (current != '\\')
                {
                    if (current < ' ')
                    {
                        throw new JsonMalformedException("A control character was found in a string.");
                    }
                    builder.Append(current);
                    index += 1;
                    continue;
                }
                index += 1;
                if (index >= content.Length)
                {
                    throw new JsonMalformedException("An escape sequence was truncated.");
                }
                char escape = content[index];
                index += 1;
                switch (escape)
                {
                    case '"':
                        builder.Append('"');
                        break;
                    case '\\':
                        builder.Append('\\');
                        break;
                    case '/':
                        builder.Append('/');
                        break;
                    case 'b':
                        builder.Append('\b');
                        break;
                    case 'f':
                        builder.Append('\f');
                        break;
                    case 'n':
                        builder.Append('\n');
                        break;
                    case 'r':
                        builder.Append('\r');
                        break;
                    case 't':
                        builder.Append('\t');
                        break;
                    case 'u':
                        if (index + 4 > content.Length)
                        {
                            throw new JsonMalformedException("A \\u escape was truncated.");
                        }
                        int code;
                        if (!int.TryParse(
                            content.Substring(index, 4),
                            NumberStyles.HexNumber,
                            CultureInfo.InvariantCulture,
                            out code))
                        {
                            throw new JsonMalformedException("A \\u escape was not hexadecimal.");
                        }
                        builder.Append((char)code);
                        index += 4;
                        break;
                    default:
                        throw new JsonMalformedException("An unknown escape sequence was found.");
                }
            }
        }

        private static double ReadNumber(string content, ref int index)
        {
            int start = index;
            if (Peek(content, index) == '-' || Peek(content, index) == '+')
            {
                index += 1;
            }
            while (index < content.Length)
            {
                char current = content[index];
                if ((current >= '0' && current <= '9')
                    || current == '.'
                    || current == 'e'
                    || current == 'E'
                    || current == '+'
                    || current == '-')
                {
                    index += 1;
                    continue;
                }
                break;
            }
            if (index == start)
            {
                throw new JsonMalformedException("Expected a value.");
            }
            double parsed;
            if (!double.TryParse(
                content.Substring(start, index - start),
                NumberStyles.Float,
                CultureInfo.InvariantCulture,
                out parsed))
            {
                throw new JsonMalformedException("A number could not be read.");
            }
            return parsed;
        }

        private static void Expect(string content, ref int index, string literal)
        {
            if (index + literal.Length > content.Length
                || string.CompareOrdinal(content, index, literal, 0, literal.Length) != 0)
            {
                throw new JsonMalformedException("An unexpected literal was found.");
            }
            index += literal.Length;
        }

        private static char Peek(string content, int index)
        {
            return index < content.Length ? content[index] : '\0';
        }

        private static void SkipWhitespace(string content, ref int index)
        {
            while (index < content.Length)
            {
                char current = content[index];
                if (current == ' ' || current == '\t' || current == '\r' || current == '\n')
                {
                    index += 1;
                    continue;
                }
                // A byte-order mark can survive a UTF-8 read; it is not content.
                if (current == '\uFEFF' && index == 0)
                {
                    index += 1;
                    continue;
                }
                break;
            }
        }
    }
}
