// Copyright 2026 The PlayerThree authors
// SPDX-License-Identifier: Apache-2.0

#include "PlayerThree/Transport.h"

#include <cstring>
#include <string>

#if defined(_WIN32)
#if defined(PLAYERTHREECORE_API)
// Inside Unreal, windows.h goes through the engine's wrappers; the Windows types stay allowed until the end of
// this file, where HideWindowsPlatformTypes.h restores the engine's macros.
#include "Windows/AllowWindowsPlatformTypes.h"
#include <windows.h>
#else
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif
#else
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <spawn.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
extern char** environ;
#endif

namespace playerthree {

#if !defined(_WIN32)

namespace {

[[noreturn]] void Fail(const std::string& what) {
  throw TransportError("playerthree/sidecar: " + what + ": " + std::strerror(errno));
}

/** Pipe or socket file descriptors; `child` > 0 when this transport spawned the host. */
class FdTransport final : public Transport {
 public:
  FdTransport(int readFd, int writeFd, bool owns, pid_t child = -1, int exitWaitMs = 0)
      : read_(readFd), write_(writeFd), owns_(owns), child_(child), exitWaitMs_(exitWaitMs) {}
  ~FdTransport() override { Close(); }

  std::size_t Read(char* buffer, std::size_t capacity, int timeoutMs) override {
    if (read_ < 0) throw TransportError("playerthree/sidecar: transport closed");
    pollfd p{read_, POLLIN, 0};
    for (;;) {
      const int ready = ::poll(&p, 1, timeoutMs < 0 ? -1 : timeoutMs);
      if (ready < 0 && errno == EINTR) continue;
      if (ready < 0) Fail("poll");
      if (ready == 0) return 0;
      break;
    }
    for (;;) {
      const ssize_t n = ::read(read_, buffer, capacity);
      if (n < 0 && errno == EINTR) continue;
      if (n < 0) Fail("read");
      if (n == 0) throw TransportError("playerthree/sidecar: host closed the connection");
      return static_cast<std::size_t>(n);
    }
  }

  void Write(const char* data, std::size_t size) override {
    if (write_ < 0) throw TransportError("playerthree/sidecar: transport closed");
    // A vanished peer must surface as an error, not kill the engine with SIGPIPE: block it on this thread for the
    // write and drain a SIGPIPE the write raised, without touching the process-wide disposition.
    sigset_t pipeOnly, previous;
    sigemptyset(&pipeOnly);
    sigaddset(&pipeOnly, SIGPIPE);
    pthread_sigmask(SIG_BLOCK, &pipeOnly, &previous);
    int error = 0;
    while (size > 0) {
      const ssize_t n = ::write(write_, data, size);
      if (n < 0 && errno == EINTR) continue;
      if (n < 0) {
        error = errno;
        break;
      }
      data += n;
      size -= static_cast<std::size_t>(n);
    }
    if (error == EPIPE && !sigismember(&previous, SIGPIPE)) {
      // sigwait returns at once for a pending signal; macOS has no sigtimedwait to poll with.
      sigset_t pending;
      sigemptyset(&pending);
      if (sigpending(&pending) == 0 && sigismember(&pending, SIGPIPE)) {
        int drained = 0;
        sigwait(&pipeOnly, &drained);
      }
    }
    pthread_sigmask(SIG_SETMASK, &previous, nullptr);
    if (error != 0) {
      errno = error;
      Fail("write");
    }
  }

  void Close() override {
    if (owns_) {
      if (write_ >= 0 && write_ != read_) ::close(write_);
      if (read_ >= 0) ::close(read_);
    }
    read_ = write_ = -1;
    if (child_ > 0) {
      // The host exits once its stdin closes; give it exitWaitMs_, then terminate it.
      int status = 0;
      pid_t done = 0;
      for (int waited = 0; done == 0; waited += 10) {
        done = ::waitpid(child_, &status, WNOHANG);
        if (done != 0 || waited >= exitWaitMs_) break;
        ::usleep(10000);
      }
      if (done == 0) {
        ::kill(child_, SIGTERM);
        done = ::waitpid(child_, &status, 0);
      }
      if (done == child_ && WIFEXITED(status)) exit_ = WEXITSTATUS(status);
      child_ = -1;
    }
  }

  std::optional<int> ExitCode() const override { return exit_; }

 private:
  int read_;
  int write_;
  bool owns_;
  pid_t child_;
  int exitWaitMs_;
  std::optional<int> exit_;
};

void CloseOnExec(int fd) {
  if (::fcntl(fd, F_SETFD, FD_CLOEXEC) < 0) Fail("fcntl");
}

}  // namespace

std::unique_ptr<Transport> ConnectSocket(const std::string& path) {
  sockaddr_un address{};
  if (path.empty() || path.size() >= sizeof(address.sun_path)) {
    throw TransportError("playerthree/sidecar: Unix socket path is empty or too long");
  }
  address.sun_family = AF_UNIX;
  std::memcpy(address.sun_path, path.c_str(), path.size() + 1);
  const int fd = ::socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0) Fail("socket");
  CloseOnExec(fd);
  if (::connect(fd, reinterpret_cast<const sockaddr*>(&address), sizeof(address)) < 0) {
    const int error = errno;
    ::close(fd);
    errno = error;
    Fail("connect " + path);
  }
#if defined(__linux__)
  ucred peer{};
  socklen_t length = sizeof(peer);
  const bool known = ::getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &peer, &length) == 0;
  const uid_t peerUid = peer.uid;
#else
  uid_t peerUid = 0;
  gid_t peerGid = 0;
  const bool known = ::getpeereid(fd, &peerUid, &peerGid) == 0;
#endif
  if (!known || peerUid != ::geteuid()) {
    ::close(fd);
    throw TransportError("playerthree/sidecar: the socket's host runs as another OS user");
  }
  return std::make_unique<FdTransport>(fd, fd, /*owns=*/true);
}

std::unique_ptr<Transport> SpawnHost(const std::vector<std::string>& argv, int exitWaitMs) {
  if (argv.empty()) throw TransportError("playerthree/sidecar: SpawnHost needs a command");
  int toChild[2];
  int fromChild[2];
  if (::pipe(toChild) < 0) Fail("pipe");
  if (::pipe(fromChild) < 0) {
    const int error = errno;
    ::close(toChild[0]);
    ::close(toChild[1]);
    errno = error;
    Fail("pipe");
  }
  // Every end is close-on-exec; the dup2 actions below give the child clean copies as fds 0 and 1.
  for (int fd : {toChild[0], toChild[1], fromChild[0], fromChild[1]}) CloseOnExec(fd);
  posix_spawn_file_actions_t actions;
  posix_spawn_file_actions_init(&actions);
  posix_spawn_file_actions_adddup2(&actions, toChild[0], STDIN_FILENO);
  posix_spawn_file_actions_adddup2(&actions, fromChild[1], STDOUT_FILENO);
  std::vector<char*> args;
  for (const std::string& a : argv) args.push_back(const_cast<char*>(a.c_str()));
  args.push_back(nullptr);
  pid_t child = -1;
  const int error = ::posix_spawnp(&child, args[0], &actions, nullptr, args.data(), environ);
  posix_spawn_file_actions_destroy(&actions);
  ::close(toChild[0]);
  ::close(fromChild[1]);
  if (error != 0) {
    ::close(toChild[1]);
    ::close(fromChild[0]);
    errno = error;
    Fail("spawn " + argv[0]);
  }
  return std::make_unique<FdTransport>(fromChild[0], toChild[1], /*owns=*/true, child, exitWaitMs);
}

void WriteOwnerOnlyFile(const std::string& path, const std::string& contents) {
  const int fd = ::open(path.c_str(), O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (fd < 0) Fail("open " + path);
  // An existing file keeps its old mode through O_CREAT: narrow it before the secret goes in.
  if (::fchmod(fd, 0600) < 0) {
    const int error = errno;
    ::close(fd);
    errno = error;
    Fail("chmod " + path);
  }
  const char* data = contents.data();
  std::size_t left = contents.size();
  while (left > 0) {
    const ssize_t n = ::write(fd, data, left);
    if (n < 0 && errno == EINTR) continue;
    if (n < 0) {
      const int error = errno;
      ::close(fd);
      errno = error;
      Fail("write " + path);
    }
    data += n;
    left -= static_cast<std::size_t>(n);
  }
  if (::close(fd) < 0) Fail("close " + path);
}

#else  // _WIN32

namespace {

[[noreturn]] void Fail(const std::string& what) {
  throw TransportError("playerthree/sidecar: " + what + " (Windows error " + std::to_string(GetLastError()) + ")");
}

std::wstring Widen(const std::string& utf8) {
  if (utf8.empty()) return std::wstring();
  const int n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, utf8.data(), static_cast<int>(utf8.size()), nullptr, 0);
  if (n <= 0) Fail("invalid UTF-8 name");
  std::wstring out(static_cast<std::size_t>(n), L'\0');
  MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, utf8.data(), static_cast<int>(utf8.size()), &out[0], n);
  return out;
}

/** The current user's SID, or the SID owning `process`; empty on failure. */
std::vector<unsigned char> UserSid(HANDLE process) {
  std::vector<unsigned char> sid;
  HANDLE token = nullptr;
  if (!OpenProcessToken(process, TOKEN_QUERY, &token)) return sid;
  DWORD size = 0;
  GetTokenInformation(token, TokenUser, nullptr, 0, &size);
  std::vector<unsigned char> buffer(size);
  if (size > 0 && GetTokenInformation(token, TokenUser, buffer.data(), size, &size)) {
    const PSID user = reinterpret_cast<TOKEN_USER*>(buffer.data())->User.Sid;
    const DWORD length = GetLengthSid(user);
    sid.assign(static_cast<unsigned char*>(user), static_cast<unsigned char*>(user) + length);
  }
  CloseHandle(token);
  return sid;
}

/** Anonymous pipes or a named pipe client handle. Reads poll PeekNamedPipe, which both kinds support. */
class HandleTransport final : public Transport {
 public:
  HandleTransport(HANDLE readHandle, HANDLE writeHandle, bool owns, HANDLE child = nullptr, int exitWaitMs = 0)
      : read_(readHandle), write_(writeHandle), owns_(owns), child_(child), exitWaitMs_(exitWaitMs) {}
  ~HandleTransport() override { Close(); }

  std::size_t Read(char* buffer, std::size_t capacity, int timeoutMs) override {
    if (read_ == nullptr) throw TransportError("playerthree/sidecar: transport closed");
    const ULONGLONG deadline = timeoutMs < 0 ? 0 : GetTickCount64() + static_cast<ULONGLONG>(timeoutMs);
    for (;;) {
      DWORD available = 0;
      if (!PeekNamedPipe(read_, nullptr, 0, nullptr, &available, nullptr)) {
        const DWORD error = GetLastError();
        if (error == ERROR_BROKEN_PIPE || error == ERROR_PIPE_NOT_CONNECTED) {
          throw TransportError("playerthree/sidecar: host closed the connection");
        }
        Fail("PeekNamedPipe");
      }
      if (available > 0) {
        const DWORD want = static_cast<DWORD>(capacity < available ? capacity : available);
        DWORD got = 0;
        if (!ReadFile(read_, buffer, want, &got, nullptr)) Fail("ReadFile");
        return got;
      }
      if (timeoutMs >= 0 && GetTickCount64() >= deadline) return 0;
      Sleep(1);
    }
  }

  void Write(const char* data, std::size_t size) override {
    if (write_ == nullptr) throw TransportError("playerthree/sidecar: transport closed");
    while (size > 0) {
      DWORD wrote = 0;
      const DWORD chunk = static_cast<DWORD>(size > 0x10000000 ? 0x10000000 : size);
      if (!WriteFile(write_, data, chunk, &wrote, nullptr)) Fail("WriteFile");
      data += wrote;
      size -= wrote;
    }
  }

  void Close() override {
    if (owns_) {
      if (write_ != nullptr && write_ != read_) CloseHandle(write_);
      if (read_ != nullptr) CloseHandle(read_);
    }
    read_ = write_ = nullptr;
    if (child_ != nullptr) {
      const bool exited = WaitForSingleObject(child_, static_cast<DWORD>(exitWaitMs_)) != WAIT_TIMEOUT;
      if (!exited) {
        TerminateProcess(child_, 1);
        WaitForSingleObject(child_, INFINITE);
      }
      DWORD code = 0;
      if (exited && GetExitCodeProcess(child_, &code)) exit_ = static_cast<int>(code);
      CloseHandle(child_);
      child_ = nullptr;
    }
  }

  std::optional<int> ExitCode() const override { return exit_; }

 private:
  HANDLE read_;
  HANDLE write_;
  bool owns_;
  HANDLE child_;
  int exitWaitMs_;
  std::optional<int> exit_;
};

/** CommandLineToArgvW-compatible quoting of one argument. */
void AppendQuoted(std::wstring& line, const std::wstring& arg) {
  if (!line.empty()) line.push_back(L' ');
  if (!arg.empty() && arg.find_first_of(L" \t\n\v\"") == std::wstring::npos) {
    line += arg;
    return;
  }
  line.push_back(L'"');
  std::size_t slashes = 0;
  for (wchar_t c : arg) {
    if (c == L'\\') {
      ++slashes;
      continue;
    }
    line.append(c == L'"' ? slashes * 2 + 1 : slashes, L'\\');
    slashes = 0;
    line.push_back(c);
  }
  line.append(slashes * 2, L'\\');
  line.push_back(L'"');
}

}  // namespace

std::unique_ptr<Transport> ConnectSocket(const std::string& path) {
  const std::wstring wide = Widen(path);
  HANDLE pipe = CreateFileW(wide.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING,
                            SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr);
  if (pipe == INVALID_HANDLE_VALUE) Fail("connect pipe " + path);
  ULONG serverPid = 0;
  bool sameUser = false;
  if (GetNamedPipeServerProcessId(pipe, &serverPid)) {
    HANDLE server = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, serverPid);
    if (server != nullptr) {
      const std::vector<unsigned char> mine = UserSid(GetCurrentProcess());
      sameUser = !mine.empty() && mine == UserSid(server);
      CloseHandle(server);
    }
  }
  if (!sameUser) {
    CloseHandle(pipe);
    throw TransportError("playerthree/sidecar: the pipe's host runs as another user");
  }
  return std::make_unique<HandleTransport>(pipe, pipe, true);
}

std::unique_ptr<Transport> SpawnHost(const std::vector<std::string>& argv, int exitWaitMs) {
  if (argv.empty()) throw TransportError("playerthree/sidecar: SpawnHost needs a command");
  SECURITY_ATTRIBUTES inherit{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
  HANDLE childIn = nullptr, toChild = nullptr, fromChild = nullptr, childOut = nullptr;
  if (!CreatePipe(&childIn, &toChild, &inherit, 0)) Fail("CreatePipe");
  if (!CreatePipe(&fromChild, &childOut, &inherit, 0)) {
    CloseHandle(childIn);
    CloseHandle(toChild);
    Fail("CreatePipe");
  }
  // Only the child's ends are inherited.
  SetHandleInformation(toChild, HANDLE_FLAG_INHERIT, 0);
  SetHandleInformation(fromChild, HANDLE_FLAG_INHERIT, 0);
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESTDHANDLES;
  startup.hStdInput = childIn;
  startup.hStdOutput = childOut;
  startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
  std::wstring line;
  for (const std::string& a : argv) AppendQuoted(line, Widen(a));
  PROCESS_INFORMATION process{};
  const BOOL ok = CreateProcessW(nullptr, &line[0], nullptr, nullptr, TRUE, CREATE_NO_WINDOW, nullptr, nullptr,
                                 &startup, &process);
  CloseHandle(childIn);
  CloseHandle(childOut);
  if (!ok) {
    CloseHandle(toChild);
    CloseHandle(fromChild);
    Fail("spawn " + argv[0]);
  }
  CloseHandle(process.hThread);
  return std::make_unique<HandleTransport>(fromChild, toChild, true, process.hProcess, exitWaitMs);
}

void WriteOwnerOnlyFile(const std::string& path, const std::string& contents) {
  const std::wstring wide = Widen(path);
  HANDLE file = CreateFileW(wide.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS,
                            FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  if (file == INVALID_HANDLE_VALUE) Fail("open " + path);
  const char* data = contents.data();
  std::size_t left = contents.size();
  while (left > 0) {
    DWORD wrote = 0;
    if (!WriteFile(file, data, static_cast<DWORD>(left > 0x10000000 ? 0x10000000 : left), &wrote, nullptr)) {
      CloseHandle(file);
      Fail("write " + path);
    }
    data += wrote;
    left -= wrote;
  }
  CloseHandle(file);
}

#endif

}  // namespace playerthree

#if defined(_WIN32) && defined(PLAYERTHREECORE_API)
#include "Windows/HideWindowsPlatformTypes.h"
#endif
