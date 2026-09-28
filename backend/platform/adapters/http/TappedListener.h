#pragma once

#include <drogon/HttpAppFramework.h>

#include <cstddef>
#include <cstdint>
#include <string>

namespace wm {

// The server's listener, every connection's bytes read through a CredentialTap of its own before Drogon parses them,
// so the sync endpoints read §9.1's credentials as sent (tappedCredentialsOf). A connection the tap refuses is answered
// 400 and closed.
// Where Drogon hands each accepted connection to its connection callback before it reads a byte (Linux: Drogon 1.9
// applies the callback in its Linux listener alone), the tap wraps Drogon's own reader. Elsewhere a relay takes the
// port: it taps each connection's bytes and carries them over loopback to Drogon, listening on a free loopback port,
// and carries Drogon's answers back untouched.
// The relay serves development builds: production runs on Linux. Drogon's loopback port takes requests no tap read, so a
// process on the same machine that connects to it directly is read as whatever kSentCredentialsField it sends.
// Call once, instead of addListener, before app().run(); `ioThreads` sizes the relay's own loops.
void listenTapped(drogon::HttpAppFramework& app, const std::string& host, std::uint16_t port, std::size_t ioThreads);

}
