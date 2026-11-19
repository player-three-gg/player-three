// Copyright 2026 The PlayerThree authors
// SPDX-License-Identifier: Apache-2.0

using System;
using PlayerThree.Sidecar;
using Xunit;

public class JsonTests
{
    [Theory]
    [InlineData("null")]
    [InlineData("true")]
    [InlineData("[1,-2,0.5,1e+21,\"x\"]")]
    [InlineData("{\"a\":{\"b\":[]},\"c\":\"\\u0000\\n\\\"\\\\\"}")]
    public void RoundTripsCompactJson(string text) => Assert.Equal(text, JsonValue.Parse(text).ToString());

    [Fact]
    public void PrintsIntegersLikeJavaScript()
    {
        Assert.Equal("[100000,-10,0,4.25]", JsonValue.ArrayOf(100000, -10, 0.0, 4.25).ToString());
        Assert.Equal("9007199254740991", JsonValue.From(JsonValue.MaxSafeInteger).ToString());
        Assert.Throws<ArgumentOutOfRangeException>(() => JsonValue.From(JsonValue.MaxSafeInteger + 1));
        Assert.Throws<ArgumentException>(() => JsonValue.From(double.NaN));
    }

    [Fact]
    public void EscapesEveryLineBreakSoAMessageStaysOneLine()
    {
        var s = JsonValue.From("a\nb\rc\u2028d\u2029e\u0001").ToString();
        Assert.Equal("\"a\\nb\\rc\\u2028d\\u2029e\\u0001\"", s);
        Assert.Equal("a\nb\rc\u2028d\u2029e\u0001", JsonValue.Parse(s).AsString());
    }

    [Fact]
    public void DecodesUnicodeEscapesAndSurrogatePairs()
    {
        Assert.Equal("±😀", JsonValue.Parse("\"\\u00b1\\ud83d\\ude00\"").AsString());
        Assert.Equal("±😀", JsonValue.Parse("\"±😀\"").AsString());
    }

    [Theory]
    [InlineData("")]
    [InlineData("{} x")]
    [InlineData("{\"a\":1,\"a\":2}")]
    [InlineData("[1,]")]
    [InlineData("01")]
    [InlineData("1.")]
    [InlineData("\"\n\"")]
    [InlineData("'x'")]
    [InlineData("NaN")]
    [InlineData("1e999")]
    public void RejectsInvalidJson(string text) => Assert.Throws<FormatException>(() => JsonValue.Parse(text));

    [Fact]
    public void BoundsNesting()
    {
        var ok = new string('[', 129) + new string(']', 129);
        Assert.Equal(JsonKind.Array, JsonValue.Parse(ok).Kind);
        var deep = new string('[', 130) + new string(']', 130);
        Assert.Throws<FormatException>(() => JsonValue.Parse(deep));
    }

    [Fact]
    public void ObjectsKeepInsertionOrderAndReplaceInPlace()
    {
        var o = JsonValue.NewObject().Set("b", 1).Set("a", 2).Set("b", 3);
        Assert.Equal("{\"b\":3,\"a\":2}", o.ToString());
        Assert.True(o.DeepEquals(JsonValue.Parse("{\"a\":2,\"b\":3}")));
        Assert.Null(o["missing"]);
    }

    [Fact]
    public void AccessorsCheckKindsAndIntegers()
    {
        var v = JsonValue.Parse("{\"i\":3,\"f\":3.5,\"s\":\"x\"}");
        Assert.Equal(3, v["i"].AsInt());
        Assert.Throws<FormatException>(() => v["f"].AsInt());
        Assert.Throws<InvalidOperationException>(() => v["s"].AsInt());
    }
}
