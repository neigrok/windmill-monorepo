#include "products/roadmap/sync/PgRoadmap.h"

#include <map>
#include <stdexcept>
#include <string>

namespace wm::roadmap::engine {

using sync::SqlType;
using sync::TableMap;

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

}

// Roadmap's types are those of its product scope and of the trees and overlays its `tree` records govern, the only
// governed scopes of the composition.
PgRoadmap::PgRoadmap(const sync::Registry& registry) {
  for (const sync::TypeDef& type : registry.types()) {
    if (type.scope == sync::RegistryScope{sync::ScopeKind::product, "roadmap"} || type.scope.kind != sync::ScopeKind::product)
      tables_.push_back(std::make_unique<sync::PgTableType>(type, tableOf(type.name)));
  }
}

void PgRoadmap::bindTo(sync::SyncCatalog& catalog) {
  std::map<std::string, sync::TypeStore*> stores;
  for (const auto& table : tables_) stores.emplace(table->def().name, table.get());
  product_.bindTo(catalog, stores);
}

}
