#include "platform/adapters/postgres/PgAuthRepository.h"
#include "platform/adapters/postgres/PgOAuthRepository.h"
#include "test/PgTestPool.h"
#include "test/testing.h"

#include <cstdlib>
#include <memory>
#include <string>

using namespace wm;

// An authorization code is bound to the session its consent was given through, read in the statement that spends it: it
// exchanges, once, while that session is live, and a code whose session was signed out, expired, or was never named, as
// a code from before codes named one, is spent for nothing.
TEST(pg_oauth_code_exchanges_only_while_the_session_it_was_issued_through_is_live) {
  if (!std::getenv("WM_PG_TEST")) SKIP("WM_PG_TEST unset");
  const auto oauth = std::make_shared<PgOAuthRepository>(pgTestPool());
  PgAuthRepository auth{pgTestPool(), nullptr, {}, oauth};
  const UserId account{"a3300000-0000-4000-8000-000000000001"};
  const UnixMs now = 1700000000000;
  const auto rows = [](const std::string& sql, const std::string& account) {
    PgLease connection{*pgTestPool()};
    pqxx::work tx{*connection};
    const pqxx::result result = tx.exec_params(sql, account);
    tx.commit();
    return result;
  };
  rows("DELETE FROM users WHERE id=$1::uuid", account.str());
  rows("INSERT INTO users(id,email) VALUES($1::uuid,'oauth-code-pg@example.com')", account.str());
  {
    PgLease connection{*pgTestPool()};
    pqxx::work tx{*connection};
    tx.exec("INSERT INTO oauth_clients(client_id,redirect_uris) VALUES('code-session-client',ARRAY['https://client.example/cb']) "
            "ON CONFLICT DO NOTHING");
    tx.commit();
  }
  auth.insertSession("code-session-live", account, now + 1000000, "", "", now);
  auth.insertSession("code-session-ended", account, now + 1000000, "", "", now);
  auth.insertSession("code-session-expiring", account, now + 10, "", "", now);
  const StoredCode code{"code-session-client", account, "https://client.example/cb", "challenge", "resource", "", now + 1000000};
  REQUIRE(oauth->insertCode("code-live", code, "code-session-live", now));
  REQUIRE(oauth->insertCode("code-ended", code, "code-session-ended", now));
  REQUIRE(oauth->insertCode("code-expired", code, "code-session-expiring", now));
  rows("INSERT INTO oauth_codes(code_hash,client_id,user_id,redirect_uri,code_challenge,resource,expires_ms) "
       "VALUES('code-unbound','code-session-client',$1::uuid,'https://client.example/cb','challenge','resource',1700001000000)",
       account.str());
  auth.deleteSession("code-session-ended");

  const std::optional<StoredCode> taken = oauth->takeCode("code-live", now + 100);
  REQUIRE(taken.has_value());
  CHECK_EQ(taken->clientId, std::string("code-session-client"));
  CHECK(taken->user == account);
  CHECK_FALSE(oauth->takeCode("code-live", now + 100));
  CHECK_FALSE(oauth->takeCode("code-ended", now + 100));
  CHECK_FALSE(oauth->takeCode("code-expired", now + 100));
  CHECK_FALSE(oauth->takeCode("code-unbound", now + 100));
  CHECK_EQ(rows("SELECT count(*) FROM oauth_codes WHERE user_id=$1::uuid", account.str())[0][0].as<int>(), 0);

  rows("DELETE FROM users WHERE id=$1::uuid", account.str());
  PgLease connection{*pgTestPool()};
  pqxx::work tx{*connection};
  tx.exec("DELETE FROM oauth_clients WHERE client_id='code-session-client'");
  tx.commit();
}
