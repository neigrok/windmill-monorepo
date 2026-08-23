# Sign in with Apple — the owner's checklist

Apple sign-in is the primary door in the iOS app and is **off** until the four values below exist.
Off means the button is absent, never present-and-broken: `configured()` is false and
`/v1/auth/apple` answers 404.

Everything on the repo side is written: `POST /v1/auth/apple` redeems the code server-side,
`user_identities` binds the Apple subject so a rotated relay address cannot fork an account, and
the account-link door covers Hide My Email (`backend/AUTH.md`). What is missing is account data
only the account holder can produce. Cost: $99/year and about half an hour.

## 1. Apple Developer Program

<https://developer.apple.com/programs/enroll/>

Enrol as whoever should own the app long-term. Moving an app between an individual account and an
organisation later is a support ticket, not a setting. An organisation needs a D-U-N-S number,
which is free and can take a few days to issue.

Wait for approval before step 2.

## 2. Register the App ID

App Store Connect → Certificates, Identifiers & Profiles → **Identifiers** → `+` → App IDs → App.

- **Bundle ID (explicit):** `works.windmill.app` — must match `PRODUCT_BUNDLE_IDENTIFIER` in
  `apps/ios/project.yml` exactly. It is also the `APPLE_CLIENT_ID` the backend sends to Apple, so a
  typo fails at token exchange rather than at build.
- **Capabilities:** tick **Sign in with Apple**.

The native flow needs no Services ID — those are for the web/redirect flow, and the app posts an
authorization code instead.

## 3. Create the Sign in with Apple key (.p8)

Identifiers & Profiles → **Keys** → `+`.

- Name: `Windmill Sign in with Apple`
- Tick **Sign in with Apple**, then **Configure** → pick the App ID from step 2 as the primary.
- Register → **Download**. You get `AuthKey_XXXXXXXXXX.p8`.

**Apple lets you download this file exactly once.** If it is lost the key must be revoked and
replaced. Put it in a password manager before closing the tab.

## 4. The four values

| Value | Where it comes from | Looks like |
|---|---|---|
| `APPLE_CLIENT_ID` | the bundle id from step 2 | `works.windmill.app` |
| `APPLE_TEAM_ID` | top-right of the developer portal, or Membership details | `A1B2C3D4E5` (10 chars) |
| `APPLE_KEY_ID` | shown on the key from step 3, and in its filename | `ABC123DEFG` (10 chars) |
| `APPLE_PRIVATE_KEY` | the **contents** of the `.p8` file | `-----BEGIN PRIVATE KEY-----\nMIGT…` |

## 5. Set them as GitHub secrets

The deploy workflow renders them into the server's `.env` (`.github/workflows/deploy.yml`).

```sh
gh secret set APPLE_CLIENT_ID   --body "works.windmill.app"
gh secret set APPLE_TEAM_ID     --body "YOUR_TEAM_ID"
gh secret set APPLE_KEY_ID      --body "YOUR_KEY_ID"
gh secret set APPLE_PRIVATE_KEY < AuthKey_YOUR_KEY_ID.p8      # the whole file, newlines and all
```

Pipe the private key file in rather than using `--body`: a flattened key fails to sign, and the
failure surfaces as a generic "apple sign-in could not be completed".

Then deploy: `gh workflow run deploy.yml`.

## 6. Turn it on

- `apps/ios/project.yml` → `WMAppleSignInEnabled: true`
- add the `com.apple.developer.applesignin` entitlement and the team id to the target

End-to-end testing needs a **real device or a signed simulator build** —
`ASAuthorizationController` cannot complete against an unsigned simulator app.

## What to expect the first time

- **Apple sends the name exactly once**, on the very first authorization for an Apple ID, and never
  again. The app forwards it on that one request; the backend seeds a new account with it and never
  renames an existing one.
- **Hide My Email is normal.** A relay address is verified and stable, so it makes a working
  account — it just cannot find the account that person may already have on the web. That is why
  the app offers "Already use Windmill on the web? Link this account." exactly once, right after
  such a signup.
- **To rehearse a true first run** after signing in once, revoke the app in Settings → your name →
  Sign-In & Security → Sign in with Apple → Windmill → Stop using.
