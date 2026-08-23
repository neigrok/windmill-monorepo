#include "platform/adapters/http/VendorCall.h"

#include "test/testing.h"

#include <string>

using namespace wm;

TEST(vendor_call_levels_split_a_failing_vendor_from_one_refusing_us_from_traffic) {
  CHECK(levelForVendorCall(200, VendorFault::none) == Severity::info);
  CHECK(levelForVendorCall(201, VendorFault::none) == Severity::info);
  CHECK(levelForVendorCall(202, VendorFault::none) == Severity::info);
  CHECK(levelForVendorCall(302, VendorFault::none) == Severity::info);
  CHECK(levelForVendorCall(399, VendorFault::none) == Severity::info);
  CHECK(levelForVendorCall(400, VendorFault::none) == Severity::warn);
  CHECK(levelForVendorCall(401, VendorFault::none) == Severity::warn);
  CHECK(levelForVendorCall(422, VendorFault::none) == Severity::warn);
  CHECK(levelForVendorCall(429, VendorFault::none) == Severity::warn);
  CHECK(levelForVendorCall(499, VendorFault::none) == Severity::warn);
  CHECK(levelForVendorCall(500, VendorFault::none) == Severity::error);
  CHECK(levelForVendorCall(502, VendorFault::none) == Severity::error);
  CHECK(levelForVendorCall(529, VendorFault::none) == Severity::error);
}

// A call that never got an answer is an error whatever number rode along with it: the status is meaningless once the fault is set.
TEST(vendor_call_levels_treat_every_transport_fault_as_ours_to_chase) {
  CHECK(levelForVendorCall(0, VendorFault::dns) == Severity::error);
  CHECK(levelForVendorCall(0, VendorFault::network) == Severity::error);
  CHECK(levelForVendorCall(0, VendorFault::tls) == Severity::error);
  CHECK(levelForVendorCall(0, VendorFault::timeout) == Severity::error);
  CHECK(levelForVendorCall(0, VendorFault::badReply) == Severity::error);
  CHECK(levelForVendorCall(200, VendorFault::timeout) == Severity::error);
}

// Every field on the line is metadata the caller supplied by name: there is no parameter a body, an address, a prompt or a key could arrive in.
TEST(vendor_call_line_carries_the_vendor_operation_status_and_cost) {
  CHECK_EQ(vendorCallLine("resend", "send", 200, VendorFault::none, 340'500),
           std::string("vendor=resend op=send status=200 340.5ms"));
  CHECK_EQ(vendorCallLine("paddle", "customers.find", 403, VendorFault::none, 88'100),
           std::string("vendor=paddle op=customers.find status=403 88.1ms"));
  CHECK_EQ(vendorCallLine("openai", "transcribe", 500, VendorFault::none, 4'201'900),
           std::string("vendor=openai op=transcribe status=500 4201.9ms"));
}

// A call that never landed has no status; the word says which leg failed — dns is a config, tls is a cert, timeout is a vendor gone slow.
TEST(vendor_call_line_names_the_failed_leg_instead_of_inventing_a_status) {
  CHECK_EQ(vendorCallLine("anthropic", "compose.stream", 0, VendorFault::timeout, 90'000'000),
           std::string("vendor=anthropic op=compose.stream status=timeout 90000.0ms"));
  CHECK_EQ(vendorCallLine("google", "exchange", 0, VendorFault::dns, 12'000),
           std::string("vendor=google op=exchange status=dns 12.0ms"));
  CHECK_EQ(vendorCallLine("apple", "exchange", 0, VendorFault::tls, 55'500),
           std::string("vendor=apple op=exchange status=tls 55.5ms"));
  CHECK_EQ(vendorCallLine("amplitude", "forward", 0, VendorFault::network, 3'300),
           std::string("vendor=amplitude op=forward status=network 3.3ms"));
  CHECK_EQ(vendorCallLine("anthropic", "tend", 0, VendorFault::badReply, 1'700),
           std::string("vendor=anthropic op=tend status=bad-reply 1.7ms"));
}

TEST(vendor_call_line_lets_the_fault_take_the_status_field) {
  CHECK_EQ(vendorCallLine("resend", "send", 200, VendorFault::timeout, 10'000'000),
           std::string("vendor=resend op=send status=timeout 10000.0ms"));
}

TEST(vendor_call_line_keeps_one_decimal_so_fast_and_free_stay_different) {
  CHECK_EQ(vendorCallLine("resend", "send", 200, VendorFault::none, 40),
           std::string("vendor=resend op=send status=200 0.0ms"));
  CHECK_EQ(vendorCallLine("resend", "send", 200, VendorFault::none, 450),
           std::string("vendor=resend op=send status=200 0.4ms"));
  CHECK_EQ(vendorCallLine("resend", "send", 200, VendorFault::none, 0),
           std::string("vendor=resend op=send status=200 0.0ms"));
  CHECK_EQ(vendorCallLine("resend", "send", 200, VendorFault::none, 1'000'000),
           std::string("vendor=resend op=send status=200 1000.0ms"));
}
