// Copyright 2026 The PlayerThree authors
// SPDX-License-Identifier: Apache-2.0

using System;
using System.IO;
using System.Text;

namespace PlayerThree.Sidecar
{
    /// <summary>
    /// §20.8 framing: newline-delimited UTF-8 JSON, one message per line, each at most
    /// <see cref="MaxMessageBytes"/> bytes (the JSON text, excluding the terminating <c>\n</c>).
    /// </summary>
    public static class Framing
    {
        /// <summary>Largest message, in UTF-8 bytes of JSON text.</summary>
        public const int MaxMessageBytes = 1048576;

        internal static readonly UTF8Encoding StrictUtf8 = new UTF8Encoding(false, true);

        /// <summary>Encodes one message as its framed bytes (JSON + <c>\n</c>); throws <see cref="SidecarProtocolException"/> when too large.</summary>
        public static byte[] Encode(JsonValue message)
        {
            var text = message.ToString();
            var length = StrictUtf8.GetByteCount(text);
            if (length > MaxMessageBytes) throw new SidecarProtocolException("too_large", $"message is {length} bytes; the limit is {MaxMessageBytes}");
            var bytes = new byte[length + 1];
            StrictUtf8.GetBytes(text, 0, text.Length, bytes, 0);
            bytes[length] = (byte)'\n';
            return bytes;
        }
    }

    /// <summary>Reads framed messages from a byte stream. Not thread-safe: one reader thread owns it.</summary>
    public sealed class FrameReader
    {
        private readonly Stream _stream;
        private readonly byte[] _buffer = new byte[64 * 1024];
        private int _start;
        private int _end;
        // Bytes of the current, still unterminated line; grows up to MaxMessageBytes only when a line spans reads.
        private readonly MemoryStream _line = new MemoryStream();

        /// <summary>Reads from <paramref name="stream"/>.</summary>
        public FrameReader(Stream stream) { _stream = stream ?? throw new ArgumentNullException(nameof(stream)); }

        /// <summary>
        /// The next message, or <c>null</c> at a clean end of stream (no partial line). Throws
        /// <see cref="SidecarProtocolException"/> for an oversized line, invalid UTF-8, invalid JSON, a non-object
        /// message, or a stream that ends mid-line.
        /// </summary>
        public JsonValue Read()
        {
            while (true)
            {
                if (_start == _end)
                {
                    _start = 0;
                    _end = _stream.Read(_buffer, 0, _buffer.Length);
                    if (_end <= 0)
                    {
                        _end = 0;
                        if (_line.Length == 0) return null;
                        throw new SidecarProtocolException("framing", "stream ended inside a message");
                    }
                }
                var nl = Array.IndexOf(_buffer, (byte)'\n', _start, _end - _start);
                var take = (nl < 0 ? _end : nl) - _start;
                if (_line.Length + take > Framing.MaxMessageBytes) throw new SidecarProtocolException("too_large", $"incoming message exceeds {Framing.MaxMessageBytes} bytes");
                if (nl < 0)
                {
                    _line.Write(_buffer, _start, take);
                    _start = _end;
                    continue;
                }
                string text;
                if (_line.Length == 0) text = Decode(_buffer, _start, take);
                else
                {
                    _line.Write(_buffer, _start, take);
                    text = Decode(_line.GetBuffer(), 0, (int)_line.Length);
                    _line.SetLength(0);
                }
                _start = nl + 1;
                JsonValue message;
                try { message = JsonValue.Parse(text); }
                catch (FormatException e) { throw new SidecarProtocolException("framing", e.Message); }
                if (message.Kind != JsonKind.Object) throw new SidecarProtocolException("framing", "a message must be a JSON object");
                return message;
            }
        }

        private static string Decode(byte[] bytes, int offset, int count)
        {
            try { return Framing.StrictUtf8.GetString(bytes, offset, count); }
            catch (DecoderFallbackException) { throw new SidecarProtocolException("framing", "message is not valid UTF-8"); }
        }
    }

    /// <summary>Writes framed messages; safe to call from any thread (one whole line per write).</summary>
    public sealed class FrameWriter
    {
        private readonly Stream _stream;
        private readonly object _gate = new object();

        /// <summary>Writes to <paramref name="stream"/>.</summary>
        public FrameWriter(Stream stream) { _stream = stream ?? throw new ArgumentNullException(nameof(stream)); }

        /// <summary>Writes and flushes one message.</summary>
        public void Write(JsonValue message)
        {
            var bytes = Framing.Encode(message);
            lock (_gate)
            {
                _stream.Write(bytes, 0, bytes.Length);
                _stream.Flush();
            }
        }
    }

    /// <summary>The peer broke the §20.8 framing or message contract, or a message exceeded the size limit.</summary>
    public sealed class SidecarProtocolException : Exception
    {
        /// <summary>Closed reason: <c>framing</c>, <c>too_large</c> or <c>protocol</c>.</summary>
        public string Code { get; }

        /// <summary>A protocol failure with its closed reason.</summary>
        public SidecarProtocolException(string code, string message) : base(message) { Code = code; }
    }
}
