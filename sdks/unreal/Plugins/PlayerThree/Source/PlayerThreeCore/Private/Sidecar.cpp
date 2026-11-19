// Copyright 2026 The PlayerThree authors
// SPDX-License-Identifier: Apache-2.0

#include "PlayerThree/Sidecar.h"

#include <algorithm>
#include <chrono>
#include <exception>

namespace playerthree {

namespace {

/** Answered as `{"ok":false,"code":...}` for a host call. */
struct CallError {
  std::string code;
  std::string message;
};

const char* const kMatchMethods[] = {"step", "outcome", "view", "observe", "apply", "report", "events", "setSeatInfo"};
const char* const kHookMethods[] = {hooks::kMatchData, hooks::kDebugView, hooks::kObserverView, hooks::kEnd,
                                    hooks::kForfeit,   hooks::kRank,      hooks::kClone,        hooks::kSignalLimits};

template <std::size_t N>
bool OneOf(const char* const (&list)[N], const std::string& value) {
  return std::any_of(std::begin(list), std::end(list), [&](const char* item) { return value == item; });
}

const Json& Arg(const Json& args, std::size_t index) {
  if (index >= args.size()) throw InvalidCall("missing argument " + std::to_string(index));
  return args[index];
}

std::string String(const Json& value, const char* what) {
  if (!value.is_string()) throw InvalidCall(std::string(what) + " must be a string");
  return value.get<std::string>();
}

std::int64_t Integer(const Json& value, const char* what) {
  if (!value.is_number_integer()) throw InvalidCall(std::string(what) + " must be an integer");
  return value.get<std::int64_t>();
}

std::vector<std::string> Strings(const Json& value, const char* what) {
  if (!value.is_array()) throw InvalidCall(std::string(what) + " must be an array of strings");
  std::vector<std::string> out;
  out.reserve(value.size());
  for (const Json& item : value) out.push_back(String(item, what));
  return out;
}

Seat ParseSeat(const Json& value) {
  if (!value.is_object()) throw InvalidCall("seat must be {team, role}");
  return Seat{String(value.value("team", Json()), "seat.team"), String(value.value("role", Json()), "seat.role")};
}

/** Printable ASCII only, at most 500 bytes: a diagnostic must never break the frame (UTF-8) or flood the host. */
std::string Diagnostic(const std::string& text) {
  std::string out;
  for (char c : text) {
    if (out.size() >= 500) break;
    out.push_back(c >= 0x20 && c < 0x7f ? c : '?');
  }
  return out;
}

using Clock = std::chrono::steady_clock;

}  // namespace

SidecarClient::SidecarClient(GameDefinition& game, std::unique_ptr<Transport> transport, SidecarOptions options)
    : game_(game),
      transport_(std::move(transport)),
      options_(options),
      decoder_(options.maxMessageBytes),
      buffer_(64 * 1024),
      hooks_(game.Hooks()) {
  if (!transport_) throw std::invalid_argument("playerthree/sidecar: a transport is required");
  for (const std::string& hook : hooks_) {
    if (!OneOf(kHookMethods, hook)) throw std::invalid_argument("playerthree/sidecar: unknown hook " + hook);
  }
}

SidecarClient::~SidecarClient() { Close(); }

void SidecarClient::Close() { Shutdown("closed", "closed by the engine"); }

void SidecarClient::Shutdown(const std::string& code, const std::string& reason) {
  if (!transport_) return;
  // Detached first so Connected() is false inside the handler; destroyed only after it returns.
  const std::unique_ptr<Transport> closed = std::move(transport_);
  closed->Close();
  hostExit_ = closed->ExitCode();
  closeCode_ = code;
  closeReason_ = reason;
  // The host disposed every session; bots are host-side seats and go with them. Matches stay for ReleaseMatch.
  bots_.clear();
  if (onClosed_) onClosed_(reason);
}

void SidecarClient::ThrowClosed() const {
  const std::string code = closeCode_.empty() ? "closed" : closeCode_;
  throw SidecarError(code, "playerthree/sidecar: connection closed (" + code + "): " + closeReason_);
}

void SidecarClient::Abort(const std::string& code, const std::string& message) {
  if (!transport_) return;
  try {
    const std::string line = EncodeMessage(Json{{"op", "error"}, {"code", code}, {"message", Diagnostic(message)}});
    transport_->Write(line.data(), line.size());
  } catch (const std::exception&) {
    // The notice is best effort; the close below is what the peer relies on.
  }
  Shutdown(code, message);
}

void SidecarClient::Send(const Json& message) {
  if (!transport_) ThrowClosed();
  const std::string line = EncodeMessage(message, options_.maxMessageBytes);
  try {
    transport_->Write(line.data(), line.size());
  } catch (const TransportError& e) {
    Shutdown("closed", e.what());
    ThrowClosed();
  }
}

bool SidecarClient::Pump(int timeoutMs) {
  if (!transport_) return false;
  std::size_t n = 0;
  try {
    n = transport_->Read(buffer_.data(), buffer_.size(), timeoutMs);
  } catch (const TransportError& e) {
    Shutdown("closed", e.what());
    return false;
  }
  try {
    decoder_.Feed(buffer_.data(), n);
  } catch (const FramingError& e) {
    Abort(e.code(), e.what());
    return false;
  }
  std::string line;
  while (transport_ && decoder_.Next(line)) Handle(line);
  return transport_ != nullptr;
}

bool SidecarClient::Poll(int timeoutMs) {
  if (!transport_) return false;
  if (inCall_ || inPush_ || outstanding_ != 0) {
    throw SidecarError("busy", "playerthree/sidecar: Poll inside a call, push handler or request");
  }
  const Clock::time_point deadline = Clock::now() + std::chrono::milliseconds(std::max(timeoutMs, 0));
  do {
    const auto left = std::chrono::duration_cast<std::chrono::milliseconds>(deadline - Clock::now()).count();
    if (!Pump(static_cast<int>(std::max<long long>(left, 0)))) return false;
  } while (Clock::now() < deadline);
  return true;
}

void SidecarClient::Handle(const std::string& line) {
  Json message;
  try {
    message = DecodeMessage(line);
  } catch (const FramingError& e) {
    Abort("bad_frame", e.what());
    return;
  }
  const Json op = message.value("op", Json());
  if (!op.is_string()) return Abort("bad_frame", "message without a string op");
  const std::string kind = op.get<std::string>();

  if (kind == "error") {
    const Json code = message.value("code", Json());
    const Json text = message.value("message", Json());
    Shutdown(code.is_string() ? code.get<std::string>() : "protocol",
             text.is_string() ? Diagnostic(text.get<std::string>()) : "host closed the connection");
    return;
  }
  if (!ready_) {
    if (kind != "ready" || !helloSent_) return Abort("bad_frame", "expected ready after hello");
    const Json hash = message.value("surfaceHash", Json());
    if (!hash.is_string()) return Abort("bad_frame", "ready without surfaceHash");
    surfaceHash_ = hash.get<std::string>();
    const Json mcp = message.value("mcp", Json());
    mcpUrl_ = mcp.is_string() ? mcp.get<std::string>() : std::string();
    ready_ = true;
    return;
  }
  if (kind == "call") return HandleCall(message);
  if (kind == "result") {
    const Json id = message.value("id", Json());
    const Json ok = message.value("ok", Json());
    if (!id.is_number_integer() || id.get<std::int64_t>() != outstanding_ || outstanding_ == 0 || replied_ ||
        !ok.is_boolean()) {
      return Abort("bad_frame", "result for an id not outstanding");
    }
    reply_ = Reply{};
    reply_.ok = ok.get<bool>();
    if (reply_.ok) {
      reply_.data = message.value("data", Json());
    } else {
      const Json code = message.value("code", Json());
      const Json text = message.value("message", Json());
      if (!code.is_string()) return Abort("bad_frame", "failed result without a code");
      reply_.code = code.get<std::string>();
      if (text.is_string()) reply_.message = Diagnostic(text.get<std::string>());
    }
    replied_ = true;
    return;
  }
  if (kind == "push") {
    const Json session = message.value("session", Json());
    const Json pushKind = message.value("kind", Json());
    if (!session.is_string() || !pushKind.is_string()) return Abort("bad_frame", "push without session and kind");
    if (!onPush_) return;
    // Pushes arrive in the middle of other traffic: the handler may record them but must not start a request.
    inPush_ = true;
    try {
      onPush_(Push{session.get<std::string>(), pushKind.get<std::string>(), message.value("data", Json())});
    } catch (...) {
      inPush_ = false;
      throw;
    }
    inPush_ = false;
    return;
  }
  Abort("bad_frame", "unknown op " + kind);
}

void SidecarClient::HandleCall(const Json& message) {
  const Json id = message.value("id", Json());
  const Json session = message.value("session", Json());
  const Json method = message.value("method", Json());
  const Json args = message.value("args", Json::array());
  if (!id.is_number_integer() || id.get<std::int64_t>() <= 0 || !session.is_string() || !method.is_string() ||
      !args.is_array()) {
    return Abort("bad_frame", "call needs integer id, session, method and args[]");
  }
  // The host keeps at most one call in flight and the engine cannot pump while serving one, so calls never nest.
  inCall_ = true;
  Json reply{{"op", "result"}, {"id", id}};
  try {
    Json data = Dispatch(session.get<std::string>(), method.get<std::string>(), args);
    reply["ok"] = true;
    reply["data"] = std::move(data);
  } catch (const CallError& e) {
    reply["ok"] = false;
    reply["code"] = e.code;
    if (!e.message.empty()) reply["message"] = Diagnostic(e.message);
  } catch (const InvalidCall& e) {
    reply["ok"] = false;
    reply["code"] = "invalid";
    reply["message"] = Diagnostic(e.what());
  } catch (const Json::exception& e) {
    // A JSON type error inside an adapter means it read an argument of the wrong shape.
    reply["ok"] = false;
    reply["code"] = "invalid";
    reply["message"] = Diagnostic(e.what());
  } catch (const std::exception& e) {
    reply["ok"] = false;
    reply["code"] = "engine_error";
    reply["message"] = Diagnostic(e.what());
  } catch (...) {
    reply["ok"] = false;
    reply["code"] = "engine_error";
  }
  inCall_ = false;
  if (!transport_) return;
  std::string line;
  try {
    line = EncodeMessage(reply, options_.maxMessageBytes);
  } catch (const FramingError& e) {
    // Oversized or non-UTF-8 adapter output: report it instead of breaking the stream.
    line = EncodeMessage(Json{{"op", "result"}, {"id", id}, {"ok", false}, {"code", "engine_error"},
                              {"message", Diagnostic(std::string("result ") + e.code() + ": " + e.what())}});
  }
  try {
    transport_->Write(line.data(), line.size());
  } catch (const TransportError& e) {
    Shutdown("closed", e.what());
  }
}

Json SidecarClient::Dispatch(const std::string& session, const std::string& method, const Json& args) {
  const bool hook = OneOf(kHookMethods, method);
  if (hook && std::find(hooks_.begin(), hooks_.end(), method) == hooks_.end()) {
    throw CallError{"unknown_method", "hook not declared in hello: " + method};
  }

  if (method == "create" || method == "createBot") {
    if (matches_.count(session) || bots_.count(session)) throw InvalidCall("session already exists");
    if (method == "createBot") {
      const Json options = args.size() > 2 ? args[2] : Json();
      std::unique_ptr<BotCommander> bot =
          game_.CreateBot(ParseSeat(Arg(args, 0)), String(Arg(args, 1), "opponent"), options);
      if (!bot) throw CallError{"engine_error", "CreateBot returned no bot"};
      bots_[session] = std::move(bot);
      return nullptr;
    }
    const Json& spec = Arg(args, 0);
    if (!spec.is_object()) throw InvalidCall("create needs {seed, teams}");
    CreateOptions options;
    options.seed = Integer(spec.value("seed", Json()), "seed");
    options.teams = Strings(spec.value("teams", Json()), "teams");
    options.options = spec.value("options", Json());
    options.alliances = spec.value("alliances", Json());
    std::unique_ptr<GameAdapter> match = game_.Create(options);
    if (!match) throw CallError{"engine_error", "Create returned no match"};
    const std::int64_t tick = match->Tick();
    matches_[session] = std::move(match);
    return Json{{"tick", tick}};
  }

  if (method == "dispose") {
    if (matches_.erase(session) == 0 && bots_.erase(session) == 0) throw CallError{"unknown_session", session};
    return nullptr;
  }

  if (method == "init" || method == "think") {
    const auto found = bots_.find(session);
    if (found == bots_.end()) throw CallError{"unknown_session", session};
    if (method == "init") {
      found->second->Init(Arg(args, 0));
      return nullptr;
    }
    Json intents = found->second->Think(Arg(args, 0));
    if (!intents.is_array()) throw CallError{"engine_error", "Think must return an array of intents"};
    return intents;
  }

  if (!hook && !OneOf(kMatchMethods, method)) throw CallError{"unknown_method", method};
  const auto found = matches_.find(session);
  if (found == matches_.end()) throw CallError{"unknown_session", session};
  GameAdapter& game = *found->second;

  if (method == "step") {
    game.Step();
    return Json{{"tick", game.Tick()}};
  }
  if (method == "outcome") return game.Outcome(String(Arg(args, 0), "team"));
  if (method == "view") {
    const Json opts = args.size() > 1 ? args[1] : Json();
    const bool snapshot = opts.is_object() && opts.value("snapshot", false);
    return game.View(String(Arg(args, 0), "team"), snapshot);
  }
  if (method == "observe") {
    const Json detail = args.size() > 2 ? args[2] : Json::array();
    return game.Observe(ParseSeat(Arg(args, 0)), Integer(Arg(args, 1), "sinceTick"), Strings(detail, "detail"));
  }
  if (method == "apply") {
    const Seat seat = ParseSeat(Arg(args, 0));
    const Json& intent = Arg(args, 1);
    if (!intent.is_object()) throw InvalidCall("intent must be an object");
    const Json context = args.size() > 2 ? args[2] : Json();
    ApplyResult result;
    if (context.is_object()) {
      IntentContext ctx;
      ctx.source = String(context.value("source", Json()), "context.source");
      const Json roles = context.value("ownerRoles", Json());
      if (!roles.is_null()) ctx.ownerRoles = Strings(roles, "context.ownerRoles");
      result = game.Apply(seat, intent, &ctx);
    } else if (context.is_null()) {
      result = game.Apply(seat, intent, nullptr);
    } else {
      throw InvalidCall("context must be an object or null");
    }
    if (result.ok) return Json{{"ok", true}};
    return Json{{"ok", false}, {"code", result.code}};
  }
  if (method == "report") return game.Report(String(Arg(args, 0), "team"));
  if (method == "events") return game.Events(ParseSeat(Arg(args, 0)), Integer(Arg(args, 1), "sinceTick"));
  if (method == "setSeatInfo") {
    const Json& info = Arg(args, 1);
    if (!info.is_object()) throw InvalidCall("seat info must be {controller, mandate}");
    game.SetSeatInfo(ParseSeat(Arg(args, 0)), info.value("controller", Json()), info.value("mandate", Json()));
    return nullptr;
  }
  if (method == hooks::kMatchData) return game.MatchData(ParseSeat(Arg(args, 0)));
  if (method == hooks::kDebugView) return game.DebugView();
  if (method == hooks::kObserverView) return game.ObserverView();
  if (method == hooks::kSignalLimits) return game.SignalLimits();
  if (method == hooks::kEnd) {
    game.End(Arg(args, 0), Arg(args, 1));
    return nullptr;
  }
  if (method == hooks::kForfeit) {
    game.Forfeit(String(Arg(args, 0), "team"));
    return nullptr;
  }
  if (method == hooks::kRank) return game.Rank(String(Arg(args, 0), "team"));
  // clone: the copy becomes the host-chosen new session.
  const std::string target = String(Arg(args, 0), "session");
  if (matches_.count(target) || bots_.count(target)) throw InvalidCall("clone target session already exists");
  std::unique_ptr<GameAdapter> copy = game.Clone();
  if (!copy) throw CallError{"engine_error", "Clone returned no match"};
  const std::int64_t tick = copy->Tick();
  matches_[target] = std::move(copy);
  return Json{{"tick", tick}};
}

void SidecarClient::Hello() {
  if (helloSent_) throw SidecarError("protocol", "playerthree/sidecar: Hello() was already called");
  helloSent_ = true;
  Send(Json{{"op", "hello"}, {"protocol", kProtocolVersion}, {"manifest", game_.Manifest()}, {"hooks", hooks_}});
  const Clock::time_point deadline = Clock::now() + std::chrono::milliseconds(options_.helloTimeoutMs);
  while (!ready_) {
    const auto left = std::chrono::duration_cast<std::chrono::milliseconds>(deadline - Clock::now()).count();
    if (left <= 0) {
      Abort("timeout", "no ready within the hello timeout");
      ThrowClosed();
    }
    if (!Pump(static_cast<int>(left))) ThrowClosed();
  }
}

std::int64_t SidecarClient::BeginRequest() {
  if (!transport_) ThrowClosed();
  if (!ready_) throw SidecarError("protocol", "playerthree/sidecar: Hello() must succeed first");
  if (inCall_ || inPush_) {
    throw SidecarError("busy", "playerthree/sidecar: no engine request from inside a host call or push handler");
  }
  if (outstanding_ != 0) throw SidecarError("busy", "playerthree/sidecar: one engine request at a time");
  outstanding_ = nextId_++;
  replied_ = false;
  return outstanding_;
}

SidecarClient::Reply SidecarClient::Await(int timeoutMs) {
  const bool forever = timeoutMs < 0;
  const Clock::time_point deadline = Clock::now() + std::chrono::milliseconds(forever ? 0 : timeoutMs);
  while (!replied_) {
    int wait = -1;
    if (!forever) {
      const auto left = std::chrono::duration_cast<std::chrono::milliseconds>(deadline - Clock::now()).count();
      if (left <= 0) {
        outstanding_ = 0;
        Abort("timeout", "no reply to an engine request within the request timeout");
        ThrowClosed();
      }
      wait = static_cast<int>(left);
    }
    if (!Pump(wait)) {
      outstanding_ = 0;
      ThrowClosed();
    }
  }
  outstanding_ = 0;
  replied_ = false;
  return std::move(reply_);
}

std::int64_t SidecarClient::Step(const std::string& session, std::int64_t n) {
  if (n < 1) throw std::invalid_argument("playerthree/sidecar: Step needs n >= 1");
  const std::int64_t id = BeginRequest();
  try {
    Send(Json{{"op", "advance"}, {"id", id}, {"session", session}, {"n", n}});
  } catch (...) {
    outstanding_ = 0;
    throw;
  }
  Reply reply = Await(options_.requestTimeoutMs);
  if (!reply.ok) throw SidecarError(reply.code, "playerthree/sidecar: advance failed: " + reply.code);
  const Json tick = reply.data.is_object() ? reply.data.value("tick", Json()) : Json();
  if (!tick.is_number_integer()) throw SidecarError("protocol", "playerthree/sidecar: advance result without tick");
  return tick.get<std::int64_t>();
}

Json SidecarClient::Request(const std::string& method, Json args) {
  if (!args.is_array()) throw std::invalid_argument("playerthree/sidecar: Request args must be an array");
  const std::int64_t id = BeginRequest();
  try {
    Send(Json{{"op", "host"}, {"id", id}, {"method", method}, {"args", std::move(args)}});
  } catch (...) {
    outstanding_ = 0;
    throw;
  }
  Reply reply = Await(options_.requestTimeoutMs);
  if (!reply.ok) {
    throw SidecarError(reply.code, "playerthree/sidecar: " + method + " failed: " + reply.code +
                                       (reply.message.empty() ? "" : " (" + reply.message + ")"));
  }
  return std::move(reply.data);
}

std::string SidecarClient::CreateMatch(const Json& spec) {
  const Json data = Request("createMatch", Json::array({spec}));
  const Json session = data.is_object() ? data.value("session", Json()) : Json();
  if (!session.is_string()) throw SidecarError("protocol", "playerthree/sidecar: createMatch result without session");
  return session.get<std::string>();
}

std::string SidecarClient::MintSeatToken(const std::string& session, const std::string& team,
                                         const std::string& role) {
  const Json data = Request("mintSeatToken", Json::array({session, team, role}));
  const Json token = data.is_object() ? data.value("token", Json()) : Json();
  if (!token.is_string()) throw SidecarError("protocol", "playerthree/sidecar: mintSeatToken result without token");
  return token.get<std::string>();
}

void SidecarClient::DisposeMatch(const std::string& session) { Request("dispose", Json::array({session})); }

GameAdapter* SidecarClient::Match(const std::string& session) const {
  const auto found = matches_.find(session);
  return found == matches_.end() ? nullptr : found->second.get();
}

std::vector<std::string> SidecarClient::Matches() const {
  std::vector<std::string> out;
  out.reserve(matches_.size());
  for (const auto& entry : matches_) out.push_back(entry.first);
  return out;
}

std::unique_ptr<GameAdapter> SidecarClient::ReleaseMatch(const std::string& session) {
  const auto found = matches_.find(session);
  if (found == matches_.end()) return nullptr;
  std::unique_ptr<GameAdapter> match = std::move(found->second);
  matches_.erase(found);
  return match;
}

}  // namespace playerthree
