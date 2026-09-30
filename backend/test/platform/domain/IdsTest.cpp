#include "platform/domain/Ids.h"

#include "test/testing.h"

#include <cstdint>
#include <limits>
#include <optional>
#include <string>

using namespace wm;

// The stamp codec and the clock's tick and observe rules are pinned by the golden corpus
// (sync_corpus/stamp/*, sync_corpus/hlc/*); these cases cover what the corpus cannot say.

TEST(hlc_text_round_trips_including_the_unset_sentinel) {
  Hlc stamp{1770000000123ull, 7, "u_42#r_8f31c2"};
  CHECK_EQ(parseHlc(toString(stamp)), std::optional<Hlc>(stamp));
  CHECK_EQ(toString(Hlc{}), std::string("0:0:"));
  CHECK_EQ(parseHlc("0:0:"), std::optional<Hlc>(Hlc{}));
  CHECK_FALSE(parseHlc("0:0:")->isSet());
}

TEST(a_text_that_is_not_a_stamp_parses_to_nothing_rather_than_throwing) {
  CHECK_EQ(parseHlc(""), std::nullopt);
  CHECK_EQ(parseHlc("x:0:dev"), std::nullopt);
  CHECK_EQ(parseHlc("99999999999999999999999:0:a"), std::nullopt);   // past 64 bits, not an overflow
  CHECK_EQ(parseHlc("5:0:"), std::nullopt);
}

TEST(hlc_clock_ticks_are_strictly_monotone_even_when_wall_time_goes_backward) {
  HlcClock clock("a");
  Hlc first = clock.tick(100);
  Hlc second = clock.tick(100);   // same wall ms → counter advances
  Hlc third = clock.tick(50);     // wall ms went backward → still dominates
  Hlc fourth = clock.tick(200);   // wall ms jumps forward → counter resets, still dominates
  CHECK(second > first);
  CHECK(third > second);
  CHECK(fourth > third);
  CHECK_EQ(fourth.physicalMs, 200ull);
  CHECK_EQ(fourth.counter, 0u);
}

TEST(hlc_clock_carries_a_full_counter_into_the_next_millisecond_and_stays_monotone) {
  HlcClock clock("a", HlcClock::State{1000, std::numeric_limits<std::uint32_t>::max() - 1});
  Hlc last = clock.tick(0);
  Hlc carried = clock.tick(0);
  CHECK_EQ(last, (Hlc{1000, std::numeric_limits<std::uint32_t>::max(), "a"}));
  CHECK_EQ(carried, (Hlc{1001, 0, "a"}));
  CHECK(carried > last);
  CHECK_EQ(clock.state(), (HlcClock::State{1001, 0}));
}

TEST(hlc_clock_observe_makes_the_next_tick_dominate_the_observed_stamp) {
  HlcClock clock("a");
  Hlc remote{5000, 3, "b"};
  clock.observe(remote);
  Hlc next = clock.tick(10);  // local wall time is far behind the observed stamp
  CHECK(next > remote);       // the receive rule: a write after seeing a tombstone beats it
}

TEST(distinct_replica_actors_never_tie) {
  HlcClock tabOne("u_42#r_aaa");
  HlcClock tabTwo("u_42#r_bbb");
  Hlc a = tabOne.tick(100);
  Hlc b = tabTwo.tick(100);   // same user, same wall ms, different replica nonce
  CHECK_FALSE(a == b);        // the uniqueness precondition holds across tabs
}
