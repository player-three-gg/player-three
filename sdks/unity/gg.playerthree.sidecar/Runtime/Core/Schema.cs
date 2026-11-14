// Copyright 2026 The PlayerThree authors
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;

namespace PlayerThree.Sidecar
{
    /// <summary>
    /// One node of the closed schema vocabulary (SPEC §3), as the same plain JSON the TypeScript <c>t.*</c> builders
    /// produce (<c>{"t":"int","min":0,"max":9}</c> …). Build nodes with <see cref="T"/>; each validates its own bounds
    /// so an unsafe schema fails where it is written. The host re-validates the whole manifest at <c>hello</c>.
    /// </summary>
    public sealed class Schema
    {
        private readonly JsonValue _node;

        internal Schema(JsonValue node) { _node = node; }

        /// <summary>The node type: <c>enum</c>, <c>id</c>, <c>str</c>, <c>ints</c>, <c>int</c>, <c>num</c>, <c>bool</c>, <c>list</c>, <c>obj</c>, <c>opt</c> or <c>union</c>.</summary>
        public string Type => _node["t"].AsString();

        /// <summary>A copy of the node's plain JSON.</summary>
        public JsonValue ToJson() => _node.Clone();

        /// <summary>A copy of this node with developer documentation attached (not valid on <c>opt</c>).</summary>
        public Schema Doc(string doc)
        {
            if (Type == "opt") throw new ArgumentException("playerthree/schema: document the optional field's item, not t.opt");
            T.CheckDoc(doc);
            return new Schema(_node.Clone().Set("doc", doc));
        }

        /// <summary>The node's JSON text.</summary>
        public override string ToString() => _node.ToString();

        internal JsonValue Node => _node;
    }

    /// <summary>Schema node constructors mirroring the TypeScript <c>t</c> builders and their bound checks.</summary>
    public static class T
    {
        private static readonly Regex EnumLiteral = new Regex("^[A-Za-z][A-Za-z0-9_.<>]{0,47}$", RegexOptions.CultureInvariant);
        private static readonly Regex IdPrefix = new Regex("^[a-z]{1,8}$", RegexOptions.CultureInvariant);
        private static readonly Regex FieldName = new Regex("^[A-Za-z_][A-Za-z0-9_]{0,47}$", RegexOptions.CultureInvariant);
        private const int MaxStringLength = 100000;
        private const int MaxDocLength = 4000;

        /// <summary>Closed enum of string literals (non-empty, unique, each matching <c>^[A-Za-z][A-Za-z0-9_.&lt;&gt;]{0,47}$</c>).</summary>
        public static Schema Enum(params string[] values) => Enum(values, null);

        /// <summary>Closed enum with documentation.</summary>
        public static Schema Enum(IReadOnlyList<string> values, string doc)
        {
            if (values == null || values.Count == 0) throw Fail("enum needs at least one literal");
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var v in values)
            {
                if (v == null || !EnumLiteral.IsMatch(v)) throw Fail($"enum literal must match {EnumLiteral}: {v}");
                if (!seen.Add(v)) throw Fail("duplicate enum literal");
            }
            CheckDoc(doc);
            return WithDoc(Node("enum", null).Set("values", JsonValue.Strings(values)), doc).Wrap();
        }

        /// <summary>Opaque entity id with a lowercase prefix of 1–8 letters.</summary>
        public static Schema Id(string prefix, string doc = null)
        {
            if (prefix == null || !IdPrefix.IsMatch(prefix)) throw Fail($"id prefix must match {IdPrefix}");
            CheckDoc(doc);
            return WithDoc(Node("id", null).Set("prefix", prefix), doc).Wrap();
        }

        /// <summary>
        /// Trusted, bounded text (0..100000 Unicode code points) with an optional anchored pattern. Its provenance must
        /// exclude third-party player text. The host checks the pattern against the linear-time regex subset.
        /// </summary>
        public static Schema Str(int maxLength, string pattern = null, string doc = null)
        {
            if (maxLength < 0 || maxLength > MaxStringLength) throw Fail("bad string maxLength (0..100000 Unicode code points)");
            if (pattern != null && (pattern.Length < 2 || pattern.Length > 256 || pattern[0] != '^' || pattern[pattern.Length - 1] != '$'))
                throw Fail("pattern must use the bounded anchored safe regex subset");
            CheckDoc(doc);
            var n = Node("str", null).Set("maxLength", maxLength);
            if (pattern != null) n.Set("pattern", pattern);
            return WithDoc(n, doc).Wrap();
        }

        /// <summary>Flat bounded integer array.</summary>
        public static Schema Ints(int maxItems, long min, long max, string doc = null)
        {
            if (maxItems < 0) throw Fail("bad ints maxItems");
            CheckSafeRange(min, max, "bad ints range");
            CheckDoc(doc);
            return WithDoc(Node("ints", null).Set("maxItems", maxItems).Set("min", min).Set("max", max), doc).Wrap();
        }

        /// <summary>Bounded integer.</summary>
        public static Schema Int(long min, long max, string doc = null)
        {
            CheckSafeRange(min, max, "bad int range");
            return WithDoc(Node("int", null).Set("min", min).Set("max", max), doc).Wrap();
        }

        /// <summary>Bounded finite number.</summary>
        public static Schema Num(double min, double max, string doc = null)
        {
            if (double.IsNaN(min) || double.IsInfinity(min) || double.IsNaN(max) || double.IsInfinity(max) || min > max) throw Fail("bad num range");
            return WithDoc(Node("num", null).Set("min", min).Set("max", max), doc).Wrap();
        }

        /// <summary>Boolean.</summary>
        public static Schema Bool(string doc = null) => Node("bool", doc).Wrap();

        /// <summary>List of at most <paramref name="max"/> items.</summary>
        public static Schema List(Schema item, int max, string doc = null)
        {
            if (item == null) throw new ArgumentNullException(nameof(item));
            if (max < 0) throw Fail("bad list max");
            NotOpt(item, "list item");
            return WithDoc(Node("list", null).Set("item", item.ToJson()).Set("max", max), doc).Wrap();
        }

        /// <summary>Closed object; fields keep the given order. Mark optional fields with <see cref="Opt"/>.</summary>
        public static Schema Obj(params (string name, Schema schema)[] fields) => Node("obj", null).Set("fields", Fields(fields)).Wrap();

        /// <summary>
        /// Closed object whose layered match options replace it atomically (<c>merge:"replace"</c>) instead of merging
        /// member by member.
        /// </summary>
        public static Schema ObjReplace(params (string name, Schema schema)[] fields) => Node("obj", null).Set("fields", Fields(fields)).Set("merge", "replace").Wrap();

        /// <summary>Optional-field marker; only valid directly inside <see cref="Obj"/> or a <see cref="Union"/> variant.</summary>
        public static Schema Opt(Schema item)
        {
            if (item == null) throw new ArgumentNullException(nameof(item));
            NotOpt(item, "t.opt item");
            return new Schema(JsonValue.NewObject().Set("t", "opt").Set("item", item.ToJson()));
        }

        /// <summary>Tagged union: <paramref name="tag"/> names the discriminating field, each variant lists its other fields.</summary>
        public static Schema Union(string tag, params (string variant, (string name, Schema schema)[] fields)[] variants)
        {
            if (tag == null || !FieldName.IsMatch(tag)) throw Fail("invalid union tag");
            if (variants == null || variants.Length == 0) throw Fail("union needs variants");
            var v = JsonValue.NewObject();
            foreach (var (name, fields) in variants)
            {
                if (name == null || !EnumLiteral.IsMatch(name)) throw Fail($"union variant must match {EnumLiteral}: {name}");
                if (v.Has(name)) throw Fail("duplicate union variant");
                foreach (var f in fields ?? Array.Empty<(string, Schema)>()) if (f.name == tag) throw Fail("variant fields must not redeclare the tag");
                v.Set(name, Fields(fields ?? Array.Empty<(string, Schema)>()));
            }
            return Node("union", null).Set("tag", tag).Set("variants", v).Wrap();
        }

        /// <summary>Validated plain-JSON fields object (shared by obj, union variants and intent params).</summary>
        internal static JsonValue Fields((string name, Schema schema)[] fields)
        {
            var o = JsonValue.NewObject();
            foreach (var (name, schema) in fields ?? Array.Empty<(string, Schema)>())
            {
                if (name == null || !FieldName.IsMatch(name)) throw Fail($"invalid field name {name}");
                if (schema == null) throw new ArgumentNullException(nameof(fields), $"field {name} has no schema");
                if (o.Has(name)) throw Fail($"duplicate field {name}");
                o.Set(name, schema.ToJson());
            }
            return o;
        }

        internal static void CheckDoc(string doc)
        {
            if (doc != null && doc.Length > MaxDocLength) throw Fail("doc must be at most 4000 UTF-16 code units");
        }

        internal static bool IsEnumLiteral(string s) => s != null && EnumLiteral.IsMatch(s);

        private static void CheckSafeRange(long min, long max, string why)
        {
            if (min < -JsonValue.MaxSafeInteger || max > JsonValue.MaxSafeInteger || min > max) throw Fail(why);
        }

        private static void NotOpt(Schema s, string what)
        {
            if (s.Type == "opt") throw Fail($"{what} cannot be t.opt (only fields are optional)");
        }

        private static JsonValue Node(string t, string doc)
        {
            CheckDoc(doc);
            return WithDoc(JsonValue.NewObject().Set("t", t), doc);
        }

        private static JsonValue WithDoc(JsonValue node, string doc) => doc == null ? node : node.Set("doc", doc);

        private static Schema Wrap(this JsonValue node) => new Schema(node);

        private static ArgumentException Fail(string why) => new ArgumentException("playerthree/schema: " + why);
    }
}
