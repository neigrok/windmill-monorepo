#pragma once

// The golden corpus of the sync engine (packages/api-contract/sync/corpus, engine.md §11.1), replayed
// as test cases: one case per vector of every file a runner claims, one skipped case per file claimed
// as pending, another binary's or the client's, and one failing case for a file nobody claims or a claim with no
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
#include <vector>

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

// A server file exercised by a named binary against its required store.
struct ExternalRunner {
  std::string binary;
};

// A file that is one value rather than a list of vectors (constants.json), checked whole in one case.
struct FileCheck {
  std::function<void(const Json::Value& file)> check;
};

// A transcript (.jsonl): its lines, one JSON value each, replayed whole in one case.
struct Transcript {
  std::function<void(const std::vector<Json::Value>& lines)> replay;
};

// Keyed by a file's path under the corpus ("jcs/values.json"), or by a directory ("admit/") for every
// file in it; a file's own key wins over its directory's.
using Claims = std::map<std::string, std::variant<Runner, Pending, ClientRole, ExternalRunner, FileCheck, Transcript>>;

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

inline Json::Value readCorpusFile(const std::filesystem::path& path) {
  std::ifstream stream(path, std::ios::binary);
  return parseJson(std::string{std::istreambuf_iterator<char>(stream), std::istreambuf_iterator<char>()});
}

inline void registerFileCheck(const std::string& file, const std::filesystem::path& path, const FileCheck& claim) {
  ::testing::Register{"sync_corpus/" + file, [path, claim] { claim.check(readCorpusFile(path)); }};
}

inline void registerTranscript(const std::string& file, const std::filesystem::path& path, const Transcript& claim,
                               const std::function<const char*()>& skipReason = {}) {
  ::testing::Register{"sync_corpus/" + file, [path, claim, skipReason] {
                        if (skipReason && skipReason()) SKIP(skipReason());
                        std::ifstream stream(path, std::ios::binary);
                        std::vector<Json::Value> lines;
                        for (std::string line; std::getline(stream, line);) {
                          if (!line.empty()) lines.push_back(parseJson(line));
                        }
                        claim.replay(lines);
                      }};
}

inline void registerVectors(const std::string& file, const std::filesystem::path& path, const Runner& run,
                            const std::function<const char*()>& skipReason = {}) {
  Json::Value vectors;
  try {
    vectors = readCorpusFile(path);
  } catch (const JsonError& error) {
    registerFailure("sync_corpus/" + file, std::string("unreadable: ") + error.what());
    return;
  }
  if (!vectors.isArray() || vectors.empty()) {
    registerFailure("sync_corpus/" + file, "is not a non-empty array of vectors");
    return;
  }
  for (const Json::Value& vector : vectors) {
    ::testing::Register{"sync_corpus/" + file + ": " + vector["name"].asString(), [run, vector, skipReason] {
                          if (skipReason && skipReason()) SKIP(skipReason());
                          checkSame(run(vector["input"]), vector["expect"], __FILE__, __LINE__);
                        }};
  }
}

// A second binary's reading of part of the corpus over another backend: the vectors of the named files (a
// key ending in '/' names every file of that directory without a key of its own), each skipped while
// `skipReason` answers one. Coverage stays the domain binary's registerCorpus; a named file the corpus lacks
// still fails.
inline void registerFiles(const std::filesystem::path& directory, const std::map<std::string, std::variant<Runner, Transcript>>& files,
                          const std::function<const char*()>& skipReason) {
  if (!std::filesystem::is_directory(directory)) {
    registerFailure("sync_corpus", "corpus missing at " + directory.string());
    return;
  }
  for (const auto& [claimed, run] : files) {
    std::set<std::string> matched;
    if (!claimed.ends_with('/')) {
      if (std::filesystem::exists(directory / claimed)) matched.insert(claimed);
    } else {
      for (const auto& entry : std::filesystem::directory_iterator(directory / claimed)) {
        const std::string file = claimed + entry.path().filename().string();
        if (entry.is_regular_file() && !files.contains(file)) matched.insert(file);
      }
    }
    if (matched.empty()) registerFailure("sync_corpus/" + claimed, "is claimed, but the corpus has no such file");
    for (const std::string& file : matched) {
      if (const Transcript* transcript = std::get_if<Transcript>(&run)) registerTranscript(file, directory / file, *transcript, skipReason);
      else registerVectors(file, directory / file, std::get<Runner>(run), skipReason);
    }
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
      registerFailure("sync_corpus/" + file, "nobody claims corpus/" + file + ": give it a runner, or name its pending, external or client owner");
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
    if (const ExternalRunner* external = std::get_if<ExternalRunner>(&claim->second)) {
      const std::string reason = "external runner: " + external->binary;
      ::testing::Register{"sync_corpus/" + file, [reason] { SKIP(reason); }};
      continue;
    }
    if (const FileCheck* whole = std::get_if<FileCheck>(&claim->second)) {
      registerFileCheck(file, directory / file, *whole);
      continue;
    }
    if (const Transcript* transcript = std::get_if<Transcript>(&claim->second)) {
      registerTranscript(file, directory / file, *transcript);
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
