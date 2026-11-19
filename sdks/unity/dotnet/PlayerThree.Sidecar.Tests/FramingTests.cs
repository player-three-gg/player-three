// Copyright 2026 The PlayerThree authors
// SPDX-License-Identifier: Apache-2.0

using System.IO;
using System.Text;
using PlayerThree.Sidecar;
using Xunit;

public class FramingTests
{
    /// <summary>A stream that returns at most <c>chunk</c> bytes per read, to split lines across reads.</summary>
    private sealed class Trickle : MemoryStream
    {
        private readonly int _chunk;
        public Trickle(byte[] bytes, int chunk) : base(bytes) { _chunk = chunk; }
        public override int Read(byte[] buffer, int offset, int count) => base.Read(buffer, offset, System.Math.Min(count, _chunk));
    }

    private static FrameReader Reader(string text, int chunk = int.MaxValue) => new FrameReader(new Trickle(Encoding.UTF8.GetBytes(text), chunk));

    /// <summary>A JSON object line whose UTF-8 JSON text is exactly <paramref name="bytes"/> long.</summary>
    private static string LineOfBytes(int bytes)
    {
        const string head = "{\"op\":\"call\",\"pad\":\"";
        const string tail = "\"}";
        return head + new string('x', bytes - head.Length - tail.Length) + tail;
    }

    [Fact]
    public void ReadsOneMessagePerLineAcrossArbitraryChunks()
    {
        foreach (var chunk in new[] { 1, 3, 7, 4096 })
        {
            var r = Reader("{\"op\":\"ready\",\"surfaceHash\":\"ab\"}\n{\"op\":\"push\",\"kind\":\"±\"}\n", chunk);
            Assert.Equal("ab", r.Read()["surfaceHash"].AsString());
            Assert.Equal("±", r.Read()["kind"].AsString());
            Assert.Null(r.Read());
        }
    }

    [Fact]
    public void AcceptsExactlyTheLimitExcludingTheNewline()
    {
        var line = LineOfBytes(Framing.MaxMessageBytes);
        Assert.Equal(Framing.MaxMessageBytes, Encoding.UTF8.GetByteCount(line));
        var m = Reader(line + "\n", 65536).Read();
        Assert.Equal("call", m["op"].AsString());
    }

    [Fact]
    public void RejectsOneByteOverTheLimit()
    {
        var e = Assert.Throws<SidecarProtocolException>(() => Reader(LineOfBytes(Framing.MaxMessageBytes + 1) + "\n", 65536).Read());
        Assert.Equal("too_large", e.Code);
    }

    [Fact]
    public void RejectsAnOversizedLineBeforeItsNewlineArrives()
    {
        // No terminator at all: the reader must stop at the limit instead of buffering without bound.
        var e = Assert.Throws<SidecarProtocolException>(() => Reader(new string('x', Framing.MaxMessageBytes + 10), 65536).Read());
        Assert.Equal("too_large", e.Code);
    }

    [Theory]
    [InlineData("not json\n")]
    [InlineData("[1,2]\n")]
    [InlineData("{\"op\":\"ready\"}")] // EOF inside a message
    public void RejectsBadFrames(string text) => Assert.Equal("framing", Assert.Throws<SidecarProtocolException>(() => Reader(text).Read()).Code);

    [Fact]
    public void RejectsInvalidUtf8()
    {
        var bytes = new byte[] { (byte)'"', 0xff, (byte)'"', (byte)'\n' };
        Assert.Equal("framing", Assert.Throws<SidecarProtocolException>(() => new FrameReader(new MemoryStream(bytes)).Read()).Code);
    }

    [Fact]
    public void WritesCompactLinesAndRefusesOversizedMessages()
    {
        var ms = new MemoryStream();
        var w = new FrameWriter(ms);
        w.Write(JsonValue.NewObject().Set("op", "result").Set("id", 3).Set("ok", true).Set("data", "a\nb"));
        Assert.Equal("{\"op\":\"result\",\"id\":3,\"ok\":true,\"data\":\"a\\nb\"}\n", Encoding.UTF8.GetString(ms.ToArray()));

        var big = JsonValue.NewObject().Set("pad", new string('x', Framing.MaxMessageBytes));
        Assert.Equal("too_large", Assert.Throws<SidecarProtocolException>(() => w.Write(big)).Code);
        Assert.Equal(Framing.MaxMessageBytes + 1, Framing.Encode(JsonValue.Parse(LineOfBytes(Framing.MaxMessageBytes))).Length);
    }
}
