#pragma once

#include <functional>
#include <iostream>
#include <string>
#include <vector>

namespace testing {

struct Case {
  std::string name;
  std::function<void()> fn;
};

inline std::vector<Case>& registry() {
  static std::vector<Case> cases;
  return cases;
}

inline int& failures() {
  static int count = 0;
  return count;
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

inline int run() {
  int passed = 0;
  for (auto& c : registry()) {
    int before = failures();
    c.fn();
    if (failures() == before) {
      ++passed;
      std::cout << "ok   " << c.name << "\n";
    } else {
      std::cout << "FAIL " << c.name << "\n";
    }
  }
  std::cout << "\n" << passed << "/" << registry().size()
            << " cases passed, " << failures() << " assertion(s) failed\n";
  return failures() == 0 ? 0 : 1;
}

}

#define TEST(name)                                            \
  static void name();                                         \
  static ::testing::Register reg_##name{#name, name};         \
  static void name()

#define CHECK(cond) do { if (!(cond)) ::testing::fail(#cond, __FILE__, __LINE__); } while (0)
#define CHECK_FALSE(cond) CHECK(!(cond))
#define CHECK_EQ(a, b) do { if (!((a) == (b))) ::testing::fail(#a " == " #b, __FILE__, __LINE__); } while (0)
