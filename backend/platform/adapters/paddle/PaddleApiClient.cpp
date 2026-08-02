#include "platform/adapters/paddle/PaddleApiClient.h"

#include "platform/adapters/http/VendorCall.h"

#include <drogon/HttpClient.h>
#include <drogon/HttpRequest.h>
#include <drogon/HttpResponse.h>

#include <json/json.h>

#include <memory>
#include <utility>

namespace wm {

namespace {
std::string asStr(const Json::Value& value) {
  return value.isString() ? value.asString() : std::string();
}

std::string dump(const Json::Value& value) {
  Json::StreamWriterBuilder builder;
  builder["indentation"] = "";
  return Json::writeString(builder, value);
}

std::optional<Json::Value> parse(const std::string& text) {
  Json::CharReaderBuilder builder;
  const std::unique_ptr<Json::CharReader> reader(builder.newCharReader());
  Json::Value parsed;
  std::string errors;
  if (!reader->parse(text.data(), text.data() + text.size(), &parsed, &errors)) return std::nullopt;
  return parsed;
}
}

PaddleApiClient::PaddleApiClient(std::string apiKey, const std::string& environment)
    : apiKey_(std::move(apiKey)),
      host_(environment == "production" ? "api.paddle.com" : "sandbox-api.paddle.com") {
  loop_.run();
}

void PaddleApiClient::request(int method, const std::string& op, const std::string& path,
                              const std::vector<std::pair<std::string, std::string>>& query,
                              const std::string& body,
                              std::function<void(std::optional<std::string>)> done) {
  auto client = drogon::HttpClient::newHttpClient("https://" + host_, loop_.getLoop());
  auto req = drogon::HttpRequest::newHttpRequest();
  req->setMethod(static_cast<drogon::HttpMethod>(method));
  req->setPath(path);
  // Never fold a query string into setPath — drogon percent-encodes the '?' into the path and the
  // request arrives at a route that doesn't exist.
  for (const auto& [key, value] : query) req->setParameter(key, value);
  req->addHeader("authorization", "Bearer " + apiKey_);
  if (!body.empty()) {
    req->setContentTypeCode(drogon::CT_APPLICATION_JSON);
    req->setBody(body);
  }

  // The status and the operation are enough to triage; the body can echo request detail — the
  // customer's address above all — and the key never appears in either.
  VendorCall call("paddle", op);
  client->sendRequest(
      req,
      [client, call, done = std::move(done)](drogon::ReqResult result,
                                             const drogon::HttpResponsePtr& resp) mutable {
        if (!call.succeeded(result, resp)) {
          done(std::nullopt);
          return;
        }
        done(std::string(resp->getBody()));
      },
      15.0);
}

void PaddleApiClient::createTransaction(const std::string& customerId, const std::string& userId,
                                        const std::string& priceId,
                                        std::function<void(std::optional<PaddleCheckout>)> done) {
  Json::Value item(Json::objectValue);
  item["price_id"] = priceId;
  item["quantity"] = 1;
  Json::Value transaction(Json::objectValue);
  transaction["items"].append(item);
  transaction["customer_id"] = customerId;
  // The stamp that makes the webhook's binding authoritative rather than inferred.
  transaction["custom_data"]["user_id"] = userId;

  request(drogon::Post, "transactions.create", "/transactions", {}, dump(transaction),
          [done = std::move(done)](std::optional<std::string> body) {
            const std::optional<Json::Value> json = body ? parse(*body) : std::nullopt;
            if (!json) {
              done(std::nullopt);
              return;
            }
            const Json::Value& data = (*json)["data"];
            PaddleCheckout checkout;
            checkout.transactionId = asStr(data["id"]);
            checkout.checkoutUrl = asStr(data["checkout"]["url"]);
            if (checkout.transactionId.empty()) {
              done(std::nullopt);
              return;
            }
            done(checkout);
          });
}

void PaddleApiClient::startCheckout(const std::string& email, const std::string& userId,
                                    const std::string& priceId,
                                    std::function<void(std::optional<PaddleCheckout>)> done) {
  if (!configured() || priceId.empty()) {
    done(std::nullopt);
    return;
  }

  // Reuse the customer this email already has, so a returning subscriber keeps one Paddle identity
  // (and one billing history) instead of collecting a customer per checkout.
  request(drogon::Get, "customers.find", "/customers", {{"email", email}}, "",
          [this, email, userId, priceId, done = std::move(done)](std::optional<std::string> body) mutable {
            const std::optional<Json::Value> json = body ? parse(*body) : std::nullopt;
            if (json) {
              const Json::Value& data = (*json)["data"];
              if (data.isArray() && !data.empty()) {
                const std::string existing = asStr(data[0]["id"]);
                if (!existing.empty()) {
                  createTransaction(existing, userId, priceId, std::move(done));
                  return;
                }
              }
            }

            Json::Value create(Json::objectValue);
            create["email"] = email;
            request(drogon::Post, "customers.create", "/customers", {}, dump(create),
                    [this, userId, priceId, done = std::move(done)](std::optional<std::string> made) mutable {
                      const std::optional<Json::Value> json = made ? parse(*made) : std::nullopt;
                      if (!json) {
                        done(std::nullopt);
                        return;
                      }
                      const std::string customerId = asStr((*json)["data"]["id"]);
                      if (customerId.empty()) {
                        done(std::nullopt);
                        return;
                      }
                      createTransaction(customerId, userId, priceId, std::move(done));
                    });
          });
}

}
