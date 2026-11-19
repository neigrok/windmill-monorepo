#include "products/roadmap/adoption/Cutover.h"

#include "platform/adapters/json/JsonText.h"
#include "products/roadmap/adoption/ReadModels.h"

#include <chrono>
#include <fstream>
#include <stdexcept>

namespace wm::roadmap::adoption {

namespace {

// Every document by its roadmap's id, a line each.
std::vector<Json::Value> linesOf(const std::map<std::string, Document>& documents) {
  std::vector<Json::Value> lines;
  for (const auto& [id, document] : documents) lines.push_back(document.toJson());
  return lines;
}

}

Json::Value StageReport::toJson() const {
  Json::Value out(Json::objectValue);
  out["stage"] = stage;
  out["verdict"] = verdict;
  out["ms"] = Json::Int64(ms);
  out["counts"] = counts.toJson();
  return out;
}

StageFailure::StageFailure(StageReport report)
    : std::runtime_error("a stage of the roadmap adoption failed before its end"), report(std::move(report)) {}

PrivateRecord::PrivateRecord(std::optional<std::filesystem::path> directory) : directory_(std::move(directory)) {}

void PrivateRecord::write(const std::string& name, const std::vector<Json::Value>& lines) const {
  if (!directory_) return;
  std::filesystem::create_directories(*directory_);
  std::filesystem::permissions(*directory_, std::filesystem::perms::owner_all, std::filesystem::perm_options::replace);
  const std::filesystem::path file = *directory_ / name;
  {
    std::ofstream out(file, std::ios::trunc);
    std::filesystem::permissions(file, std::filesystem::perms::owner_read | std::filesystem::perms::owner_write,
                                 std::filesystem::perm_options::replace);
    for (const Json::Value& line : lines) out << dump(line) << '\n';
    if (!out) throw std::runtime_error("the private record could not be written");
  }
}

std::optional<std::vector<Json::Value>> PrivateRecord::read(const std::string& name) const {
  if (!directory_) return std::nullopt;
  std::ifstream in(*directory_ / name);
  if (!in) return std::nullopt;
  std::vector<Json::Value> lines;
  for (std::string line; std::getline(in, line);) {
    if (!line.empty()) lines.push_back(parse(line));
  }
  return lines;
}

Cutover::Cutover(PgAdoption& adoption, Expectation expectation, PrivateRecord record, ReadModelServers& servers)
    : adoption_(adoption), expectation_(std::move(expectation)), record_(std::move(record)), servers_(servers) {}

const std::vector<std::string>& Cutover::stages() {
  static const std::vector<std::string> order{"unfold", "read-models-before", "before", "adopt", "demo", "after", "read-models", "digests"};
  return order;
}

StageReport Cutover::run(const std::string& stage) {
  const auto started = std::chrono::steady_clock::now();
  StageReport report;
  if (const std::uint64_t others = adoption_.otherSessions(); others > 0) {
    report.verdict = "othersConnected";
    report.counts.add("sessions.otherClients", others);
  } else if (stage == "unfold") report = unfold();
  else if (stage == "read-models-before") report = readModelsBefore();
  else if (stage == "before") report = before();
  else if (stage == "adopt") report = adopt();
  else if (stage == "demo") report = demo();
  else if (stage == "after") report = after();
  else if (stage == "read-models") report = readModels();
  else if (stage == "digests") report = digests();
  else throw std::invalid_argument("no such stage");
  report.stage = stage;
  report.ms = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - started).count();
  return report;
}

// The old server's reading of every roadmap, one document each, what the move would count, and whether anything stops it.
StageReport Cutover::before() {
  const Survey survey(adoption_.oldTables(), expectation_);
  const OldReadings old = adoption_.oldReadings(survey);
  const std::map<std::string, Document> documents = documentsBefore(old.readings, expectation_, survey.accounts());
  record_.write("before.jsonl", linesOf(documents));
  const Plan planned = plan(survey);
  std::vector<std::pair<std::string, std::string>> stoppedBy = survey.stoppedBy();
  for (const std::string& roadmap : adoption_.scopesInTheWay(planned)) stoppedBy.emplace_back(roadmap, "stop.scopeAlreadyThere");
  std::vector<Json::Value> stops;
  StageReport report;
  for (const auto& [roadmap, reason] : stoppedBy) {
    Json::Value line(Json::objectValue);
    line["roadmap"] = roadmap;
    line["reason"] = reason;
    stops.push_back(line);
    report.counts.add(reason);
  }
  record_.write("stops.jsonl", stops);
  report.passed = stoppedBy.empty();
  report.verdict = report.passed ? "ready" : "stops";
  report.counts += survey.tally();
  report.counts += planned.tally;
  report.counts.add("documents.before", documents.size());
  report.counts.add("documents.unreadableToday", old.unreadable.size());
  return report;
}

// Every owner's roadmaps that hold no `tree` record yet, one owner a transaction, nothing while anything stops the move.
StageReport Cutover::adopt() {
  const Survey survey(adoption_.oldTables(), expectation_);
  const Plan planned = plan(survey);
  StageReport report{.verdict = "stops"};
  report.counts += planned.stops;
  if (planned.stopped()) return report;
  const std::vector<std::string> inTheWay = adoption_.scopesInTheWay(planned);
  if (!inTheWay.empty()) {
    report.counts.add("stop.scopeAlreadyThere", inTheWay.size());
    std::vector<Json::Value> lines;
    for (const std::string& roadmap : inTheWay) {
      Json::Value line(Json::objectValue);
      line["roadmap"] = roadmap;
      line["reason"] = "scopeAlreadyThere";
      lines.push_back(line);
    }
    record_.write("adopt-failure.jsonl", lines);
    return report;
  }
  if (!adoption_.houseStands()) {
    report.counts.add("stop.houseAddressTaken");
    return report;
  }
  for (const OwnerPlan& owner : planned.owners) {
    try {
      const Written written = adoption_.write(owner);
      report.counts.add("adopted.roadmaps", written.adopted);
      report.counts.add("adopted.owners", written.adopted > 0 ? 1 : 0);
      report.counts.add("alreadyAdopted.roadmaps", written.already);
    } catch (const AdoptionFailure& failure) {
      Json::Value line(Json::objectValue);
      line["owner"] = owner.owner.str();
      line["roadmap"] = failure.roadmap;
      line["reason"] = failure.code;
      record_.write("adopt-failure.jsonl", {line});
      report.counts.add((failure.stops ? "stop." : "failure.") + failure.code);
      if (!failure.stops) throw StageFailure(std::move(report));
      return report;
    }
  }
  if (report.counts["adopted.roadmaps"] > 0) report.counts += planned.tally;
  report.verdict = report.counts["adopted.roadmaps"] > 0 ? "adopted" : "unchanged";
  report.passed = true;
  return report;
}

// The public demo, adopted from the rows db/schema.sql seeds where the engine holds no record of it; one it holds, alive
// or deleted, is never written again.
StageReport Cutover::demo() {
  if (adoption_.adopted(kDemoRoadmap)) return StageReport{.verdict = "present", .passed = true};
  const Survey survey(adoption_.oldTables(), expectation_);
  const Plan planned = plan(survey, std::set<std::string>{kDemoRoadmap});
  StageReport report{.verdict = "stops"};
  report.counts += planned.stops;
  if (planned.stopped()) return report;
  if (planned.owners.empty()) return StageReport{.verdict = "noSource"};
  if (!adoption_.houseStands()) {
    report.counts.add("stop.houseAddressTaken");
    return report;
  }
  for (const OwnerPlan& owner : planned.owners) report.counts.add("adopted.roadmaps", adoption_.write(owner).adopted);
  report.verdict = "seeded";
  report.passed = true;
  return report;
}

// Every roadmap the move adopts, read back through the binding and the read domain and compared with the old server's own
// reading of it, one it cannot read counted apart; each deleted one's id spent.
StageReport Cutover::after() {
  const Survey survey(adoption_.oldTables(), expectation_);
  const OldReadings old = adoption_.oldReadings(survey);
  const std::map<std::string, Document> before = documentsBefore(old.readings, expectation_, survey.accounts());
  std::map<std::string, Document> after;
  for (const UserId& owner : adoption_.owners()) after.merge(documentsAfter(adoption_.roadmapsOf(owner)));
  record_.write("after.jsonl", linesOf(after));

  StageReport report{.verdict = "same"};
  std::vector<Json::Value> differ;
  for (const auto& [id, document] : before) {
    const auto read = after.find(id);
    std::vector<std::string> sections = read == after.end() ? std::vector<std::string>{"missing"} : differences(document, read->second);
    if (sections.empty()) {
      report.counts.add("roadmaps.same");
      continue;
    }
    report.counts.add("roadmaps.differ");
    Json::Value line(Json::objectValue);
    line["roadmap"] = id;
    line["sections"] = Json::Value(Json::arrayValue);
    for (const std::string& section : sections) {
      report.counts.add("differ." + section);
      line["sections"].append(section);
    }
    differ.push_back(line);
  }
  for (const auto& [id, document] : after) {
    if (old.unreadable.contains(id)) report.counts.add("roadmaps.unreadableToday");
    else if (!before.contains(id)) report.counts.add("roadmaps.inTheEngineAlone");
  }
  for (const auto& [id, roadmap] : survey.roadmaps()) {
    if (roadmap.deleted) report.counts.add(adoption_.adopted(id) ? "spentIds.held" : "spentIds.missing");
  }
  record_.write("differences.jsonl", differ);
  const bool same = report.counts["roadmaps.differ"] == 0 && report.counts["spentIds.missing"] == 0;
  report.verdict = same ? "same" : "differs";
  report.passed = same;
  return report;
}

// The old server's own opening of every roadmap, and what it unfolded.
StageReport Cutover::unfold() {
  std::set<std::string> documents;
  {
    const Survey survey(adoption_.oldTables(), expectation_);
    for (const auto& [id, surveyed] : survey.roadmaps()) {
      if (surveyed.roadmap->wholeDocument) documents.insert(id);
    }
  }
  StageReport report{.verdict = "unfolded", .passed = true};
  {
    const Survey survey(adoption_.oldTables(), expectation_);
    report.counts += servers_.settleOld(survey);
  }
  const Survey settled(adoption_.oldTables(), expectation_);
  for (const auto& [id, surveyed] : settled.roadmaps()) {
    if (!documents.contains(id)) continue;
    report.counts.add(surveyed.roadmap->wholeDocument ? "wholeDocuments.leftAsTheyWere" : "wholeDocuments.unfoldedIntoRows");
  }
  return report;
}

// The old server's answers, kept for the read-models stage to compare the new server's with.
StageReport Cutover::readModelsBefore() {
  if (!record_.kept()) return StageReport{.verdict = "noPrivateRecord"};
  const Survey survey(adoption_.oldTables(), expectation_);
  const std::vector<Json::Value> answers = servers_.askOld(survey);
  record_.write("read-models-before.jsonl", answers);
  StageReport report{.verdict = "asked", .passed = true};
  report.counts.add("answers", answers.size());
  return report;
}

StageReport Cutover::readModels() {
  const std::optional<std::vector<Json::Value>> old = record_.read("read-models-before.jsonl");
  if (!old) return StageReport{.verdict = "nothingAskedBefore"};
  const Survey survey(adoption_.oldTables(), expectation_);
  return compareAnswers(*old, servers_.askNew(survey), record_);
}

// Every alive scope summed from its rows (§6.12), against the digest its row holds; and every tree's `open`, which lets a
// stranger read it, against its reach.
StageReport Cutover::digests() {
  StageReport report;
  std::vector<Json::Value> differ;
  for (const Summed& summed : adoption_.sums()) {
    report.counts.add("scopes.summed");
    report.counts.add(summed.digestHolds ? "scopes.digestHolds" : "scopes.digestDiffers");
    if (!summed.seqHolds) report.counts.add("scopes.seqBelowARow");
    if (!summed.openHolds) report.counts.add("scopes.openDiffersFromItsReach");
    if (summed.digestHolds && summed.seqHolds && summed.openHolds) continue;
    differ.push_back(Json::Value(summed.key.text()));
  }
  record_.write("digests.jsonl", differ);
  report.passed = differ.empty();
  report.verdict = report.passed ? "summed" : "differs";
  return report;
}

}
