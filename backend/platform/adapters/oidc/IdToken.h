#pragma once

#include <json/json.h>

#include <optional>
#include <string>

namespace wm {

// The claims inside an id_token, or nullopt if the token is malformed. The signature is NOT checked:
// both providers are driven through a server-side code exchange, so the TLS connection this process
// opened to the provider's token endpoint is the proof of origin. A token handed to us by a client
// carries no such proof and must never reach this function.
std::optional<Json::Value> idTokenClaims(const std::string& idToken);

// A string claim, or "" for anything that isn't one. asString() throws on a non-string node and a
// claim like `aud` can legally be an array, so every claim is read through here.
std::string stringClaim(const Json::Value& claims, const char* name);

// email_verified rides as a bool or as the string "true" depending on the provider's serialization
// (Apple sends the string; Google has sent both).
bool verifiedClaim(const Json::Value& claims, const char* name);

}
