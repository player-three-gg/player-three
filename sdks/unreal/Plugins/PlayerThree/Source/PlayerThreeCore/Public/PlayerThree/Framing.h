// Copyright 2026 The PlayerThree authors
// SPDX-License-Identifier: Apache-2.0

// SPEC §20.8 (a) framing: newline-delimited UTF-8 JSON, one message (a JSON object) per line, at most
// kMaxMessageBytes bytes per message, not counting the terminating '\n'.
#pragma once

#include <cstddef>
#include <deque>
#include <stdexcept>
#include <string>
#include <string_view>

#include "PlayerThree/Json.h"

namespace playerthree {

/** Largest message on the sidecar channel in UTF-8 bytes, excluding its '\n' terminator. */
inline constexpr std::size_t kMaxMessageBytes = 1048576;

/** A framing violation. `code` is `too_large`, `invalid_json` or `invalid_utf8`. */
class P3_API FramingError : public std::runtime_error {
 public:
  FramingError(std::string code, const std::string& what) : std::runtime_error(what), code_(std::move(code)) {}
  const std::string& code() const noexcept { return code_; }

 private:
  std::string code_;
};

/**
 * Splits an inbound byte stream into lines. Bytes may arrive in any chunking; a line is complete at '\n'. A line
 * longer than the limit fails as soon as it is known to be too long, so a peer cannot make the reader buffer without
 * bound. After a FramingError the decoder is unusable: the stream has lost sync and the connection must close.
 */
class P3_API LineDecoder {
 public:
  explicit LineDecoder(std::size_t maxBytes = kMaxMessageBytes) : max_(maxBytes) {}

  /** Appends bytes; throws FramingError(`too_large`) when an unterminated or complete line exceeds the limit. */
  void Feed(const char* data, std::size_t size);
  /** Pops the next complete line without its '\n' into `line`; false when none is complete yet. */
  bool Next(std::string& line);
  /** Bytes of the current unterminated line. */
  std::size_t Pending() const noexcept { return partial_.size(); }

 private:
  std::size_t max_;
  std::string partial_;
  std::deque<std::string> lines_;
};

/** Parses one line into a message object; throws FramingError(`invalid_json`) unless it is a JSON object. */
P3_API Json DecodeMessage(std::string_view line);

/**
 * Serializes a message compactly with its '\n' terminator. Throws FramingError(`invalid_utf8`) for strings that are
 * not valid UTF-8 and FramingError(`too_large`) above `maxBytes`.
 */
P3_API std::string EncodeMessage(const Json& message, std::size_t maxBytes = kMaxMessageBytes);

}  // namespace playerthree
