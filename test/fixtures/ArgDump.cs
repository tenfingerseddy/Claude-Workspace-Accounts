using System;
using System.IO;
using System.Text;

// A stand-in for the real Claude executable used by the wrapper argument-fidelity gate.
//
// Unlike a .cmd shim, a compiled executable receives its argument vector through the
// same CreateProcess path the real CLI uses, so a byte-exact comparison against the
// vector the test spawned is meaningful.
internal static class ArgDump
{
    private static int Main(string[] args)
    {
        if (args.Length >= 2 && args[0] == "auth" && args[1] == "status")
        {
            Console.Out.Write(
                "{\"loggedIn\":true,\"email\":\""
                    + Read("FAKE_EMAIL", "work@example.com")
                    + "\",\"account\":{\"id\":\""
                    + Read("FAKE_ACCOUNT_ID", "acct-work")
                    + "\"},\"organization\":{\"id\":\""
                    + Read("FAKE_ORG_ID", "org-work")
                    + "\"}}"
            );
            return 0;
        }

        string destination = Environment.GetEnvironmentVariable("ARGDUMP_OUT");
        if (!string.IsNullOrEmpty(destination))
        {
            File.WriteAllText(destination, ToJsonArray(args), new UTF8Encoding(false));
        }

        for (int index = 0; index < args.Length; index++)
        {
            if (args[index] == "--echo-stdin")
            {
                using (Stream input = Console.OpenStandardInput())
                using (Stream output = Console.OpenStandardOutput())
                {
                    var buffer = new byte[8192];
                    int read;
                    while ((read = input.Read(buffer, 0, buffer.Length)) > 0)
                    {
                        output.Write(buffer, 0, read);
                    }
                    output.Flush();
                }
                return 0;
            }
            if (args[index] == "--exact-stdout")
            {
                // No trailing newline, no BOM: a stream-json consumer needs byte fidelity.
                using (Stream output = Console.OpenStandardOutput())
                {
                    byte[] payload = Encoding.UTF8.GetBytes("{\"type\":\"exact\"}");
                    output.Write(payload, 0, payload.Length);
                    output.Flush();
                }
                return 0;
            }
            if (args[index] == "--write-stderr")
            {
                Console.Error.Write("ARGDUMP_STDERR");
                Console.Out.Write("ARGDUMP_STDOUT");
                return 0;
            }
            if (args[index] == "--exit-code" && index + 1 < args.Length)
            {
                Console.Out.Write("FAKE_CLAUDE_LAUNCHED");
                return int.Parse(args[index + 1]);
            }
        }

        Console.Out.Write("FAKE_CLAUDE_LAUNCHED");
        return 0;
    }

    private static string Read(string name, string fallback)
    {
        string value = Environment.GetEnvironmentVariable(name);
        return string.IsNullOrEmpty(value) ? fallback : value;
    }

    private static string ToJsonArray(string[] values)
    {
        var builder = new StringBuilder("[");
        for (int index = 0; index < values.Length; index++)
        {
            if (index > 0)
            {
                builder.Append(',');
            }
            AppendJsonString(builder, values[index]);
        }
        builder.Append(']');
        return builder.ToString();
    }

    private static void AppendJsonString(StringBuilder builder, string value)
    {
        builder.Append('"');
        foreach (char character in value)
        {
            switch (character)
            {
                case '"':
                    builder.Append("\\\"");
                    break;
                case '\\':
                    builder.Append("\\\\");
                    break;
                case '\n':
                    builder.Append("\\n");
                    break;
                case '\r':
                    builder.Append("\\r");
                    break;
                case '\t':
                    builder.Append("\\t");
                    break;
                default:
                    if (character < ' ' || character > '~')
                    {
                        builder.Append("\\u").Append(((int)character).ToString("x4"));
                    }
                    else
                    {
                        builder.Append(character);
                    }
                    break;
            }
        }
        builder.Append('"');
    }
}
