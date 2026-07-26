using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace ClaudeAccountGuard
{
    /// <summary>
    /// Windows command-line encoding.
    ///
    /// Claude Code hands the wrapper an argument vector; the CLI must receive that vector
    /// byte for byte. Windows has no argument vector at the process boundary, only a single
    /// command-line string, so every argument is encoded with the exact inverse of the
    /// parser the child will use (<c>CommandLineToArgvW</c>, which is also what the C runtime
    /// and .NET use). Any layer that re-parses in between - a shell, a script host - breaks
    /// that inverse and silently drops or rewrites arguments.
    /// </summary>
    internal static class WindowsCommandLine
    {
        /// <summary>
        /// Encodes one argument, quoting only when the parser would otherwise split or
        /// misread it. This is the encoding a normal process launch produces.
        /// </summary>
        public static string Encode(string argument)
        {
            string value = argument ?? string.Empty;
            if (value.Length > 0 && !NeedsQuoting(value))
            {
                return value;
            }
            return Quote(value);
        }

        /// <summary>
        /// Encodes one argument with quotes always present.
        ///
        /// Used only when the command line must survive a pass through the command
        /// processor: quotes are what stop <c>cmd.exe</c> from treating <c>&amp;</c>,
        /// <c>|</c>, <c>&lt;</c>, <c>&gt;</c>, <c>(</c>, <c>)</c> and <c>^</c> as syntax,
        /// and they are transparent to the argument parser underneath.
        /// </summary>
        public static string EncodeQuoted(string argument)
        {
            return Quote(argument ?? string.Empty);
        }

        private static bool NeedsQuoting(string value)
        {
            foreach (char character in value)
            {
                if (character == '"' || char.IsWhiteSpace(character))
                {
                    return true;
                }
            }
            return false;
        }

        private static string Quote(string value)
        {
            var builder = new StringBuilder(value.Length + 2);
            builder.Append('"');
            int backslashes = 0;
            foreach (char character in value)
            {
                if (character == '\\')
                {
                    backslashes += 1;
                    continue;
                }
                if (character == '"')
                {
                    // A quote is escaped by one backslash, and every backslash that runs
                    // into it must itself be doubled.
                    builder.Append('\\', (backslashes * 2) + 1);
                    builder.Append('"');
                    backslashes = 0;
                    continue;
                }
                builder.Append('\\', backslashes);
                backslashes = 0;
                builder.Append(character);
            }
            // Backslashes that run into the closing quote would escape it.
            builder.Append('\\', backslashes * 2);
            builder.Append('"');
            return builder.ToString();
        }

        public static bool IsBatchFile(string target)
        {
            if (string.IsNullOrEmpty(target))
            {
                return false;
            }
            string extension;
            try
            {
                extension = Path.GetExtension(target);
            }
            catch (ArgumentException)
            {
                return false;
            }
            return string.Equals(extension, ".cmd", StringComparison.OrdinalIgnoreCase)
                || string.Equals(extension, ".bat", StringComparison.OrdinalIgnoreCase);
        }

        /// <summary>The command processor, resolved without trusting a hostile ComSpec.</summary>
        public static string CommandProcessor()
        {
            string configured = Environment.GetEnvironmentVariable("ComSpec");
            if (!string.IsNullOrEmpty(configured) && File.Exists(configured))
            {
                return configured;
            }
            string system = Environment.GetFolderPath(Environment.SpecialFolder.System);
            return Path.Combine(system, "cmd.exe");
        }

        /// <summary>
        /// Builds the application path and command line for a launch.
        ///
        /// <c>CreateProcess</c> cannot execute a batch file, so a <c>.cmd</c> or <c>.bat</c>
        /// target is run through <c>cmd.exe /d /s /v:off /c</c>: <c>/d</c> skips AutoRun
        /// commands, <c>/s</c> makes the quote handling of the trailing string predictable,
        /// and <c>/v:off</c> disables delayed expansion so <c>!</c> stays literal even on a
        /// machine where it is enabled by default.
        /// </summary>
        public static void Compose(
            IList<string> command,
            string resolvedExecutable,
            out string applicationName,
            out string commandLine
        )
        {
            string executable = resolvedExecutable ?? command[0];
            if (IsBatchFile(executable))
            {
                applicationName = CommandProcessor();
                var inner = new StringBuilder();
                inner.Append(EncodeQuoted(executable));
                for (int index = 1; index < command.Count; index++)
                {
                    inner.Append(' ');
                    inner.Append(EncodeQuoted(command[index]));
                }
                commandLine = EncodeQuoted(applicationName)
                    + " /d /s /v:off /c \""
                    + inner
                    + "\"";
                return;
            }

            // A null application name lets Windows resolve the command line itself, which is
            // the only way an unresolvable executable produces its genuine error rather than
            // one this wrapper invented.
            applicationName = resolvedExecutable;
            var builder = new StringBuilder();
            builder.Append(EncodeQuoted(executable));
            for (int index = 1; index < command.Count; index++)
            {
                builder.Append(' ');
                builder.Append(Encode(command[index]));
            }
            commandLine = builder.ToString();
        }
    }

    /// <summary>
    /// A job object that owns every process the wrapper starts.
    ///
    /// Without it, killing the wrapper leaves the Claude CLI running and holding the
    /// workspace's stdio; with <c>JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE</c> the last handle to
    /// the job closes when the wrapper exits and Windows terminates the tree. Every step is
    /// best effort: a machine or container that refuses job objects must still be able to
    /// run Claude.
    /// </summary>
    internal static class ProcessJob
    {
        private static readonly object Gate = new object();
        private static bool attempted;
        private static IntPtr handle = IntPtr.Zero;

        public static void Adopt(IntPtr processHandle)
        {
            if (processHandle == IntPtr.Zero)
            {
                return;
            }
            try
            {
                IntPtr job = Ensure();
                if (job != IntPtr.Zero)
                {
                    NativeMethods.AssignProcessToJobObject(job, processHandle);
                }
            }
            catch (Exception)
            {
                // Process containment is a robustness measure, never a launch precondition.
            }
        }

        private static IntPtr Ensure()
        {
            lock (Gate)
            {
                if (attempted)
                {
                    return handle;
                }
                attempted = true;
                IntPtr created = NativeMethods.CreateJobObject(IntPtr.Zero, null);
                if (created == IntPtr.Zero)
                {
                    return IntPtr.Zero;
                }
                var information = new NativeMethods.JobObjectExtendedLimitInformation();
                information.BasicLimitInformation.LimitFlags =
                    NativeMethods.JobObjectLimitKillOnJobClose;
                int size = Marshal.SizeOf(
                    typeof(NativeMethods.JobObjectExtendedLimitInformation)
                );
                IntPtr buffer = Marshal.AllocHGlobal(size);
                try
                {
                    Marshal.StructureToPtr(information, buffer, false);
                    if (!NativeMethods.SetInformationJobObject(
                        created,
                        NativeMethods.JobObjectExtendedLimitInformationClass,
                        buffer,
                        (uint)size))
                    {
                        NativeMethods.CloseHandle(created);
                        return IntPtr.Zero;
                    }
                }
                finally
                {
                    Marshal.FreeHGlobal(buffer);
                }
                // The handle is deliberately never closed and never inheritable: the job
                // must live exactly as long as this process and no longer.
                handle = created;
                return handle;
            }
        }
    }

    /// <summary>
    /// Result of a captured child process run.
    ///
    /// stdout is kept as bytes. One caller parses it as UTF-8 JSON; the other passes it straight
    /// through to a status line, where decoding and re-encoding it would be a chance to corrupt
    /// somebody's output for no reason.
    /// </summary>
    internal sealed class CaptureResult
    {
        private static readonly byte[] NoBytes = new byte[0];

        private readonly int exitCode;
        private readonly byte[] standardOutputBytes;

        public CaptureResult(int exitCode, byte[] standardOutputBytes)
        {
            this.exitCode = exitCode;
            this.standardOutputBytes = standardOutputBytes ?? NoBytes;
        }

        public int ExitCode
        {
            get { return exitCode; }
        }

        public byte[] StandardOutputBytes
        {
            get { return standardOutputBytes; }
        }

        /// <summary>stdout decoded as UTF-8, with any byte-order mark removed.</summary>
        public string StandardOutput
        {
            get
            {
                int offset = standardOutputBytes.Length >= 3
                    && standardOutputBytes[0] == 0xEF
                    && standardOutputBytes[1] == 0xBB
                    && standardOutputBytes[2] == 0xBF
                    ? 3
                    : 0;
                return new UTF8Encoding(false).GetString(
                    standardOutputBytes,
                    offset,
                    standardOutputBytes.Length - offset
                );
            }
        }
    }

    /// <summary>Starts the Claude CLI, or a preflight query against it.</summary>
    internal static class ChildProcess
    {
        private static int consoleSignalsHeld;

        /// <summary>
        /// Runs the target with the wrapper's own standard handles.
        ///
        /// Nothing is redirected: stdout, stderr and stdin are the wrapper's, so the CLI sees
        /// the real console (or the real pipes) with no buffering layer that could inject a
        /// byte-order mark, rewrite line endings, merge the two output channels or reorder
        /// them. The child's exit code is returned verbatim.
        /// </summary>
        public static bool TryRun(
            IList<string> command,
            string resolvedExecutable,
            out int exitCode
        )
        {
            exitCode = 0;
            IntPtr processHandle = IntPtr.Zero;
            IntPtr threadHandle = IntPtr.Zero;
            try
            {
                string applicationName;
                string commandLine;
                WindowsCommandLine.Compose(
                    command,
                    resolvedExecutable,
                    out applicationName,
                    out commandLine
                );
                HoldConsoleSignals();
                AllowStandardHandleInheritance();

                var startupInformation = new NativeMethods.StartupInformation();
                startupInformation.cb = Marshal.SizeOf(typeof(NativeMethods.StartupInformation));
                NativeMethods.ProcessInformation processInformation;
                // Suspended, so the process is inside the job before it can run - and
                // therefore before it can start a grandchild that escapes containment.
                bool created = NativeMethods.CreateProcess(
                    applicationName,
                    new StringBuilder(commandLine),
                    IntPtr.Zero,
                    IntPtr.Zero,
                    true,
                    NativeMethods.CreateSuspended,
                    IntPtr.Zero,
                    null,
                    ref startupInformation,
                    out processInformation
                );
                if (!created)
                {
                    return false;
                }
                processHandle = processInformation.ProcessHandle;
                threadHandle = processInformation.ThreadHandle;
                ProcessJob.Adopt(processHandle);
                if (NativeMethods.ResumeThread(threadHandle) == unchecked((uint)-1))
                {
                    // A child that cannot be resumed would hang the launch forever.
                    NativeMethods.TerminateProcess(processHandle, 1);
                    return false;
                }
                NativeMethods.WaitForSingleObject(processHandle, NativeMethods.Infinite);
                uint code;
                if (!NativeMethods.GetExitCodeProcess(processHandle, out code))
                {
                    return false;
                }
                exitCode = unchecked((int)code);
                return true;
            }
            catch (Exception)
            {
                return false;
            }
            finally
            {
                if (threadHandle != IntPtr.Zero)
                {
                    NativeMethods.CloseHandle(threadHandle);
                }
                if (processHandle != IntPtr.Zero)
                {
                    NativeMethods.CloseHandle(processHandle);
                }
            }
        }

        /// <summary>
        /// Runs a short preflight command against the CLI and captures its stdout.
        ///
        /// Standard input is redirected and closed immediately so the query cannot consume a
        /// single byte of the stdin the CLI itself is about to read, and stderr is discarded
        /// so diagnostics from the query never reach a stream-json consumer.
        /// </summary>
        public static CaptureResult Capture(
            IList<string> command,
            string resolvedExecutable,
            int timeoutMilliseconds
        )
        {
            string executable = resolvedExecutable ?? command[0];
            var startInfo = new ProcessStartInfo();
            if (WindowsCommandLine.IsBatchFile(executable))
            {
                var inner = new StringBuilder();
                inner.Append(WindowsCommandLine.EncodeQuoted(executable));
                for (int index = 1; index < command.Count; index++)
                {
                    inner.Append(' ');
                    inner.Append(WindowsCommandLine.EncodeQuoted(command[index]));
                }
                startInfo.FileName = WindowsCommandLine.CommandProcessor();
                startInfo.Arguments = "/d /s /v:off /c \"" + inner + "\"";
            }
            else
            {
                var builder = new StringBuilder();
                for (int index = 1; index < command.Count; index++)
                {
                    if (builder.Length > 0)
                    {
                        builder.Append(' ');
                    }
                    builder.Append(WindowsCommandLine.Encode(command[index]));
                }
                startInfo.FileName = executable;
                startInfo.Arguments = builder.ToString();
            }
            return Capture(startInfo, null, timeoutMilliseconds);
        }

        /// <summary>
        /// Runs a shell command line the user wrote, feeding it a payload on stdin and capturing
        /// its stdout.
        ///
        /// A user's status-line command is a command line, not an argument vector, so it must reach
        /// the command processor with its own quoting intact. It is placed between the outer quotes
        /// that <c>/s</c> strips, which is the one arrangement that hands <c>cmd.exe</c> the exact
        /// text the user wrote: <c>/s</c> removes the first character and the last quote and runs
        /// the remainder verbatim. Passing the command as an argument instead is what let PowerShell
        /// 5.1 strip the quotes out of <c>node "C:\my scripts\line.js"</c>.
        /// </summary>
        public static CaptureResult CaptureShellCommand(
            string command,
            string standardInput,
            int timeoutMilliseconds
        )
        {
            var startInfo = new ProcessStartInfo();
            startInfo.FileName = WindowsCommandLine.CommandProcessor();
            startInfo.Arguments = "/d /s /v:off /c \"" + command + "\"";
            return Capture(
                startInfo,
                new UTF8Encoding(false).GetBytes(standardInput ?? string.Empty),
                timeoutMilliseconds
            );
        }

        /// <summary>
        /// The shared capture machinery. stdout is read as raw bytes so nothing re-encodes it, and
        /// both pipes are drained on their own threads because a child that fills either one while
        /// this thread waits on the other would deadlock.
        /// </summary>
        private static CaptureResult Capture(
            ProcessStartInfo startInfo,
            byte[] standardInput,
            int timeoutMilliseconds
        )
        {
            startInfo.UseShellExecute = false;
            startInfo.CreateNoWindow = true;
            startInfo.RedirectStandardInput = true;
            startInfo.RedirectStandardOutput = true;
            startInfo.RedirectStandardError = true;

            using (Process process = Process.Start(startInfo))
            {
                if (process == null)
                {
                    throw new IOException("The captured process did not start.");
                }
                ProcessJob.Adopt(process.Handle);

                var captured = new MemoryStream();
                Thread outputReader = new Thread(delegate()
                {
                    try
                    {
                        var chunk = new byte[8192];
                        Stream source = process.StandardOutput.BaseStream;
                        int read;
                        while ((read = source.Read(chunk, 0, chunk.Length)) > 0)
                        {
                            captured.Write(chunk, 0, read);
                        }
                    }
                    catch (Exception)
                    {
                        // Whatever arrived before the failure is still worth returning.
                    }
                });
                outputReader.IsBackground = true;
                outputReader.Start();
                Thread errorReader = new Thread(delegate()
                {
                    try
                    {
                        process.StandardError.ReadToEnd();
                    }
                    catch (Exception)
                    {
                        // Diagnostics from a captured child are intentionally discarded.
                    }
                });
                errorReader.IsBackground = true;
                errorReader.Start();

                try
                {
                    if (standardInput != null && standardInput.Length > 0)
                    {
                        Stream sink = process.StandardInput.BaseStream;
                        sink.Write(standardInput, 0, standardInput.Length);
                        sink.Flush();
                    }
                    process.StandardInput.Close();
                }
                catch (IOException)
                {
                    // A child that exits without reading its input is entitled to.
                }

                if (!process.WaitForExit(timeoutMilliseconds))
                {
                    try
                    {
                        process.Kill();
                    }
                    catch (Exception)
                    {
                        // The process may have exited between the wait and the kill.
                    }
                    throw new TimeoutException("The captured process did not complete in time.");
                }
                outputReader.Join(timeoutMilliseconds);
                errorReader.Join(1000);
                return new CaptureResult(process.ExitCode, captured.ToArray());
            }
        }

        /// <summary>
        /// Stops a console signal from killing the wrapper before the CLI has handled it.
        ///
        /// Ctrl+C reaches every process attached to the console, so the CLI receives it
        /// directly and gets to shut down on its own terms. If the wrapper died on the same
        /// signal it would abandon the CLI mid-request; instead it keeps waiting and reports
        /// whatever exit code the CLI chooses.
        /// </summary>
        private static void HoldConsoleSignals()
        {
            if (Interlocked.Exchange(ref consoleSignalsHeld, 1) == 1)
            {
                return;
            }
            try
            {
                Console.CancelKeyPress += OnCancelKeyPress;
            }
            catch (Exception)
            {
                // No console, or a host that forbids the handler: the child still receives
                // the signal, and the job object still cleans up on wrapper death.
            }
        }

        private static void OnCancelKeyPress(object sender, ConsoleCancelEventArgs argument)
        {
            argument.Cancel = true;
        }

        private static void AllowStandardHandleInheritance()
        {
            MarkInheritable(NativeMethods.StandardInputHandle);
            MarkInheritable(NativeMethods.StandardOutputHandle);
            MarkInheritable(NativeMethods.StandardErrorHandle);
        }

        private static void MarkInheritable(int standardHandle)
        {
            try
            {
                IntPtr value = NativeMethods.GetStdHandle(standardHandle);
                if (value == IntPtr.Zero || value == NativeMethods.InvalidHandleValue)
                {
                    return;
                }
                NativeMethods.SetHandleInformation(
                    value,
                    NativeMethods.HandleFlagInherit,
                    NativeMethods.HandleFlagInherit
                );
            }
            catch (Exception)
            {
                // A non-inheritable standard handle only means the child gets none.
            }
        }
    }

    internal static class NativeMethods
    {
        internal const uint CreateSuspended = 0x00000004;
        internal const uint Infinite = 0xFFFFFFFF;
        internal const int JobObjectExtendedLimitInformationClass = 9;
        internal const uint JobObjectLimitKillOnJobClose = 0x00002000;
        internal const int StandardInputHandle = -10;
        internal const int StandardOutputHandle = -11;
        internal const int StandardErrorHandle = -12;
        internal const uint HandleFlagInherit = 0x00000001;
        internal static readonly IntPtr InvalidHandleValue = new IntPtr(-1);

        [StructLayout(LayoutKind.Sequential)]
        internal struct StartupInformation
        {
            public int cb;
            public IntPtr lpReserved;
            public IntPtr lpDesktop;
            public IntPtr lpTitle;
            public int dwX;
            public int dwY;
            public int dwXSize;
            public int dwYSize;
            public int dwXCountChars;
            public int dwYCountChars;
            public int dwFillAttribute;
            public int dwFlags;
            public short wShowWindow;
            public short cbReserved2;
            public IntPtr lpReserved2;
            public IntPtr hStdInput;
            public IntPtr hStdOutput;
            public IntPtr hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct ProcessInformation
        {
            public IntPtr ProcessHandle;
            public IntPtr ThreadHandle;
            public int ProcessId;
            public int ThreadId;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct JobObjectBasicLimitInformation
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct IoCounters
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct JobObjectExtendedLimitInformation
        {
            public JobObjectBasicLimitInformation BasicLimitInformation;
            public IoCounters IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern bool CreateProcess(
            string lpApplicationName,
            StringBuilder lpCommandLine,
            IntPtr lpProcessAttributes,
            IntPtr lpThreadAttributes,
            bool bInheritHandles,
            uint dwCreationFlags,
            IntPtr lpEnvironment,
            string lpCurrentDirectory,
            ref StartupInformation lpStartupInfo,
            out ProcessInformation lpProcessInformation
        );

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern uint ResumeThread(IntPtr hThread);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern bool CloseHandle(IntPtr hObject);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern bool SetInformationJobObject(
            IntPtr hJob,
            int jobObjectInformationClass,
            IntPtr lpJobObjectInformation,
            uint cbJobObjectInformationLength
        );

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern IntPtr GetStdHandle(int nStdHandle);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern bool SetHandleInformation(IntPtr hObject, uint dwMask, uint dwFlags);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern bool MoveFileEx(
            string lpExistingFileName,
            string lpNewFileName,
            uint dwFlags
        );

        internal const uint MoveFileReplaceExisting = 0x00000001;
    }
}
