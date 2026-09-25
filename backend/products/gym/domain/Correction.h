#pragma once

#include "products/gym/domain/Training.h"

namespace wm::gym {

struct CorrectionSetIn {
  Set set;
  bool rpeNamed;
  bool noteNamed;

  bool operator==(const CorrectionSetIn&) const = default;
};

struct SessionCorrectionIn {
  std::string requestId;
  std::uint64_t startedAtMs;
  std::uint64_t finishedAtMs;
  std::string routineName;
  std::vector<CorrectionSetIn> sets;

  bool operator==(const SessionCorrectionIn&) const = default;
};

struct SessionCorrectionBatch {
  Session session;
  std::vector<Set> sets;
  std::vector<Set> replaced;
  std::vector<Set> removed;

  SessionCorrectionBatch(const Session& stored, const std::vector<Set>& current,
      const SessionCorrectionIn& incoming, std::uint64_t nowMs);
};

}
