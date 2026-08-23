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
// on a developer's mac and on CI's linux. Days count from 1970-01-01, but only DIFFERENCES are
// ever read, so the epoch is arbitrary.
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
// can see in both passages and check for themselves.
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
      // the words a journal is made of
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
// expensive half of the pass, so it is measured once here and never recomputed.
struct Judged {
  const Vectored* passage = nullptr;
  float cosine = 0.0f;
  long ageDays = 0;
};

// The tail every ranking in this file breaks ties on: the OLDER day, then the span id. Without a
// total order two runs over one corpus could disagree and the echo set would reshuffle nightly.
bool olderFirst(const Judged& a, const Judged& b) {
  if (!(a.passage->day == b.passage->day)) return a.passage->day < b.passage->day;
  return a.passage->spanId < b.passage->spanId;
}

// The N closest passages retrieval did NOT hand over — younger than `minDayGap`, or beaten inside
// their own age band. Only the debug door asks for these: they cost one more cosine pass over the
// whole corpus per trigger.
void appendNearMisses(const Vectored& trigger, const std::vector<Vectored>& history,
                      const std::vector<Vectored>& retrieved, int wanted, TriggerTrace& trace) {
  std::set<std::int64_t> handedOver;
  for (const Vectored& candidate : retrieved) handedOver.insert(candidate.spanId);

  std::vector<Judged> missed;
  for (const Vectored& candidate : history) {
    if (handedOver.count(candidate.spanId)) continue;
    missed.push_back(Judged{&candidate, cosine(trigger.vector, candidate.vector),
                            daysBetween(candidate.day, trigger.day)});
  }
  const std::size_t take = std::min<std::size_t>(missed.size(), static_cast<std::size_t>(wanted));
  std::partial_sort(missed.begin(), missed.begin() + take, missed.end(),
                    [](const Judged& a, const Judged& b) {
                      if (a.cosine != b.cosine) return a.cosine > b.cosine;
                      return olderFirst(a, b);
                    });
  for (std::size_t i = 0; i < take; ++i)
    trace.notes.push_back(CandidateNote{missed[i].passage->spanId, missed[i].passage->day,
                                        missed[i].passage->text, missed[i].cosine,
                                        missed[i].ageDays, 0.0, 0.0, 1,
                                        missed[i].passage->spanId, Fate::notRetrieved});
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

AnchorVocabulary AnchorVocabulary::of(const std::vector<Vectored>& corpus,
                                      const SelectionRules& rules) {
  AnchorVocabulary vocabulary;
  const int passages = static_cast<int>(corpus.size());
  if (passages < rules.vocabularyFloor || rules.commonShare <= 0.0) return vocabulary;

  // Document frequency: one passage counts a word once, however often it repeats inside it.
  std::map<std::string, int> carrying;
  for (const Vectored& passage : corpus)
    for (const std::string& token : anchorsOf(passage.text)) ++carrying[token];

  const int threshold = static_cast<int>(std::ceil(rules.commonShare * passages));
  for (const auto& [token, count] : carrying)
    if (count >= threshold) vocabulary.common.insert(token);
  return vocabulary;
}

bool sharesAnchor(const std::string& a, const std::string& b, const AnchorVocabulary& vocabulary) {
  std::set<std::string> left;
  for (const std::string& token : anchorsOf(a))
    if (vocabulary.common.count(token) == 0) left.insert(token);
  if (left.empty()) return false;

  for (const std::string& token : anchorsOf(b))
    if (left.count(token) > 0) return true;
  return false;
}

bool sharesAnchor(const std::string& a, const std::string& b) {
  return sharesAnchor(a, b, AnchorVocabulary{});
}

int crowdOf(const Vectored& trigger, const std::vector<Vectored>& corpus,
            const SelectionRules& rules) {
  int crowd = 0;
  for (const Vectored& neighbour : corpus) {
    if (neighbour.spanId == trigger.spanId) continue;   // a passage is not its own neighbour
    if (cosine(trigger.vector, neighbour.vector) >= rules.refrainRadius) ++crowd;
  }
  return crowd;
}

bool isRefrain(const Vectored& trigger, const std::vector<Vectored>& corpus,
               const SelectionRules& rules) {
  return crowdOf(trigger, corpus, rules) >= rules.refrainCrowd;
}

const char* fateText(Fate fate) {
  switch (fate) {
    case Fate::selected: return "selected";
    case Fate::notRetrieved: return "not_retrieved";
    case Fate::restatement: return "restatement";
    case Fate::noAnchor: return "no_anchor";
    case Fate::familyMember: return "family_member";
    case Fate::recencyQuota: return "recency_quota";
    case Fate::monthQuota: return "month_quota";
    case Fate::outranked: return "outranked";
    case Fate::dismissed: return "dismissed";
    case Fate::pageCap: return "page_cap";
  }
  return "outranked";
}

std::vector<Vectored> stratify(const Vectored& trigger, const std::vector<Vectored>& corpus,
                               const SelectionRules& rules) {
  // The bands as day counts — 7-30d, 1-3mo, 3-12mo, 1-3y, 3y+ — so nothing downstream parses a
  // label, and a raised minDayGap simply empties the first band.
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

  // Top-perBand out of EACH band, youngest band first, so an old passage competes against its own
  // era rather than losing to last month's prose on a flat top-N.
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

Selection selectExplained(const Vectored& trigger, const std::vector<Vectored>& candidates,
                          const SelectionRules& rules, const AnchorVocabulary& vocabulary) {
  Selection selection;
  if (candidates.empty() || rules.shown <= 0) return selection;

  std::vector<Judged> judged;
  judged.reserve(candidates.size());
  for (const Vectored& candidate : candidates)
    judged.push_back(Judged{&candidate, cosine(trigger.vector, candidate.vector),
                            std::max(0L, daysBetween(candidate.day, trigger.day))});

  // z against this trigger's OWN retrieved background, taken before any rule narrows it: a single
  // global threshold would mean a different thing on every page of the same journal.
  double mean = 0.0;
  for (const Judged& candidate : judged) mean += candidate.cosine;
  mean /= static_cast<double>(judged.size());
  double variance = 0.0;
  for (const Judged& candidate : judged)
    variance += (candidate.cosine - mean) * (candidate.cosine - mean);
  variance /= static_cast<double>(judged.size());
  const double stddev = std::sqrt(variance);
  selection.mean = mean;
  selection.stddev = stddev;

  // Every candidate gets a note before a single rule runs, and each rule below stamps the ones it
  // took out, so the reasons cannot drift from the behaviour.
  std::map<std::int64_t, std::size_t> noteOf;
  selection.notes.reserve(judged.size());
  for (const Judged& candidate : judged) {
    noteOf[candidate.passage->spanId] = selection.notes.size();
    const double z = stddev == 0.0 ? 0.0 : (candidate.cosine - mean) / stddev;
    selection.notes.push_back(CandidateNote{candidate.passage->spanId, candidate.passage->day,
                                            candidate.passage->text, candidate.cosine,
                                            candidate.ageDays, z, 0.0, 1,
                                            candidate.passage->spanId, Fate::outranked});
  }
  auto noted = [&selection, &noteOf](std::int64_t spanId) -> CandidateNote& {
    return selection.notes[noteOf[spanId]];
  };

  std::vector<Judged> survivors;
  for (const Judged& candidate : judged) {
    if (candidate.cosine >= rules.restatement) {   // a restatement is not a memory
      noted(candidate.passage->spanId).fate = Fate::restatement;
      continue;
    }
    // No shared anchor means no way for the reader to check the pairing from what is on screen,
    // whatever the cosine says.
    if (!sharesAnchor(trigger.text, candidate.passage->text, vocabulary)) {
      noted(candidate.passage->spanId).fate = Fate::noAnchor;
      continue;
    }
    survivors.push_back(candidate);
  }
  if (survivors.empty()) return selection;

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

  // The representative is the OLDEST member, and it carries the family size so the ranking can
  // discount a candidate that is really standing for thirty near-copies.
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

    for (std::size_t member : members) {
      CandidateNote& note = noted(survivors[member].passage->spanId);
      note.familySize = static_cast<int>(members.size());
      note.representative = representative.passage->spanId;
      if (member != eldest) note.fate = Fate::familyMember;
    }
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

  // Why each representative that did not make it did not: read off the counters the loop exited
  // with, which are the ones standing in its way when it stopped.
  for (std::size_t i = 0; i < standings.size(); ++i) {
    if (taken[i]) continue;
    CandidateNote& note = noted(standings[i].judged.passage->spanId);
    if (standings[i].judged.ageDays <= 30 && fromLastThirtyDays >= rules.maxRecent)
      note.fate = Fate::recencyQuota;
    else if (perCalendarMonth[standings[i].judged.passage->day.iso().substr(0, 7)] >=
             rules.maxPerMonth)
      note.fate = Fate::monthQuota;
    else note.fate = Fate::outranked;
  }

  // The oldest qualifying candidate is guaranteed a slot, over the quotas and over the score:
  // nothing else in the ranking protects the first time someone wrote a thing.
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
      noted(chosen[weakest].judged.passage->spanId).fate = Fate::outranked;
      chosen.erase(chosen.begin() + static_cast<std::ptrdiff_t>(weakest));
    }
    standings[eldest].score = penalised(standings[eldest]);
    chosen.push_back(standings[eldest]);
  }

  std::sort(chosen.begin(), chosen.end(), [](const Standing& a, const Standing& b) {
    if (a.score != b.score) return a.score > b.score;
    return olderFirst(a.judged, b.judged);
  });

  selection.pairings.reserve(chosen.size());
  for (const Standing& standing : chosen) {
    CandidateNote& note = noted(standing.judged.passage->spanId);
    note.fate = Fate::selected;
    note.score = standing.score;
    selection.pairings.push_back(Pairing{trigger.spanId, standing.judged.passage->spanId,
                                         standing.judged.cosine,
                                         static_cast<float>(standing.score), standing.familySize});
  }
  return selection;
}

std::vector<Pairing> select(const Vectored& trigger, const std::vector<Vectored>& candidates,
                            const SelectionRules& rules, const AnchorVocabulary& vocabulary) {
  return selectExplained(trigger, candidates, rules, vocabulary).pairings;
}

PageSelection selectForPage(const std::vector<Vectored>& tonight,
                            const std::vector<Vectored>& history,
                            const std::set<std::pair<std::int64_t, std::int64_t>>& dismissed,
                            const SelectionRules& rules, int echoesPerPage, int nearestReported) {
  PageSelection page;
  // Counted once for the page, over the WHOLE corpus this writer has — tonight included, because a
  // word they use every night is theirs whether they used it tonight or last March.
  std::vector<Vectored> everything = history;
  everything.insert(everything.end(), tonight.begin(), tonight.end());
  const AnchorVocabulary vocabulary = AnchorVocabulary::of(everything, rules);
  // Where a pairing's note lives, so the two rules that act on WHOLE-PAGE state — the reader's
  // dismissals and the page ceiling — can stamp the same notes the per-trigger pass filled in.
  std::map<std::pair<std::int64_t, std::int64_t>, std::pair<std::size_t, std::size_t>> noteAt;
  std::vector<Pairing> proposed;

  for (const Vectored& trigger : tonight) {
    TriggerTrace trace;
    trace.spanId = trigger.spanId;
    trace.text = trigger.text;
    trace.history = static_cast<int>(history.size());
    trace.crowd = crowdOf(trigger, history, rules);
    trace.refrain = trace.crowd >= rules.refrainCrowd;

    const std::vector<Vectored> retrieved = stratify(trigger, history, rules);
    trace.retrieved = static_cast<int>(retrieved.size());

    // A refrain ("tired again") emits nothing at all. It is still traced — what it retrieved and how
    // crowded it was is what someone tuning the gate needs to see.
    if (!trace.refrain) {
      const Selection selection = selectExplained(trigger, retrieved, rules, vocabulary);
      trace.mean = selection.mean;
      trace.stddev = selection.stddev;
      trace.notes = selection.notes;
      for (const Pairing& pairing : selection.pairings) {
        const auto key = std::make_pair(pairing.triggerSpanId, pairing.matchSpanId);
        if (dismissed.count(key)) continue;
        proposed.push_back(pairing);
      }
    }

    if (nearestReported > 0) appendNearMisses(trigger, history, retrieved, nearestReported, trace);
    if (trace.refrain) ++page.refrains;
    page.traces.push_back(std::move(trace));
  }

  for (std::size_t t = 0; t < page.traces.size(); ++t)
    for (std::size_t n = 0; n < page.traces[t].notes.size(); ++n)
      noteAt[{page.traces[t].spanId, page.traces[t].notes[n].spanId}] = {t, n};

  auto stamp = [&page, &noteAt](const Pairing& pairing, Fate fate) {
    const auto at = noteAt.find({pairing.triggerSpanId, pairing.matchSpanId});
    if (at != noteAt.end()) page.traces[at->second.first].notes[at->second.second].fate = fate;
  };
  for (const auto& waved : dismissed) {
    const auto at = noteAt.find(waved);
    if (at != noteAt.end() &&
        page.traces[at->second.first].notes[at->second.second].fate == Fate::selected)
      page.traces[at->second.first].notes[at->second.second].fate = Fate::dismissed;
  }

  // The page-level cap. `selectExplained` bounds one trigger's pairings; this bounds the page, which
  // is the unit the reader sees. Highest-scoring first.
  std::sort(proposed.begin(), proposed.end(), [](const Pairing& a, const Pairing& b) {
    if (a.score != b.score) return a.score > b.score;
    if (a.triggerSpanId != b.triggerSpanId) return a.triggerSpanId < b.triggerSpanId;
    return a.matchSpanId < b.matchSpanId;
  });
  if (echoesPerPage >= 0 && static_cast<int>(proposed.size()) > echoesPerPage) {
    for (std::size_t i = static_cast<std::size_t>(echoesPerPage); i < proposed.size(); ++i)
      stamp(proposed[i], Fate::pageCap);
    page.cappedOut = static_cast<int>(proposed.size()) - echoesPerPage;
    proposed.erase(proposed.begin() + echoesPerPage, proposed.end());
  }
  page.pairings = std::move(proposed);
  return page;
}

}
