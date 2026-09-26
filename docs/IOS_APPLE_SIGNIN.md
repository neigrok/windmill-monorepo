# Sign in with Apple configuration

The iOS Apple sign-in button is disabled by `WMAppleSignInEnabled: false` in
[project.yml](../apps/ios/project.yml). The backend route exists, but returns 404 unless all four
Apple configuration values are present. The current deploy workflow and Compose service do not
forward those values.

## Required configuration

| Backend environment variable | Value |
| --- | --- |
| `APPLE_CLIENT_ID` | Native bundle ID: `works.windmill.app` |
| `APPLE_TEAM_ID` | Apple Developer team ID |
| `APPLE_KEY_ID` | Sign in with Apple key ID |
| `APPLE_PRIVATE_KEY` | Complete private key PEM, preserving its newlines |

The backend reads these in [main.cpp](../backend/platform/infra/main.cpp). Its
[Apple adapter](../backend/platform/adapters/oidc/AppleOAuthClient.cpp) exchanges the native
application's authorization code and signs the client secret with the private key.

## Activation work

1. Configure the app identifier and Sign in with Apple key in the Apple Developer account that
   owns `works.windmill.app`.
2. Add the four inputs to the deployment secret bindings, environment renderer and backend
   Compose environment. The private-key transport must preserve the PEM's newlines; the current
   renderer writes single-line environment values and needs an explicit encoding strategy.
3. Configure the iOS team's signing and `com.apple.developer.applesignin` entitlement, then set
   `WMAppleSignInEnabled: true`.
4. Verify sign-in from a signed app, including a first authorization, an existing account and a
   relay-email account. A unit test or unsigned simulator launch does not verify Apple's flow.

Setting GitHub secrets alone does not enable the feature. The deployment changes above are still
required; [deploy.yml](../.github/workflows/deploy.yml) replaces the server environment on deploy.

## Account behavior

The API accepts the authorization code and optional name. It binds the provider subject through
`user_identities`, so email is not the identity key. A name can seed a new account; it does not
rename an existing one. Relay-email accounts use the account-link flow described in
[backend authentication](../backend/AUTH.md).
