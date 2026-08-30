import Foundation
import SwiftUI

// Where the links are in a page of writing. The grammar is the brand's one, written down in
// packages/api-contract/journal-links.json; web paints from the same cases, so neither surface can
// drift alone. Conservative on purpose: a journal is prose, and a false link in the middle of a
// sentence is worse than a missed one — so only an explicit scheme or a `www.` counts, never a bare
// `whatever.com`.
enum JournalLinks {
    // UTF-16 offsets, which is the unit the shared golden is written in.
    struct Span: Equatable {
        let lo: Int
        let hi: Int
        let href: String
    }

    static func find(in text: String) -> [Span] {
        guard !text.isEmpty else { return [] }
        let page = text as NSString
        var found: [Span] = []
        for match in link.matches(in: text, range: NSRange(location: 0, length: page.length)) {
            let lo = match.range.location
            if gluedToAWord(text, at: lo) { continue }
            let raw = trimTail(page.substring(with: match.range))
            let scheme = raw.range(of: "^https?://", options: [.regularExpression, .caseInsensitive]) != nil
            guard hasHost(raw, scheme: scheme) else { continue }
            found.append(Span(lo: lo, hi: lo + (raw as NSString).length, href: scheme ? raw : "https://" + raw))
        }
        return found
    }

    // The writing with its links live: lamp, underlined, and tappable where the text itself is.
    static func attributed(_ text: String, tint: Color) -> AttributedString {
        let page = text as NSString
        var out = AttributedString()
        var at = 0
        for span in find(in: text) {
            if span.lo > at {
                out.append(AttributedString(page.substring(with: NSRange(location: at, length: span.lo - at))))
            }
            var piece = AttributedString(page.substring(with: NSRange(location: span.lo, length: span.hi - span.lo)))
            if let url = URL(string: span.href) {
                piece.link = url
                piece.foregroundColor = tint
                piece.underlineStyle = .single
            }
            out.append(piece)
            at = span.hi
        }
        if at < page.length { out.append(AttributedString(page.substring(from: at))) }
        return out
    }

    private static let link = try! NSRegularExpression(
        pattern: "(?:https?://|www\\.)[^\\s<>\"'`]+",
        options: [.caseInsensitive]
    )

    // Punctuation a sentence puts after a URL, never inside one.
    private static let tail: Set<Character> = [".", ",", ";", ":", "!", "?", "…", "*", "_", "'", "\"", "\u{2019}", "\u{201D}"]

    private static let closers: [Character: Character] = [")": "(", "]": "[", "}": "{"]

    private static func gluedToAWord(_ text: String, at offset: Int) -> Bool {
        guard offset > 0,
              let start = Range(NSRange(location: offset, length: 0), in: text)?.lowerBound,
              start > text.startIndex
        else { return false }
        let before = text[text.index(before: start)]
        return before.isLetter || before.isNumber || before == "@"
    }

    private static func trimTail(_ raw: String) -> String {
        var out = raw
        while let last = out.last {
            if let open = closers[last] {
                // A closer the URL opened itself stays — /wiki/Windmill_(machine) is the whole link.
                if opensIts(out, open: open, close: last) { return out }
                out.removeLast()
                continue
            }
            guard tail.contains(last) else { return out }
            out.removeLast()
        }
        return out
    }

    private static func opensIts(_ raw: String, open: Character, close: Character) -> Bool {
        var depth = 0
        for character in raw {
            if character == open { depth += 1 } else if character == close { depth -= 1 }
        }
        return depth >= 0
    }

    // With a scheme the writer said it was a link, so any host will do — a bare `localhost` included.
    // Without one, `www.` alone is not enough: the host has to end in something that looks like a TLD.
    private static func hasHost(_ raw: String, scheme: Bool) -> Bool {
        let afterScheme = raw.replacingOccurrences(
            of: "^https?://", with: "", options: [.regularExpression, .caseInsensitive]
        )
        let authority = afterScheme.prefix { $0 != "/" && $0 != "?" && $0 != "#" }
        let afterUser = authority.split(separator: "@", omittingEmptySubsequences: false).last ?? ""
        let host = afterUser.prefix { $0 != ":" }
        if host.isEmpty { return false }
        return scheme || String(host).range(of: "\\.[a-z]{2,}$", options: [.regularExpression, .caseInsensitive]) != nil
    }
}
