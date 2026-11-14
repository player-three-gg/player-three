// Copyright 2026 The PlayerThree authors
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Threading;

namespace PlayerThree.Sidecar
{
    /// <summary>
    /// A connected byte channel to the sidecar host. The engine is always the client (SPEC §20.8): it spawns the host
    /// over stdio, or connects to the host's owner-only Unix domain socket or named pipe. Never a network interface.
    /// </summary>
    public abstract class SidecarTransport : IDisposable
    {
        /// <summary>Environment variable a launcher uses to pass the host's socket path to the engine.</summary>
        public const string SocketEnvironmentVariable = "PLAYERTHREE_SIDECAR_SOCKET";

        internal SidecarTransport() { }

        /// <summary>Host → engine bytes; read only by the client's reader thread.</summary>
        internal abstract Stream Input { get; }
        /// <summary>Engine → host bytes.</summary>
        internal abstract Stream Output { get; }

        /// <summary>Stops sending so the host sees end of stream. Never blocks on a pending read of <see cref="Input"/>.</summary>
        internal abstract void Shutdown();
        /// <summary>Forces a pending read of <see cref="Input"/> to return (kill the process, close the socket) when the host does not hang up.</summary>
        internal abstract void Abort();
        /// <summary>Releases what is left once no read is pending.</summary>
        internal abstract void Release();

        private int _disposed;

        /// <summary>Closes and releases the channel (for a transport never handed to <see cref="PlayerThreeSidecar.Start"/>, which otherwise owns it). Idempotent.</summary>
        public void Dispose()
        {
            if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
            Shutdown();
            Abort();
            Release();
        }

        /// <summary>
        /// Spawns the host with stdio as the channel, e.g. <c>Spawn("node", "…/packages/sidecar/bin/playerthree-sidecar.ts", "--stdio")</c>.
        /// Its stderr (host logs) goes to <paramref name="log"/> line by line, or is inherited when <paramref name="log"/> is null.
        /// </summary>
        public static SidecarTransport Spawn(string fileName, IEnumerable<string> arguments, Action<string> log = null, string workingDirectory = null)
        {
            if (fileName == null) throw new ArgumentNullException(nameof(fileName));
            var psi = new ProcessStartInfo
            {
                FileName = fileName,
                Arguments = JoinArguments(arguments ?? Array.Empty<string>()),
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = log != null,
            };
            if (workingDirectory != null) psi.WorkingDirectory = workingDirectory;
            var process = Process.Start(psi) ?? throw new InvalidOperationException($"could not start {fileName}");
            if (log != null)
            {
                var t = new Thread(() =>
                {
                    try
                    {
                        string line;
                        while ((line = process.StandardError.ReadLine()) != null) log(line);
                    }
                    catch (Exception) { /* the process went away; nothing left to forward */ }
                }) { IsBackground = true, Name = "playerthree-sidecar-stderr" };
                t.Start();
            }
            return new ProcessTransport(process);
        }

        /// <summary>
        /// Connects to the host's local socket: a named pipe (<c>\\.\pipe\name</c>) on Windows, otherwise a Unix domain
        /// socket path.
        /// </summary>
        public static SidecarTransport Connect(string path, int timeoutMs = 10000)
        {
            if (string.IsNullOrEmpty(path)) throw new ArgumentException("socket path required", nameof(path));
            const string pipePrefix = @"\\.\pipe\";
            if (path.StartsWith(pipePrefix, StringComparison.OrdinalIgnoreCase))
            {
                // Asynchronous handles let a dispose cancel the reader's pending read instead of blocking on it.
                var pipe = new NamedPipeClientStream(".", path.Substring(pipePrefix.Length), PipeDirection.InOut, PipeOptions.Asynchronous);
                pipe.Connect(timeoutMs);
                return new PipeTransport(pipe);
            }
            if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows) && !File.Exists(path))
                throw new ArgumentException(@"on Windows pass a named pipe path (\\.\pipe\<name>) or an existing AF_UNIX socket file", nameof(path));
            var socket = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified);
            try
            {
                var connect = socket.BeginConnect(new UnixDomainSocketEndPoint(path), null, null);
                if (!connect.AsyncWaitHandle.WaitOne(timeoutMs)) throw new TimeoutException($"sidecar socket {path} did not accept within {timeoutMs} ms");
                socket.EndConnect(connect);
            }
            catch
            {
                socket.Dispose();
                throw;
            }
            return new SocketTransport(socket);
        }

        /// <summary>Connects to the socket named by <see cref="SocketEnvironmentVariable"/>; null when it is unset.</summary>
        public static SidecarTransport FromEnvironment(int timeoutMs = 10000)
        {
            var path = Environment.GetEnvironmentVariable(SocketEnvironmentVariable);
            return string.IsNullOrEmpty(path) ? null : Connect(path, timeoutMs);
        }

        /// <summary>
        /// A channel over existing streams (tests, custom launchers). Closing the connection disposes
        /// <paramref name="output"/>; <paramref name="input"/> is disposed once its reader has returned, so the other end
        /// must close its side for the connection to finish.
        /// </summary>
        public static SidecarTransport FromStreams(Stream input, Stream output) => new StreamTransport(input, output);

        /// <summary>Windows-style command-line quoting, which .NET also uses to split arguments on Unix.</summary>
        internal static string JoinArguments(IEnumerable<string> args)
        {
            var parts = new List<string>();
            foreach (var a in args)
            {
                if (a.Length > 0 && a.IndexOfAny(new[] { ' ', '\t', '"', '\n' }) < 0) { parts.Add(a); continue; }
                var sb = new System.Text.StringBuilder("\"");
                var backslashes = 0;
                foreach (var c in a)
                {
                    if (c == '\\') { backslashes++; continue; }
                    if (c == '"') sb.Append('\\', backslashes * 2 + 1).Append('"');
                    else sb.Append('\\', backslashes).Append(c);
                    backslashes = 0;
                }
                sb.Append('\\', backslashes * 2).Append('"');
                parts.Add(sb.ToString());
            }
            return string.Join(" ", parts);
        }

        private static void Quietly(Action a)
        {
            try { a(); }
            catch (Exception) { /* closing: the peer may already be gone */ }
        }

        private sealed class StreamTransport : SidecarTransport
        {
            private readonly Stream _input, _output;

            internal StreamTransport(Stream input, Stream output)
            {
                _input = input ?? throw new ArgumentNullException(nameof(input));
                _output = output ?? throw new ArgumentNullException(nameof(output));
            }
            internal override Stream Input => _input;
            internal override Stream Output => _output;
            internal override void Shutdown() => Quietly(_output.Dispose);
            internal override void Abort() { } // arbitrary streams offer no portable way to interrupt a read
            internal override void Release() => Quietly(_input.Dispose);
        }

        private sealed class SocketTransport : SidecarTransport
        {
            private readonly Socket _socket;
            private readonly NetworkStream _stream;

            internal SocketTransport(Socket socket)
            {
                _socket = socket;
                _stream = new NetworkStream(socket, true);
            }
            internal override Stream Input => _stream;
            internal override Stream Output => _stream;
            internal override void Shutdown() => Quietly(() => _socket.Shutdown(SocketShutdown.Send));
            internal override void Abort() => Quietly(() => _socket.Shutdown(SocketShutdown.Both));
            internal override void Release() => Quietly(_stream.Dispose);
        }

        private sealed class PipeTransport : SidecarTransport
        {
            private readonly NamedPipeClientStream _pipe;

            internal PipeTransport(NamedPipeClientStream pipe) { _pipe = pipe; }
            internal override Stream Input => _pipe;
            internal override Stream Output => _pipe;
            // A pipe cannot half-close; disposing it is the disconnect and cancels the pending (overlapped) read.
            internal override void Shutdown() => Quietly(_pipe.Dispose);
            internal override void Abort() { }
            internal override void Release() { }
        }

        private sealed class ProcessTransport : SidecarTransport
        {
            private readonly Process _process;

            internal ProcessTransport(Process process) { _process = process; }
            internal override Stream Input => _process.StandardOutput.BaseStream;
            internal override Stream Output => _process.StandardInput.BaseStream;
            // Closing the host's stdin is its disconnect: it disposes every session and exits (SPEC §20.8).
            internal override void Shutdown() => Quietly(_process.StandardInput.Close);
            internal override void Abort() => Quietly(() => { if (!_process.HasExited) _process.Kill(); });

            internal override void Release()
            {
                Quietly(() => { if (!_process.WaitForExit(3000)) _process.Kill(); });
                _process.Dispose();
            }
        }
    }
}
