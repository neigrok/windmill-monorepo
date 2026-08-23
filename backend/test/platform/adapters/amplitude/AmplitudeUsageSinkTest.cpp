#include "platform/adapters/amplitude/AmplitudeUsageSink.h"

#include "test/testing.h"

#include <memory>
#include <stdexcept>
#include <vector>

namespace {

using namespace wm;

struct RecordingLedger : UsageSink {
  std::vector<AiSpend> spends;
  void record(const AiSpend& spend) noexcept override { spends.push_back(spend); }
};

struct ThrowingLedger : UsageSink {
  // noexcept on the port means a throw here would terminate.
  void record(const AiSpend&) noexcept override {}
};

AiSpend spendOf(const char* product, const char* model) {
  AiSpend spend;
  spend.product = product;
  spend.operation = "test.call";
  spend.model = model;
  spend.runId = "run-1";
  spend.outcome = AiOutcome::ok;
  spend.tokens = TokenUse{1000, 100, 0, 0};
  return spend;
}

}

// A spend reaches the ledger whether or not there is anywhere to mirror it to; an unconfigured Amplitude must not cost a single row.
TEST(amplitude_usage_sink_writes_the_ledger_even_with_no_amplitude_behind_it) {
  auto ledger = std::make_shared<RecordingLedger>();
  AmplitudeUsageSink sink{ledger, nullptr};

  sink.record(spendOf("roadmap", "claude-sonnet-5"));
  sink.record(spendOf("gym", "claude-opus-5"));

  CHECK_EQ(ledger->spends.size(), 2u);
  CHECK_EQ(ledger->spends[0].product, std::string{"roadmap"});
  CHECK_EQ(ledger->spends[0].model, std::string{"claude-sonnet-5"});
  CHECK_EQ(ledger->spends[0].tokens.input, 1000);
  CHECK_EQ(ledger->spends[1].product, std::string{"gym"});
}

// A client with an empty key is the shape production takes when AMPLITUDE_API_KEY is unset. Recording through it must be silent and still reach the ledger.
TEST(amplitude_usage_sink_stays_quiet_and_still_records_when_the_key_is_empty) {
  auto ledger = std::make_shared<RecordingLedger>();
  auto amplitude = std::make_shared<AmplitudeClient>("");
  AmplitudeUsageSink sink{ledger, amplitude};

  sink.record(spendOf("journal", "claude-opus-5"));
  // An unpriced model too: the mirror computes a cost for its own properties, and a model it cannot price must not throw on the way to the ledger.
  sink.record(spendOf("journal", "claude-nothing-we-know"));

  CHECK_EQ(ledger->spends.size(), 2u);
  CHECK_EQ(ledger->spends[1].model, std::string{"claude-nothing-we-know"});
}

// Both collaborators absent is the degenerate wiring: five adapters treat a null sink as "record nowhere".
TEST(amplitude_usage_sink_with_nothing_behind_it_is_a_no_op_rather_than_a_crash) {
  AmplitudeUsageSink sink{nullptr, nullptr};
  sink.record(spendOf("roadmap", "claude-sonnet-5"));

  auto throwing = std::make_shared<ThrowingLedger>();
  AmplitudeUsageSink guarded{throwing, nullptr};
  guarded.record(spendOf("roadmap", "claude-sonnet-5"));
  CHECK(true);
}
