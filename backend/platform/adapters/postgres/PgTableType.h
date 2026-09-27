#pragma once

#include "platform/ports/SyncType.h"

#include <pqxx/pqxx>

#include <cstddef>
#include <map>
#include <string>
#include <vector>

namespace wm::sync {

// The SQL type of a field's value column.
enum class SqlType { text, bigint, float8, boolean, jsonb };

// Where one type's records sit (§2.2): its table, each field's value column by SQL type (the column is the
// field's name in snake case), and how many superseded heads of a text field the product keeps per record
// in `<table>_revisions` (G6).
struct TableMap {
  std::string table;
  std::map<std::string, SqlType> fields;
  std::size_t revisionsKept = 0;
};

// The common product store: one table, one row per record, with §2.2's envelope derived from the TypeDef
// (born, life, life_stamp, <field>_stamp, <field>_rev and <field>_merged where the type has them). A type
// that does not fit one table implements TypeStore itself.
class PgTableType final : public TypeStore {
public:
  // Throws std::logic_error unless the map names exactly the type's fields, so a registry edit that the
  // table does not follow fails boot.
  PgTableType(const TypeDef& type, TableMap map);

  const TypeDef& def() const override { return type_; }
  std::map<std::string, Row> lock(SyncTxn&, const ScopeKey& scope, const std::vector<RecordId>& ids) override;
  std::set<std::string> elsewhere(SyncTxn&, const ScopeKey& scope, const std::vector<RecordId>& ids) override;
  void apply(SyncTxn&, const ScopeKey& scope, const std::vector<RowWrite>& writes) override;
  std::vector<Row> feed(SyncTxn&, const ScopeKey& scope, const FeedQuery& query) override;
  std::uint64_t count(SyncTxn&, const ScopeKey& scope, const FeedQuery& query) override;
  std::optional<std::int64_t> maxSerial(SyncTxn&, const ScopeKey& scope, const std::string& field,
                                        const std::map<std::string, Json::Value>& match) override;
  std::optional<std::string> revisionText(SyncTxn&, const ScopeKey& scope, const RecordId& id, const std::string& field, Seq rev) override;
  void purge(SyncTxn&, const ScopeKey& scope) override;

private:
  // One column of the table and how a row's part is read from it and written to it.
  struct Column {
    std::string name;
    std::string field;
    enum class Part { scope, id, seq, rc, ru, born, life, lifeStamp, value, stamp, text, rev, merged, serial } part;
    SqlType type = SqlType::text;
  };

  template <typename R>
  Row rowOf(const R& result) const;
  std::string keysetWhere(pqxx::params& params, const ScopeKey& scope, const FeedQuery& query) const;
  const Column& valueColumn(const std::string& field) const;

  const TypeDef& type_;
  TableMap map_;
  std::vector<Column> columns_;
  std::string columnList_;
  std::string conflictTarget_;
  std::string idOrder_;
  std::string aliveWhere_;
  std::string visibleWhere_;
};

}
