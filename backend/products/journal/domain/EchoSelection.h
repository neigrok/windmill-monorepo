#pragma once

#include "products/journal/domain/Page.h"

#include <cstdint>
#include <set>
#include <string>
#include <utility>
#include <vector>

namespace wm {

struct Vectored {
  std::int64_t spanId = 0;
  LocalDate day;
  std::string text;
  std::vector<float> vector;
};

// The defaults are the policy; nothing else hardcodes these numbers.
struct SelectionRules {
  int minDayGap = 7;              // a page younger than a week is not an echo
  int shown = 10;                 // the cap on ONE TRIGGER's pairings — a whole page is capped by
                                  // SweepBudget::echoesPerPage instead

  double refrainRadius = 0.80;    // a candidate this close counts toward the crowd
  int refrainCrowd = 5;           // this many neighbours and the trigger is a refrain

  double familyRadius = 0.85;     // candidates this close to EACH OTHER collapse into one family
  double restatement = 0.97;      // a candidate this close to the trigger is a restatement

  int perBand = 8;                // top-k retrieved from each age band
  int maxRecent = 2;              // at most this many shown from the last 30 days
  int maxPerMonth = 2;            // at most this many shown from any one calendar month

  // A word this many of the writer's own passages carry is theirs, not an anchor. AnchorVocabulary's
  // built-in common-word list is English, so without this every word in another language looks rare.
  double commonShare = 0.25;
  // Below this many passages the vocabulary stays empty and only the English list applies.
  int vocabularyFloor = 8;

  double distanceWeight = 0.15;   // alpha — how much age ranks
  double familyPenalty = 0.25;    // beta  — how much standing for many near-copies costs
  double diversityPenalty = 0.50; // gamma — punish similarity to what is already selected
};

struct Pairing {
  std::int64_t triggerSpanId = 0;
  std::int64_t matchSpanId = 0;
  float cosine = 0.0f;
  float score = 0.0f;         // the ranked score; ordering is by this, descending
  int familySize = 1;         // how many near-identical candidates this one stands for
};

// Cosine in [0, 1]. Mismatched or zero-norm vectors give 0, never a divide.
float cosine(const std::vector<float>& a, const std::vector<float>& b);

// Whole days from `earlier` to `later`, negative if the order is reversed. Integer civil-date
// arithmetic, so mac and CI linux cannot disagree.
long daysBetween(const LocalDate& earlier, const LocalDate& later);

// Document frequency over passages, not occurrences: a word repeated four times in one passage is
// one passage's word. Under `vocabularyFloor` passages nothing is common.
struct AnchorVocabulary {
  std::set<std::string> common;

  static AnchorVocabulary of(const std::vector<Vectored>& corpus, const SelectionRules& rules);
};

// Do these two passages share at least one word uncommon for this writer? No anchor, no echo,
// whatever the cosine says. The two-argument form asks against the English list alone.
bool sharesAnchor(const std::string& a, const std::string& b);
bool sharesAnchor(const std::string& a, const std::string& b, const AnchorVocabulary& vocabulary);

// How many passages sit within `refrainRadius` of this trigger, its own row excluded.
int crowdOf(const Vectored& trigger, const std::vector<Vectored>& corpus,
            const SelectionRules& rules);

// A refrain emits nothing.
bool isRefrain(const Vectored& trigger, const std::vector<Vectored>& corpus,
               const SelectionRules& rules);

// At least `minDayGap` older, then top-`perBand` by cosine from each age band: 7-30d, 1-3mo,
// 3-12mo, 1-3y, 3y+.
std::vector<Vectored> stratify(const Vectored& trigger, const std::vector<Vectored>& corpus,
                               const SelectionRules& rules);

// Collapse near-identical candidates into families (keeping the oldest member), drop restatements,
// apply the quotas, score, and return at most `shown` pairings by score. The oldest qualifying
// candidate is guaranteed a slot. Deterministic.
std::vector<Pairing> select(const Vectored& trigger, const std::vector<Vectored>& candidates,
                            const SelectionRules& rules, const AnchorVocabulary& vocabulary = {});

// What became of one candidate, in the order the rules run.
enum class Fate {
  selected,
  notRetrieved,    // close enough to be worth reporting, but retrieval never handed it over:
                   // younger than minDayGap, or beaten inside its own age band
  restatement,     // cosine >= rules.restatement
  noAnchor,        // no low-frequency word in common
  familyMember,    // collapsed into a near-identical family; `representative` is the one that stood
  recencyQuota,    // the last 30 days were already full
  monthQuota,      // its calendar month was already full
  outranked,       // qualified, lost the ranking
  dismissed,       // the reader waved this pairing away
  pageCap,         // selected for its trigger, then cut by the page's own ceiling
};

const char* fateText(Fate fate);

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

// `select` is this without the notes.
struct Selection {
  std::vector<Pairing> pairings;
  std::vector<CandidateNote> notes;
  double mean = 0.0;
  double stddev = 0.0;
};

Selection selectExplained(const Vectored& trigger, const std::vector<Vectored>& candidates,
                          const SelectionRules& rules,
                          const AnchorVocabulary& vocabulary = {});

// A whole page's pairings: refrain gate, per-trigger selection, dismissals, then the page ceiling.
// `nearestReported` also notes the N closest passages retrieval did not hand over, as
// `notRetrieved`, at the cost of one extra cosine pass over the corpus per trigger.
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
