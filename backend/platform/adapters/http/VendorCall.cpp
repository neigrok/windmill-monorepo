#include "platform/adapters/http/VendorCall.h"

#include <trantor/utils/Logger.h>

#include <utility>

namespace wm {

namespace {
const char* faultWord(VendorFault fault) {
  switch (fault) {
    case VendorFault::dns: return "dns";
    case VendorFault::network: return "network";
    case VendorFault::tls: return "tls";
    case VendorFault::timeout: return "timeout";
    case VendorFault::badReply: return "bad-reply";
    case VendorFault::none: return "";
  }
  return "";
}

// drogon's transport verdicts, collapsed onto the words above. The default arm is deliberate: a
// newer drogon adding a result must degrade to "network", never fail to build this file.
VendorFault faultFor(drogon::ReqResult result) {
  switch (result) {
    case drogon::ReqResult::Ok: return VendorFault::none;
    case drogon::ReqResult::BadResponse: return VendorFault::badReply;
    case drogon::ReqResult::BadServerAddress: return VendorFault::dns;
    case drogon::ReqResult::Timeout: return VendorFault::timeout;
    case drogon::ReqResult::HandshakeError: return VendorFault::tls;
    case drogon::ReqResult::InvalidCertificate: return VendorFault::tls;
    default: return VendorFault::network;
  }
}
}

Severity levelForVendorCall(int status, VendorFault fault) {
  if (fault != VendorFault::none) return Severity::error;
  return severityForStatus(status);
}

std::string vendorCallLine(const std::string& vendor, const std::string& op, int status,
                           VendorFault fault, long long micros) {
  const std::string answer =
      fault == VendorFault::none ? std::to_string(status) : std::string(faultWord(fault));
  return "vendor=" + vendor + " op=" + op + " status=" + answer + " " + tookMs(micros) + "ms";
}

VendorCall::VendorCall(std::string vendor, std::string op)
    : vendor_(std::move(vendor)), op_(std::move(op)), started_(std::chrono::steady_clock::now()) {}

bool VendorCall::succeeded(drogon::ReqResult result, const drogon::HttpResponsePtr& response) {
  const VendorFault fault = faultFor(result);
  if (fault != VendorFault::none) {
    report(0, fault);
    return false;
  }
  // An Ok with nothing attached is drogon telling us the call landed and saying nothing about what
  // came back — which is a reply we could not read, not a status of zero.
  if (!response) {
    report(0, VendorFault::badReply);
    return false;
  }

  const int status = static_cast<int>(response->getStatusCode());
  report(status, VendorFault::none);
  return status >= 200 && status < 300;  // any 2xx — the one definition of success on this seam
}

void VendorCall::answered(int status) {
  if (status < 100) {
    report(0, VendorFault::badReply);  // the reply ended before it ever named a status
    return;
  }
  report(status, VendorFault::none);
}

void VendorCall::lost(VendorFault fault) { report(0, fault); }

void VendorCall::report(int status, VendorFault fault) {
  if (reported_) return;  // a call reports its outcome once, whichever path settled it first
  reported_ = true;

  const long long micros = std::chrono::duration_cast<std::chrono::microseconds>(
                               std::chrono::steady_clock::now() - started_)
                               .count();
  const std::string line = vendorCallLine(vendor_, op_, status, fault, micros);
  switch (levelForVendorCall(status, fault)) {
    case Severity::error: LOG_ERROR << line; return;
    case Severity::warn: LOG_WARN << line; return;
    case Severity::info: LOG_INFO << line; return;
  }
}

}
