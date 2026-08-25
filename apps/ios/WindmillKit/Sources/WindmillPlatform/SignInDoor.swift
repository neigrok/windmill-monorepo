import AuthenticationServices
import SwiftUI

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

    public init(auth: AuthStore, refusal: String? = nil) {
        self.auth = auth
        _refusal = State(initialValue: refusal)
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
            .onChange(of: auth.arrival) { _, arrival in
                switch arrival {
                case .signedIn: dismiss()
                case .refused(let line): refusal = line
                case nil: break
                }
            }
        }
    }

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
                Text(working ? "Sending…" : "Email me a code")
                    .font(WindmillFont.body(16, .semibold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, WindmillSpace.x3)
                    .actionCapsule(Self.appleSignInEnabled ? .quiet : .primary)
            }
            .disabled(working || email.isEmpty)

            Text("No password. What you make on this device is claimed by your account when you sign in.")
                .font(WindmillFont.body(13))
                .foregroundStyle(WindmillColor.textTertiary)
        }
    }

    private func waiting(on address: String) -> some View {
        VStack(alignment: .leading, spacing: WindmillSpace.x5) {
            Text("Check your email")
                .font(WindmillFont.display(22))
                .foregroundStyle(WindmillColor.textPrimary)

            Text("We sent a code to \(address). It works once and lasts 15 minutes.")
                .font(WindmillFont.body(15))
                .foregroundStyle(WindmillColor.textSecondary)

            // Numeric keyboard, but paste still accepts a whole magic link or bare token.
            DoorField(placeholder: "6-digit code", text: $pasted)
                .keyboardType(.numberPad)

            Button {
                Task { await signIn(to: address) }
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
                // Appears at 30 seconds.
                if canResend {
                    Button("Resend") { Task { await requestLink() } }
                }
            }
            .font(WindmillFont.body(14))
            .foregroundStyle(WindmillColor.textSecondary)
        }
    }

    // Offered only for a brand-new account reached through a Hide My Email relay.
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
            // The trimmed address the mail actually went to, not the raw field.
            sentTo = auth.linkSentTo
            canResend = false
            Task {
                try? await Task.sleep(for: .seconds(30))
                canResend = true
            }
        } catch {
            refusal = (error as? WindmillApiError)?.line ?? "That didn’t go through"
        }
    }

    // Try the code first: MagicLink.token(in:) would accept a code as a token and use the wrong endpoint.
    private func signIn(to address: String) async {
        working = true
        refusal = nil
        defer { working = false }
        do {
            if let code = SignInCode.parse(pasted) {
                try await auth.completeCode(email: address, code: code)
            } else {
                try await auth.completeLink(pasted)
            }
            dismiss()
        } catch {
            refusal = SignInCode.parse(pasted) != nil
                ? SignInCode.refusal(for: error)
                : MagicLink.refusal(for: error)
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

    static var appleSignInEnabled: Bool {
        Bundle.main.object(forInfoDictionaryKey: "WMAppleSignInEnabled") as? Bool ?? false
    }
}

// The placeholder is drawn rather than handed to `prompt:`, whose accent a sheet does not reliably inherit.
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
