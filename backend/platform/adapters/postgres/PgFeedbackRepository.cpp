#include "platform/adapters/postgres/PgFeedbackRepository.h"

#include "platform/adapters/postgres/PgConnection.h"

#include <pqxx/pqxx>

namespace wm {

PgFeedbackRepository::PgFeedbackRepository(std::string connString) : connString_(std::move(connString)) {}

void PgFeedbackRepository::insert(const std::string& sessionKey, const std::optional<UserId>& user,
                                  const std::string& message, const std::string& email,
                                  const std::string& context) {
  // One row in one txn. An absent optional lands as SQL null: a ghost has no user_id, and an
  // empty correlation key / email / context is a null rather than a blank string.
  pqxx::params params;
  if (sessionKey.empty()) params.append();
  else params.append(sessionKey);
  if (user) params.append(user->str());
  else params.append();
  params.append(message);
  if (email.empty()) params.append();
  else params.append(email);
  if (context.empty()) params.append();
  else params.append(context);

  pqxx::work txn{pgThreadConnection(connString_)};
  txn.exec("INSERT INTO feedback (session_key, user_id, message, email, context) "
           "VALUES ($1, $2::uuid, $3, $4, $5)",
           params);
  txn.commit();
}

}
