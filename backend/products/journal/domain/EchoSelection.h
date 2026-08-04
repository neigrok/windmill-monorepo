#pragma once

#include "products/journal/domain/Page.h"

#include <cstdint>
#include <string>
#include <vector>

namespace wm {

// A passage as retrieval sees it: who it is, when it was written, what it says, where it sits in
// the embedding space.
struct Vectored {
  std::int64_t spanId = 0;
  LocalDate day;
  std::string text;
  std::vector<float> vector;
};

// Every knob in one struct so a test can vary one and a reader can see the whole policy at once.
// The defaults are the shipped policy; nothing else in the codebase may hardcode these numbers.
struct SelectionRules {
  int minDayGap = 7;              // a page younger than a week is not an echo
  int shown = 10;                 // the cap on what one page carries

  double refrainRadius = 0.80;    // a candidate this close counts toward the crowd
  int refrainCrowd = 5;           // this many neighbours and the trigger is a refrain, not a thought

  double familyRadius = 0.85;     // candidates this close to EACH OTHER collapse into one family
  double restatement = 0.97;      // a candidate this close to the trigger is a restatement, not a memory

  int perBand = 8;                // top-k retrieved from each age band
  int maxRecent = 2;              // at most this many shown from the last 30 days
  int maxPerMonth = 2;            // at most this many shown from any one calendar month

  double distanceWeight = 0.15;   // alpha — the card sells distance, so distance must rank
  double familyPenalty = 0.25;    // beta  — a candidate standing for 30 near-copies is worth less
  double diversityPenalty = 0.50; // gamma — punish similarity to what is already selected
};

// One trigger-to-candidate pairing that survived selection, ready for curation.
struct Pairing {
  std::int64_t triggerSpanId = 0;
  std::int64_t matchSpanId = 0;
  float cosine = 0.0f;
  float score = 0.0f;         // the ranked score; ordering is by this, descending
  int familySize = 1;         // how many near-identical candidates this one stands for
};

// Cosine in [0, 1]. Mismatched or zero-norm vectors resonate with nothing — 0, never a divide.
float cosine(const std::vector<float>& a, const std::vector<float>& b);

// Whole days from `earlier` to `later`, negative if the order is reversed. Pure integer civil-date
// arithmetic (days-from-civil) so a developer's mac and CI's linux cannot disagree.
long daysBetween(const LocalDate& earlier, const LocalDate& later);

// Do these two passages share at least one low-frequency lexical anchor — a name, a rare content
// word, something outside the common-word list?
//
// This is the enforcement mechanism for "an echo may only assert something the user can CHECK from
// what is on screen". Two pronoun-only passages — "he was awful again tonight. i just went to bed."
// written eighteen months apart about two different men — sit at near-identical cosine and offer
// the reader no way at all to tell whether the pairing is right. Maximum apparent evidence, zero
// checkable evidence. No anchor, no echo, whatever the cosine says.
bool sharesAnchor(const std::string& a, const std::string& b);

// Is this trigger a refrain ("tired again", "long day, nothing to report") rather than a thought?
// Measured on a real single-author corpus: a refrain has twenty-plus neighbours above
// `refrainRadius`; every genuine echo trigger has between zero and six. A refrain emits nothing —
// it is the rule that stops a nightly journal handing someone ten copies of last Tuesday.
bool isRefrain(const Vectored& trigger, const std::vector<Vectored>& corpus,
               const SelectionRules& rules);

// The corpus narrowed to what this trigger is judged against: at least `minDayGap` older, then
// top-`perBand` by cosine from EACH age band — 7-30d, 1-3mo, 3-12mo, 1-3y, 3y+.
//
// Banding rather than a flat top-N is what makes the feature's own thesis reachable. "You may have
// forgotten you ever planned it" is a function of age, so an old passage has to compete against its
// own era; against a flat top-30 on a dense journal it loses every time to structurally similar
// prose from last month, and the curator can only reject — it can never rescue what retrieval
// never surfaced.
std::vector<Vectored> stratify(const Vectored& trigger, const std::vector<Vectored>& corpus,
                               const SelectionRules& rules);

// Collapse near-identical candidates into families (keeping the OLDEST member, which is the one the
// product's own copy is about), drop restatements, apply the recency and per-month quotas, score,
// and return at most `shown` pairings ordered by score. The oldest qualifying candidate is
// guaranteed a slot: the first time someone wrote a thing is the payload, and nothing else in the
// ranking protects it.
//
// Deterministic — the same inputs always yield the same pairings in the same order.
std::vector<Pairing> select(const Vectored& trigger, const std::vector<Vectored>& candidates,
                            const SelectionRules& rules);

}
