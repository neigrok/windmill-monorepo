#include "products/journal/domain/EchoFinder.h"

#include <cmath>
#include <cstddef>
#include <string>

namespace wm {

namespace {

// A Gregorian day-number from a "YYYY-MM-DD" — Howard Hinnant's days-from-civil, pure integer math
// so the gap between two pages is identical on a developer's mac and on CI's Linux, where a
// <chrono>/timezone path would quietly diverge. Days count from 1970-01-01, but only the DIFFERENCE
// of two day-numbers is ever read, so the epoch is arbitrary. Prefixed `echo` to stay journal-unique.
long echoDayNumber(const LocalDate& date) {
  const std::string& iso = date.iso();
  long y = std::stol(iso.substr(0, 4));                 // LocalDate's ctor already guaranteed the shape
  long m = std::stol(iso.substr(5, 2));
  long d = std::stol(iso.substr(8, 2));
  y -= (m <= 2);                                         // treat Jan/Feb as months 13/14 of the prior year
  const long era = (y >= 0 ? y : y - 399) / 400;
  const long yoe = y - era * 400;                        // year of era, [0, 399]
  const long doy = (153 * (m > 2 ? m - 3 : m + 9) + 2) / 5 + d - 1;   // day of year, [0, 365]
  const long doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;             // day of era, [0, 146096]
  return era * 146097 + doe - 719468;
}

// Cosine similarity in [0, 1] for these non-negative embeddings. A zero-norm vector resonates with
// nothing (0, never a divide-by-zero), and vectors of different dimensionality are not comparable.
float echoCosine(const std::vector<float>& a, const std::vector<float>& b) {
  if (a.size() != b.size()) return 0.0f;
  double dot = 0.0, normA = 0.0, normB = 0.0;
  for (std::size_t i = 0; i < a.size(); ++i) {
    dot += static_cast<double>(a[i]) * b[i];
    normA += static_cast<double>(a[i]) * a[i];
    normB += static_cast<double>(b[i]) * b[i];
  }
  if (normA == 0.0 || normB == 0.0) return 0.0f;
  return static_cast<float>(dot / (std::sqrt(normA) * std::sqrt(normB)));
}

}

std::optional<EchoMatch> match(const EchoCandidate& trigger,
                               const std::vector<EchoCandidate>& corpus, const EchoRules& rules) {
  if (trigger.vector.empty()) return std::nullopt;   // nothing to read across; not an error, just no echo

  const long triggerDay = echoDayNumber(trigger.day);
  const EchoCandidate* best = nullptr;
  float bestScore = 0.0f;

  for (const EchoCandidate& candidate : corpus) {
    // An echo reaches back: the candidate must be at least the gap OLDER (a strictly larger
    // day-number gap), which also excludes the trigger comparing against its own day.
    if (triggerDay - echoDayNumber(candidate.day) < rules.minDayGap) continue;
    // Comparable at all: the same non-zero dimensionality as the trigger.
    if (candidate.vector.size() != trigger.vector.size()) continue;

    const float score = echoCosine(trigger.vector, candidate.vector);
    if (score > bestScore) {
      bestScore = score;
      best = &candidate;
    }
  }

  if (!best || bestScore < rules.threshold) return std::nullopt;
  return EchoMatch{best->day,
                   {0, static_cast<int>(trigger.body.size())},
                   {0, static_cast<int>(best->body.size())},
                   bestScore};
}

}
