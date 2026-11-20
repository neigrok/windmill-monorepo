#pragma once

#include "products/roadmap/adoption/Adoption.h"
#include "products/roadmap/adoption/Audit.h"
#include "products/roadmap/adoption/PgAdoption.h"

#include <json/json.h>

#include <filesystem>
#include <map>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

// Roadmap's cutover onto the sync engine, stage by stage (Roadmap on the sync engine §8.1, §11): what each stage did,
// as counts and a verdict anyone may read, and what it read and wrote, ids and text included, into a private record.

namespace wm::roadmap::adoption {

// What one stage did: its verdict, whether the cutover may go on past it, and its counts.
struct StageReport {
  std::string stage;
  std::string verdict;
  bool passed = false;
  Tally counts;
  std::int64_t ms = 0;

  // One line for a public log: the stage, its verdict, its time and its counts, never an id or a text.
  Json::Value toJson() const;
};

// A stage that failed before its end, and what it had counted by then, the failure's static code among the counts.
struct StageFailure : std::runtime_error {
  explicit StageFailure(StageReport report);

  StageReport report;
};

// The files a stage writes what it read into, one JSON value a line, in a directory kept apart from every log and meant
// to be encrypted before it leaves the machine; with no directory nothing is written. Each stage's file replaces the
// one an earlier run of it wrote, readable by its owner alone.
class PrivateRecord {
public:
  explicit PrivateRecord(std::optional<std::filesystem::path> directory);
  bool kept() const { return directory_.has_value(); }
  void write(const std::string& name, const std::vector<Json::Value>& lines) const;
  // The lines an earlier stage wrote, none where it wrote no file.
  std::optional<std::vector<Json::Value>> read(const std::string& name) const;

private:
  std::optional<std::filesystem::path> directory_;
};

// What the old server's read models answered, and how many of their reads failed: their routes count each failure rather
// than report it, since a roadmap the old server cannot read today fails every read of it.
struct OldAnswers {
  std::vector<Json::Value> answers;
  std::uint64_t failedReads = 0;
};

// The old server's read models, built as windmill_server builds them without ROADMAP_ENGINE_ENABLED, and the new ones,
// built as it builds them with it (ReadModels.h asks both the same questions).
class ReadModelServers {
public:
  virtual ~ReadModelServers() = default;
  // The old server opens every roadmap it can and closes it again, writing what it writes on opening one: a roadmap
  // stored only as a whole document unfolded into rows, a head behind its activity taken past it. Counts what it opened
  // and what it could not.
  virtual Tally settleOld(const Survey& survey) = 0;
  virtual OldAnswers askOld(const Survey& survey) = 0;
  virtual std::vector<Json::Value> askNew(const Survey& survey) = 0;
};

// The stages, run in this order by the cutover: `unfold` lets the old server open every roadmap, unfolding a whole
// document into rows; `read-models-before` asks the old server's read models and keeps their answers in the private
// record; `before` reads every roadmap and says whether the move may run; `adopt` writes the engine's tables, one owner a
// transaction, so a run cut short is run again; `demo` seeds the public demo under the house account where the engine
// lacks it; `after` reads every adopted roadmap back through the read domain and compares it with what roadmap's tables
// hold; `read-models` asks the new read models the same questions and compares; `digests` sums every scope from its rows.
class Cutover {
public:
  Cutover(PgAdoption& adoption, Expectation expectation, PrivateRecord record, ReadModelServers& servers);

  static const std::vector<std::string>& stages();
  // The stage, unless another client is connected to the database: the server is stopped for the move, and nothing
  // else may write roadmap's tables while it runs. Throws StageFailure for a stage that fails before its end.
  StageReport run(const std::string& stage);

private:
  StageReport unfold();
  StageReport readModelsBefore();
  StageReport before();
  StageReport adopt();
  StageReport demo();
  StageReport after();
  StageReport readModels();
  StageReport digests();

  PgAdoption& adoption_;
  Expectation expectation_;
  PrivateRecord record_;
  ReadModelServers& servers_;
};

}
