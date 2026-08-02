#pragma once

#include "platform/adapters/http/LogFormat.h"

#include <drogon/HttpResponse.h>
#include <drogon/HttpTypes.h>

#include <chrono>
#include <string>

namespace wm {

// Why a call never got an answer. A closed set of words, because the only other way to say it is to
// print the vendor's own text — and the clients on this seam carry the most sensitive bytes in the
// product. dns / network / tls / timeout / bad-reply is everything an operator can act on anyway.
enum class VendorFault { none, dns, network, tls, timeout, badReply };

// A call that never landed is the vendor failing us however it failed, so a fault outranks whatever
// status came with it; past that the shared rule decides (LogFormat.h), which is what lets one alert
// cover both directions of the edge.
Severity levelForVendorCall(int status, VendorFault fault);

// `vendor=resend op=send status=200 340.5ms` — the line's body, without the timestamp trantor
// prepends. A fault takes the status field rather than printing a 0 no vendor ever returned. Pure,
// so the format is pinned by a test rather than read off a screen and hoped at.
std::string vendorCallLine(const std::string& vendor, const std::string& op, int status,
                           VendorFault fault, long long micros);

// One outbound third-party call, from the moment it is sent to the moment it answers. Built at the
// call site, carried into the callback, and settled exactly once — success reported as loudly as
// failure, because a vendor that has quietly gone slow never produces an error for anyone to notice.
//
// It is handed a status and a fault word and nothing else. No body, address, prompt, token or key
// can reach a log line through this seam, because there is no parameter for one to arrive in.
class VendorCall {
public:
  VendorCall(std::string vendor, std::string op);

  // The shape every drogon client shares: report the outcome, and answer the one question the call
  // site actually asks. Nine clients would otherwise each write their own "is this a 2xx" by hand,
  // and the one that got it wrong would be the one nobody read.
  bool succeeded(drogon::ReqResult result, const drogon::HttpResponsePtr& response);

  // The streaming leg speaks HTTP/1.1 itself, so it reports the status it read off the wire, and
  // names the transport failure when the reply never got that far.
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
