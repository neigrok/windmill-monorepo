#include "platform/adapters/sentry/ObservedTool.h"
#include "test/testing.h"

#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
#include <memory>
#include <regex>
#include <stdexcept>
#include <string>
#include <vector>

using namespace wm;

namespace {
struct Producer {
  std::vector<std::string>& order;
  std::string name;
  std::weak_ptr<int> dependency;
  void stop() {
    REQUIRE(!dependency.expired());
    order.push_back(name);
  }
};

std::string source(const std::filesystem::path& path) {
  std::ifstream file(path);
  return {std::istreambuf_iterator<char>(file), std::istreambuf_iterator<char>()};
}
}

TEST(observability_lifetime_stops_producers_in_reverse_order_before_the_reporter) {
  std::vector<std::string> order;
  auto dependency = std::make_shared<int>(1);
  auto first = std::make_shared<Producer>(Producer{order, "first", dependency});
  auto second = std::make_shared<Producer>(Producer{order, "second", dependency});
  {
    ObservabilityLifetime lifetime([&order] { order.push_back("reporter"); });
    lifetime.watch(first, dependency);
    lifetime.watch(second, dependency);
    first.reset();
    second.reset();
    dependency.reset();
    lifetime.stop();
    lifetime.stop();
  }
  CHECK_EQ(order, (std::vector<std::string>{"second", "first", "reporter"}));
}

TEST(observability_lifetime_stops_all_producers_and_the_reporter_during_exception_unwind) {
  std::vector<std::string> order;
  try {
    ObservabilityLifetime lifetime([&order] { order.push_back("reporter"); });
    lifetime.onStop([&order] { order.push_back("producer"); });
    throw std::runtime_error("PRIVATE_BODY");
  } catch (const std::runtime_error&) {}
  CHECK_EQ(order, (std::vector<std::string>{"producer", "reporter"}));
}

TEST(observability_lifetime_releases_producer_dependencies_before_reporter_shutdown) {
  auto dependency = std::make_shared<int>(1);
  const std::weak_ptr<int> weak = dependency;
  bool released = false;
  {
    ObservabilityLifetime lifetime([&] { released = weak.expired(); });
    lifetime.onStop([] {}, dependency);
    dependency.reset();
  }
  CHECK(released);
}

TEST(observability_lifecycle_covers_every_binary_composition_root) {
  auto backend = std::filesystem::path(__FILE__);
  for (int parent = 0; parent < 5; ++parent) backend = backend.parent_path();
  const std::regex main(R"(int\s+main\s*\([^)]*\)\s*\{)");
  const std::regex lifecycle(R"(\b(ObservabilityLifetime|runObservedTool)\b)");
  std::size_t binaries = 0;
  for (const auto& file : std::filesystem::directory_iterator(backend / "platform/infra")) {
    if (file.path().extension() != ".cpp") continue;
    const std::string code = source(file.path());
    std::smatch match;
    if (!std::regex_search(code, match, main)) continue;
    ++binaries;
    const std::string composition = code.substr(static_cast<std::size_t>(match.position()));
    CHECK(std::regex_search(composition, lifecycle));
  }
  CHECK_EQ(binaries, std::size_t{9});
  const std::string shared = source(backend / "platform/adapters/sentry/ObservedTool.cpp");
  CHECK(shared.find("ObservabilityLifetime lifetime") != std::string::npos);
  CHECK(shared.find("stopLogTee()") != std::string::npos);
  CHECK(shared.find("toolReporter->drain()") != std::string::npos);
  std::cout << "observability lifecycle inventory: " << binaries << " binary composition roots\n";
}
