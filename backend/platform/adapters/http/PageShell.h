#pragma once

#include <drogon/HttpResponse.h>

#include <string>

namespace wm {

// The seam every crawlable, server-rendered page shares: the design lives as a file in the web
// root, and the server splices its content between two marker comments.
std::string htmlEscape(const std::string& text);

// Read a file from the deployed web root. An unset root or an unreadable file yields "", which
// every caller reads as "degrade", never as a crash.
std::string readWebFile(const std::string& webRoot, const std::string& name);

// Replace whatever sits between the two markers with `content`, keeping the markers themselves.
// A shell missing either marker — or carrying them out of order — comes back untouched.
std::string spliceBetween(const std::string& shell, const std::string& startTag,
                          const std::string& endTag, const std::string& content);

// Whom an answer is the same for: everyone, so any cache may keep it for five minutes, or the caller it was read for
// alone, so no cache keeps it and none hands it to someone else.
enum class Audience { everyone, caller };

// The Cache-Control an answer for `audience` carries.
const char* cacheControlFor(Audience audience);

drogon::HttpResponsePtr htmlPage(std::string body, Audience audience = Audience::everyone);

}
