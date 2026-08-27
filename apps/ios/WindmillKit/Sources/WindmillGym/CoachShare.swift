import SwiftUI
import UIKit
import WindmillPlatform

// The expiry is printed from the server's reply, never counted off this device's clock.
// `POST /v1/gym/sessions/{id}/share` is idempotent on the session: sharing twice hands back the live link.
public struct SessionShare: Equatable, Codable, Sendable {
    public let token: String
    public let expiresAtMs: Int64
    // Optional on the wire; `Coach.link` composes the fallback.
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
    // The word coach names the room and nothing else; the link handed to a person is a workout.
    public static let shareTitle = "Share this workout"

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
        public let note: String?  // the log's own words, when a door did not open
    }

    public enum State: Equatable {
        case closed(note: String? = nil)
        case working
        case live(share: SessionShare, note: String? = nil)
        case revoked

        // A revoke that did not happen leaves the link live.
        public func after(_ event: Event) -> State {
            switch event {
            case .asked:
                return .working
            case .minted(let share):
                return .live(share: share)
            case .mintFailed(let why):
                return .closed(note: why)
            case .revoked:
                return .revoked
            case .revokeFailed(let why):
                guard case .live(let share, _) = self else { return self }
                return .live(share: share, note: why)
            }
        }
    }

    public enum Event: Equatable {
        case asked
        case minted(SessionShare)
        case mintFailed(String)
        case revoked
        case revokeFailed(String)
    }

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
            return Card(title: shareTitle, body: offer, link: nil,
                        action: note == nil ? "Get a link" : "Try again", revoke: nil, note: note)
        case .working:
            return Card(title: shareTitle, body: offer, link: nil,
                        action: "…", revoke: nil, note: nil)
        case .live(let share, let note):
            return Card(
                title: "The link is live",
                body: "Anyone who has this link can read this one workout. It stops working on "
                    + "\(Readout.day(share.expiresAtMs)), and revoking it kills it immediately.",
                link: link(share, base: base),
                // The system share sheet hands the link on and reports nothing back, so there is no
                // `copied` state to draw and nothing pretends there is.
                action: shareTitle,
                revoke: "Revoke the link",
                note: note)
        case .revoked:
            return Card(title: "The link is dead",
                        body: "Anyone still holding it gets nothing. You can make a new one whenever you like.",
                        link: nil, action: "Get a new link", revoke: nil, note: nil)
        }
    }
}

struct CoachDoors {
    let base: URL
    let mint: () async -> Result<SessionShare, TrainingStore.WriteFailure>
    let revoke: () async -> TrainingStore.WriteFailure?
}

// The system share sheet over a link the log has only just minted. `ShareLink` needs its value up
// front and a share token is a round trip, so this is the one place the room reaches for UIKit.
struct SharedLink: Identifiable, Equatable {
    let url: URL
    var id: String { url.absoluteString }
}

struct ShareSheet: UIViewControllerRepresentable {
    let link: SharedLink

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [link.url], applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

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

            if let address = card.link, let url = URL(string: address) {
                ShareLink(item: url) {
                    Label(card.action, systemImage: "square.and.arrow.up")
                        .font(WindmillFont.body(16, .semibold))
                        .foregroundStyle(skin.accent)
                        .frame(maxWidth: .infinity, minHeight: GymTap.minimum)
                        .background(RoundedRectangle(cornerRadius: WindmillRadius.lg)
                            .strokeBorder(skin.lineStrong, lineWidth: 1))
                }
            } else {
                Button { Task { await act() } } label: {
                    Text(card.action)
                        .font(WindmillFont.body(16, .semibold))
                        .foregroundStyle(skin.accent)
                        .frame(maxWidth: .infinity, minHeight: GymTap.minimum)
                        .background(RoundedRectangle(cornerRadius: WindmillRadius.lg)
                            .strokeBorder(skin.lineStrong, lineWidth: 1))
                }
                .disabled(state == .working)
            }

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

    private func act() async {
        state = state.after(.asked)
        switch await doors.mint() {
        case .success(let share):
            state = state.after(.minted(share))
        case .failure(let why):
            state = state.after(.mintFailed(why.line("the link wasn’t made")))
        }
    }

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
