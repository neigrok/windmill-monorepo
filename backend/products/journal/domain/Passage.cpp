#include "products/journal/domain/Passage.h"

#include <algorithm>
#include <cstddef>
#include <string>
#include <string_view>
#include <vector>

namespace wm {

namespace {

// A half-open byte range into the body. Every cut this file makes lands on a newline, on ASCII
// whitespace, or immediately after an ASCII terminator or a whole closing quote — and no ASCII byte
// ever occurs inside a multi-byte UTF-8 sequence, so a span boundary is always a codepoint boundary
// without the segmenter decoding a single character.
struct Span {
  int lo = 0;
  int hi = 0;
};

// A run of sentences that will not be split further. The count travels with the span because the
// `maxSentences` cap is counted in sentences, and a merge puts several of them inside one unit.
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

// Whitespace-separated runs, so "- called mum" counts three: the bullet is a character the writer
// typed, and the alternative is a punctuation table that has to be right about every language the
// journal might be written in.
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

// The hard boundary. `journal_page.body` keeps the writer's soft line breaks, and a large share of
// nightly journalers write bare lists with no terminal punctuation anywhere — split those on
// sentences alone and three unrelated items become one passage whose vector means nothing.
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

// A closing quote or bracket sits after the full stop and belongs to the sentence it closes. The
// curly forms are here because a phone substitutes them as you type; each is three bytes and is
// stepped over whole, never byte by byte.
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

// Does the full stop at `dot` end a word that carries one mid-sentence? Deliberately short and
// obvious rather than exhaustive: this is someone's diary, not a legal corpus, and every entry here
// is a sentence break the segmenter refuses forever.
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

// Sentence boundaries within one line. A boundary is a run of `.`, `!` or `?` followed by
// whitespace — demanding the whitespace is what keeps "3.5" and "c++.net" whole without a special
// case for either — and a run ending in a full stop is refused when that stop closes an
// abbreviation. Capitalisation is never consulted: a journal is written in lower case.
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

// One line's passages: fragments merge first, and the cap applies to what survives. That order is
// the policy — a passage under `minWords` is a universal attractor, measured at a hub score of 18.4
// against 7.4 for a passage of ten words or more, so gluing one to its neighbour is worth overrunning
// `maxSentences` for, and never the other way round.
std::vector<Span> passagesIn(const std::string& body, Span line, const SegmentRules& rules) {
  std::vector<Unit> units;
  for (const Span& sentence : sentencesIn(body, line)) {
    // A fragment joins the passage before it — on this line only, because joining across one is
    // precisely what the line boundary exists to forbid.
    if (!units.empty() && wordCount(body, sentence) < rules.minWords) {
      units.back().span.hi = sentence.hi;
      ++units.back().sentences;
      continue;
    }
    units.push_back({sentence, 1});
  }
  // An opening fragment had nothing before it, so it joins the one after instead. With no "after"
  // either, the line is one short fragment and stands as its own passage — never nothing.
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

// Lines, then sentences within a line, then fragments merged into their neighbours. The nesting is
// the guarantee: passages are produced one line at a time, so nothing downstream of `linesOf` can
// see across a line break, let alone join over one.
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

// Whitespace and nothing else. No case folding, no punctuation stripping, no Unicode folding: this
// is the predicate that decides whether a deleted line is gone everywhere, and every forgiving
// transformation is a way for text the user removed to keep matching text that is still there.
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
      // A whitespace run must be answered by at least one whitespace byte, however either side
      // spells it — this is the newline a "one unit per line" answer flattened into a space.
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

// The first place at or after `from` where `unit` sits, or -1. Only positions whose byte equals the
// unit's first byte are tried, which is what keeps a long page and a long unit from costing their
// product on every call.
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
    // Out of order, or overlapping something already taken: look once from the top before giving
    // up, because a segmenter that reordered its answer still named real text.
    if (lo < 0) lo = findFrom(body, unit, 0);
    if (lo < 0) continue;

    const int hi = matchAt(body, unit, lo);
    passages.push_back(Passage{static_cast<int>(passages.size()), lo, hi,
                               body.substr(lo, hi - lo)});
    after = hi;
  }
  return passages;
}

}
