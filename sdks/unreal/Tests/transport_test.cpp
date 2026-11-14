// Copyright 2026 The PlayerThree authors
// SPDX-License-Identifier: Apache-2.0

// Real OS channels (POSIX): a Unix domain socket the host listens on, and a host spawned over stdio.
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <optional>
#include <string>
#include <thread>

#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

#include "PlayerThree/Sidecar.h"
#include "PlayerThree/Transport.h"
#include "TugOfWar.h"
#include "check.h"

using playerthree::TransportError;

namespace {

/** Reads from `t` until a '\n' arrives (or 5 s pass). */
std::string ReadLine(playerthree::Transport& t) {
  std::string out;
  char buffer[256];
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
  while (out.find('\n') == std::string::npos && std::chrono::steady_clock::now() < deadline) {
    out.append(buffer, t.Read(buffer, sizeof(buffer), 100));
  }
  return out;
}

std::string TempDir() {
  char pattern[] = "/tmp/p3-transport-XXXXXX";
  const char* dir = ::mkdtemp(pattern);
  return dir ? dir : "";
}

}  // namespace

TEST(unix_socket_round_trip_timeout_and_eof) {
  const std::string dir = TempDir();
  CHECK(!dir.empty());
  const std::string path = dir + "/host.sock";
  const int server = ::socket(AF_UNIX, SOCK_STREAM, 0);
  sockaddr_un address{};
  address.sun_family = AF_UNIX;
  std::snprintf(address.sun_path, sizeof(address.sun_path), "%s", path.c_str());
  CHECK(::bind(server, reinterpret_cast<sockaddr*>(&address), sizeof(address)) == 0);
  ::chmod(path.c_str(), 0600);
  CHECK(::listen(server, 1) == 0);
  std::string heard;
  std::thread host([&] {
    const int peer = ::accept(server, nullptr, nullptr);
    char buffer[64];
    while (heard.find('\n') == std::string::npos) {
      const ssize_t n = ::read(peer, buffer, sizeof(buffer));
      if (n <= 0) break;
      heard.append(buffer, static_cast<std::size_t>(n));
    }
    const std::string reply = "{\"op\":\"ready\"}\n";
    (void)::write(peer, reply.data(), reply.size());
    ::close(peer);
  });

  std::unique_ptr<playerthree::Transport> t = playerthree::ConnectSocket(path);
  char buffer[16];
  const auto start = std::chrono::steady_clock::now();
  CHECK_EQ(t->Read(buffer, sizeof(buffer), 30), std::size_t{0});  // nothing yet: a timeout, not an error
  CHECK(std::chrono::steady_clock::now() - start >= std::chrono::milliseconds(25));
  const std::string hello = "{\"op\":\"hello\"}\n";
  t->Write(hello.data(), hello.size());
  CHECK_EQ(ReadLine(*t), std::string("{\"op\":\"ready\"}\n"));
  host.join();
  CHECK_EQ(heard, hello);
  THROWS(ReadLine(*t), TransportError);  // the host closed
  t->Close();
  t->Close();
  THROWS(t->Write("x", 1), TransportError);
  ::close(server);
  ::unlink(path.c_str());
  ::rmdir(dir.c_str());
}

TEST(unix_socket_connect_failures) {
  THROWS(playerthree::ConnectSocket("/tmp/p3-no-such-dir/host.sock"), TransportError);
  THROWS(playerthree::ConnectSocket(""), TransportError);
  THROWS(playerthree::ConnectSocket(std::string(200, 'x')), TransportError);
}

TEST(spawned_host_handshake_and_exit_code) {
  // A stand-in host: answers hello with ready, then waits for end of input and exits 3.
  const char* script =
      "IFS= read -r hello; case \"$hello\" in *'\"op\":\"hello\"'*) ;; *) exit 9;; esac;"
      "printf '%s\\n' '{\"op\":\"ready\",\"surfaceHash\":\"00ff\",\"mcp\":\"http://127.0.0.1:9/mcp\"}';"
      "cat >/dev/null; exit 3";
  tug::TugDefinition game;
  playerthree::SidecarClient client(game, playerthree::SpawnHost({"sh", "-c", script}));
  client.Hello();
  CHECK_EQ(client.SurfaceHash(), std::string("00ff"));
  client.Close();
  CHECK(!client.Connected());
  CHECK(client.HostExitCode() == std::optional<int>(3));
}

TEST(spawned_host_exit_is_end_of_stream) {
  tug::TugDefinition game;
  playerthree::SidecarClient client(game, playerthree::SpawnHost({"sh", "-c", "exit 0"}));
  THROWS_IF(client.Hello(), playerthree::SidecarError, e.code() == "closed");
  CHECK(client.HostExitCode() == std::optional<int>(0));
}

TEST(writing_to_a_vanished_host_is_an_error_not_sigpipe) {
  std::unique_ptr<playerthree::Transport> t = playerthree::SpawnHost({"sh", "-c", "exec 0<&-; exit 0"});
  std::this_thread::sleep_for(std::chrono::milliseconds(200));
  const std::string big(1 << 20, 'x');
  bool failed = false;
  try {
    for (int i = 0; i < 8; ++i) t->Write(big.data(), big.size());
  } catch (const TransportError&) {
    failed = true;
  }
  CHECK(failed);
  t->Close();
}

TEST(spawn_failures) {
  THROWS(playerthree::SpawnHost({}), TransportError);
  THROWS(playerthree::SpawnHost({"/nonexistent/p3-host"}), TransportError);
}

TEST(secrets_are_written_owner_only) {
  const std::string dir = TempDir();
  const std::string path = dir + "/token";
  auto read = [](const std::string& p) {
    std::string out;
    char buffer[64];
    FILE* f = std::fopen(p.c_str(), "rb");
    if (!f) return out;
    for (std::size_t n; (n = std::fread(buffer, 1, sizeof(buffer), f)) > 0;) out.append(buffer, n);
    std::fclose(f);
    return out;
  };
  auto mode = [](const std::string& p) {
    struct stat info {};
    return ::stat(p.c_str(), &info) == 0 ? (info.st_mode & 07777u) : 0u;
  };
  playerthree::WriteOwnerOnlyFile(path, "secret-1");
  CHECK_EQ(mode(path), 0600u);
  CHECK_EQ(read(path), std::string("secret-1"));
  // A pre-existing, wider file is narrowed and truncated.
  ::chmod(path.c_str(), 0644);
  playerthree::WriteOwnerOnlyFile(path, "s2");
  CHECK_EQ(mode(path), 0600u);
  CHECK_EQ(read(path), std::string("s2"));
  // A symlink planted at the path is refused, not followed.
  const std::string target = dir + "/elsewhere";
  const std::string link = dir + "/link";
  CHECK(::symlink(target.c_str(), link.c_str()) == 0);
  THROWS(playerthree::WriteOwnerOnlyFile(link, "s3"), TransportError);
  CHECK(::access(target.c_str(), F_OK) != 0);
  THROWS(playerthree::WriteOwnerOnlyFile(dir + "/missing/token", "s4"), TransportError);
  ::unlink(link.c_str());
  ::unlink(path.c_str());
  ::rmdir(dir.c_str());
}

TEST_MAIN()
