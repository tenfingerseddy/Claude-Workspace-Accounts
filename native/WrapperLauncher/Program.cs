using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Threading;

namespace ClaudeAccountGuard.WrapperLauncher
{
    internal static class Program
    {
        private const int GuardFailureExitCode = 78;

        public static int Main(string[] args)
        {
            if (args.Length == 0 || string.IsNullOrWhiteSpace(args[0]))
            {
                Console.Error.WriteLine("CLAUDE_ACCOUNT_GUARD_BLOCKED category=binary_missing");
                Console.Error.WriteLine("The Claude process wrapper did not receive the bundled Claude executable.");
                return GuardFailureExitCode;
            }

            string executableDirectory = Path.GetDirectoryName(
                Assembly.GetExecutingAssembly().Location
            );
            string scriptPath = Path.Combine(
                executableDirectory ?? AppDomain.CurrentDomain.BaseDirectory,
                "claude-account-guard-wrapper.ps1"
            );
            if (!File.Exists(scriptPath))
            {
                // A stable launcher can outlive an uninstalled extension. If its support script
                // has also been removed, preserve Claude Code functionality without inspecting
                // or modifying any account state.
                return StartAndWait(args[0], args.Skip(1));
            }

            var powershellArguments = new List<string>
            {
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                scriptPath
            };
            powershellArguments.AddRange(args);
            return StartAndWait("powershell.exe", powershellArguments);
        }

        private static int StartAndWait(string executable, IEnumerable<string> arguments)
        {
            try
            {
                var startInfo = new ProcessStartInfo
                {
                    FileName = executable,
                    Arguments = JoinArguments(arguments),
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardInput = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    WindowStyle = ProcessWindowStyle.Hidden
                };

                using (Process process = Process.Start(startInfo))
                {
                    if (process == null)
                    {
                        Console.Error.WriteLine("CLAUDE_ACCOUNT_GUARD_BLOCKED category=launcher_failed");
                        return GuardFailureExitCode;
                    }
                    Thread inputPump = StartPump(
                        Console.OpenStandardInput(),
                        process.StandardInput.BaseStream,
                        true,
                        true
                    );
                    Thread outputPump = StartPump(
                        process.StandardOutput.BaseStream,
                        Console.OpenStandardOutput(),
                        false,
                        false
                    );
                    Thread errorPump = StartPump(
                        process.StandardError.BaseStream,
                        Console.OpenStandardError(),
                        false,
                        false
                    );
                    process.WaitForExit();
                    outputPump.Join();
                    errorPump.Join();
                    return process.ExitCode;
                }
            }
            catch (Exception)
            {
                Console.Error.WriteLine("CLAUDE_ACCOUNT_GUARD_BLOCKED category=launcher_failed");
                Console.Error.WriteLine("The stable Account Guard launcher could not start its preflight process.");
                return GuardFailureExitCode;
            }
        }

        private static Thread StartPump(
            Stream input,
            Stream output,
            bool closeOutput,
            bool background
        )
        {
            var thread = new Thread(delegate()
            {
                try
                {
                    var buffer = new byte[81920];
                    int read;
                    while ((read = input.Read(buffer, 0, buffer.Length)) > 0)
                    {
                        output.Write(buffer, 0, read);
                        output.Flush();
                    }
                }
                catch (IOException)
                {
                    // The peer closing a standard stream is a normal process-exit condition.
                }
                catch (ObjectDisposedException)
                {
                    // The child may exit while the input pump is blocked.
                }
                finally
                {
                    if (closeOutput)
                    {
                        try
                        {
                            output.Close();
                        }
                        catch
                        {
                            // Nothing else can be done during process teardown.
                        }
                    }
                }
            });
            thread.IsBackground = background;
            thread.Start();
            return thread;
        }

        private static string JoinArguments(IEnumerable<string> arguments)
        {
            return string.Join(" ", arguments.Select(QuoteArgument));
        }

        private static string QuoteArgument(string argument)
        {
            if (argument.Length > 0 && !argument.Any(char.IsWhiteSpace) && argument.IndexOf('"') < 0)
            {
                return argument;
            }

            var result = new StringBuilder("\"");
            int backslashes = 0;
            foreach (char character in argument)
            {
                if (character == '\\')
                {
                    backslashes++;
                    continue;
                }
                if (character == '"')
                {
                    result.Append('\\', backslashes * 2 + 1);
                    result.Append('"');
                    backslashes = 0;
                    continue;
                }
                result.Append('\\', backslashes);
                backslashes = 0;
                result.Append(character);
            }
            result.Append('\\', backslashes * 2);
            result.Append('"');
            return result.ToString();
        }
    }
}
