#include "products/journal/domain/EchoSelection.h"

#include "products/journal/domain/Passage.h"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdio>
#include <limits>
#include <map>
#include <numeric>
#include <set>
#include <string>
#include <unordered_set>
#include <vector>

namespace wm {

namespace {

// Howard Hinnant's days-from-civil. Integer math only, so mac and CI linux agree. Only differences
// are ever read, so the epoch is arbitrary.
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

// What survives this list is a low-frequency lexical anchor: a name, a place, a number, a rare
// content word.
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

// One codepoint and the bytes it cost. A truncated or impossible sequence answers U+FFFD over a
// single byte, which is unclassified below — so a bad byte can only end a token, never swallow the
// rest of the line.
struct Decoded {
  char32_t code = 0;
  std::size_t width = 1;
};

Decoded decodeUtf8(const std::string& text, std::size_t at) {
  const unsigned char lead = static_cast<unsigned char>(text[at]);
  if (lead < 0x80) return Decoded{lead, 1};
  if (lead < 0xC0 || lead > 0xF4) return Decoded{0xFFFD, 1};   // a continuation byte, or no lead at all
  const std::size_t width = lead >= 0xF0 ? 4 : lead >= 0xE0 ? 3 : 2;
  if (at + width > text.size()) return Decoded{0xFFFD, 1};

  char32_t code = lead & (0xFF >> (width + 1));
  for (std::size_t i = 1; i < width; ++i) {
    const unsigned char next = static_cast<unsigned char>(text[at + i]);
    if ((next & 0xC0) != 0x80) return Decoded{0xFFFD, 1};
    code = (code << 6) | (next & 0x3F);
  }
  return Decoded{code, width};
}

// The token-forming, lower-case form of one codepoint — 0 when it forms no token, which is every
// punctuation mark, sign and emoji, and every script not named here. Classifying by codepoint is
// what makes the anchor rule work outside ASCII: a byte-wise "0x80 and up is wordly" glues «» ' ' …
// and nbsp into their neighbours (so «Работа» never matched работа) and makes an em dash a word two
// passages can "share", while folding only 'A'-'Z' leaves every Russian sentence's first word a
// different token from its own lower-case form. Never std::tolower: its locale is the machine's.
//
// An unlisted codepoint falls out as no token rather than as a word, so an unknown script degrades
// to "this passage has no anchors" instead of to "its punctuation is an anchor".
char32_t wordlyLower(char32_t code) {
  if (code >= U'a' && code <= U'z') return code;
  if (code >= U'A' && code <= U'Z') return code + 0x20;
  if (code >= U'0' && code <= U'9') return code;
  if (code < 0x00C0) return 0;                    // every ASCII mark, nbsp, the guillemets
  if (code <= 0x00FF) {                           // Latin-1 letters, the × and ÷ signs apart
    if (code == 0x00D7 || code == 0x00F7) return 0;
    return code <= 0x00DE ? code + 0x20 : code;
  }
  if (code == 0x0386) return 0x03AC;              // Greek: the accented capitals fold out of block
  if (code >= 0x0388 && code <= 0x038A) return code + 0x25;
  if (code == 0x038C) return 0x03CC;
  if (code == 0x038E || code == 0x038F) return code + 0x3F;
  if (code >= 0x0391 && code <= 0x03AB) return code == 0x03A2 ? 0 : code + 0x20;
  if (code >= 0x03AC && code <= 0x03CE) return code;
  if (code >= 0x0400 && code <= 0x040F) return code + 0x50;   // Cyrillic: Ё Є І Ї Ў and their kin
  if (code >= 0x0410 && code <= 0x042F) return code + 0x20;
  if (code >= 0x0430 && code <= 0x045F) return code;
  // The historic and minority-language half of Cyrillic is laid out in upper/lower PAIRS, so the
  // fold is the pairing rather than a table. U+0482-U+0489 are signs and combining marks, never
  // letters, and the palochka is the one letter whose pair sits across the block.
  if (code >= 0x0460 && code <= 0x0481) return code % 2 == 0 ? code + 1 : code;
  if (code == 0x04C0) return 0x04CF;
  if (code >= 0x04C1 && code <= 0x04CE) return code % 2 == 1 ? code + 1 : code;
  if ((code >= 0x048A && code <= 0x04BF) || (code >= 0x04CF && code <= 0x04FF))
    return code % 2 == 0 ? code + 1 : code;
  return 0;
}

// Words are runs of codepoints `wordlyLower` keeps, folded as they are read. No stemmer and no
// prefix match: билеты and билетов stay two words until a measurement says otherwise.
std::set<std::string> anchorsOf(const std::string& text) {
  std::set<std::string> found;
  std::string token;
  for (std::size_t at = 0; at < text.size();) {
    const Decoded decoded = decodeUtf8(text, at);
    at += decoded.width;
    const char32_t folded = wordlyLower(decoded.code);
    if (folded == 0) {
      if (!token.empty() && !commonWords().count(token)) found.insert(token);
      token.clear();
      continue;
    }
    if (folded >= 0x80) {   // nothing this classifier keeps reaches U+0800, so two bytes carry it
      token.push_back(static_cast<char>(0xC0 | (folded >> 6)));
      token.push_back(static_cast<char>(0x80 | (folded & 0x3F)));
      continue;
    }
    token.push_back(static_cast<char>(folded));
  }
  if (!token.empty() && !commonWords().count(token)) found.insert(token);
  return found;
}

// Cosine is measured once here and never recomputed.
struct Judged {
  const Vectored* passage = nullptr;
  float cosine = 0.0f;
  long ageDays = 0;
};

// The tie-break every ranking here ends on: the older day, then the span id. A total order keeps
// two runs over one corpus identical.
bool olderFirst(const Judged& a, const Judged& b) {
  if (!(a.passage->day == b.passage->day)) return a.passage->day < b.passage->day;
  return a.passage->spanId < b.passage->spanId;
}

// The N closest passages retrieval did not hand over: younger than `minDayGap`, or beaten inside
// their own age band. Costs one more cosine pass over the whole corpus per trigger.
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

struct Standing {
  Judged judged;
  int familySize = 1;
  double base = 0.0;
  double score = 0.0;
};

}

namespace {

// FNV-1a over every SelectionRules knob, in a fixed order, so a threshold change reopens the pages
// it would judge differently. Add a knob to SelectionRules and add it here.
std::string rulesTag(const SelectionRules& rules) {
  const double values[] = {
      static_cast<double>(rules.minDayGap),  static_cast<double>(rules.shown),
      rules.refrainRadius,                   static_cast<double>(rules.refrainCrowd),
      rules.familyRadius,                    rules.restatement,
      rules.commonShare,                     static_cast<double>(rules.vocabularyFloor),
      rules.refrainShare,                    static_cast<double>(rules.maxPerMatchDay),
      static_cast<double>(rules.perBand),    static_cast<double>(rules.maxRecent),
      static_cast<double>(rules.maxPerMonth), rules.distanceWeight,
      rules.familyPenalty,                   rules.diversityPenalty,
  };
  std::uint32_t hash = 2166136261u;
  for (const double value : values) {
    const auto* bytes = reinterpret_cast<const unsigned char*>(&value);
    for (std::size_t i = 0; i < sizeof(double); ++i) {
      hash ^= bytes[i];
      hash *= 16777619u;
    }
  }
  char tag[9];
  std::snprintf(tag, sizeof(tag), "%08x", hash);
  return tag;
}

}

std::string judgeVersion(const std::string& curatorVersion, const SelectionRules& rules) {
  return curatorVersion + "/" + rulesTag(rules);
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

int refrainThreshold(std::size_t history, const SelectionRules& rules) {
  // Written in the double domain and clamped before the cast, because `refrainShare` is a live query
  // knob on the tuning door and `std::stod` accepts "nan" and "1e300". A NaN fails every comparison,
  // including `<= 0.0`, so a guard written the obvious way lets it through to a cast that is
  // undefined behaviour; `share > floor` is false for NaN and lands on the floor, which is the
  // answer an unreadable knob deserves.
  const double share = std::ceil(rules.refrainShare * static_cast<double>(history));
  const double floor = static_cast<double>(rules.refrainCrowd);
  if (!(share > floor)) return rules.refrainCrowd;
  return share >= static_cast<double>(std::numeric_limits<int>::max())
             ? std::numeric_limits<int>::max()
             : static_cast<int>(share);
}

bool isRefrain(const Vectored& trigger, const std::vector<Vectored>& corpus,
               const SelectionRules& rules) {
  return crowdOf(trigger, corpus, rules) >= refrainThreshold(corpus.size(), rules);
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
    case Fate::sameDay: return "same_day";
    case Fate::pageCap: return "page_cap";
  }
  return "outranked";
}

std::vector<Vectored> stratify(const Vectored& trigger, const std::vector<Vectored>& corpus,
                               const SelectionRules& rules) {
  // The bands as day counts: 7-30d, 1-3mo, 3-12mo, 1-3y, 3y+.
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

  // Top-perBand out of each band, youngest band first.
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

  // z against this trigger's own retrieved background, taken before any rule narrows it.
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

  // Every candidate gets a note before any rule runs; each rule stamps the ones it took out.
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

  // The same sentence typed twice is not a memory at any cosine, and identity is free to prove:
  // deterministic, model-independent, and true where an embedder happens to place the pair. The
  // cosine test stays beside it because the curator has no restatement rule of its own — its scale
  // calls the same specific thing named on both sides related at 0.9-1.0 — so anything an exact
  // test lets through reaches a judge that would keep it.
  const std::string identity = normalizedForIdentity(trigger.text);

  std::vector<Judged> survivors;
  for (const Judged& candidate : judged) {
    if (candidate.cosine >= rules.restatement ||
        normalizedForIdentity(candidate.passage->text) == identity) {
      noted(candidate.passage->spanId).fate = Fate::restatement;
      continue;
    }
    if (!sharesAnchor(trigger.text, candidate.passage->text, vocabulary)) {
      noted(candidate.passage->spanId).fate = Fate::noAnchor;
      continue;
    }
    survivors.push_back(candidate);
  }
  if (survivors.empty()) return selection;

  // Single-link families at familyRadius, measured between candidates; the lower index wins the
  // union, so families build in the same order every run.
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

  // The representative is the oldest member and carries the family size.
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

  // The diversity term reads what is already chosen, so the ranking is re-measured every slot.
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

  // Why each representative missed: read off the counters the loop exited with.
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

  // The oldest qualifying candidate is guaranteed a slot, over the quotas and over the score.
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
  // Counted once for the page, over the whole corpus this writer has, tonight included.
  std::vector<Vectored> everything = history;
  everything.insert(everything.end(), tonight.begin(), tonight.end());
  const AnchorVocabulary vocabulary = AnchorVocabulary::of(everything, rules);
  // Where a pairing's note lives, so the whole-page rules stamp the notes the per-trigger pass
  // filled in.
  std::map<std::pair<std::int64_t, std::int64_t>, std::pair<std::size_t, std::size_t>> noteAt;
  std::vector<Pairing> proposed;

  for (const Vectored& trigger : tonight) {
    TriggerTrace trace;
    trace.spanId = trigger.spanId;
    trace.text = trigger.text;
    trace.history = static_cast<int>(history.size());
    trace.crowd = crowdOf(trigger, history, rules);
    trace.refrain = trace.crowd >= refrainThreshold(history.size(), rules);

    const std::vector<Vectored> retrieved = stratify(trigger, history, rules);
    trace.retrieved = static_cast<int>(retrieved.size());

    // A refrain emits nothing, and is still traced.
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

  // Highest-scoring first, and the order both whole-page rules below read.
  std::sort(proposed.begin(), proposed.end(), [](const Pairing& a, const Pairing& b) {
    if (a.score != b.score) return a.score > b.score;
    if (a.triggerSpanId != b.triggerSpanId) return a.triggerSpanId < b.triggerSpanId;
    return a.matchSpanId < b.matchSpanId;
  });

  // One card per past day. The write side is day-grained — a dismissal and a signal are both keyed
  // (trigger day, match day) — so two pairings reaching into one past page render as two cards
  // sharing one dismissal row, and waving one away would silently retire the other. Collapsed
  // BEFORE the page cap, so the cap counts cards. A pairing dropped here lost to a sibling and is
  // contingent on it, never a refusal of the pair itself.
  if (rules.maxPerMatchDay > 0) {
    std::map<std::int64_t, std::string> dayOf;
    for (const Vectored& span : history) dayOf.emplace(span.spanId, span.day.iso());

    std::map<std::string, int> perMatchDay;
    std::vector<Pairing> carded;
    for (const Pairing& pairing : proposed) {
      const auto at = dayOf.find(pairing.matchSpanId);
      const std::string day = at == dayOf.end() ? std::string{} : at->second;
      if (++perMatchDay[day] > rules.maxPerMatchDay) {
        stamp(pairing, Fate::sameDay);
        continue;
      }
      carded.push_back(pairing);
    }
    proposed = std::move(carded);
  }

  // The page-level cap; `selectExplained` bounds one trigger's.
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
