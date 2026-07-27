#pragma once

#include "platform/domain/Auth.h"
#include "products/journal/domain/EchoFinder.h"

#include <cstdint>
#include <string>
#include <utility>
#include <vector>

namespace wm {

// A candidate user for a nightly pass: someone with recent page activity, carrying the email the
// sweep needs to ask billing whether they are a subscriber.
struct EchoUser {
  UserId user;
  Email email;
};

// A page whose stored vector is missing or stale, handed to the embedder. stampMs is the page's HLC
// ms, recorded on the fresh vector so a later pass knows the embedding is current.
struct PageText {
  LocalDate day;
  std::string body;
  std::uint64_t stampMs = 0;
};

// One echo as the read endpoint returns it (score kept for ranking, never rendered as a number).
struct StoredEcho {
  LocalDate triggerDay;
  LocalDate matchDay;
  std::pair<int, int> triggerSpan;
  std::pair<int, int> matchSpan;
  float score = 0.0f;
};

// Echo storage + the nightly sweep's reads. Owner-scoped throughout. Entitlement is NOT asked here —
// the sweep checks the subscription and simply never calls the write path for a non-subscriber, so
// "absent, not locked" falls out of this table staying empty for them.
struct EchoRepository {
  virtual ~EchoRepository() = default;

  virtual std::vector<EchoUser> activeSince(std::uint64_t sinceMs) = 0;
  virtual std::vector<PageText> pagesNeedingVector(const UserId& user) = 0;
  virtual void saveVector(const UserId& user, const LocalDate& day, const std::vector<float>& vector,
                          std::uint64_t bodyStampMs) = 0;
  virtual std::vector<EchoCandidate> corpusOf(const UserId& user) = 0;
  virtual std::vector<LocalDate> triggersSince(const UserId& user, std::uint64_t sinceMs) = 0;
  virtual void saveEcho(const UserId& user, const LocalDate& triggerDay, const EchoMatch& match) = 0;

  virtual std::vector<StoredEcho> echoesFor(const UserId& user, const LocalDate& from,
                                            const LocalDate& to) = 0;
  virtual void dismiss(const UserId& user, const LocalDate& triggerDay) = 0;
};

}
