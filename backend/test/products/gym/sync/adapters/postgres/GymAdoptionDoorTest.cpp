#include "test/products/gym/sync/adapters/postgres/GymDoorFixture.h"
#include "test/testing.h"
#include "products/gym/application/GymSwitches.h"

using namespace wm;
using namespace wm::sync;


TEST(gym_engine_doors_refuse_unadopted_rows_and_receipts_without_creating_a_scope) {
  if (!std::getenv("WM_PG_TEST")) SKIP("requires WM_SYNC_DATABASE_URL");
  for (const std::string state : {"no-scope", "empty-scope", "partial-envelope", "missing-spent", "seed-alias", "enveloped-no-scope", "stale-scope"}) {
    gym::doortest::Harness h;
    {
      PgLease lease{*gym::doortest::pool()};
      pqxx::work sql{*lease};
      if (state == "missing-spent") {
        sql.exec("insert into gym_note_saves(id,user_id,note) values('note_missing_spent',$1::uuid,'{}'::jsonb)", pqxx::params{h.user.str()});
      } else if (state == "seed-alias") {
        sql.exec("insert into gym_exercise_aliases(user_id,exercise_id,name) values($1::uuid,'dip','Parallel')", pqxx::params{h.user.str()});
      } else {
        sql.exec("insert into gym_notes(id,user_id,title,body,position) values('note_unadopted',$1::uuid,'History','Keep me',0)", pqxx::params{h.user.str()});
      }
      if (state == "empty-scope" || state == "partial-envelope" || state == "stale-scope") {
        sql.exec("insert into sync_scopes(key,kind,owner) values($1,'product',$2::uuid)", pqxx::params{ScopeKey::product(h.user, "gym").text(), h.user.str()});
      }
      if (state == "partial-envelope") {
        sql.exec("update gym_notes set seq=1,rc=1,ru=1,born='1:0:srv',life_stamp='1:0:srv',body_stamp='1:0:srv',ord='a0',ord_stamp='1:0:srv' where id='note_unadopted'");
      }
      if (state == "enveloped-no-scope" || state == "stale-scope") {
        sql.exec("update gym_notes set seq=1,rc=1,ru=1,born='1:0:srv',life_stamp='1:0:srv',title_stamp='1:0:srv',body_stamp='1:0:srv',ord='a0',ord_stamp='1:0:srv' where id='note_unadopted'");
      }
      sql.commit();
    }
    const auto before = [&] {
      PgLease lease{*gym::doortest::pool()};
      pqxx::read_transaction sql{*lease};
      return sql.exec("select count(*) from sync_scopes")[0][0].as<int>();
    }();
    bool refused = false;
    try { h.door.closeStale(h.user); }
    catch (const gym::GymUnavailable& error) { refused = error.code == "gym-not-adopted"; }
    CHECK(refused);
    PgLease lease{*gym::doortest::pool()};
    pqxx::read_transaction sql{*lease};
    CHECK_EQ(sql.exec("select count(*) from sync_scopes")[0][0].as<int>(), before);
    CHECK(sql.exec("select request_id from sync_requests").empty());
    CHECK(h.failures.messages.empty());
  }
}
