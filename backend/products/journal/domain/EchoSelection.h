#pragma once

#include "products/journal/domain/Page.h"

#include <cstdint>
#include <set>
#include <string>
#include <utility>
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

// Every knob in one struct. The defaults are the policy; nothing else in the codebase may hardcode
// these numbers.
struct SelectionRules {
  int minDayGap = 7;              // a page younger than a week is not an echo
  int shown = 10;                 // the cap on ONE TRIGGER's pairings — a whole page is capped by
                                  // SweepBudget::echoesPerPage instead

  double refrainRadius = 0.80;    // a candidate this close counts toward the crowd
  int refrainCrowd = 5;           // this many neighbours and the trigger is a refrain, not a thought

  double familyRadius = 0.85;     // candidates this close to EACH OTHER collapse into one family
  double restatement = 0.97;      // a candidate this close to the trigger is a restatement, not a memory

  int perBand = 8;                // top-k retrieved from each age band
  int maxRecent = 2;              // at most this many shown from the last 30 days
  int maxPerMonth = 2;            // at most this many shown from any one calendar month

  // A word this many of the writer's OWN passages carry is theirs, not an anchor. AnchorVocabulary's
  // built-in common-word list is English, so without this every word in another language looks rare.
  double commonShare = 0.40;
  // Below this many passages a corpus cannot say what is common — one word in three pages means
  // nothing — so the vocabulary stays empty and only the English list applies.
  int vocabularyFloor = 8;

  double distanceWeight = 0.15;   // alpha — how much age ranks
  double familyPenalty = 0.25;    // beta  — a candidate standing for many near-copies is worth less
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

// The writer's own common words, counted rather than guessed. Document frequency over PASSAGES, not
// occurrences: a word repeated four times in one passage is one passage's word. Under
// `vocabularyFloor` passages nothing is common.
struct AnchorVocabulary {
  std::set<std::string> common;

  static AnchorVocabulary of(const std::vector<Vectored>& corpus, const SelectionRules& rules);
};

// Do these two passages share at least one word that is uncommon FOR THIS WRITER — a name, a rare
// content word? No anchor, no echo, whatever the cosine says: it is what lets the reader see why
// two passages were put together. The two-argument form asks against the English list alone.
bool sharesAnchor(const std::string& a, const std::string& b);
bool sharesAnchor(const std::string& a, const std::string& b, const AnchorVocabulary& vocabulary);

// How many passages sit within `refrainRadius` of this trigger, its own row excluded. The count
// behind `isRefrain`, exposed so the debug door shows the number the rule read.
int crowdOf(const Vectored& trigger, const std::vector<Vectored>& corpus,
            const SelectionRules& rules);

// Is this trigger a refrain ("tired again", "long day, nothing to report") rather than a thought?
// A refrain emits nothing.
bool isRefrain(const Vectored& trigger, const std::vector<Vectored>& corpus,
               const SelectionRules& rules);

// The corpus narrowed to what this trigger is judged against: at least `minDayGap` older, then
// top-`perBand` by cosine from EACH age band — 7-30d, 1-3mo, 3-12mo, 1-3y, 3y+, so an old passage
// competes against its own era rather than against last month.
std::vector<Vectored> stratify(const Vectored& trigger, const std::vector<Vectored>& corpus,
                               const SelectionRules& rules);

// Collapse near-identical candidates into families (keeping the OLDEST member), drop restatements,
// apply the recency and per-month quotas, score, and return at most `shown` pairings ordered by
// score. The oldest qualifying candidate is guaranteed a slot. Deterministic — the same inputs
// always yield the same pairings in the same order.
std::vector<Pairing> select(const Vectored& trigger, const std::vector<Vectored>& candidates,
                            const SelectionRules& rules, const AnchorVocabulary& vocabulary = {});

// What became of one candidate, in the order the rules run. Produced BY the selection itself, never
// by a second pass that re-decides the same questions.
enum class Fate {
  selected,
  notRetrieved,    // close enough to be worth reporting, but retrieval never handed it over:
                   // younger than minDayGap, or beaten inside its own age band
  restatement,     // cosine >= rules.restatement — the same sentence again, not a memory
  noAnchor,        // no low-frequency word in common, so the reader could not check the pairing
  familyMember,    // collapsed into a near-identical family; `representative` is the one that stood
  recencyQuota,    // the last 30 days were already full
  monthQuota,      // its calendar month was already full
  outranked,       // qualified, lost the ranking
  dismissed,       // the reader waved this pairing away
  pageCap,         // selected for its trigger, then cut by the page's own ceiling
};

const char* fateText(Fate fate);

// One candidate as the selection saw it: every number the ranking read.
struct CandidateNote {
  std::int64_t spanId = 0;
  LocalDate day;
  std::string text;
  float cosine = 0.0f;
  long ageDays = 0;
  double z = 0.0;                    // against this trigger's own retrieved background
  double score = 0.0;                // the ranked score, where the candidate got as far as ranking
  int familySize = 1;
  std::int64_t representative = 0;   // the family's oldest member; its own id when it stood itself
  Fate fate = Fate::outranked;
};

// One trigger passage's whole pass: the refrain count, what retrieval handed over, the background
// the z-scores are against, and every candidate's fate.
struct TriggerTrace {
  std::int64_t spanId = 0;
  std::string text;
  int crowd = 0;
  bool refrain = false;
  int history = 0;                        // passages the corpus offered, before any gate
  int retrieved = 0;                      // what stratify handed to selection
  double mean = 0.0;
  double stddev = 0.0;
  std::vector<CandidateNote> notes;
};

// One trigger's selection, with the reasons. `select` is this without them.
struct Selection {
  std::vector<Pairing> pairings;
  std::vector<CandidateNote> notes;
  double mean = 0.0;
  double stddev = 0.0;
};

Selection selectExplained(const Vectored& trigger, const std::vector<Vectored>& candidates,
                          const SelectionRules& rules,
                          const AnchorVocabulary& vocabulary = {});

// A whole page's pairings — the refrain gate, per-trigger selection, the reader's dismissals and the
// page ceiling, in that order. It is the last step that is a pure function of passages and rules.
//
// `nearestReported` buys the near misses: the N closest passages retrieval did NOT hand over, noted
// as `notRetrieved`. It costs one extra cosine pass over the corpus per trigger, so the live path
// asks for none and only the debug door pays.
struct PageSelection {
  std::vector<Pairing> pairings;   // after the page cap, best first
  std::vector<TriggerTrace> traces;
  int refrains = 0;                // trigger passages that emitted nothing
  int cappedOut = 0;               // pairings the page ceiling cut
};

PageSelection selectForPage(const std::vector<Vectored>& tonight,
                            const std::vector<Vectored>& history,
                            const std::set<std::pair<std::int64_t, std::int64_t>>& dismissed,
                            const SelectionRules& rules, int echoesPerPage,
                            int nearestReported = 0);

}
