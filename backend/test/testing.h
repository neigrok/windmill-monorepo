#pragma once

#include <csignal>
#include <cstdio>
#include <cstring>
#include <exception>
#include <functional>
#include <iostream>
#include <string>
#include <vector>

#include <unistd.h>

namespace testing {

struct Case {
  std::string name;
  std::function<void()> fn;
};

// One run's whole truth: the cases, the failure tally, and what the case in flight did — whether a
// REQUIRE cut it short, whether it skipped, and its name, kept in a plain buffer the crash reporter
// can read after the process is past trusting malloc.
struct Run {
  std::vector<Case> cases;
  int failures = 0;
  bool stoppedEarly = false;
  std::string skipped;
  char running[192] = {0};
};

inline Run& state() {
  static Run run;
  return run;
}

inline std::vector<Case>& registry() {
  return state().cases;
}

inline int& failures() {
  return state().failures;
}

struct Register {
  Register(std::string name, std::function<void()> fn) {
    registry().push_back({std::move(name), std::move(fn)});
  }
};

inline void fail(const char* expr, const char* file, int line) {
  ++failures();
  std::cerr << "  FAIL " << file << ":" << line << "  " << expr << "\n";
}

// REQUIRE's half: records the failure and answers false so the macro can leave the body before the
// next line dereferences what the check just proved absent.
inline bool required(bool ok, const char* expr, const char* file, int line) {
  if (ok) return true;
  fail(expr, file, line);
  state().stoppedEarly = true;
  return false;
}

inline void skip(const std::string& reason) {
  state().skipped = reason;
}

// A crashing case takes the whole binary with it, so the summary below never prints and every later
// case vanishes without a word. Rescue the one thing worth rescuing — the name of the case in
// flight — with write(2), then re-raise so the exit status still tells the truth.
inline void reportCrash(int sig) {
  const char* head = "\n*** CRASHED mid-case; no later case in this binary ran: ";
  ::write(2, head, std::strlen(head));
  ::write(2, state().running, std::strlen(state().running));
  ::write(2, " ***\n", 5);
  std::signal(sig, SIG_DFL);
  std::raise(sig);
}

inline int run() {
  Run& r = state();
  for (int sig : {SIGSEGV, SIGBUS, SIGILL, SIGFPE, SIGABRT, SIGTRAP}) std::signal(sig, reportCrash);

  int passed = 0;
  int stoppedEarly = 0;
  int skipped = 0;
  for (const Case& c : r.cases) {
    const int before = r.failures;
    r.stoppedEarly = false;
    r.skipped.clear();
    std::snprintf(r.running, sizeof(r.running), "%s", c.name.c_str());

    try {
      c.fn();
    } catch (const std::exception& e) {
      ++r.failures;
      r.stoppedEarly = true;
      std::cerr << "  FAIL threw std::exception: " << e.what() << "\n";
    } catch (...) {
      ++r.failures;
      r.stoppedEarly = true;
      std::cerr << "  FAIL threw a non-std exception\n";
    }

    if (r.failures != before) {
      if (r.stoppedEarly) ++stoppedEarly;
      std::cout << "FAIL " << c.name << (r.stoppedEarly ? "  (stopped before the end)" : "") << "\n";
      continue;
    }
    if (!r.skipped.empty()) {
      ++skipped;
      std::cout << "skip " << c.name << "  (" << r.skipped << ")\n";
      continue;
    }
    ++passed;
    std::cout << "ok   " << c.name << "\n";
  }

  std::cout << "\n" << passed << "/" << r.cases.size() << " cases passed, " << stoppedEarly
            << " stopped before the end, " << skipped << " skipped, " << r.failures
            << " assertion(s) failed\n";
  return r.failures == 0 ? 0 : 1;
}

}

#define TEST(name)                                            \
  static void name();                                         \
  static ::testing::Register reg_##name{#name, name};         \
  static void name()

#define CHECK(cond) do { if (!(cond)) ::testing::fail(#cond, __FILE__, __LINE__); } while (0)
#define CHECK_FALSE(cond) CHECK(!(cond))
#define CHECK_EQ(a, b) do { if (!((a) == (b))) ::testing::fail(#a " == " #b, __FILE__, __LINE__); } while (0)

// REQUIRE is CHECK that leaves the case. Use it wherever the next line depends on the check —
// dereferencing an optional, indexing a container — so a regression reports one failure instead of
// trapping and taking every later case in the binary down with it.
#define REQUIRE(cond) do { if (!::testing::required(static_cast<bool>(cond), #cond, __FILE__, __LINE__)) return; } while (0)

// A case the environment cannot run. The summary counts it as skipped and never as passed.
#define SKIP(reason) do { ::testing::skip(reason); return; } while (0)
