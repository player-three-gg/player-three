// Copyright 2026 The PlayerThree authors
// SPDX-License-Identifier: Apache-2.0

// An in-process stand-in for the sidecar host: a Transport whose far end is a script reacting synchronously to each
// engine message. Lets the client's protocol handling be tested on one thread, byte for byte.
#pragma once

#include <algorithm>
#include <cstdint>
#include <cstring>
#include <deque>
#include <functional>
#include <string>
#include <vector>

#include "PlayerThree/Framing.h"
#include "PlayerThree/Transport.h"

class FakeHost final : public playerthree::Transport {
 public:
  using Json = playerthree::Json;

  /** Called for every complete message the engine writes. */
  std::function<void(const Json&)> onMessage;
  /** Every message the engine wrote, in order. */
  std::vector<Json> received;
  bool closed = false;
  /** After the queued bytes drain, Read reports end of stream. */
  bool eof = false;
  /** Largest chunk handed to the engine per Read, to exercise partial frames. */
  std::size_t chunk = 4096;

  void Send(const Json& message) { inbound_ += playerthree::EncodeMessage(message, SIZE_MAX); }
  void SendRaw(const std::string& bytes) { inbound_ += bytes; }

  /** Sends a call to the engine; `then` gets the engine's result. Calls queue and go out one at a time. */
  void Call(const std::string& session, const std::string& method, Json args, std::function<void(const Json&)> then) {
    calls_.push_back({session, method, std::move(args), std::move(then)});
    if (calls_.size() == 1) SendFront();
  }
  /** Runs once the call queue drains (e.g. the reply to an `advance`). */
  void AfterCalls(std::function<void()> done) {
    if (calls_.empty()) {
      done();
    } else {
      afterCalls_ = std::move(done);
    }
  }

  std::size_t Read(char* buffer, std::size_t capacity, int) override {
    if (closed) throw playerthree::TransportError("closed");
    if (inbound_.empty()) {
      if (eof) throw playerthree::TransportError("host closed the connection");
      return 0;
    }
    const std::size_t n = std::min({capacity, chunk, inbound_.size()});
    std::memcpy(buffer, inbound_.data(), n);
    inbound_.erase(0, n);
    return n;
  }

  void Write(const char* data, std::size_t size) override {
    if (closed) throw playerthree::TransportError("closed");
    outbound_.append(data, size);
    std::size_t newline;
    while ((newline = outbound_.find('\n')) != std::string::npos) {
      const Json message = Json::parse(outbound_.substr(0, newline));
      outbound_.erase(0, newline + 1);
      received.push_back(message);
      if (message.value("op", "") == "result" && !calls_.empty() && message["id"] == calls_.front().id) {
        Pending done = std::move(calls_.front());
        calls_.pop_front();
        if (done.then) done.then(message);
        if (!calls_.empty()) {
          SendFront();
        } else if (afterCalls_) {
          std::function<void()> after = std::move(afterCalls_);
          afterCalls_ = nullptr;
          after();
        }
        continue;
      }
      if (onMessage) onMessage(message);
    }
  }

  void Close() override { closed = true; }

  /** The last message the engine sent with this op. */
  Json Last(const std::string& op) const {
    for (auto it = received.rbegin(); it != received.rend(); ++it) {
      if (it->value("op", "") == op) return *it;
    }
    return Json();
  }

 private:
  struct Pending {
    std::string session;
    std::string method;
    Json args;
    std::function<void(const Json&)> then;
    std::int64_t id = 0;
  };

  void SendFront() {
    Pending& call = calls_.front();
    call.id = nextCall_++;
    Send(Json{{"op", "call"}, {"id", call.id}, {"session", call.session}, {"method", call.method}, {"args", call.args}});
  }

  std::string inbound_;
  std::string outbound_;
  std::deque<Pending> calls_;
  std::function<void()> afterCalls_;
  std::int64_t nextCall_ = 1;
};
