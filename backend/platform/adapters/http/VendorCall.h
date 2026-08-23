#pragma once

#include "platform/adapters/http/LogFormat.h"

#include <drogon/HttpResponse.h>
#include <drogon/HttpTypes.h>

#include <chrono>
#include <string>

namespace wm {

// Why a call never got an answer, as a closed set: dns / network / tls / timeout / bad-reply.
enum class VendorFault { none, dns, network, tls, timeout, badReply };

// A call that never landed is a fault, which outranks whatever status came with it; past that the
// shared rule decides (LogFormat.h).
Severity levelForVendorCall(int status, VendorFault fault);

// `vendor=resend op=send status=200 340.5ms` — the line's body, without trantor's timestamp. A
// fault takes the status field rather than printing a 0 no vendor ever returned.
std::string vendorCallLine(const std::string& vendor, const std::string& op, int status,
                           VendorFault fault, long long micros);

// One outbound third-party call, from send to answer. Built at the call site, carried into the
// callback, and settled exactly once. It is handed a status and a fault word and nothing else: no
// body, address, prompt, token or key can reach a log line through this seam.
class VendorCall {
public:
  VendorCall(std::string vendor, std::string op);

  // Report the outcome, and answer the one question the call site asks: was this a 2xx.
  bool succeeded(drogon::ReqResult result, const drogon::HttpResponsePtr& response);

  // The streaming leg speaks HTTP/1.1 itself, so it reports the status it read off the wire.
  void answered(int status);
  void lost(VendorFault fault);

private:
  void report(int status, VendorFault fault);

  std::string vendor_;
  std::string op_;
  std::chrono::steady_clock::time_point started_;
  bool reported_ = false;
};

}
