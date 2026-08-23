#include "products/journal/domain/Passage.h"

#include <algorithm>
#include <cstddef>
#include <string>
#include <string_view>
#include <vector>

namespace wm {

namespace {

// A half-open byte range into the body. Every cut lands on ASCII, so a boundary is always a
// codepoint boundary.
struct Span {
  int lo = 0;
  int hi = 0;
};

// A run of sentences that will not be split further; `maxSentences` is counted in `sentences`.
struct Unit {
  Span span;
  int sentences = 0;
};

bool isBlank(char c) {
  return c == ' ' || c == '\t' || c == '\r' || c == '\n' || c == '\v' || c == '\f';
}

Span trimmed(const std::string& body, Span span) {
  while (span.lo < span.hi && isBlank(body[span.lo])) ++span.lo;
  while (span.hi > span.lo && isBlank(body[span.hi - 1])) --span.hi;
  return span;
}

// Whitespace-separated runs, so "- called mum" counts three.
int wordCount(const std::string& body, Span span) {
  int words = 0;
  int at = span.lo;
  while (at < span.hi) {
    while (at < span.hi && isBlank(body[at])) ++at;
    if (at == span.hi) break;
    ++words;
    while (at < span.hi && !isBlank(body[at])) ++at;
  }
  return words;
}

std::vector<Span> linesOf(const std::string& body) {
  std::vector<Span> lines;
  const int size = static_cast<int>(body.size());
  int start = 0;
  while (start <= size) {
    int end = start;
    while (end < size && body[end] != '\n') ++end;
    const Span line = trimmed(body, {start, end});
    if (line.lo < line.hi) lines.push_back(line);
    start = end + 1;
  }
  return lines;
}

// A closing quote or bracket belongs to the sentence it closes; curly forms are three bytes and are
// stepped over whole.
int pastClosers(const std::string& body, Span line, int at) {
  while (at < line.hi) {
    const char c = body[at];
    if (c == '"' || c == '\'' || c == ')' || c == ']' || c == '}') {
      ++at;
      continue;
    }
    const bool curly = line.hi - at >= 3 && (body.compare(at, 3, "\xe2\x80\x9d") == 0 ||   // ”
                                             body.compare(at, 3, "\xe2\x80\x99") == 0);    // ’
    if (!curly) return at;
    at += 3;
  }
  return at;
}

// Does the full stop at `dot` end a word that carries one mid-sentence?
bool closesAbbreviation(const std::string& body, Span line, int dot) {
  static constexpr std::string_view known[] = {"mr", "mrs", "ms",  "dr",  "prof", "st",
                                               "jr", "sr",  "vs",  "etc", "e.g",  "i.e"};
  int start = dot;
  while (start > line.lo && !isBlank(body[start - 1])) --start;
  std::string word = body.substr(start, dot - start);
  for (char& c : word) {
    if (c >= 'A' && c <= 'Z') c += 'a' - 'A';
  }
  for (const std::string_view candidate : known) {
    if (word == candidate) return true;
  }
  return false;
}

// A boundary is a run of `.`, `!` or `?` followed by whitespace, and a run ending in a full stop is
// refused when that stop closes an abbreviation. Capitalisation is never consulted.
std::vector<Span> sentencesIn(const std::string& body, Span line) {
  std::vector<Span> sentences;
  int start = line.lo;
  for (int at = line.lo; at < line.hi; ++at) {
    const char c = body[at];
    if (c != '.' && c != '!' && c != '?') continue;

    int end = at;   // "..." and "?!" end one sentence, not three
    while (end + 1 < line.hi &&
           (body[end + 1] == '.' || body[end + 1] == '!' || body[end + 1] == '?')) ++end;
    const int after = pastClosers(body, line, end + 1);
    at = end;

    if (after >= line.hi) break;                                        // the line ends the sentence
    if (!isBlank(body[after])) continue;                                // inside a number or a url
    if (body[end] == '.' && closesAbbreviation(body, line, end)) continue;

    sentences.push_back(trimmed(body, {start, after}));
    start = after;
    at = after - 1;
  }
  const Span tail = trimmed(body, {start, line.hi});
  if (tail.lo < tail.hi) sentences.push_back(tail);
  return sentences;
}

// Fragments merge first and the `maxSentences` cap applies to what survives, so a merge may
// overrun it.
std::vector<Span> passagesIn(const std::string& body, Span line, const SegmentRules& rules) {
  std::vector<Unit> units;
  for (const Span& sentence : sentencesIn(body, line)) {
    if (!units.empty() && wordCount(body, sentence) < rules.minWords) {
      units.back().span.hi = sentence.hi;
      ++units.back().sentences;
      continue;
    }
    units.push_back({sentence, 1});
  }
  // An opening fragment joins the one after instead; with no "after", it stands as its own passage.
  if (units.size() > 1 && wordCount(body, units.front().span) < rules.minWords) {
    units[1].span.lo = units.front().span.lo;
    units[1].sentences += units.front().sentences;
    units.erase(units.begin());
  }

  std::vector<Span> passages;
  for (std::size_t i = 0; i < units.size();) {
    Span span = units[i].span;
    int sentences = units[i].sentences;
    ++i;
    while (i < units.size() && sentences + units[i].sentences <= rules.maxSentences) {
      span.hi = units[i].span.hi;
      sentences += units[i].sentences;
      ++i;
    }
    passages.push_back(span);
  }
  return passages;
}

}

// Passages are produced one line at a time; nothing downstream of `linesOf` sees across a break.
std::vector<Passage> segment(const std::string& body, const SegmentRules& rules) {
  std::vector<Passage> passages;
  for (const Span& line : linesOf(body)) {
    for (const Span& span : passagesIn(body, line, rules)) {
      passages.push_back(Passage{static_cast<int>(passages.size()), span.lo, span.hi,
                                 body.substr(span.lo, span.hi - span.lo)});
    }
  }
  return passages;
}

// Whitespace and nothing else: no case folding, no punctuation stripping, no Unicode folding.
std::string normalizedForIdentity(const std::string& text) {
  std::string identity;
  identity.reserve(text.size());
  bool separated = false;   // whitespace seen; spent only once something follows it
  for (const char c : text) {
    if (isBlank(c)) {
      separated = !identity.empty();
      continue;
    }
    if (separated) {
      identity.push_back(' ');
      separated = false;
    }
    identity.push_back(c);
  }
  return identity;
}

namespace {

// Does `unit` sit in `body` starting exactly at `at`, treating any run of whitespace on either side
// as one? Returns the end offset in the body, or -1. The unit is already trimmed by the caller.
int matchAt(const std::string& body, const std::string& unit, int at) {
  const int bodySize = static_cast<int>(body.size());
  const int unitSize = static_cast<int>(unit.size());
  int b = at;
  int u = 0;
  while (u < unitSize) {
    if (isBlank(unit[u])) {
      // A whitespace run must be answered by at least one whitespace byte, however spelled.
      if (b >= bodySize || !isBlank(body[b])) return -1;
      while (b < bodySize && isBlank(body[b])) ++b;
      while (u < unitSize && isBlank(unit[u])) ++u;
      continue;
    }
    if (b >= bodySize || body[b] != unit[u]) return -1;
    ++b;
    ++u;
  }
  return b;
}

// The first place at or after `from` where `unit` sits, or -1.
int findFrom(const std::string& body, const std::string& unit, int from) {
  if (unit.empty()) return -1;
  const int bodySize = static_cast<int>(body.size());
  for (int at = std::max(0, from); at < bodySize; ++at) {
    if (body[at] != unit[0]) continue;
    if (matchAt(body, unit, at) >= 0) return at;
  }
  return -1;
}

}

std::vector<Passage> locateUnits(const std::string& body, const std::vector<std::string>& units) {
  std::vector<Passage> passages;
  int after = 0;
  for (const std::string& raw : units) {
    const Span trimmedUnit = trimmed(raw, {0, static_cast<int>(raw.size())});
    const std::string unit = raw.substr(trimmedUnit.lo, trimmedUnit.hi - trimmedUnit.lo);
    if (unit.empty()) continue;

    int lo = findFrom(body, unit, after);
    // Out of order or overlapping something taken: look once from the top before giving up.
    if (lo < 0) lo = findFrom(body, unit, 0);
    if (lo < 0) continue;

    const int hi = matchAt(body, unit, lo);
    passages.push_back(Passage{static_cast<int>(passages.size()), lo, hi,
                               body.substr(lo, hi - lo)});
    after = hi;
  }
  return passages;
}

std::vector<Passage> atomsOf(const std::string& body) {
  // minWords 0 merges nothing and maxSentences 1 groups nothing, so `segment` cuts to its floor.
  return segment(body, SegmentRules{0, 1});
}

Grouping unitsFrom(const std::string& body, const std::vector<Passage>& atoms,
                   const std::vector<int>& starts) {
  Grouping grouped;
  if (atoms.empty()) return grouped;

  const int count = static_cast<int>(atoms.size());
  std::vector<int> opens;
  for (const int start : starts) {
    if (start < 1 || start > count) {
      ++grouped.dropped;                       // named an atom that is not on the page
      continue;
    }
    opens.push_back(start);
  }
  std::sort(opens.begin(), opens.end());
  const std::size_t named = opens.size();
  opens.erase(std::unique(opens.begin(), opens.end()), opens.end());
  grouped.dropped += static_cast<int>(named - opens.size());   // the same atom opened twice

  // The first atom opens a unit whether or not anyone said so: text before the first named start
  // belongs to somebody, and dropping it would lose the writer a thought.
  if (opens.empty() || opens.front() != 1) opens.insert(opens.begin(), 1);

  for (std::size_t i = 0; i < opens.size(); ++i) {
    const int from = opens[i] - 1;
    const int to = (i + 1 < opens.size() ? opens[i + 1] - 1 : count) - 1;
    const int lo = atoms[static_cast<std::size_t>(from)].lo;
    const int hi = atoms[static_cast<std::size_t>(to)].hi;
    grouped.units.push_back(Passage{static_cast<int>(grouped.units.size()), lo, hi,
                                    body.substr(lo, hi - lo)});
  }
  return grouped;
}

}
