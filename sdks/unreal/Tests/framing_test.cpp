// Copyright 2026 The PlayerThree authors
// SPDX-License-Identifier: Apache-2.0

// SPEC §20.8 (a) framing: newline-delimited UTF-8 JSON objects, ≤ 1048576 bytes excluding the '\n'.
#include <string>

#include "PlayerThree/Framing.h"
#include "check.h"

using playerthree::DecodeMessage;
using playerthree::EncodeMessage;
using playerthree::FramingError;
using playerthree::Json;
using playerthree::kMaxMessageBytes;
using playerthree::LineDecoder;

namespace {

void FeedString(LineDecoder& decoder, const std::string& bytes) { decoder.Feed(bytes.data(), bytes.size()); }

/** A `{"pad":"xxx…"}` message of exactly `bytes` bytes. */
std::string PaddedLine(std::size_t bytes) {
  const std::string frame = "{\"pad\":\"\"}";
  return "{\"pad\":\"" + std::string(bytes - frame.size(), 'x') + "\"}";
}

}  // namespace

TEST(lines_split_across_any_chunking) {
  const std::string stream = "{\"op\":\"a\"}\n{\"op\":\"b\"}\n{\"op\":\"c\"";
  for (std::size_t chunk = 1; chunk <= stream.size(); ++chunk) {
    LineDecoder decoder;
    std::vector<std::string> lines;
    std::string line;
    for (std::size_t at = 0; at < stream.size(); at += chunk) {
      decoder.Feed(stream.data() + at, std::min(chunk, stream.size() - at));
      while (decoder.Next(line)) lines.push_back(line);
    }
    CHECK_EQ(lines.size(), std::size_t{2});
    CHECK_EQ(lines[0], std::string("{\"op\":\"a\"}"));
    CHECK_EQ(lines[1], std::string("{\"op\":\"b\"}"));
    CHECK_EQ(decoder.Pending(), std::string("{\"op\":\"c\"").size());
  }
}

TEST(many_lines_in_one_chunk_and_empty_feed) {
  LineDecoder decoder;
  decoder.Feed(nullptr, 0);
  FeedString(decoder, "{}\n{}\n{}\n");
  std::string line;
  int n = 0;
  while (decoder.Next(line)) ++n;
  CHECK_EQ(n, 3);
  CHECK(!decoder.Next(line));
}

TEST(limit_excludes_the_newline) {
  const std::string exact = PaddedLine(kMaxMessageBytes);
  CHECK_EQ(exact.size(), kMaxMessageBytes);
  LineDecoder decoder;
  FeedString(decoder, exact + "\n");
  std::string line;
  CHECK(decoder.Next(line));
  CHECK_EQ(line.size(), kMaxMessageBytes);
  CHECK_EQ(DecodeMessage(line)["pad"].get<std::string>().size(), kMaxMessageBytes - 10);
}

TEST(one_byte_over_the_limit_fails) {
  LineDecoder decoder;
  THROWS_IF(FeedString(decoder, PaddedLine(kMaxMessageBytes + 1) + "\n"), FramingError, e.code() == "too_large");
}

TEST(oversized_line_fails_before_its_newline_arrives) {
  // The reader must not buffer an unterminated line without bound.
  LineDecoder decoder(16);
  FeedString(decoder, std::string(16, 'x'));
  THROWS_IF(FeedString(decoder, "y"), FramingError, e.code() == "too_large");
}

TEST(small_limit_counts_each_line_separately) {
  LineDecoder decoder(4);
  FeedString(decoder, "1234\n5678\n12");
  std::string line;
  CHECK(decoder.Next(line) && line == "1234");
  CHECK(decoder.Next(line) && line == "5678");
  FeedString(decoder, "34\n");
  CHECK(decoder.Next(line) && line == "1234");
}

TEST(decode_accepts_objects_only) {
  CHECK_EQ(DecodeMessage("{\"op\":\"call\",\"id\":1}")["id"].get<int>(), 1);
  CHECK(DecodeMessage(" {\"a\":[1,2]} \r").is_object());
  for (const char* bad : {"", "[]", "1", "\"op\"", "null", "{", "{\"a\":1}{", "{\"a\":1} x", "{'a':1}"}) {
    THROWS_IF(DecodeMessage(bad), FramingError, e.code() == "invalid_json");
  }
}

TEST(decode_rejects_invalid_utf8) {
  const std::string lone = std::string("{\"s\":\"") + '\xff' + "\"}";
  THROWS_IF(DecodeMessage(lone), FramingError, e.code() == "invalid_json");
  const std::string overlong = std::string("{\"s\":\"") + '\xc0' + '\xaf' + "\"}";
  THROWS_IF(DecodeMessage(overlong), FramingError, e.code() == "invalid_json");
}

TEST(decode_keeps_utf8_and_escapes) {
  const Json m = DecodeMessage("{\"s\":\"\xc2\xb1\\u00b1\\n\"}");
  CHECK_EQ(m["s"].get<std::string>(), std::string("\xc2\xb1\xc2\xb1\n"));
}

TEST(encode_is_one_compact_line) {
  const Json m{{"op", "result"}, {"id", 3}, {"ok", true}, {"data", {{"text", "a\nb"}, {"rope", -2}}}};
  const std::string line = EncodeMessage(m);
  CHECK_EQ(line, std::string("{\"op\":\"result\",\"id\":3,\"ok\":true,\"data\":{\"text\":\"a\\nb\",\"rope\":-2}}\n"));
  CHECK_EQ(line.find('\n'), line.size() - 1);
  CHECK_EQ(DecodeMessage(line.substr(0, line.size() - 1)), m);
}

TEST(encode_keeps_non_ascii_as_utf8) {
  CHECK_EQ(EncodeMessage(Json{{"doc", "\xc2\xb1"}}), std::string("{\"doc\":\"\xc2\xb1\"}\n"));
}

TEST(encode_limits) {
  CHECK_EQ(EncodeMessage(DecodeMessage(PaddedLine(kMaxMessageBytes))).size(), kMaxMessageBytes + 1);
  THROWS_IF(EncodeMessage(DecodeMessage(PaddedLine(kMaxMessageBytes + 1))), FramingError, e.code() == "too_large");
  THROWS_IF(EncodeMessage(Json{{"s", std::string("\xff")}}), FramingError, e.code() == "invalid_utf8");
}

TEST_MAIN()
