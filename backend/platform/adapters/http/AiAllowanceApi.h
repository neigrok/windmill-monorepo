#pragma once

#include "platform/application/AuthService.h"
#include "platform/application/Entitlements.h"
#include "platform/ports/FailureReporter.h"

#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>
#include <functional>
#include <memory>

namespace wm {

class AiAllowanceApi {
public:
  AiAllowanceApi(std::shared_ptr<AuthService> auth, std::shared_ptr<Entitlements> entitlements,
                 std::shared_ptr<FailureReporter> failures);
  void get(const drogon::HttpRequestPtr& request,
           std::function<void(const drogon::HttpResponsePtr&)>&& reply);

private:
  std::shared_ptr<AuthService> auth_;
  std::shared_ptr<Entitlements> entitlements_;
  std::shared_ptr<FailureReporter> failures_;
};

}
