// Copyright 2026 The PlayerThree authors
// SPDX-License-Identifier: Apache-2.0

// Minimal test harness (no external test framework): TEST registers a case, CHECK records a failure and carries on,
// THROWS expects an exception type and optional predicate. main() runs every case and exits non-zero on failure.
#pragma once

#include <functional>
#include <iostream>
#include <string>
#include <vector>

namespace check {

struct Case {
  const char* name;
  std::function<void()> body;
};

inline std::vector<Case>& Cases() {
  static std::vector<Case> cases;
  return cases;
}

inline int& Failures() {
  static int failures = 0;
  return failures;
}

struct Register {
  Register(const char* name, std::function<void()> body) { Cases().push_back({name, std::move(body)}); }
};

inline void Fail(const char* file, int line, const std::string& what) {
  ++Failures();
  std::cerr << file << ":" << line << ": FAILED " << what << "\n";
}

inline int RunAll() {
  for (const Case& c : Cases()) {
    const int before = Failures();
    try {
      c.body();
    } catch (const std::exception& e) {
      Fail(c.name, 0, std::string("unexpected exception: ") + e.what());
    }
    std::cerr << (Failures() == before ? "ok   " : "FAIL ") << c.name << "\n";
  }
  std::cerr << Cases().size() << " cases, " << Failures() << " failures\n";
  return Failures() == 0 ? 0 : 1;
}

}  // namespace check

#define CHECK_CAT2(a, b) a##b
#define CHECK_CAT(a, b) CHECK_CAT2(a, b)
#define TEST(name)                                                                   \
  static void CHECK_CAT(test_, name)();                                              \
  static const check::Register CHECK_CAT(register_, name)(#name, CHECK_CAT(test_, name)); \
  static void CHECK_CAT(test_, name)()

#define CHECK(cond)                                     \
  do {                                                  \
    if (!(cond)) check::Fail(__FILE__, __LINE__, #cond); \
  } while (0)

#define CHECK_EQ(a, b)                                                                                  \
  do {                                                                                                  \
    /* copies: `a` may be a reference into a temporary */                                              \
    const auto check_a = (a);                                                                           \
    const auto check_b = (b);                                                                           \
    if (!(check_a == check_b)) check::Fail(__FILE__, __LINE__, std::string(#a " == " #b));              \
  } while (0)

/** Runs `expr`, expecting it to throw `Type`; `pred(e)` must hold for the caught exception. */
#define THROWS_IF(expr, Type, pred)                                                       \
  do {                                                                                    \
    bool check_thrown = false;                                                            \
    try {                                                                                 \
      (void)(expr);                                                                       \
    } catch (const Type& e) {                                                             \
      check_thrown = true;                                                                \
      if (!(pred)) check::Fail(__FILE__, __LINE__, std::string(#expr " threw, but not " #pred)); \
    }                                                                                     \
    if (!check_thrown) check::Fail(__FILE__, __LINE__, std::string(#expr " did not throw " #Type)); \
  } while (0)

#define THROWS(expr, Type) THROWS_IF(expr, Type, true)

#define TEST_MAIN() \
  int main() { return check::RunAll(); }
