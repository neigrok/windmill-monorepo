import SwiftUI
import UIKit
import WindmillPlatform

// THE COACH SHARE — one workout, handed to one person, by the lifter's own hand. It is the whole of
// gym's sharing and the shape is the point: a capability that EXPIRES and is REVOKED by deleting one
// row, per session, never per account. There is no profile, no feed, no gallery and no social share
// sheet; nothing about a session is discoverable without the token, and every other read in this
// product is still `WHERE user_id = :caller`.
//
// What the copy has to say, in every state it can be in, because a link that leaves your phone is a
// thing you are owed the truth about: ANYONE WHO HAS IT CAN READ THIS ONE WORKOUT · IT EXPIRES ·
// YOU CAN REVOKE IT. The expiry is the server's fact and is printed from the reply, never counted
// off this device's clock — a device-local clock can support an omission, never an assertion.

// What `POST /v1/gym/sessions/{id}/share` answers with. Idempotent on the session: tapping Share
// twice hands back the link that is already live rather than a second capability to revoke later.
public struct SessionShare: Equatable, Codable, Sendable {
    public let token: String
    public let expiresAtMs: Int64
    // The link, composed by the SERVER, because it is the only participant that knows where the
    // browser app is served. Optional so a phone talking to a backend older than this field still
    // decodes; `Coach.link` says what happens then.
    public let url: String?

    public init(token: String, expiresAtMs: Int64, url: String? = nil) {
        self.token = token
        self.expiresAtMs = expiresAtMs
        self.url = url
    }

    enum CodingKeys: String, CodingKey {
        case token
        case expiresAtMs = "expiresAt"
        case url
    }
}

public enum Coach {
    // The offer, and the sentence under it that is the same whether the door has never been opened
    // or the log just refused to open it. Said before anything is minted, so it names no expiry date
    // — there is no share yet and therefore no day to name.
    public static let offer = """
        A link to this one workout — every set, load and rep in it, and nothing else about your \
        account. Anyone who has the link can read it. It expires, and you can revoke it whenever \
        you like.
        """

    public struct Card: Equatable {
        public let title: String
        public let body: String
        public let link: String?
        public let action: String
        public let revoke: String?
        public let note: String?          // the log's own words, when a door did not open
    }

    // Four states, and `note` rides on the two that can carry a refusal: a mint that failed leaves
    // the card closed WITH a reason, and a revoke that failed leaves the link live WITH one — the
    // link is still out there and a card that said otherwise would be the lie that matters most here.
    public enum State: Equatable {
        case closed(note: String? = nil)
        case working
        case live(share: SessionShare, copied: Bool = false, note: String? = nil)
        case revoked

        // The whole state machine, as one pure step. It is here rather than inside the view because
        // the rule that matters most in it — A REVOKE THAT DID NOT HAPPEN LEAVES THE LINK LIVE — is
        // a decision about what a lifter is told about a capability that is still out there, and a
        // decision like that belongs somewhere a test can stand.
        public func after(_ event: Event) -> State {
            switch event {
            case .asked:
                return .working
            case .minted(let share):
                return .live(share: share)
            case .mintFailed(let why):
                return .closed(note: why)
            case .copied:
                guard case .live(let share, _, let note) = self else { return self }
                return .live(share: share, copied: true, note: note)
            case .revoked:
                return .revoked
            // The note is the news, so the copied flag goes back down with it: the button under a
            // failure reads "Copy link" again rather than claiming a clipboard state from before it.
            case .revokeFailed(let why):
                guard case .live(let share, _, _) = self else { return self }
                return .live(share: share, note: why)
            }
        }
    }

    public enum Event: Equatable {
        case asked
        case minted(SessionShare)
        case mintFailed(String)
        case copied
        case revoked
        case revokeFailed(String)
    }

    // The address the coach opens, and it is the server's to compose rather than ours. This phone
    // knows where the API answers; it does not know where the browser app is served, and the two are
    // one host in production — which is exactly how this shipped pointing at `/v1/gym/shared/…`, the
    // JSON route, so a coach tapping a link from a phone was handed a page of JSON.
    //
    // The fallback is the reader page's own route and never the API's, so the worst case against an
    // older backend is a link built from the wrong host rather than one that opens the wrong thing.
    public static func link(_ share: SessionShare, base: URL) -> String {
        if let sent = share.url, !sent.isEmpty { return sent }
        let origin = base.absoluteString.hasSuffix("/")
            ? String(base.absoluteString.dropLast())
            : base.absoluteString
        return "\(origin)/#/gym/shared/\(share.token)"
    }

    public static func card(_ state: State, base: URL) -> Card {
        switch state {
        case .closed(let note):
            return Card(title: "Share with a coach", body: offer, link: nil,
                        action: note == nil ? "Get a link" : "Try again", revoke: nil, note: note)
        case .working:
            return Card(title: "Share with a coach", body: offer, link: nil,
                        action: "…", revoke: nil, note: nil)
        case .live(let share, let copied, let note):
            return Card(
                title: "The link is live",
                body: "Anyone who has this link can read this one workout. It stops working on "
                    + "\(Readout.day(share.expiresAtMs)), and revoking it kills it immediately.",
                link: link(share, base: base),
                action: copied ? "Copied" : "Copy link",
                revoke: "Revoke the link",
                note: note)
        case .revoked:
            return Card(title: "The link is dead",
                        body: "Anyone still holding it gets nothing. You can make a new one whenever you like.",
                        link: nil, action: "Get a new link", revoke: nil, note: nil)
        }
    }
}

// The two doors the room lends this card, already bound to one session, plus where the log lives so
// the token can be spelled as an address. Passed as a value for the same reason the finish screen
// takes `onDiscard` rather than the store: a screen that holds the store can write to the log in
// ways its own copy does not describe.
struct CoachDoors {
    let base: URL
    let mint: () async -> Result<SessionShare, TrainingStore.WriteFailure>
    let revoke: () async -> TrainingStore.WriteFailure?
}

// One drawing of the share, used by the screen a session ends on and by the screen it is revisited
// from. Nothing is minted until the tap, and nothing on screen claims a link exists until the log
// has said so — the same rule "Keep this as a routine" follows two cards up.
struct CoachShareCard: View {
    let doors: CoachDoors

    @Environment(\.gymSkin) private var skin
    @State private var state = Coach.State.closed()

    var body: some View {
        let card = Coach.card(state, base: doors.base)
        return VStack(alignment: .leading, spacing: WindmillSpace.x3) {
            Text(card.title)
                .font(WindmillFont.display(18))
                .foregroundStyle(skin.ink)

            Text(card.body)
                .font(GymType.numeral(12))
                .foregroundStyle(skin.inkFaint)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)

            if let link = card.link {
                // The address is shown in full and not behind the word "link": what leaves the phone
                // is what a coach can open, and a lifter is owed the sight of it before they send it.
                Text(link)
                    .font(GymType.numeral(11))
                    .foregroundStyle(skin.accent)
                    .lineLimit(2)
                    .truncationMode(.middle)
                    .textSelection(.enabled)
                    .padding(WindmillSpace.x3)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: WindmillRadius.md).fill(skin.raised))
            }

            if let note = card.note {
                Text(note)
                    .font(GymType.numeral(12))
                    .foregroundStyle(skin.alarmInk)
                    .lineSpacing(3)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Button { Task { await act() } } label: {
                Text(card.action)
                    .font(WindmillFont.body(16, .semibold))
                    .foregroundStyle(skin.accent)
                    .frame(maxWidth: .infinity, minHeight: GymTap.minimum)
                    .background(RoundedRectangle(cornerRadius: WindmillRadius.lg)
                        .strokeBorder(skin.lineStrong, lineWidth: 1))
            }
            .disabled(state == .working)

            if let revoke = card.revoke {
                Button { Task { await revokeLink() } } label: {
                    Text(revoke)
                        .font(WindmillFont.body(15, .semibold))
                        .foregroundStyle(skin.inkDim)
                        .frame(maxWidth: .infinity, minHeight: GymTap.minimum)
                }
            }
        }
        .padding(WindmillSpace.x4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: WindmillRadius.lg).fill(skin.surface))
        .overlay(RoundedRectangle(cornerRadius: WindmillRadius.lg).strokeBorder(skin.line, lineWidth: 1))
    }

    // The one action, whatever the card currently offers: mint, or copy the link that is already
    // live. Copying is the only thing here that never touches the log.
    private func act() async {
        if case .live(let share, _, _) = state {
            UIPasteboard.general.string = Coach.link(share, base: doors.base)
            state = state.after(.copied)
            return
        }
        state = state.after(.asked)
        switch await doors.mint() {
        case .success(let share):
            state = state.after(.minted(share))
        case .failure(let why):
            state = state.after(.mintFailed(why.line("the link wasn’t made")))
        }
    }

    // A revoke that did not happen leaves the link LIVE and says so. Drawing it as dead would tell a
    // lifter their coach can no longer read the session on the strength of a request that failed —
    // the one mistake this card is not allowed to make. The live state is kept across the round trip
    // rather than replaced by `.working`, because that is what the failure branch has to fall back to.
    private func revokeLink() async {
        guard case .live = state else { return }
        let live = state
        state = state.after(.asked)
        guard let why = await doors.revoke() else {
            state = state.after(.revoked)
            return
        }
        state = live.after(.revokeFailed(why.line("the link is still live")))
    }
}
