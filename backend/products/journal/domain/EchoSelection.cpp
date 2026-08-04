#include "products/journal/domain/EchoSelection.h"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <map>
#include <numeric>
#include <set>
#include <string>
#include <unordered_set>
#include <vector>

namespace wm {

namespace {

// Howard Hinnant's days-from-civil — pure integer math, so the gap between two pages is identical
// on a developer's mac and on CI's linux, where a <chrono>/timezone path quietly diverges. Days
// count from 1970-01-01, but only DIFFERENCES are ever read, so the epoch is arbitrary.
long dayNumber(const LocalDate& date) {
  const std::string& iso = date.iso();
  long y = std::stol(iso.substr(0, 4));          // LocalDate's ctor already guaranteed the shape
  long m = std::stol(iso.substr(5, 2));
  long d = std::stol(iso.substr(8, 2));
  y -= (m <= 2);                                 // Jan/Feb are months 13/14 of the prior year
  const long era = (y >= 0 ? y : y - 399) / 400;
  const long yoe = y - era * 400;                                    // year of era,  [0, 399]
  const long doy = (153 * (m > 2 ? m - 3 : m + 9) + 2) / 5 + d - 1;  // day of year,  [0, 365]
  const long doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;            // day of era,   [0, 146096]
  return era * 146097 + doe - 719468;
}

// The words a nightly journal writes every night. What survives this list is what "low-frequency
// lexical anchor" means here: a name, a place, a number, a rare content word — something the reader
// can see in both passages and check for themselves. Short and inline on purpose. A real frequency
// table would make the rule unreadable and would still be wrong about one person's vocabulary.
const std::unordered_set<std::string>& commonWords() {
  static const std::unordered_set<std::string> words{
      // pronouns, articles, determiners
      "i", "me", "my", "mine", "you", "your", "yours", "he", "him", "his", "she", "her", "hers",
      "it", "its", "we", "us", "our", "ours", "they", "them", "their", "who", "what", "which",
      "this", "that", "these", "those", "a", "an", "the", "some", "any", "all", "no", "one",
      "other", "such", "same",
      // auxiliaries and the handful of verbs every sentence leans on
      "am", "is", "are", "was", "were", "be", "been", "being", "have", "has", "had", "do", "does",
      "did", "doing", "will", "would", "can", "could", "should", "shall", "may", "might", "must",
      "get", "got", "go", "going", "went", "gone", "come", "came", "make", "made", "want", "need",
      "like", "say", "said",
      // prepositions, conjunctions, the adverbs of degree
      "of", "in", "on", "at", "to", "for", "with", "from", "by", "about", "into", "over", "under",
      "after", "before", "between", "through", "up", "down", "out", "off", "again", "then", "than",
      "so", "but", "and", "or", "if", "because", "as", "while", "when", "where", "why", "how",
      "not", "too", "very", "also", "still", "back", "here", "there", "now", "just", "really",
      "even", "only", "ever", "never", "always", "more", "most", "much", "many", "bit", "lot",
      "well", "good", "bad", "better", "best",
      // the words a journal is made of, which is exactly why they anchor nothing
      "today", "tonight", "yesterday", "tomorrow", "day", "days", "night", "nights", "morning",
      "evening", "week", "month", "year", "time", "times", "feel", "feeling", "felt", "think",
      "thinking", "thought", "know", "knew", "thing", "things",
      // what an apostrophe leaves behind once the split lands on non-alphanumerics
      "s", "t", "m", "d", "ll", "re", "ve", "don", "didn", "doesn", "isn", "wasn", "aren", "weren",
      "couldn", "wouldn", "shouldn", "haven", "hadn", "dont", "cant", "im", "ive",
  };
  return words;
}

// Split on anything that is not a letter, a digit, or a byte of a multi-byte character — a UTF-8
// word stays one token, so a journal kept in a non-Latin script still has anchors — then fold ASCII
// case by hand. Never std::tolower, whose locale belongs to the machine rather than to us.
std::set<std::string> anchorsOf(const std::string& text) {
  std::set<std::string> found;
  std::string token;
  for (char byte : text) {
    const unsigned char raw = static_cast<unsigned char>(byte);   // char's sign is the platform's
    const bool wordly = (raw >= 'a' && raw <= 'z') || (raw >= 'A' && raw <= 'Z') ||
                        (raw >= '0' && raw <= '9') || raw >= 0x80;
    if (wordly) {
      token.push_back(raw >= 'A' && raw <= 'Z' ? static_cast<char>(raw + 32)
                                               : static_cast<char>(raw));
      continue;
    }
    if (!token.empty() && !commonWords().count(token)) found.insert(token);
    token.clear();
  }
  if (!token.empty() && !commonWords().count(token)) found.insert(token);
  return found;
}

// A candidate carrying the two numbers every rule below reads. Cosine over 384 dimensions is the
// expensive half of the pass, so it is measured once, here, and never recomputed against the
// trigger again.
struct Judged {
  const Vectored* passage = nullptr;
  float cosine = 0.0f;
  long ageDays = 0;
};

// The tail every ranking in this file breaks ties on: the OLDER day, then the span id. Without a
// total order two runs over one corpus could disagree, and an echo set that reshuffles nightly
// reads as the journal changing its mind about what mattered.
bool olderFirst(const Judged& a, const Judged& b) {
  if (!(a.passage->day == b.passage->day)) return a.passage->day < b.passage->day;
  return a.passage->spanId < b.passage->spanId;
}

// A family's representative as the ranking sees it: the oldest member, the count it stands for, its
// score before diversity, and the score it was actually taken at.
struct Standing {
  Judged judged;
  int familySize = 1;
  double base = 0.0;
  double score = 0.0;
};

}

float cosine(const std::vector<float>& a, const std::vector<float>& b) {
  if (a.size() != b.size()) return 0.0f;

  double dot = 0.0, normA = 0.0, normB = 0.0;
  for (std::size_t i = 0; i < a.size(); ++i) {
    dot += static_cast<double>(a[i]) * b[i];
    normA += static_cast<double>(a[i]) * a[i];
    normB += static_cast<double>(b[i]) * b[i];
  }
  if (normA == 0.0 || normB == 0.0) return 0.0f;   // a direction-less vector resonates with nothing

  const double similarity = dot / (std::sqrt(normA) * std::sqrt(normB));
  if (similarity <= 0.0) return 0.0f;                      // opposed is not near; the range is [0,1]
  return static_cast<float>(std::min(similarity, 1.0));    // rounding may not push it past 1 either
}

long daysBetween(const LocalDate& earlier, const LocalDate& later) {
  return dayNumber(later) - dayNumber(earlier);
}

bool sharesAnchor(const std::string& a, const std::string& b) {
  const std::set<std::string> left = anchorsOf(a);
  if (left.empty()) return false;
  for (const std::string& token : anchorsOf(b))
    if (left.count(token) > 0) return true;
  return false;
}

bool isRefrain(const Vectored& trigger, const std::vector<Vectored>& corpus,
               const SelectionRules& rules) {
  int crowd = 0;
  for (const Vectored& neighbour : corpus) {
    if (neighbour.spanId == trigger.spanId) continue;   // a passage is not its own neighbour
    if (cosine(trigger.vector, neighbour.vector) >= rules.refrainRadius) ++crowd;
  }
  return crowd >= rules.refrainCrowd;
}

std::vector<Vectored> stratify(const Vectored& trigger, const std::vector<Vectored>& corpus,
                               const SelectionRules& rules) {
  // The bands as day counts — 7-30d, 1-3mo, 3-12mo, 1-3y, 3y+ — so nothing downstream ever parses
  // a label, and a raised minDayGap simply empties the first band instead of contradicting it.
  static constexpr long bandEnds[] = {30, 91, 365, 1095};
  static constexpr std::size_t bandCount = 5;

  std::vector<std::vector<Judged>> bands(bandCount);
  for (const Vectored& candidate : corpus) {
    const long age = daysBetween(candidate.day, trigger.day);
    if (age < rules.minDayGap) continue;   // a page younger than the gap is not an echo
    std::size_t band = bandCount - 1;
    for (std::size_t i = 0; i + 1 < bandCount; ++i)
      if (age <= bandEnds[i]) {
        band = i;
        break;
      }
    bands[band].push_back(Judged{&candidate, cosine(trigger.vector, candidate.vector), age});
  }

  // Top-perBand out of EACH band, youngest band first. An old passage competes against its own era;
  // against a flat top-N on a dense journal it loses every night to last month's prose, and the
  // curator downstream can only reject — it can never rescue what retrieval never surfaced.
  std::vector<Vectored> retrieved;
  for (std::vector<Judged>& band : bands) {
    std::sort(band.begin(), band.end(), [](const Judged& a, const Judged& b) {
      if (a.cosine != b.cosine) return a.cosine > b.cosine;
      return olderFirst(a, b);
    });
    const std::size_t take = std::min<std::size_t>(
        band.size(), rules.perBand > 0 ? static_cast<std::size_t>(rules.perBand) : 0);
    for (std::size_t i = 0; i < take; ++i) retrieved.push_back(*band[i].passage);
  }
  return retrieved;
}

std::vector<Pairing> select(const Vectored& trigger, const std::vector<Vectored>& candidates,
                            const SelectionRules& rules) {
  if (candidates.empty() || rules.shown <= 0) return {};

  std::vector<Judged> judged;
  judged.reserve(candidates.size());
  for (const Vectored& candidate : candidates)
    judged.push_back(Judged{&candidate, cosine(trigger.vector, candidate.vector),
                            std::max(0L, daysBetween(candidate.day, trigger.day))});

  // z against this trigger's OWN retrieved background, taken before any rule narrows it. Measured
  // top-1 cosine across triggers runs p10 0.594 / p50 0.704 / p90 0.889, so a single global
  // threshold would mean a different thing on every page of the same journal.
  double mean = 0.0;
  for (const Judged& candidate : judged) mean += candidate.cosine;
  mean /= static_cast<double>(judged.size());
  double variance = 0.0;
  for (const Judged& candidate : judged)
    variance += (candidate.cosine - mean) * (candidate.cosine - mean);
  variance /= static_cast<double>(judged.size());
  const double stddev = std::sqrt(variance);

  std::vector<Judged> survivors;
  for (const Judged& candidate : judged) {
    if (candidate.cosine >= rules.restatement) continue;   // a restatement is not a memory
    // No shared anchor means no way for the reader to check the pairing from what is on screen,
    // whatever the cosine says. This is the whole enforcement of rule 1.
    if (!sharesAnchor(trigger.text, candidate.passage->text)) continue;
    survivors.push_back(candidate);
  }
  if (survivors.empty()) return {};

  // Single-link families at familyRadius, measured BETWEEN candidates — the lower index always wins
  // the union, so the same corpus always builds the same families in the same order.
  std::vector<std::size_t> root(survivors.size());
  std::iota(root.begin(), root.end(), std::size_t{0});
  auto rootOf = [&root](std::size_t index) {
    while (root[index] != index) {
      root[index] = root[root[index]];
      index = root[index];
    }
    return index;
  };
  for (std::size_t i = 0; i < survivors.size(); ++i)
    for (std::size_t j = i + 1; j < survivors.size(); ++j) {
      if (cosine(survivors[i].passage->vector, survivors[j].passage->vector) < rules.familyRadius)
        continue;
      const std::size_t left = rootOf(i);
      const std::size_t right = rootOf(j);
      root[std::max(left, right)] = std::min(left, right);
    }

  std::map<std::size_t, std::vector<std::size_t>> families;
  for (std::size_t i = 0; i < survivors.size(); ++i) families[rootOf(i)].push_back(i);

  // The representative is the OLDEST member — the first time someone wrote a thing is what the
  // product's own copy is about — and it carries the family size so the ranking can discount a
  // candidate that is really standing for thirty near-copies.
  std::vector<Standing> standings;
  standings.reserve(families.size());
  for (const auto& family : families) {
    const std::vector<std::size_t>& members = family.second;
    std::size_t eldest = members.front();
    for (std::size_t member : members)
      if (olderFirst(survivors[member], survivors[eldest])) eldest = member;

    const Judged& representative = survivors[eldest];
    const double z = stddev == 0.0 ? 0.0 : (representative.cosine - mean) / stddev;
    const double base = z + rules.distanceWeight * std::log(1.0 + representative.ageDays / 30.0) -
                        rules.familyPenalty * std::log(1.0 + static_cast<double>(members.size()));
    standings.push_back(Standing{representative, static_cast<int>(members.size()), base, 0.0});
  }

  // The diversity term is a function of what is ALREADY chosen, so the ranking is re-measured every
  // slot rather than sorted once — take the best, then ask again.
  std::vector<Standing> chosen;
  std::vector<bool> taken(standings.size(), false);
  int fromLastThirtyDays = 0;
  std::map<std::string, int> perCalendarMonth;
  auto penalised = [&chosen, &rules](const Standing& standing) {
    double closest = 0.0;
    for (const Standing& already : chosen)
      closest = std::max(closest, static_cast<double>(cosine(standing.judged.passage->vector,
                                                             already.judged.passage->vector)));
    return standing.base - rules.diversityPenalty * closest;
  };

  while (static_cast<int>(chosen.size()) < rules.shown) {
    std::size_t best = standings.size();
    double bestScore = 0.0;
    for (std::size_t i = 0; i < standings.size(); ++i) {
      if (taken[i]) continue;
      if (standings[i].judged.ageDays <= 30 && fromLastThirtyDays >= rules.maxRecent) continue;
      if (perCalendarMonth[standings[i].judged.passage->day.iso().substr(0, 7)] >= rules.maxPerMonth)
        continue;
      const double score = penalised(standings[i]);
      if (best == standings.size() || score > bestScore ||
          (score == bestScore && olderFirst(standings[i].judged, standings[best].judged))) {
        best = i;
        bestScore = score;
      }
    }
    if (best == standings.size()) break;

    taken[best] = true;
    standings[best].score = bestScore;
    if (standings[best].judged.ageDays <= 30) ++fromLastThirtyDays;
    ++perCalendarMonth[standings[best].judged.passage->day.iso().substr(0, 7)];
    chosen.push_back(standings[best]);
  }

  // The oldest qualifying candidate is guaranteed a slot, over the quotas and over the score.
  // "You may have forgotten you ever planned it" makes the first time the payload, and nothing else
  // in the ranking protects it — a low z or a full month otherwise drops exactly the passage the
  // feature exists to surface.
  std::size_t eldest = 0;
  for (std::size_t i = 1; i < standings.size(); ++i)
    if (olderFirst(standings[i].judged, standings[eldest].judged)) eldest = i;

  if (!taken[eldest]) {
    if (static_cast<int>(chosen.size()) >= rules.shown) {
      std::size_t weakest = 0;
      for (std::size_t i = 1; i < chosen.size(); ++i)
        if (chosen[i].score < chosen[weakest].score ||
            (chosen[i].score == chosen[weakest].score &&
             olderFirst(chosen[weakest].judged, chosen[i].judged)))
          weakest = i;
      chosen.erase(chosen.begin() + static_cast<std::ptrdiff_t>(weakest));
    }
    standings[eldest].score = penalised(standings[eldest]);
    chosen.push_back(standings[eldest]);
  }

  std::sort(chosen.begin(), chosen.end(), [](const Standing& a, const Standing& b) {
    if (a.score != b.score) return a.score > b.score;
    return olderFirst(a.judged, b.judged);
  });

  std::vector<Pairing> pairings;
  pairings.reserve(chosen.size());
  for (const Standing& standing : chosen)
    pairings.push_back(Pairing{trigger.spanId, standing.judged.passage->spanId,
                               standing.judged.cosine, static_cast<float>(standing.score),
                               standing.familySize});
  return pairings;
}

}
