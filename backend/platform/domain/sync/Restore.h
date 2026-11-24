#pragma once

#include "platform/domain/sync/Record.h"
#include "platform/domain/sync/Registry.h"

#include <json/json.h>

#include <functional>
#include <optional>
#include <string>
#include <vector>

namespace wm::sync {

// K-3 Undo of an act on the server (§6.4): the fixed arguments of an engine `restore` command and of an
// `inverse` command's evidence, and the one evaluation of restore operations. Slots and versions use the
// E-7 receipt encoding: {kind: born|life} | {kind: field|text, name}, {kind: stamp, stamp} | {kind: text, revision}.

// §6.4: {expectedEpoch, operations: [field | createdRecord | createRecord]}, every operation of a type the
// command restores.
bool admitsRestoreArguments(const Registry& registry, const CommandDef& command, const Json::Value& args);
// §6.4: {expectedEpoch, ownedFields, unchangedCreatedRecords, unchangedCreatedScopes}.
bool admitsEvidence(const Registry& registry, const Json::Value& evidence);

// The E-7 version a slot of a stored row carries now, or null when the register is unset.
Json::Value versionIn(const std::optional<Row>& row, const Json::Value& slot);
// A stored row's complete versioned footprint in E-7 slot order.
Json::Value footprintOf(const Row& row);

// What a restore reads of the intent's scope: a locked row and whether its id is wholly absent.
struct RestoreReader {
  std::function<std::optional<Row>(const std::string& type, const RecordId& id)> stored;
  std::function<bool(const std::string& type, const RecordId& id)> absent;
};

struct RestoreOutcome {
  std::vector<Delta> deltas;  // one a record, every stamp unset for step 9
  Json::Value outcomes;       // [{index, s: applied | skipped, code?}]
};

// Each operation holds or skips on its own condition, in order; those that hold write back their earlier
// values, a keyed record's revival with the values it carries where the stored record is dead (§6.4 restore).
RestoreOutcome evaluateRestore(const Registry& registry, const RestoreReader& read, const Json::Value& args, const std::string& epoch);

// What an inverse command reads to check its evidence: rows and scope sequences by ScopeRef.
struct EvidenceReader {
  std::function<std::optional<Row>(const std::string& scope, const std::string& type, const RecordId& id)> row;
  std::function<std::optional<Seq>(const std::string& scope)> seq;
};

// The first condition the evidence breaks, or nothing: epoch-changed, version-changed, record-changed or
// scope-changed.
std::optional<std::string> evidenceSkip(const EvidenceReader& read, const Json::Value& evidence, const std::string& epoch);

// The command detail an inverse command answers with one outcome: applied, or skipped with its code.
Json::Value inverseDetail(const std::optional<std::string>& skip);
// Whether a command detail reports an inverse command's one outcome, as inverseDetail writes it.
bool reportsInverseOutcome(const Json::Value& detail);

}
