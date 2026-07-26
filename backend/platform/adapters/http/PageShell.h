#pragma once

#include <drogon/HttpResponse.h>

#include <string>

namespace wm {

// The seam every crawlable, server-rendered page shares: the design lives as a file in the web
// root (the frontend repo owns every pixel of it), and the server splices its content between
// two marker comments. The share page rewrites the SPA shell's unfurl meta this way; the gallery
// fills the wall's card grid the same way. C++ never owns a stylesheet.
std::string htmlEscape(const std::string& text);

// Read a file from the deployed web root. An unset root or an unreadable file yields "", which
// every caller reads as "degrade", never as a crash.
std::string readWebFile(const std::string& webRoot, const std::string& name);

// Replace whatever sits between the two markers with `content`, keeping the markers themselves.
// A shell missing either marker — or carrying them out of order — comes back untouched, so a
// template edit can only ever cost the injection, never leave a half-rewritten page.
std::string spliceBetween(const std::string& shell, const std::string& startTag,
                          const std::string& endTag, const std::string& content);

drogon::HttpResponsePtr htmlPage(std::string body);

}
