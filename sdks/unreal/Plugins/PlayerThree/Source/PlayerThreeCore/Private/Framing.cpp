// Copyright 2026 The PlayerThree authors
// SPDX-License-Identifier: Apache-2.0

#include "PlayerThree/Framing.h"

#include <cstring>

namespace playerthree {

void LineDecoder::Feed(const char* data, std::size_t size) {
  const char* end = data + size;
  while (data < end) {
    const void* found = std::memchr(data, '\n', static_cast<std::size_t>(end - data));
    const char* stop = found ? static_cast<const char*>(found) : end;
    const std::size_t chunk = static_cast<std::size_t>(stop - data);
    if (partial_.size() + chunk > max_) {
      throw FramingError("too_large", "playerthree/sidecar: message exceeds " + std::to_string(max_) + " bytes");
    }
    partial_.append(data, chunk);
    if (!found) return;
    lines_.push_back(std::move(partial_));
    partial_.clear();
    data = stop + 1;
  }
}

bool LineDecoder::Next(std::string& line) {
  if (lines_.empty()) return false;
  line = std::move(lines_.front());
  lines_.pop_front();
  return true;
}

Json DecodeMessage(std::string_view line) {
  // Non-throwing parse: a malformed peer line is a protocol error, never an engine crash. nlohmann's lexer rejects
  // invalid UTF-8 inside strings, so a successful parse is valid UTF-8 JSON.
  Json message = Json::parse(line.begin(), line.end(), nullptr, /*allow_exceptions=*/false);
  if (message.is_discarded() || !message.is_object()) {
    throw FramingError("invalid_json", "playerthree/sidecar: a message must be one JSON object per line");
  }
  return message;
}

std::string EncodeMessage(const Json& message, std::size_t maxBytes) {
  std::string out;
  try {
    // Compact (no newlines inside), non-ASCII kept as UTF-8, invalid UTF-8 rejected (strict handler).
    out = message.dump(-1, ' ', false, Json::error_handler_t::strict);
  } catch (const Json::type_error&) {
    throw FramingError("invalid_utf8", "playerthree/sidecar: message contains a string that is not valid UTF-8");
  }
  if (out.size() > maxBytes) {
    throw FramingError("too_large", "playerthree/sidecar: message exceeds " + std::to_string(maxBytes) + " bytes");
  }
  out.push_back('\n');
  return out;
}

}  // namespace playerthree
