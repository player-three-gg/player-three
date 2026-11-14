// Copyright 2026 The PlayerThree authors
// SPDX-License-Identifier: Apache-2.0

// SPEC §20.8 (a), wire protocol 1, engine side: handshake, call dispatch and codes, engine-owned clock (Step),
// host operations, pushes, limits, fatal errors and disconnect, against an in-process scripted host.
#include <memory>
#include <string>

#include "PlayerThree/Sidecar.h"
#include "TugOfWar.h"
#include "check.h"
#include "fake_host.h"

using playerthree::Json;
using playerthree::SidecarClient;
using playerthree::SidecarError;
using playerthree::SidecarOptions;

namespace {

const Json kNorth{{"team", "north"}, {"role", "puller"}};
const Json kSouth{{"team", "south"}, {"role", "puller"}};

/** A game that declares hooks, to exercise the optional calls. */
class HookMatch final : public playerthree::GameAdapter {
 public:
  std::int64_t tick = 5;
  std::string ended;
  std::int64_t Tick() const override { return tick; }
  void Step() override {
    if (tick == 7) throw std::runtime_error("sim fault");
    ++tick;
  }
  std::string Outcome(const std::string&) override { return "running"; }
  Json View(const std::string&, bool snapshot) override { return Json{{"snapshot", snapshot}}; }
  Json Observe(const playerthree::Seat& seat, std::int64_t since, const std::vector<std::string>& detail) override {
    if (seat.team == "huge") return Json{{"pad", std::string(playerthree::kMaxMessageBytes, 'x')}};
    if (seat.team == "binary") return Json{{"bad", std::string("\xff")}};
    return Json{{"team", seat.team}, {"since", since}, {"detail", detail}};
  }
  playerthree::ApplyResult Apply(const playerthree::Seat&, const Json& intent,
                                 const playerthree::IntentContext* context) override {
    if (!context) return playerthree::ApplyResult::Reject("no_context");
    if (intent.value("kind", "") == "bad") throw playerthree::InvalidCall("bad intent");
    return context->ownerRoles ? playerthree::ApplyResult::Reject(context->source + ":" + (*context->ownerRoles)[0])
                               : playerthree::ApplyResult::Accept();
  }
  Json Report(const std::string&) override { return Json::object(); }
  Json Events(const playerthree::Seat&, std::int64_t) override { return Json::array(); }
  void SetSeatInfo(const playerthree::Seat&, const Json&, const Json&) override {}
  Json MatchData(const playerthree::Seat& seat) override { return Json{{"for", seat.team}}; }
  std::int64_t Rank(const std::string& team) override { return team == "north" ? 1 : 2; }
  void End(const Json& outcomes, const Json&) override { ended = outcomes.dump(); }
  std::unique_ptr<playerthree::GameAdapter> Clone() override {
    auto copy = std::make_unique<HookMatch>(*this);
    copy->tick += 100;
    return copy;
  }
};

class HookGame final : public playerthree::GameDefinition {
 public:
  Json manifest = tug::Manifest();
  const Json& Manifest() const override { return manifest; }
  std::vector<std::string> Hooks() const override { return {"matchData", "rank", "end", "clone"}; }
  std::unique_ptr<playerthree::GameAdapter> Create(const playerthree::CreateOptions& options) override {
    if (options.seed == 13) throw playerthree::InvalidCall("unlucky");
    return std::make_unique<HookMatch>();
  }
  std::unique_ptr<playerthree::BotCommander> CreateBot(const playerthree::Seat&, const std::string&,
                                                       const Json&) override {
    return nullptr;
  }
};

struct Rig {
  FakeHost* host = nullptr;
  std::unique_ptr<SidecarClient> client;

  explicit Rig(playerthree::GameDefinition& game, SidecarOptions options = {}) {
    auto transport = std::make_unique<FakeHost>();
    host = transport.get();
    client = std::make_unique<SidecarClient>(game, std::move(transport), options);
  }

  /** Completes the handshake. */
  void Ready() {
    host->onMessage = [this](const Json& m) {
      if (m["op"] == "hello") host->Send(Json{{"op", "ready"}, {"surfaceHash", "ab12"}, {"mcp", "http://127.0.0.1:1/mcp"}});
    };
    client->Hello();
    host->onMessage = nullptr;
  }

  /** Asks the host to create session `s1` (the host calls `create` before answering createMatch). */
  std::string CreateMatch(Json createArgs = Json{{"seed", 1}, {"teams", {"north", "south"}}}) {
    host->onMessage = [this, createArgs](const Json& m) {
      if (m["op"] != "host" || m["method"] != "createMatch") return;
      const Json id = m["id"];
      host->Call("s1", "create", Json::array({createArgs}), [](const Json&) {});
      host->AfterCalls([this, id] { host->Send(Json{{"op", "result"}, {"id", id}, {"ok", true}, {"data", {{"session", "s1"}, {"tick", 0}}}}); });
    };
    const std::string session = client->CreateMatch(Json{{"seed", 1}});
    host->onMessage = nullptr;
    return session;
  }

  /** One host call outside any engine request, served by Poll; returns the engine's result. */
  Json Call(const std::string& session, const std::string& method, Json args) {
    Json result;
    host->Call(session, method, std::move(args), [&](const Json& r) { result = r; });
    client->Poll(0);
    return result;
  }
};

}  // namespace

TEST(hello_sends_manifest_and_hooks_then_reads_ready) {
  tug::TugDefinition game;
  Rig rig(game);
  rig.Ready();
  const Json hello = rig.host->received.at(0);
  CHECK_EQ(hello["op"], Json("hello"));
  CHECK_EQ(hello["protocol"], Json(1));
  CHECK_EQ(hello["manifest"].dump(), tug::Manifest().dump());
  CHECK_EQ(hello["hooks"], Json::array());
  CHECK_EQ(rig.client->SurfaceHash(), std::string("ab12"));
  CHECK_EQ(rig.client->McpUrl(), std::string("http://127.0.0.1:1/mcp"));
  THROWS_IF(rig.client->Hello(), SidecarError, e.code() == "protocol");
}

TEST(hello_declares_hooks) {
  HookGame game;
  Rig rig(game);
  rig.Ready();
  CHECK_EQ(rig.host->received.at(0)["hooks"], Json::array({"matchData", "rank", "end", "clone"}));
}

TEST(hello_rejection_closes_with_the_host_code) {
  tug::TugDefinition game;
  Rig rig(game);
  std::string closedReason;
  rig.client->OnClosed([&](const std::string& reason) { closedReason = reason; });
  rig.host->onMessage = [&](const Json&) {
    rig.host->Send(Json{{"op", "error"}, {"code", "invalid_manifest"}, {"message", "teams: required"}});
  };
  THROWS_IF(rig.client->Hello(), SidecarError, e.code() == "invalid_manifest");
  CHECK(!rig.client->Connected());
  CHECK_EQ(closedReason, std::string("teams: required"));
}

TEST(hello_times_out) {
  tug::TugDefinition game;
  SidecarOptions options;
  options.helloTimeoutMs = 30;
  Rig rig(game, options);
  FakeHost* host = rig.host;
  std::string notice;
  rig.client->OnClosed([&](const std::string&) { notice = host->Last("error").value("code", ""); });
  THROWS_IF(rig.client->Hello(), SidecarError, e.code() == "timeout");
  CHECK(!rig.client->Connected());
  CHECK_EQ(notice, std::string("timeout"));
}

TEST(anything_but_ready_before_the_handshake_is_a_bad_frame) {
  tug::TugDefinition game;
  Rig rig(game);
  rig.host->onMessage = [&](const Json&) {
    rig.host->Send(Json{{"op", "call"}, {"id", 1}, {"session", "s1"}, {"method", "step"}, {"args", Json::array()}});
  };
  THROWS_IF(rig.client->Hello(), SidecarError, e.code() == "bad_frame");
}

TEST(create_match_runs_create_before_the_reply) {
  tug::TugDefinition game;
  Rig rig(game);
  rig.Ready();
  CHECK_EQ(rig.CreateMatch(), std::string("s1"));
  const Json request = rig.host->received.at(1);
  CHECK_EQ(request["op"], Json("host"));
  CHECK_EQ(request["method"], Json("createMatch"));
  CHECK_EQ(request["args"], Json::array({Json{{"seed", 1}}}));
  CHECK(request["id"].is_number_integer() && request["id"].get<int>() > 0);
  const Json created = rig.host->received.at(2);
  CHECK_EQ(created.dump(), std::string(R"({"op":"result","id":1,"ok":true,"data":{"tick":0}})"));
  CHECK(rig.client->Match("s1") != nullptr);
  CHECK_EQ(rig.client->Matches(), std::vector<std::string>{"s1"});
}

TEST(step_serves_the_tick_and_returns_the_host_tick) {
  tug::TugDefinition game;
  Rig rig(game);
  rig.Ready();
  rig.CreateMatch();
  std::vector<std::string> results;
  auto keep = [&](const Json& r) { results.push_back(r.value("data", Json()).dump()); };
  rig.host->onMessage = [&](const Json& m) {
    if (m["op"] != "advance") return;
    CHECK_EQ(m["session"], Json("s1"));
    CHECK_EQ(m["n"], Json(2));
    FakeHost& h = *rig.host;
    h.Call("b1", "createBot", Json::array({kSouth, "easy", nullptr}), keep);
    h.Call("b1", "init", Json::array({nullptr}), keep);
    h.Call("s1", "setSeatInfo", Json::array({kNorth, {{"controller", {{"kind", "agent"}}}, {"mandate", Json::object()}}}), keep);
    h.Call("b1", "think", Json::array({{{"tick", 0}, {"rope", 0}}}), keep);
    h.Call("s1", "apply", Json::array({kSouth, {{"kind", "pull"}, {"strength", 1}}, {{"source", "bot"}}}), keep);
    h.Call("s1", "apply", Json::array({kNorth, {{"kind", "pull"}, {"strength", 3}}, nullptr}), keep);
    h.Call("s1", "step", Json::array(), keep);
    h.Call("s1", "step", Json::array(), keep);
    h.Call("s1", "observe", Json::array({kNorth, 0, Json::array()}), keep);
    h.Call("s1", "view", Json::array({"south", {{"snapshot", true}}}), keep);
    h.Call("s1", "outcome", Json::array({"north"}), keep);
    h.Call("s1", "report", Json::array({"south"}), keep);
    h.Call("s1", "events", Json::array({kNorth, 0}), keep);
    const Json id = m["id"];
    h.AfterCalls([&h, id] { h.Send(Json{{"op", "result"}, {"id", id}, {"ok", true}, {"data", {{"tick", 2}}}}); });
  };
  CHECK_EQ(rig.client->Step("s1", 2), std::int64_t{2});
  CHECK_EQ(results, (std::vector<std::string>{"null", "null", "null", R"([{"kind":"pull","strength":1}])",
                                              R"({"ok":true})", R"({"ok":true})", R"({"tick":1})", R"({"tick":2})",
                                              R"({"tick":2,"rope":2})", R"({"rope":2})", R"("running")",
                                              R"({"outcome":"running"})", "[]"}));
}

TEST(advance_failures_carry_the_host_code) {
  tug::TugDefinition game;
  Rig rig(game);
  rig.Ready();
  rig.CreateMatch();
  rig.host->onMessage = [&](const Json& m) {
    rig.host->Send(Json{{"op", "result"}, {"id", m["id"]}, {"ok", false}, {"code", "paused"}});
  };
  THROWS_IF(rig.client->Step("s1", 1), SidecarError, e.code() == "paused");
  THROWS(rig.client->Step("s1", 0), std::invalid_argument);
  CHECK(rig.client->Connected());
}

TEST(host_requests_return_data_and_failures) {
  tug::TugDefinition game;
  Rig rig(game);
  rig.Ready();
  rig.host->onMessage = [&](const Json& m) {
    if (m["method"] == "mintSeatToken") {
      CHECK_EQ(m["args"], Json::array({"s1", "north", "puller"}));
      rig.host->Send(Json{{"op", "result"}, {"id", m["id"]}, {"ok", true}, {"data", {{"token", "tok"}}}});
    } else {
      rig.host->Send(Json{{"op", "result"}, {"id", m["id"]}, {"ok", false}, {"code", "invalid"}, {"message", "no"}});
    }
  };
  CHECK_EQ(rig.client->MintSeatToken("s1", "north", "puller"), std::string("tok"));
  THROWS_IF(rig.client->Request("seats", Json::array({"s9"})), SidecarError, e.code() == "invalid");
  THROWS(rig.client->Request("seats", Json::object()), std::invalid_argument);
  // Engine request ids are positive and increase.
  CHECK_EQ(rig.host->received.at(1)["id"], Json(1));
  CHECK_EQ(rig.host->received.at(2)["id"], Json(2));
}

TEST(call_error_codes) {
  HookGame game;
  Rig rig(game);
  rig.Ready();
  rig.CreateMatch();
  auto code = [](const Json& r) { return r.value("ok", true) ? std::string("ok") : r["code"].get<std::string>(); };
  CHECK_EQ(code(rig.Call("s1", "teleport", Json::array())), std::string("unknown_method"));
  CHECK_EQ(code(rig.Call("s9", "step", Json::array())), std::string("unknown_session"));
  CHECK_EQ(code(rig.Call("s9", "dispose", Json::array())), std::string("unknown_session"));
  CHECK_EQ(code(rig.Call("b9", "think", Json::array({Json::object()}))), std::string("unknown_session"));
  CHECK_EQ(code(rig.Call("s1", "observe", Json::array({"north", 0, Json::array()}))), std::string("invalid"));
  CHECK_EQ(code(rig.Call("s1", "observe", Json::array({kNorth}))), std::string("invalid"));
  CHECK_EQ(code(rig.Call("s1", "apply", Json::array({kNorth, {{"kind", "bad"}}, {{"source", "agent"}}}))), std::string("invalid"));
  CHECK_EQ(code(rig.Call("s1", "create", Json::array({{{"seed", 2}, {"teams", {"north"}}}}))), std::string("invalid"));
  CHECK_EQ(code(rig.Call("s2", "create", Json::array({{{"seed", 13}, {"teams", {"north"}}}}))), std::string("invalid"));
  CHECK_EQ(code(rig.Call("b1", "createBot", Json::array({kNorth, "easy", nullptr}))), std::string("engine_error"));
  // Undeclared hooks are unknown methods even on a live session.
  CHECK_EQ(code(rig.Call("s1", "debugView", Json::array())), std::string("unknown_method"));
  CHECK_EQ(code(rig.Call("s1", "step", Json::array())), std::string("ok"));
  CHECK_EQ(code(rig.Call("s1", "step", Json::array())), std::string("ok"));
  const Json fault = rig.Call("s1", "step", Json::array());
  CHECK_EQ(code(fault), std::string("engine_error"));
  CHECK_EQ(fault["message"], Json("sim fault"));
  CHECK(rig.client->Connected());
}

TEST(declared_hooks_and_context) {
  HookGame game;
  Rig rig(game);
  rig.Ready();
  rig.CreateMatch();
  CHECK_EQ(rig.Call("s1", "matchData", Json::array({kSouth}))["data"], (Json{{"for", "south"}}));
  CHECK_EQ(rig.Call("s1", "rank", Json::array({"south"}))["data"], Json(2));
  CHECK_EQ(rig.Call("s1", "end", Json::array({{{"north", "win"}}, {{"north", 1}}}))["data"], Json());
  CHECK_EQ(static_cast<HookMatch*>(rig.client->Match("s1"))->ended, std::string(R"({"north":"win"})"));
  CHECK_EQ(rig.Call("s1", "clone", Json::array({"s2"}))["data"], (Json{{"tick", 105}}));
  CHECK(rig.client->Match("s2") != nullptr);
  CHECK_EQ(rig.Call("s1", "clone", Json::array({"s2"}))["code"], Json("invalid"));
  CHECK_EQ(rig.Call("s1", "apply", Json::array({kNorth, {{"kind", "x"}}, nullptr}))["data"],
           (Json{{"ok", false}, {"code", "no_context"}}));
  CHECK_EQ(rig.Call("s1", "apply", Json::array({kNorth, {{"kind", "x"}}, {{"source", "owner"}, {"ownerRoles", {"puller"}}}}))["data"],
           (Json{{"ok", false}, {"code", "owner:puller"}}));
  CHECK_EQ(rig.Call("s1", "observe", Json::array({kNorth, 3, {"a", "b"}}))["data"],
           (Json{{"team", "north"}, {"since", 3}, {"detail", {"a", "b"}}}));
  CHECK_EQ(rig.Call("s1", "view", Json::array({"north"}))["data"], (Json{{"snapshot", false}}));
  CHECK_EQ(rig.Call("s2", "dispose", Json::array())["data"], Json());
  CHECK(rig.client->Match("s2") == nullptr);
}

TEST(unencodable_results_become_engine_errors) {
  HookGame game;
  Rig rig(game);
  rig.Ready();
  rig.CreateMatch();
  const Json huge = rig.Call("s1", "observe", Json::array({{{"team", "huge"}, {"role", "puller"}}, 0, Json::array()}));
  CHECK_EQ(huge["code"], Json("engine_error"));
  const Json binary = rig.Call("s1", "observe", Json::array({{{"team", "binary"}, {"role", "puller"}}, 0, Json::array()}));
  CHECK_EQ(binary["code"], Json("engine_error"));
  CHECK(rig.client->Connected());
}

TEST(a_call_at_the_size_limit_is_answered_across_partial_reads) {
  tug::TugDefinition game;
  Rig rig(game);
  rig.Ready();
  rig.CreateMatch();
  rig.host->chunk = 1000;
  const std::string head = R"({"op":"call","id":9,"session":"s1","method":"outcome","args":["north"],"pad":")";
  const std::string line = head + std::string(playerthree::kMaxMessageBytes - head.size() - 2, 'x') + "\"}";
  CHECK_EQ(line.size(), playerthree::kMaxMessageBytes);
  rig.host->SendRaw(line + "\n");
  const std::size_t before = rig.host->received.size();
  while (rig.host->received.size() == before && rig.client->Poll(0)) {
  }
  CHECK_EQ(rig.host->Last("result").dump(), std::string(R"({"op":"result","id":9,"ok":true,"data":"running"})"));
}

TEST(an_oversized_line_during_a_request_closes_the_connection) {
  tug::TugDefinition game;
  Rig rig(game);
  rig.Ready();
  rig.CreateMatch();
  FakeHost* host = rig.host;
  std::vector<Json> seen;
  host->onMessage = [&](const Json& m) {
    if (m["op"] == "host") host->SendRaw(std::string(playerthree::kMaxMessageBytes + 1, ' ') + "\n");
  };
  rig.client->OnClosed([&](const std::string&) { seen = host->received; });
  THROWS_IF(rig.client->DisposeMatch("s1"), SidecarError, e.code() == "too_large");
  CHECK(!rig.client->Connected());
  CHECK_EQ(seen.back()["op"], Json("error"));
  CHECK_EQ(seen.back()["code"], Json("too_large"));
}

TEST(malformed_frames_are_fatal) {
  for (const std::string bad : {"not json\n", "[1]\n", "{\"op\":\"warp\"}\n", "{\"id\":1}\n",
                                "{\"op\":\"result\",\"id\":77,\"ok\":true}\n",
                                "{\"op\":\"call\",\"id\":\"1\",\"session\":\"s1\",\"method\":\"step\",\"args\":[]}\n",
                                "{\"op\":\"call\",\"id\":1,\"session\":\"s1\",\"method\":\"step\",\"args\":{}}\n"}) {
    tug::TugDefinition game;
    Rig rig(game);
    rig.Ready();
    FakeHost* host = rig.host;
    std::string code;
    rig.client->OnClosed([&](const std::string&) { code = host->Last("error").value("code", ""); });
    host->SendRaw(bad);
    CHECK(!rig.client->Poll(0));
    CHECK_EQ(code, std::string("bad_frame"));
  }
}

TEST(pushes_reach_the_handler_and_requests_inside_it_are_refused) {
  tug::TugDefinition game;
  Rig rig(game);
  rig.Ready();
  rig.CreateMatch();
  std::vector<std::string> kinds;
  std::string refused;
  rig.client->OnPush([&](const playerthree::Push& p) {
    kinds.push_back(p.session + "/" + p.kind + "/" + p.data.dump());
    try {
      rig.client->Step("s1", 1);
    } catch (const SidecarError& e) {
      refused = e.code();
    }
  });
  rig.host->onMessage = [&](const Json& m) {
    rig.host->Send(Json{{"op", "push"}, {"session", "s1"}, {"kind", "ended"}, {"data", {{"outcomes", {{"north", "win"}}}}}});
    rig.host->Send(Json{{"op", "result"}, {"id", m["id"]}, {"ok", true}, {"data", {{"tick", 1}}}});
  };
  CHECK_EQ(rig.client->Step("s1", 1), std::int64_t{1});
  CHECK_EQ(kinds, std::vector<std::string>{R"(s1/ended/{"outcomes":{"north":"win"}})"});
  CHECK_EQ(refused, std::string("busy"));
  rig.host->onMessage = nullptr;
  rig.host->Send(Json{{"op", "push"}, {"session", "s1"}, {"kind", "seats"}, {"data", Json::array()}});
  CHECK(rig.client->Poll(0));
  CHECK_EQ(kinds.size(), std::size_t{2});
}

TEST(request_timeout_closes) {
  tug::TugDefinition game;
  SidecarOptions options;
  options.requestTimeoutMs = 30;
  Rig rig(game, options);
  rig.Ready();
  THROWS_IF(rig.client->Request("seats", Json::array({"s1"})), SidecarError, e.code() == "timeout");
  CHECK(!rig.client->Connected());
}

TEST(disconnect_keeps_matches_for_the_engine) {
  tug::TugDefinition game;
  Rig rig(game);
  rig.Ready();
  rig.CreateMatch();
  bool closed = false;
  rig.client->OnClosed([&](const std::string&) { closed = true; });
  rig.host->eof = true;
  CHECK(!rig.client->Poll(10));
  CHECK(closed);
  THROWS_IF(rig.client->Step("s1", 1), SidecarError, e.code() == "closed");
  std::unique_ptr<playerthree::GameAdapter> match = rig.client->ReleaseMatch("s1");
  CHECK(match != nullptr);
  match->Step();
  CHECK_EQ(match->Tick(), std::int64_t{1});
  CHECK(rig.client->ReleaseMatch("s1") == nullptr);
}

TEST(a_host_error_notice_closes) {
  tug::TugDefinition game;
  Rig rig(game);
  rig.Ready();
  rig.host->onMessage = [&](const Json&) { rig.host->Send(Json{{"op", "error"}, {"code", "timeout"}}); };
  THROWS_IF(rig.client->Request("seats", Json::array({"s1"})), SidecarError, e.code() == "timeout");
  CHECK(!rig.client->Connected());
}

TEST_MAIN()
