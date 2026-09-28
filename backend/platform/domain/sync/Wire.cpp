#include "platform/domain/sync/Wire.h"

#include "platform/domain/sync/Jcs.h"

#include <algorithm>
#include <array>

namespace wm::sync {

namespace {

constexpr char kBase64Url[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

bool isSeq(const Json::Value& value) {
  return isSafeInteger(value) && value.asDouble() >= 0;
}

bool isIdOfKey(const Json::Value& id) {
  if (id.isString()) return true;
  if (!id.isArray() || id.empty()) return false;
  for (const Json::Value& part : id) {
    if (!part.isString()) return false;
  }
  return true;
}

}

std::string base64Url(std::string_view bytes) {
  std::string text;
  std::uint32_t buffer = 0;
  int bits = 0;
  for (const char c : bytes) {
    buffer = (buffer << 8) | static_cast<unsigned char>(c);
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      text.push_back(kBase64Url[(buffer >> bits) & 0x3F]);
    }
  }
  if (bits > 0) text.push_back(kBase64Url[(buffer << (6 - bits)) & 0x3F]);
  return text;
}

std::optional<std::string> fromBase64Url(std::string_view text) {
  std::array<int, 256> values{};
  values.fill(-1);
  for (int i = 0; i < 64; ++i) values[static_cast<unsigned char>(kBase64Url[i])] = i;
  std::string bytes;
  std::uint32_t buffer = 0;
  int bits = 0;
  for (const char c : text) {
    const int value = values[static_cast<unsigned char>(c)];
    if (value < 0) return std::nullopt;
    buffer = (buffer << 6) | static_cast<std::uint32_t>(value);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push_back(static_cast<char>((buffer >> bits) & 0xFF));
    }
  }
  return bytes;
}

Json::Value WriteEntry::toJson() const {
  Json::Value entry(Json::objectValue);
  entry["t"] = t;
  entry["id"] = id.json();
  if (from) entry["from"] = from->json();
  if (born) entry["born"] = toString(*born);
  if (f.empty()) return entry;
  Json::Value& fields = entry["f"] = Json::Value(Json::objectValue);
  for (const auto& [name, stamp] : f) fields[name] = toString(stamp);
  return entry;
}

Json::Value okResult(Seq seq, const std::optional<std::vector<WriteEntry>>& write, const Json::Value& detail) {
  Json::Value result(Json::objectValue);
  result["s"] = "ok";
  result["seq"] = Json::UInt64(seq);
  if (write) {
    Json::Value& entries = result["write"] = Json::Value(Json::arrayValue);
    for (const WriteEntry& entry : *write) entries.append(entry.toJson());
  }
  if (!detail.isNull()) result["detail"] = detail;
  return result;
}

Json::Value refusedResult(const Refused& refused) {
  Json::Value result(Json::objectValue);
  result["s"] = "refused";
  result["code"] = refused.code;
  if (!refused.detail.isNull()) result["detail"] = refused.detail;
  return result;
}

bool isAccountId(std::string_view id) {
  if (id.size() > kAccountIdBytes) return false;
  const std::string text(id);
  try {
    return jcs(Json::Value(text)) == "\"" + text + "\"";
  } catch (const JsonError&) {
    return false;
  }
}

Json::Value servedAsJson(const std::optional<UserId>& principal) {
  return principal ? Json::Value(principal->str()) : Json::Value(Json::nullValue);
}

std::string Cursor::encode() const {
  Json::Value wire(Json::objectValue);
  wire["e"] = epoch;
  wire["m"] = live ? "live" : "boot";
  wire["s"] = Json::UInt64(seq);
  if (key) {
    Json::Value& k = wire["k"] = Json::Value(Json::arrayValue);
    k.append(key->first);
    k.append(key->second.json());
  }
  if (asOf) wire["a"] = Json::UInt64(*asOf);
  return base64Url(jcs(wire));
}

std::optional<Cursor> Cursor::decode(std::string_view text) {
  const std::optional<std::string> bytes = fromBase64Url(text);
  if (!bytes) return std::nullopt;
  Json::Value wire;
  try {
    wire = parseJson(*bytes);
  } catch (const JsonError&) {
    return std::nullopt;
  }
  if (!wire.isObject()) return std::nullopt;
  for (const std::string& name : wire.getMemberNames()) {
    if (name != "e" && name != "m" && name != "s" && name != "k" && name != "a") return std::nullopt;
  }
  if (!wire["e"].isString() || !wire["m"].isString() || !isSeq(wire["s"])) return std::nullopt;
  const std::string mode = wire["m"].asString();
  if (mode != "boot" && mode != "live") return std::nullopt;

  Cursor cursor{.epoch = wire["e"].asString(), .live = mode == "live", .seq = wire["s"].asUInt64()};
  if (wire.isMember("k")) {
    const Json::Value& k = wire["k"];
    if (!k.isArray() || k.size() != 2 || !k[0].isString() || !isIdOfKey(k[1])) return std::nullopt;
    cursor.key = std::pair(k[0].asString(), RecordId(k[1]));
  }
  if (cursor.live == wire.isMember("a")) return std::nullopt;
  if (!cursor.live) {
    if (!isSeq(wire["a"]) || wire["a"].asUInt64() < cursor.seq) return std::nullopt;
    cursor.asOf = wire["a"].asUInt64();
  }
  if (cursor.encode() != text) return std::nullopt;
  return cursor;
}

Json::Value changeFrame(const std::string& epoch, const ScopeKey& scope, Seq seq, const Digest256& digest, std::vector<Json::Value> rows,
                        std::size_t inlineLimit) {
  Json::Value frame(Json::objectValue);
  frame["op"] = "change";
  frame["scope"] = scope.ref();
  frame["epoch"] = epoch;
  frame["seq"] = Json::UInt64(seq);
  frame["digest"] = digest.hex();
  std::sort(rows.begin(), rows.end(), [](const Json::Value& a, const Json::Value& b) {
    if (a["t"].asString() != b["t"].asString()) return a["t"].asString() < b["t"].asString();
    return jcs(a["id"]) < jcs(b["id"]);
  });
  Json::Value inlined(Json::arrayValue);
  for (Json::Value& row : rows) inlined.append(std::move(row));
  if (jcs(inlined).size() <= inlineLimit) frame["rows"] = std::move(inlined);
  return frame;
}

Digest256 intentDigest(const Json::Value& intent) {
  return sha256(jcs(intent));
}

}
