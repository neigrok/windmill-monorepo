#pragma once

#include "products/gym/sync/application/GymProduct.h"

namespace wm::gym::engine {

class PgGymState final : public GymState {
public:
  Json::Value load(sync::SyncTxn&, const sync::ScopeKey&) override;
  void receipt(sync::SyncTxn&, const sync::ScopeKey&, const std::string& kind,
               const std::string& id, const Json::Value& receipt) override;
};

class PgGymType final : public sync::TypeStore {
public:
  explicit PgGymType(const sync::TypeDef& type);
  const sync::TypeDef& def() const override { return type_; }
  std::map<std::string, sync::Row> lock(sync::SyncTxn&, const sync::ScopeKey&, const std::vector<sync::RecordId>&) override;
  std::set<std::string> elsewhere(sync::SyncTxn&, const sync::ScopeKey&, const std::vector<sync::RecordId>&) override;
  void apply(sync::SyncTxn&, const sync::ScopeKey&, const std::vector<sync::RowWrite>&) override;
  std::vector<sync::Row> feed(sync::SyncTxn&, const sync::ScopeKey&, const sync::FeedQuery&) override;
  std::uint64_t count(sync::SyncTxn&, const sync::ScopeKey&, const sync::FeedQuery&) override;
  std::optional<std::int64_t> maxSerial(sync::SyncTxn&, const sync::ScopeKey&, const std::string&,
                                       const std::map<std::string, Json::Value>&) override;
  std::optional<std::string> revisionText(sync::SyncTxn&, const sync::ScopeKey&, const sync::RecordId&,
                                         const std::string&, Seq) override { return std::nullopt; }
  void purge(sync::SyncTxn&, const sync::ScopeKey&) override;

  std::vector<sync::Row> adoptionRows(sync::SyncTxn&, const sync::ScopeKey&, sync::Ms migrationTime);
  std::vector<sync::Row> adoptedRows(sync::SyncTxn&, const sync::ScopeKey&);
  bool needsAdoption(sync::SyncTxn&, const sync::ScopeKey&);
  Seq greatestSeq(sync::SyncTxn&, const sync::ScopeKey&);
  void adopt(sync::SyncTxn&, const sync::ScopeKey&, const std::vector<sync::Row>&);

private:
  const sync::TypeDef& type_;
  std::string table_;
  std::string owner_;
  std::string id_;
  std::string adoptionPredicate() const;
};

class PgGym {
public:
  explicit PgGym(const sync::Registry& registry);
  void bindTo(sync::SyncCatalog& catalog);

private:
  PgGymState state_;
  std::vector<std::unique_ptr<PgGymType>> stores_;
  GymProduct product_;
};

}
