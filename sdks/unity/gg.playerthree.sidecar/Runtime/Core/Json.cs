// Copyright 2026 The PlayerThree authors
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace PlayerThree.Sidecar
{
    /// <summary>The JSON value kinds.</summary>
    public enum JsonKind { Null, Bool, Number, String, Array, Object }

    /// <summary>
    /// A small immutable-by-convention JSON value: the wire is plain JSON (§20.8), and the core must not depend on a
    /// JSON package so it drops into Unity (no System.Text.Json) and plain .NET alike. Objects keep insertion order so
    /// manifests serialize in the order they were authored (section order and enum order are meaningful).
    /// </summary>
    public sealed class JsonValue
    {
        /// <summary>The JSON <c>null</c> value.</summary>
        public static readonly JsonValue Null = new JsonValue(JsonKind.Null);
        /// <summary>The JSON <c>true</c> value.</summary>
        public static readonly JsonValue True = new JsonValue(JsonKind.Bool) { _bool = true };
        /// <summary>The JSON <c>false</c> value.</summary>
        public static readonly JsonValue False = new JsonValue(JsonKind.Bool);

        /// <summary>Largest integer a JSON number carries exactly (JavaScript's safe integer bound, 2^53 − 1).</summary>
        public const long MaxSafeInteger = 9007199254740991L;

        private bool _bool;
        private double _number;
        private string _string;
        private List<JsonValue> _items;
        private List<KeyValuePair<string, JsonValue>> _props;
        private Dictionary<string, int> _index;

        /// <summary>This value's kind.</summary>
        public JsonKind Kind { get; }

        private JsonValue(JsonKind kind) { Kind = kind; }

        /// <summary>A boolean.</summary>
        public static JsonValue From(bool value) => value ? True : False;
        /// <summary>A number; NaN and infinities have no JSON form and throw.</summary>
        public static JsonValue From(double value)
        {
            if (double.IsNaN(value) || double.IsInfinity(value)) throw new ArgumentException("JSON numbers must be finite", nameof(value));
            return new JsonValue(JsonKind.Number) { _number = value };
        }
        /// <summary>An integer; it must fit a JSON number exactly (|value| ≤ 2^53 − 1).</summary>
        public static JsonValue From(long value)
        {
            if (value > MaxSafeInteger || value < -MaxSafeInteger) throw new ArgumentOutOfRangeException(nameof(value), "integer beyond 2^53 - 1 cannot round-trip through JSON");
            return new JsonValue(JsonKind.Number) { _number = value };
        }
        /// <summary>A string; <c>null</c> becomes JSON null.</summary>
        public static JsonValue From(string value) => value == null ? Null : new JsonValue(JsonKind.String) { _string = value };

        /// <summary>A new, empty JSON array.</summary>
        public static JsonValue NewArray() => new JsonValue(JsonKind.Array) { _items = new List<JsonValue>() };
        /// <summary>A JSON array of the given items (null items become JSON null).</summary>
        public static JsonValue NewArray(IEnumerable<JsonValue> items)
        {
            var a = NewArray();
            foreach (var item in items) a._items.Add(item ?? Null);
            return a;
        }
        /// <summary>A JSON array of the given items.</summary>
        public static JsonValue ArrayOf(params JsonValue[] items) => NewArray(items);
        /// <summary>A JSON array of strings.</summary>
        public static JsonValue Strings(IEnumerable<string> items)
        {
            var a = NewArray();
            foreach (var s in items) a._items.Add(From(s));
            return a;
        }
        /// <summary>A new, empty JSON object.</summary>
        public static JsonValue NewObject() => new JsonValue(JsonKind.Object) { _props = new List<KeyValuePair<string, JsonValue>>(), _index = new Dictionary<string, int>(StringComparer.Ordinal) };

        public static implicit operator JsonValue(bool value) => From(value);
        public static implicit operator JsonValue(int value) => From((long)value);
        public static implicit operator JsonValue(long value) => From(value);
        public static implicit operator JsonValue(double value) => From(value);
        public static implicit operator JsonValue(string value) => From(value);

        /// <summary>True for JSON null.</summary>
        public bool IsNull => Kind == JsonKind.Null;

        /// <summary>The boolean; throws for other kinds.</summary>
        public bool AsBool() => Kind == JsonKind.Bool ? _bool : throw Mismatch(JsonKind.Bool);
        /// <summary>The number; throws for other kinds.</summary>
        public double AsDouble() => Kind == JsonKind.Number ? _number : throw Mismatch(JsonKind.Number);
        /// <summary>The number as an exact integer; throws when it is not integral or beyond 2^53 − 1.</summary>
        public long AsLong()
        {
            var d = AsDouble();
            if (Math.Floor(d) != d || d > MaxSafeInteger || d < -MaxSafeInteger) throw new FormatException("JSON number is not a safe integer");
            return (long)d;
        }
        /// <summary>The number as an exact 32-bit integer.</summary>
        public int AsInt()
        {
            var l = AsLong();
            if (l > int.MaxValue || l < int.MinValue) throw new FormatException("JSON number does not fit a 32-bit integer");
            return (int)l;
        }
        /// <summary>The string; throws for other kinds.</summary>
        public string AsString() => Kind == JsonKind.String ? _string : throw Mismatch(JsonKind.String);

        /// <summary>Array length or object member count; 0 otherwise.</summary>
        public int Count => Kind == JsonKind.Array ? _items.Count : Kind == JsonKind.Object ? _props.Count : 0;

        /// <summary>Array items (throws for other kinds).</summary>
        public IReadOnlyList<JsonValue> Items => Kind == JsonKind.Array ? _items : throw Mismatch(JsonKind.Array);
        /// <summary>Object members in insertion order (throws for other kinds).</summary>
        public IReadOnlyList<KeyValuePair<string, JsonValue>> Properties => Kind == JsonKind.Object ? _props : throw Mismatch(JsonKind.Object);

        /// <summary>Array item by index.</summary>
        public JsonValue this[int index] => Items[index];

        /// <summary>Object member by name, or <c>null</c> (C# null, not JSON null) when absent or not an object.</summary>
        public JsonValue this[string key] => Kind == JsonKind.Object && _index.TryGetValue(key, out var i) ? _props[i].Value : null;

        /// <summary>Object member lookup.</summary>
        public bool TryGet(string key, out JsonValue value)
        {
            value = this[key];
            return value != null;
        }

        /// <summary>True when this object has the member.</summary>
        public bool Has(string key) => this[key] != null;

        /// <summary>Sets (or replaces in place) an object member and returns this object for chaining.</summary>
        public JsonValue Set(string key, JsonValue value)
        {
            if (Kind != JsonKind.Object) throw Mismatch(JsonKind.Object);
            if (key == null) throw new ArgumentNullException(nameof(key));
            value = value ?? Null;
            if (_index.TryGetValue(key, out var i)) _props[i] = new KeyValuePair<string, JsonValue>(key, value);
            else
            {
                _index[key] = _props.Count;
                _props.Add(new KeyValuePair<string, JsonValue>(key, value));
            }
            return this;
        }

        /// <summary>Appends an array item and returns this array for chaining.</summary>
        public JsonValue Add(JsonValue value)
        {
            if (Kind != JsonKind.Array) throw Mismatch(JsonKind.Array);
            _items.Add(value ?? Null);
            return this;
        }

        private InvalidOperationException Mismatch(JsonKind want) => new InvalidOperationException($"JSON value is {Kind}, not {want}");

        /// <summary>Compact JSON text: no whitespace and every control character escaped, so it never contains a newline.</summary>
        public override string ToString()
        {
            var sb = new StringBuilder();
            Write(sb);
            return sb.ToString();
        }

        /// <summary>Structural equality (object member order ignored, numbers compared by value).</summary>
        public bool DeepEquals(JsonValue other)
        {
            if (other == null || other.Kind != Kind) return false;
            switch (Kind)
            {
                case JsonKind.Null: return true;
                case JsonKind.Bool: return _bool == other._bool;
                case JsonKind.Number: return _number == other._number;
                case JsonKind.String: return string.Equals(_string, other._string, StringComparison.Ordinal);
                case JsonKind.Array:
                    if (_items.Count != other._items.Count) return false;
                    for (var i = 0; i < _items.Count; i++) if (!_items[i].DeepEquals(other._items[i])) return false;
                    return true;
                default:
                    if (_props.Count != other._props.Count) return false;
                    foreach (var p in _props)
                    {
                        var o = other[p.Key];
                        if (o == null || !p.Value.DeepEquals(o)) return false;
                    }
                    return true;
            }
        }

        /// <summary>A deep copy (manifest builders hand out copies so later edits cannot change a built manifest).</summary>
        public JsonValue Clone()
        {
            switch (Kind)
            {
                case JsonKind.Array:
                    var a = NewArray();
                    foreach (var item in _items) a._items.Add(item.Clone());
                    return a;
                case JsonKind.Object:
                    var o = NewObject();
                    foreach (var p in _props) o.Set(p.Key, p.Value.Clone());
                    return o;
                default:
                    return this; // scalars are never mutated
            }
        }

        internal void Write(StringBuilder sb)
        {
            switch (Kind)
            {
                case JsonKind.Null: sb.Append("null"); break;
                case JsonKind.Bool: sb.Append(_bool ? "true" : "false"); break;
                case JsonKind.Number: WriteNumber(sb, _number); break;
                case JsonKind.String: WriteString(sb, _string); break;
                case JsonKind.Array:
                    sb.Append('[');
                    for (var i = 0; i < _items.Count; i++)
                    {
                        if (i > 0) sb.Append(',');
                        _items[i].Write(sb);
                    }
                    sb.Append(']');
                    break;
                default:
                    sb.Append('{');
                    for (var i = 0; i < _props.Count; i++)
                    {
                        if (i > 0) sb.Append(',');
                        WriteString(sb, _props[i].Key);
                        sb.Append(':');
                        _props[i].Value.Write(sb);
                    }
                    sb.Append('}');
                    break;
            }
        }

        private static void WriteNumber(StringBuilder sb, double d)
        {
            // Integral values within the safe range print as integers, exactly as JavaScript's JSON.stringify does.
            if (Math.Floor(d) == d && Math.Abs(d) <= MaxSafeInteger)
            {
                sb.Append(((long)d).ToString(CultureInfo.InvariantCulture));
                return;
            }
            // Round-trip digits, with the exponent spelled as JavaScript does ("1e+21", "1.5e-7", not "1E+21", "1.5E-07").
            var r = d.ToString("R", CultureInfo.InvariantCulture);
            var e = r.IndexOf('E');
            if (e < 0) { sb.Append(r); return; }
            var exp = int.Parse(r.Substring(e + 1), NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture);
            sb.Append(r, 0, e).Append('e').Append(exp < 0 ? '-' : '+').Append(Math.Abs(exp).ToString(CultureInfo.InvariantCulture));
        }

        private static void WriteString(StringBuilder sb, string s)
        {
            sb.Append('"');
            foreach (var c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    case '\b': sb.Append("\\b"); break;
                    case '\f': sb.Append("\\f"); break;
                    default:
                        // U+2028/2029 are line terminators for some readers; escaping them keeps one message per line.
                        if (c < 0x20 || c == '\u2028' || c == '\u2029') sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
        }

        /// <summary>Parses one complete JSON text (RFC 8259). Throws <see cref="FormatException"/> on anything else.</summary>
        public static JsonValue Parse(string text) => new JsonParser(text).ParseDocument();
    }

    /// <summary>Strict recursive-descent JSON parser with a nesting bound.</summary>
    internal struct JsonParser
    {
        /// <summary>Deepest nesting accepted; bounds recursion on untrusted input.</summary>
        internal const int MaxDepth = 128;

        private readonly string _s;
        private int _i;

        internal JsonParser(string text)
        {
            _s = text ?? throw new ArgumentNullException(nameof(text));
            _i = 0;
        }

        internal JsonValue ParseDocument()
        {
            SkipWs();
            var v = ParseValue(0);
            SkipWs();
            if (_i != _s.Length) throw Error("trailing characters");
            return v;
        }

        private FormatException Error(string why) => new FormatException($"invalid JSON at {_i}: {why}");

        private void SkipWs()
        {
            while (_i < _s.Length)
            {
                var c = _s[_i];
                if (c == ' ' || c == '\t' || c == '\n' || c == '\r') _i++;
                else break;
            }
        }

        private JsonValue ParseValue(int depth)
        {
            if (depth > MaxDepth) throw Error("nesting too deep");
            if (_i >= _s.Length) throw Error("unexpected end");
            var c = _s[_i];
            switch (c)
            {
                case '{': return ParseObject(depth);
                case '[': return ParseArray(depth);
                case '"': return JsonValue.From(ParseString());
                case 't': Expect("true"); return JsonValue.True;
                case 'f': Expect("false"); return JsonValue.False;
                case 'n': Expect("null"); return JsonValue.Null;
                default:
                    if (c == '-' || (c >= '0' && c <= '9')) return ParseNumber();
                    throw Error("unexpected character");
            }
        }

        private void Expect(string word)
        {
            if (string.CompareOrdinal(_s, _i, word, 0, word.Length) != 0) throw Error("bad literal");
            _i += word.Length;
        }

        private JsonValue ParseObject(int depth)
        {
            _i++;
            var o = JsonValue.NewObject();
            SkipWs();
            if (_i < _s.Length && _s[_i] == '}') { _i++; return o; }
            while (true)
            {
                SkipWs();
                if (_i >= _s.Length || _s[_i] != '"') throw Error("expected member name");
                var key = ParseString();
                if (o.Has(key)) throw Error("duplicate member name");
                SkipWs();
                if (_i >= _s.Length || _s[_i] != ':') throw Error("expected ':'");
                _i++;
                SkipWs();
                o.Set(key, ParseValue(depth + 1));
                SkipWs();
                if (_i >= _s.Length) throw Error("unexpected end");
                if (_s[_i] == ',') { _i++; continue; }
                if (_s[_i] == '}') { _i++; return o; }
                throw Error("expected ',' or '}'");
            }
        }

        private JsonValue ParseArray(int depth)
        {
            _i++;
            var a = JsonValue.NewArray();
            SkipWs();
            if (_i < _s.Length && _s[_i] == ']') { _i++; return a; }
            while (true)
            {
                SkipWs();
                a.Add(ParseValue(depth + 1));
                SkipWs();
                if (_i >= _s.Length) throw Error("unexpected end");
                if (_s[_i] == ',') { _i++; continue; }
                if (_s[_i] == ']') { _i++; return a; }
                throw Error("expected ',' or ']'");
            }
        }

        private string ParseString()
        {
            _i++; // opening quote
            StringBuilder sb = null;
            var start = _i;
            while (true)
            {
                if (_i >= _s.Length) throw Error("unterminated string");
                var c = _s[_i];
                if (c == '"')
                {
                    var tail = _s.Substring(start, _i - start);
                    _i++;
                    return sb == null ? tail : sb.Append(tail).ToString();
                }
                if (c < 0x20) throw Error("control character in string");
                if (c != '\\') { _i++; continue; }
                sb = sb ?? new StringBuilder();
                sb.Append(_s, start, _i - start);
                _i++;
                if (_i >= _s.Length) throw Error("unterminated escape");
                var e = _s[_i++];
                switch (e)
                {
                    case '"': sb.Append('"'); break;
                    case '\\': sb.Append('\\'); break;
                    case '/': sb.Append('/'); break;
                    case 'b': sb.Append('\b'); break;
                    case 'f': sb.Append('\f'); break;
                    case 'n': sb.Append('\n'); break;
                    case 'r': sb.Append('\r'); break;
                    case 't': sb.Append('\t'); break;
                    case 'u':
                        if (_i + 4 > _s.Length) throw Error("short unicode escape");
                        if (!int.TryParse(_s.Substring(_i, 4), NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out var code)) throw Error("bad unicode escape");
                        sb.Append((char)code);
                        _i += 4;
                        break;
                    default: throw Error("bad escape");
                }
                start = _i;
            }
        }

        private JsonValue ParseNumber()
        {
            var start = _i;
            if (_s[_i] == '-') _i++;
            if (_i >= _s.Length) throw Error("bad number");
            if (_s[_i] == '0') _i++;
            else if (_s[_i] >= '1' && _s[_i] <= '9') while (_i < _s.Length && _s[_i] >= '0' && _s[_i] <= '9') _i++;
            else throw Error("bad number");
            if (_i < _s.Length && _s[_i] == '.')
            {
                _i++;
                var digits = _i;
                while (_i < _s.Length && _s[_i] >= '0' && _s[_i] <= '9') _i++;
                if (_i == digits) throw Error("bad fraction");
            }
            if (_i < _s.Length && (_s[_i] == 'e' || _s[_i] == 'E'))
            {
                _i++;
                if (_i < _s.Length && (_s[_i] == '+' || _s[_i] == '-')) _i++;
                var digits = _i;
                while (_i < _s.Length && _s[_i] >= '0' && _s[_i] <= '9') _i++;
                if (_i == digits) throw Error("bad exponent");
            }
            var d = double.Parse(_s.Substring(start, _i - start), NumberStyles.Float, CultureInfo.InvariantCulture);
            if (double.IsInfinity(d)) throw Error("number out of range");
            return JsonValue.From(d);
        }
    }
}
