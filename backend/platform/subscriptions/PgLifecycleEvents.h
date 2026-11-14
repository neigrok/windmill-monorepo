#pragma once

#include "platform/adapters/postgres/PgEventRepository.h"
#include "platform/ports/EventRepository.h"
#include "platform/subscriptions/EntitlementCopy.h"

namespace wm::subscriptions {

// §10: what happens to a subscription with no device present, recorded as a product event in the store the /v1/events
// intake writes and forwards from: six of the feed's events, each with `store`, `environment` and `offer_kind` alone,
// attributed to the account the entry names. Its key digests the subscription, the name and the store's instant, which a
// restored ledger replaying the same statements states alike where its seq does not, so no page read again and no
// rebuild records it twice; two events of one name for one subscription at one instant are one. The forwarder hears of
// it once its page commits.
class PgLifecycleEvents : public FeedEntryConsumer {
public:
  PgLifecycleEvents(PgEventRepository& events, EventForwarder& forwarder) : events_(events), forwarder_(forwarder) {}

  void consume(PageTxn& page, const FeedEntry& entry) override;

private:
  PgEventRepository& events_;
  EventForwarder& forwarder_;
};

}
