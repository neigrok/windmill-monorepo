#include "products/roadmap/sync/PgRoadmap.h"

#include "platform/adapters/postgres/PgSyncStore.h"
#include "platform/application/WriteObservation.h"
#include "products/roadmap/adapters/json/CommandJson.h"
#include "platform/adapters/json/JsonText.h"
#include "products/roadmap/sync/RoadmapDeeds.h"

#include <map>
#include <stdexcept>
#include <string>
#include <utility>

namespace wm::roadmap::engine {

using namespace sync;

namespace {

// Each type's table and its fields' value columns, as db/schema.sql builds them. A step's note keeps one superseded
// head (§6.11 step 4).
TableMap tableOf(const std::string& type) {
  static const std::map<std::string, TableMap> tables{
      {"tree", {"roadmap_trees", {{"parent", SqlType::jsonb}}}},
      {"meta",
       {"roadmap_metas",
        {{"title", SqlType::text},
         {"guide", SqlType::text},
         {"guideInherited", SqlType::boolean},
         {"visibility", SqlType::text},
         {"reach", SqlType::text},
         {"root", SqlType::text},
         {"parent", SqlType::jsonb},
         {"depth", SqlType::bigint},
         {"forkedFrom", SqlType::text}}}},
      {"node",
       {"roadmap_nodes",
        {{"label", SqlType::text},
         {"icon", SqlType::text},
         {"color", SqlType::text},
         {"ord", SqlType::text},
         {"status", SqlType::text},
         {"description", SqlType::text},
         {"links", SqlType::jsonb},
         {"branch", SqlType::text}}}},
      {"edge", {"roadmap_edges", {}}},
      {"kind", {"roadmap_kinds", {{"hue", SqlType::text}, {"label", SqlType::text}, {"description", SqlType::text}, {"ord", SqlType::text}}}},
      {"progress", {"roadmap_progress", {{"mark", SqlType::jsonb}}}},
      {"pointer", {"roadmap_pointers", {{"opens", SqlType::text}}}},
      {"subtask", {"roadmap_subtasks", {{"step", SqlType::text}, {"label", SqlType::text}, {"done", SqlType::boolean}, {"ord", SqlType::text}}}},
      {"stepLink", {"roadmap_step_links", {{"step", SqlType::text}, {"url", SqlType::text}, {"title", SqlType::text}, {"ord", SqlType::text}}}},
      {"stepNote", {"roadmap_step_notes", {{"text", SqlType::text}}, 1}},
      {"coachThread", {"roadmap_coach_threads", {{"treeId", SqlType::text}, {"stepId", SqlType::text}, {"title", SqlType::text}}}},
      {"coachMessage",
       {"roadmap_coach_messages",
        {{"threadId", SqlType::text},
         {"role", SqlType::text},
         {"replica", SqlType::text},
         {"text", SqlType::text},
         {"state", SqlType::text},
         {"truncated", SqlType::boolean},
         {"refusal", SqlType::text},
         {"calls", SqlType::jsonb},
         {"receipts", SqlType::jsonb},
         {"proposalId", SqlType::text},
         {"pictures", SqlType::jsonb},
         {"at", SqlType::bigint}}}},
      {"coachProposal",
       {"roadmap_coach_proposals",
        {{"treeId", SqlType::text},
         {"threadId", SqlType::text},
         {"messageId", SqlType::text},
         {"base", SqlType::jsonb},
         {"changes", SqlType::jsonb},
         {"state", SqlType::text},
         {"undone", SqlType::boolean}}}},
      {"coachWriteFate",
       {"roadmap_coach_write_fates", {{"messageId", SqlType::text}, {"receipt", SqlType::bigint}, {"fate", SqlType::text}, {"code", SqlType::text}}}},
  };
  const auto table = tables.find(type);
  if (table == tables.end()) throw std::logic_error("roadmap stores no table for the type " + type);
  return table->second;
}

// The deed's commands, a Batch's members each.
std::vector<Command> membersOf(const Command& command) {
  if (const Batch* batch = std::get_if<Batch>(&command)) return batch->commands;
  return {command};
}

// §7's activity feed in tree_ops: one row a gesture leaves a deed in a roadmap, at the roadmap's seq as the gesture's
// latest intent there commits it, `created_at` the time the server received the gesture's first. A later intent of the
// gesture folds its deed into the row and moves it to its own seq, so a reader whose cursor passed the earlier seq is
// told the whole deed again, under the same op_id. A row that already holds the seq is a roadmap whose engine seq did not
// continue above its old head (§8.1): the intent still lands, and the deed is reported lost rather than written over
// another.
class PgDeeds final : public Deeds {
public:
  void record(SyncTxn& txn, const Deed& deed) override {
    dynamic_cast<PgSyncTxn&>(txn).beforeCommit([&txn, deed] {
      pqxx::transaction_base& sql = sqlOf(txn);
      const pqxx::result scope = sql.exec("select seq from sync_scopes where key = $1", pqxx::params{ScopeKey::tree(deed.tree).text()});
      const long long seq = scope.at(0).at(0).as<long long>();
      const std::string op = deed.gesture ? "gesture:" + *deed.gesture : "seq:" + std::to_string(seq);
      const pqxx::result held = sql.exec("select kind, payload::text from tree_ops where tree_id = $1 and op_id = $2 for update",
                                         pqxx::params{pgText(deed.tree), pgText(op)});
      if (!sql.exec("select 1 from tree_ops where tree_id = $1 and seq = $2", pqxx::params{pgText(deed.tree), seq}).empty()) {
        reportWriteFailure("roadmap.activity.record", "roadmap", currentWriteDoor(), "seq-taken", currentWriteRequestId(), {});
        return;
      }
      if (held.empty()) {
        sql.exec("insert into tree_ops (tree_id, seq, actor_id, op_id, kind, payload, hlc) values ($1, $2, $3, $4, $5, $6::jsonb, '')",
                 pqxx::params{pgText(deed.tree), seq, deed.actor.str(), pgText(op), commandKind(deed.what), dump(commandPayload(deed.what))});
        return;
      }
      std::vector<Command> members;
      if (std::optional<Command> earlier = commandFromJson(held[0][0].as<std::string>(), parse(held[0][1].as<std::string>())))
        members = membersOf(*earlier);
      for (Command& member : membersOf(deed.what)) members.push_back(std::move(member));
      const Command folded{Batch{std::move(members)}};
      sql.exec("update tree_ops set seq = $3, kind = $4, payload = $5::jsonb where tree_id = $1 and op_id = $2",
               pqxx::params{pgText(deed.tree), pgText(op), seq, commandKind(folded), dump(commandPayload(folded))});
    });
  }
};

}

// Roadmap's types are those of its product scope and of the trees and overlays its `tree` records govern, the only
// governed scopes of the composition.
PgRoadmap::PgRoadmap(const sync::Registry& registry) : deeds_(std::make_unique<PgDeeds>()), product_(*deeds_) {
  for (const sync::TypeDef& type : registry.types()) {
    if (type.scope == sync::RegistryScope{sync::ScopeKind::product, "roadmap"} || type.scope.kind != sync::ScopeKind::product)
      tables_.push_back(std::make_unique<sync::PgTableType>(type, tableOf(type.name)));
  }
}

PgRoadmap::~PgRoadmap() = default;

void PgRoadmap::bindTo(sync::SyncCatalog& catalog) {
  std::map<std::string, sync::TypeStore*> stores;
  for (const auto& table : tables_) stores.emplace(table->def().name, table.get());
  product_.bindTo(catalog, stores);
}

}
