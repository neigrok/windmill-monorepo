#pragma once

#include "products/journal/sync/JournalProduct.h"

#include <pqxx/pqxx>

namespace wm::journal::engine {

class PgJournalState final : public JournalState {
public:
  Json::Value load(sync::SyncTxn&, const sync::ScopeKey&) override;
  void receipt(sync::SyncTxn&, const sync::ScopeKey&, const std::string&, const Json::Value&) override;
  void saveClock(sync::SyncTxn&, const sync::ScopeKey&, const Json::Value&) override;
};

class PgJournalType final : public sync::TypeStore {
public:
  explicit PgJournalType(const sync::TypeDef& type);
  const sync::TypeDef& def() const override { return type_; }
  std::map<std::string, sync::Row> lock(sync::SyncTxn&, const sync::ScopeKey&, const std::vector<sync::RecordId>&) override;
  std::set<std::string> elsewhere(sync::SyncTxn&, const sync::ScopeKey&, const std::vector<sync::RecordId>&) override { return {}; }
  void apply(sync::SyncTxn&, const sync::ScopeKey&, const std::vector<sync::RowWrite>&) override;
  std::vector<sync::Row> feed(sync::SyncTxn&, const sync::ScopeKey&, const sync::FeedQuery&) override;
  std::uint64_t count(sync::SyncTxn&, const sync::ScopeKey&, const sync::FeedQuery&) override;
  sync::Tally tally(sync::SyncTxn&, const sync::ScopeKey&) override;
  std::optional<std::int64_t> maxSerial(sync::SyncTxn&, const sync::ScopeKey&, const std::string&, const std::map<std::string, Json::Value>&) override { return std::nullopt; }
  std::optional<std::string> revisionText(sync::SyncTxn&, const sync::ScopeKey&, const sync::RecordId&, const std::string&, Seq) override;
  void purge(sync::SyncTxn&, const sync::ScopeKey&) override;
  void pruneRevisions(sync::SyncTxn&, const sync::ScopeKey&, const std::set<std::string>& days, sync::Ms now);

private:
  // §2.3's keyset over this type's rows of one scope, with visibility pushed down when the query asks for it.
  std::string keysetWhere(pqxx::params& params, const sync::ScopeKey& scope, const sync::FeedQuery& query) const;

  const sync::TypeDef& type_;
  std::string table_;
  std::string idOrder_;
  std::string visibleWhere_;
};

class PgJournal {
public:
  explicit PgJournal(const sync::Registry& registry);
  void bindTo(sync::SyncCatalog&);

private:
  PgJournalState state_;
  std::vector<std::unique_ptr<PgJournalType>> stores_;
  JournalProduct product_;
};

}
