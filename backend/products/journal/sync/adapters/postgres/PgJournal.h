#pragma once

#include "products/journal/sync/application/JournalProduct.h"

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
  std::optional<std::int64_t> maxSerial(sync::SyncTxn&, const sync::ScopeKey&, const std::string&, const std::map<std::string, Json::Value>&) override { return std::nullopt; }
  std::optional<std::string> revisionText(sync::SyncTxn&, const sync::ScopeKey&, const sync::RecordId&, const std::string&, Seq) override;
  void purge(sync::SyncTxn&, const sync::ScopeKey&) override;
  void pruneRevisions(sync::SyncTxn&, const sync::ScopeKey&, const std::set<std::string>& days, sync::Ms now);

private:
  const sync::TypeDef& type_;
  std::string table_;
};

class PgJournal : public sync::ScopeReadiness {
public:
  explicit PgJournal(const sync::Registry& registry);
  void bindTo(sync::SyncCatalog&, bool checkAdoption = true);
  void requireReady(sync::SyncTxn&, const sync::ScopeKey&) override;

private:
  PgJournalState state_;
  std::vector<std::unique_ptr<PgJournalType>> stores_;
  JournalProduct product_;
};

}
