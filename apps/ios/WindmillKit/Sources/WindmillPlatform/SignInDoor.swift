import AuthenticationServices
import SwiftUI

// One door (auth canon §1): no sign-in/sign-up fork, no tabs, no passwords — the email decides, and
// the account is created the first time. Every string below is the canon's, verbatim, because the
// same sentence is already on the web and one sentence lives in one place.
//
// What is native rather than canon is the last step. The emailed link opens the WEB app, so until
// this app has an associated domain to claim `windmill.works` links with, the honest way to finish
// on a phone is to let someone paste the link they are looking at. That is stated plainly rather
// than dressed up, and the same field will keep working once universal links land.

public struct SignInDoor: View {
    @ObservedObject var auth: AuthStore
    @Environment(\.dismiss) private var dismiss

    @State private var email = ""
    @State private var pasted = ""
    @State private var sentTo: String?
    @State private var linkDoorOpen = false
    @State private var working = false
    @State private var canResend = false
    @State private var refusal: String?

    public init(auth: AuthStore) {
        self.auth = auth
    }

    public var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: WindmillSpace.x5) {
                    if linkDoorOpen {
                        linkDoor
                    } else if let sentTo {
                        waiting(on: sentTo)
                    } else {
                        asking
                    }

                    if let refusal {
                        // Every failure ends in a next step, and none of them is a wall — the
                        // remedy is always the field or the button still sitting above this line.
                        Text(refusal)
                            .font(WindmillFont.body(14))
                            .foregroundStyle(WindmillColor.neutral700)
                            .padding(WindmillSpace.x3)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(RoundedRectangle(cornerRadius: WindmillRadius.sm)
                                .fill(WindmillColor.gold400.opacity(0.14)))
                    }
                }
                .padding(WindmillSpace.x6)
            }
            .background(WindmillColor.surfaceCanvas)
            .navigationTitle(linkDoorOpen ? "Link this account" : "Sign in")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
        }
    }

    // Apple leads on this surface — one tap, no address to type, no mail to go and find. The
    // emailed link stays beside it rather than behind it, and not out of politeness: it is the only
    // way a Hide My Email account can ever reach the account that person already has on the web
    // (AUTH.md's link door), and the only door that keeps one account across phone and browser.
    //
    // Until Apple is configured the link is the ONLY door, so it takes the primary treatment back.
    // A door with no primary button is a door nobody knows how to open.
    private var asking: some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x5) {
            if Self.appleSignInEnabled {
                SignInWithAppleButton(.continue, onRequest: { request in
                    request.requestedScopes = [.fullName, .email]
                }, onCompletion: { result in
                    Task { await completeApple(result) }
                })
                .signInWithAppleButtonStyle(.black)
                .frame(height: 50)
                .disabled(working)
            }

            Text("New here? Same door — your account is created the first time.")
                .font(WindmillFont.body(15))
                .foregroundStyle(WindmillColor.textSecondary)

            DoorField(placeholder: "you@example.com", text: $email)
                .textContentType(.emailAddress)
                .keyboardType(.emailAddress)

            Button {
                Task { await requestLink() }
            } label: {
                Text(working ? "Sending…" : "Email me a link")
                    .font(WindmillFont.body(16, .semibold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, WindmillSpace.x3)
                    // Gold when the link is the only way in; a quiet outline once Apple carries the
                    // primary weight — and the label's ink follows the fill, because they are one
                    // modifier and cannot be answered differently.
                    .actionCapsule(Self.appleSignInEnabled ? .quiet : .primary)
            }
            .disabled(working || email.isEmpty)

            Text("No password. Signed out, Windmill still works — what you write lives on this device.")
                .font(WindmillFont.body(13))
                .foregroundStyle(WindmillColor.textTertiary)
        }
    }

    private func waiting(on address: String) -> some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x5) {
            Text("Check your email")
                .font(WindmillFont.display(22))
                .foregroundStyle(WindmillColor.textPrimary)

            Text("We sent a link to \(address). It works once and lasts 15 minutes.")
                .font(WindmillFont.body(15))
                .foregroundStyle(WindmillColor.textSecondary)

            Divider()

            Text("Open the link on this phone, or paste it here.")
                .font(WindmillFont.body(15))
                .foregroundStyle(WindmillColor.textSecondary)

            DoorField(placeholder: "Paste the link", text: $pasted)

            Button {
                Task { await completeLink() }
            } label: {
                Text("Sign in")
                    .font(WindmillFont.body(16, .semibold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, WindmillSpace.x3)
                    .actionCapsule(.primary)
            }
            .disabled(working || pasted.isEmpty)

            HStack(spacing: WindmillSpace.x5) {
                Button("Use a different email") {
                    sentTo = nil
                    refusal = nil
                    pasted = ""
                }
                // Absent while it would only invite a double send; it appears at 30 seconds.
                if canResend {
                    Button("Resend") { Task { await requestLink() } }
                }
            }
            .font(WindmillFont.body(14))
            .foregroundStyle(WindmillColor.textSecondary)
        }
    }

    // Offered on exactly one condition (AUTH.md): a brand-new account, reached through a Hide My
    // Email relay. Those two facts together mean this person may already have a Windmill account
    // that this sign-in could never have found — and no honest guess exists, so we ask once.
    private var linkDoor: some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x5) {
            Text("Already use Windmill on the web?")
                .font(WindmillFont.display(22))
                .foregroundStyle(WindmillColor.textPrimary)

            Text("You signed in with a private Apple address, so this is a new account. If you already have one, email yourself a link from the web and paste it here — this account folds into that one.")
                .font(WindmillFont.body(15))
                .foregroundStyle(WindmillColor.textSecondary)

            DoorField(placeholder: "Paste the link", text: $pasted)

            Button {
                Task { await linkAccount() }
            } label: {
                Text("Link this account")
                    .font(WindmillFont.body(16, .semibold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, WindmillSpace.x3)
                    .actionCapsule(.primary)
            }
            .disabled(working || pasted.isEmpty)

            Button("Not now") { dismiss() }
                .font(WindmillFont.body(14))
                .foregroundStyle(WindmillColor.textSecondary)
        }
    }

    private func requestLink() async {
        working = true
        refusal = nil
        defer { working = false }
        do {
            try await auth.requestLink(to: email)
            sentTo = email
            canResend = false
            Task {
                try? await Task.sleep(for: .seconds(30))
                canResend = true
            }
        } catch {
            refusal = (error as? WindmillApiError)?.line ?? "That didn't go through"
        }
    }

    private func completeLink() async {
        working = true
        refusal = nil
        defer { working = false }
        do {
            try await auth.completeLink(pasted)
            dismiss()
        } catch {
            refusal = "That link has expired. Links work once and last 15 minutes — send a fresh one."
        }
    }

    private func completeApple(_ result: Result<ASAuthorization, Error>) async {
        guard case .success(let authorization) = result,
              let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
              let codeData = credential.authorizationCode,
              let code = String(data: codeData, encoding: .utf8) else {
            refusal = "Apple sign-in could not be completed"
            return
        }
        working = true
        defer { working = false }
        do {
            let outcome = try await auth.signInWithApple(authorizationCode: code, name: credential.fullName?.formatted())
            // The one place the door does not close on success: a relay-address account that may
            // have a twin on the web gets the link offer before anything else happens.
            if outcome.shouldOfferLinkDoor { linkDoorOpen = true } else { dismiss() }
        } catch {
            refusal = (error as? WindmillApiError)?.line ?? "Apple sign-in could not be completed"
        }
    }

    private func linkAccount() async {
        working = true
        refusal = nil
        defer { working = false }
        do {
            try await auth.linkToAccount(pasted)
            dismiss()
        } catch {
            refusal = (error as? WindmillApiError)?.line ?? "That link has expired"
        }
    }

    // Sign in with Apple needs a paid team, an entitlement and the four server-side env vars. Until
    // the deploy has them the button is ABSENT rather than present-and-broken — the same "absent,
    // not locked" rule the product uses everywhere else.
    static var appleSignInEnabled: Bool {
        Bundle.main.object(forInfoDictionaryKey: "WMAppleSignInEnabled") as? Bool ?? false
    }
}

// The one field this door uses, in all three places it needs one (the address, and the pasted link
// on two different screens).
//
// The placeholder is DRAWN rather than handed to `prompt:` because SwiftUI colours a prompt with the
// accent, and a sheet does not reliably inherit its presenter's tint — which is how a door built
// entirely out of brand neutrals still came up with an iOS-blue placeholder sitting in the middle
// of it. Drawing it is the only way to be sure what colour it is.
struct DoorField: View {
    let placeholder: String
    @Binding var text: String

    var body: some View {
        ZStack(alignment: .leading) {
            if text.isEmpty {
                Text(placeholder)
                    .font(WindmillFont.body(16))
                    .foregroundStyle(WindmillColor.textTertiary)
            }
            TextField("", text: $text)
                .font(WindmillFont.body(16))
                .foregroundStyle(WindmillColor.textPrimary)
                .tint(WindmillColor.neutral900)
        }
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .padding(WindmillSpace.x3)
        .background(RoundedRectangle(cornerRadius: WindmillRadius.sm).fill(WindmillColor.surfaceCard))
        .overlay(RoundedRectangle(cornerRadius: WindmillRadius.sm)
            .strokeBorder(WindmillColor.borderDefault, lineWidth: 1))
    }
}
