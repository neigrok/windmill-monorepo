#include "platform/adapters/sentry/ObservedTool.h"

#include "platform/adapters/http/JsonReply.h"
#include "platform/adapters/postgres/PgAuthRepository.h"

#include <drogon/drogon.h>

#include <cstdlib>
#include <iostream>
#include <stdexcept>

int main(int argc, char** argv) {
  return wm::runObservedTool("journal.rehearsal_seed", "journal", [&](wm::WriteObservation& observation) {
    bool validated = false;
    const char* validationOutcome = "invalid-arguments";
    try {
      if (argc == 2 && std::string(argv[1]) == "--help") {
        std::cout << "windmill_journal_rehearsal_seed (DATABASE_URL must name a throwaway database before journal_sync.sql; reuses gym seed accounts)\n";
        return 0;
      }
      if (argc != 1) throw std::runtime_error("seed takes no arguments");
      validationOutcome = "not-configured";
      const char* database = std::getenv("DATABASE_URL");
      if (!database || !*database) throw std::runtime_error("DATABASE_URL is required");
      validated = true;
      wm::configureJsonReplies(drogon::app());
      auto pool = std::make_shared<wm::PgPool>(database, 1);
      std::vector<std::string> accounts;
      {
        wm::PgLease connection{*pool};
        pqxx::work transaction{*connection};
        if (transaction.exec("select 1 from journal_page union all select 1 from journal_page_revision").size() != 0)
          throw std::runtime_error("seed requires empty journal tables");
        if (transaction.exec("select 1 from information_schema.columns where table_name='journal_page' and column_name='seq'").size() != 0)
          throw std::runtime_error("seed before journal_sync.sql");
        for (const auto& row : transaction.exec("select id::text from users order by email collate \"C\"")) accounts.push_back(row[0].as<std::string>());
      }
      wm::PgAuthRepository auth{pool};
      while (accounts.size() < 6) {
        const auto n = std::to_string(accounts.size() + 1);
        accounts.push_back(auth.createUser(wm::Email{"journal-rehearsal-" + n + "@example.invalid"}, "Rehearsal " + n).id.str());
      }
      for (std::size_t index = 0; index < accounts.size(); ++index) {
        const auto& owner = accounts[index];
        wm::PgLease connection{*pool};
        pqxx::work transaction{*connection};
        transaction.exec("set local timezone='UTC'");
        Json::Value report(Json::objectValue);
        report["account"] = owner;
        report["fixture"] = Json::UInt64(index + 1);
        if (index < 3) {
          transaction.exec("insert into journal_page(user_id,day,body,mood,energy,source,stamp_ms,stamp_counter,stamp_actor,updated_at) values "
            "($1::uuid,'2026-09-01','A walk beside the sea. 🌊',0,null,'typed',1790856000000,1,'rehearsal', '2026-09-01 12:00:00.000789+00'),"
            "($1::uuid,'2026-09-02','A spoken memory.',null,0,'spoken',1790856000000,1,'rehearsal','2026-09-02 12:00:00.000789+00'),"
            "($1::uuid,'2026-09-03','',null,null,'typed',0,0,'','2026-09-03 12:00:00+00'),"
            "($1::uuid,'2026-09-04','Future content stamp survives.',10,5,'legacy',9000000000000,0,'future','2026-09-04 12:00:00+00'),"
            "($1::uuid,'2026-09-05',repeat('x',131073),null,null,'typed',1790856000001,0,'rehearsal','2026-09-05 12:00:00+00')", pqxx::params{owner});
          if (index == 0) transaction.exec("insert into journal_page(user_id,day,body,mood,energy,source,stamp_ms,stamp_counter,stamp_actor,updated_at) "
            "select $1::uuid, date '2020-01-01'+n, 'Pagination boundary '||n, null, null, 'typed', 1, 0, 'boundary', timestamp '2020-01-01'+n*interval '1 day' "
            "from generate_series(0,1000) n", pqxx::params{owner});
          transaction.exec("insert into journal_page_revision(user_id,day,body,stamp_ms,stamp_counter,stamp_actor,superseded_at) values "
            "($1::uuid,'2026-09-01','Repeated outgoing body',1,0,'old','2026-01-01 12:00:00.000456+00'),"
            "($1::uuid,'2026-09-02','Repeated outgoing body',1,0,'old','2026-01-01 12:00:00.000456+00'),"
            "($1::uuid,'2026-09-01','Repeated outgoing body',1,0,'old','2026-01-01 12:00:00.000456+00'),"
            "($1::uuid,'2026-09-01','Score-only supersession',2,0,'old','2026-09-30 12:00:00+00')", pqxx::params{owner});
          transaction.exec("insert into journal_span(user_id,span_id,day,ord,lo,hi,text,text_sha256,vector,embed_version,body_stamp_ms,body_sha256) values "
            "($1::uuid,1,'2026-09-01',0,0,6,'A walk',sha256(convert_to('A walk','UTF8')),decode('0000803f','hex'),'seed',1790856000000,sha256(convert_to('A walk beside the sea. 🌊','UTF8'))),"
            "($1::uuid,2,'2026-09-02',0,0,8,'A spoken',sha256(convert_to('A spoken','UTF8')),decode('0000803f','hex'),'seed',1790856000000,sha256(convert_to('A spoken memory.','UTF8')))", pqxx::params{owner});
          transaction.exec("insert into journal_echo(user_id,trigger_day,trigger_span_id,match_day,match_span_id,cosine,relation,curator_version) "
            "values($1::uuid,'2026-09-02',2,'2026-09-01',1,0.91,0.81,'seed')", pqxx::params{owner});
          transaction.exec("insert into journal_echo_dismissal(user_id,trigger_hash,match_hash) values($1::uuid,sha256(convert_to('unused trigger','UTF8')),sha256(convert_to('unused match','UTF8')))", pqxx::params{owner});
          transaction.exec("insert into journal_echo_offer_dismissal(user_id,day) values($1::uuid,'2026-09-02')", pqxx::params{owner});
          transaction.exec("insert into journal_echo_signal(user_id,trigger_day,trigger_span_id,match_day,match_span_id,kind,cosine,relation,curator_version) "
            "values($1::uuid,'2026-09-02',2,'2026-09-01',1,'useful',0.91,0.81,'seed')", pqxx::params{owner});
          transaction.exec("insert into journal_page_curation(user_id,day,body_stamp_ms,corpus_stamp,status,attempts,segment_version,embed_version,judge_version) "
            "values($1::uuid,'2026-09-01',1790856000000,17,'ok',0,'seed','seed','seed')", pqxx::params{owner});
          transaction.exec("insert into journal_nudge(user_id,enabled,next_due_at,slot_day,paused_until,suppressed,pause_digest) "
            "values($1::uuid,true,'2026-10-03 12:00:00+00','2026-10-03','2026-10-04 12:00:00+00',$2,'seed-pause-'||$1::text)", pqxx::params{owner, index == 2});
          transaction.exec("insert into journal_nudge_day(user_id,slot_day,decision,reason,sent_at) values($1::uuid,'2026-09-30','sent','ok','2026-09-30 12:00:00+00')", pqxx::params{owner});
          report["kind"] = "written-pages-retired-state";
        } else if (index == 3) {
          transaction.exec("insert into journal_page(user_id,day,body,mood,energy,stamp_ms,stamp_counter,stamp_actor,updated_at) "
            "values($1::uuid,'2026-09-03','',null,null,0,0,'','2026-09-03 12:00:00+00')", pqxx::params{owner});
          report["kind"] = "blank-page-pending-state";
        } else if (index == 4) {
          transaction.exec("insert into journal_page_revision(user_id,day,body,stamp_ms,stamp_counter,stamp_actor,superseded_at) "
            "values($1::uuid,'2026-08-01','Invisible revision only',0,0,'','2026-08-01 12:00:00.000456+00')", pqxx::params{owner});
          report["kind"] = "revisions-only-pending-state";
        } else report["kind"] = "empty-pending-state";
        transaction.commit();
        std::cout << wm::dump(report) << '\n';
      }
      return 0;
    } catch (const std::exception& error) {
      if (!validated) observation.finish(validationOutcome);
      else observation.reportFailure(error);
      std::cerr << "journal rehearsal seed: operation failed" << '\n';
      return 1;
    }
  });
}
