#pragma once

// The golden corpus of the sync engine (packages/api-contract/sync/corpus, engine.md §11.1), replayed
// as test cases: one case per vector of every file a runner claims, one skipped case per file claimed
// as pending or as the client's, and one failing case for a file nobody claims or a claim with no
// file. A new corpus file therefore cannot go unread.

#include "platform/domain/sync/Jcs.h"
#include "test/testing.h"

#include <algorithm>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iterator>
#include <map>
#include <set>
#include <string>
#include <variant>

namespace wm::sync::corpus {

// Answers one vector's `input` in the shape of its `expect`.
using Runner = std::function<Json::Value(const Json::Value& input)>;

// A file of the server's role, or of every role, that this binary does not run yet, and why.
struct Pending {
  std::string reason;
};

// A file of the client role (corpus/README.md's role table), which no server runner reads.
struct ClientRole {
  std::string reason;
};

// Keyed by a file's path under the corpus ("jcs/values.json"), or by a directory ("admit/") for every
// file in it; a file's own key wins over its directory's.
using Claims = std::map<std::string, std::variant<Runner, Pending, ClientRole>>;

// `{"error": true}` when `answer` throws `Refusal`, the corpus's shape for a function that must fail.
template <typename Refusal, typename Answer>
Json::Value refusedAs(Answer answer) {
  try {
    return answer();
  } catch (const Refusal&) {
    Json::Value error(Json::objectValue);
    error["error"] = true;
    return error;
  }
}

inline void checkSame(const Json::Value& answer, const Json::Value& expect, const char* file, int line) {
  const std::string answered = jcs(answer);
  const std::string expected = jcs(expect);
  if (answered == expected) return;
  const std::string message = "answer " + answered + "\n       expect " + expected;
  ::testing::fail(message.c_str(), file, line);
}

inline void registerFailure(const std::string& name, const std::string& message) {
  ::testing::Register{name, [message] { ::testing::fail(message.c_str(), __FILE__, __LINE__); }};
}

inline void registerVectors(const std::string& file, const std::filesystem::path& path, const Runner& run) {
  std::ifstream stream(path, std::ios::binary);
  const std::string text{std::istreambuf_iterator<char>(stream), std::istreambuf_iterator<char>()};
  Json::Value vectors;
  try {
    vectors = parseJson(text);
  } catch (const JsonError& error) {
    registerFailure("sync_corpus/" + file, std::string("unreadable: ") + error.what());
    return;
  }
  if (!vectors.isArray() || vectors.empty()) {
    registerFailure("sync_corpus/" + file, "is not a non-empty array of vectors");
    return;
  }
  for (const Json::Value& vector : vectors) {
    ::testing::Register{"sync_corpus/" + file + ": " + vector["name"].asString(),
                        [run, vector] { checkSame(run(vector["input"]), vector["expect"], __FILE__, __LINE__); }};
  }
}

inline void registerCorpus(const std::filesystem::path& directory, const Claims& claims) {
  if (!std::filesystem::is_directory(directory)) {
    registerFailure("sync_corpus", "corpus missing at " + directory.string());
    return;
  }

  std::set<std::string> files;
  for (const auto& entry : std::filesystem::recursive_directory_iterator(directory)) {
    const std::string extension = entry.path().extension().string();
    if (entry.is_regular_file() && (extension == ".json" || extension == ".jsonl"))
      files.insert(entry.path().lexically_relative(directory).generic_string());
  }

  for (const std::string& file : files) {
    auto claim = claims.find(file);
    const std::size_t slash = file.find('/');
    if (claim == claims.end() && slash != std::string::npos) claim = claims.find(file.substr(0, slash + 1));
    if (claim == claims.end()) {
      registerFailure("sync_corpus/" + file, "nobody claims corpus/" + file + ": give it a runner, or claim it pending or the client's");
      continue;
    }
    if (const Pending* pending = std::get_if<Pending>(&claim->second)) {
      const std::string reason = "pending: " + pending->reason;
      ::testing::Register{"sync_corpus/" + file, [reason] { SKIP(reason); }};
      continue;
    }
    if (const ClientRole* client = std::get_if<ClientRole>(&claim->second)) {
      const std::string reason = "client role: " + client->reason;
      ::testing::Register{"sync_corpus/" + file, [reason] { SKIP(reason); }};
      continue;
    }
    registerVectors(file, directory / file, std::get<Runner>(claim->second));
  }

  for (const auto& claim : claims) {
    const std::string& claimed = claim.first;
    const bool present = claimed.ends_with('/')
                             ? std::any_of(files.begin(), files.end(), [&claimed](const std::string& file) { return file.starts_with(claimed); })
                             : files.contains(claimed);
    if (!present) registerFailure("sync_corpus/" + claimed, "is claimed, but the corpus has no such file");
  }
}

}
