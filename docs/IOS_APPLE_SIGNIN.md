# Sign in with Apple — what only you can get

Apple sign-in is the primary door in the iOS app, and it is **off** until the four values below
exist. Off means the button is absent, never present-and-broken. Everything on our side is already
written and tested: `POST /v1/auth/apple` redeems the code server-side, `user_identities` binds the
subject so a rotated relay address can't fork an account, and the link door is there for the Hide My
Email case (`backend/AUTH.md`). What is missing is account data that only the account holder can
produce.

This is a checklist for **you**, in order. It costs **$99/year** (the Apple Developer Program) and
about half an hour. Nothing here is reversible-by-accident; the only destructive step is flagged.

---

## 1. Apple Developer Program — $99/year

<https://developer.apple.com/programs/enroll/>

Enrol as whoever should own the app long-term. **This choice is hard to undo**: moving an app between
an individual account and an organisation later is a support ticket, not a setting. If Windmill is
meant to be a company, enrol as the organisation (needs a D-U-N-S number, which is free and can take
a few days to issue — start there if so).

Wait for approval before step 2.

## 2. Register the App ID with our exact bundle id

App Store Connect → Certificates, Identifiers & Profiles → **Identifiers** → `+` → App IDs → App.

- **Bundle ID (explicit):** `works.windmill.app`
  This must match `PRODUCT_BUNDLE_IDENTIFIER` in `apps/ios/project.yml` **exactly** — it is also the
  `APPLE_CLIENT_ID` the backend sends to Apple, so a typo here fails at token exchange, not at
  build, which is a much later and much more confusing place to find it.
- **Capabilities:** tick **Sign in with Apple**.
- Description can be anything ("Windmill").

> For the native flow we do **not** need a Services ID. Those are for the web/redirect flow; the app
> posts an authorization code instead. If you later add Apple sign-in to windmill.works in a browser,
> that is when a Services ID and a Return URL get created.

## 3. Create the Sign in with Apple key (.p8)

Identifiers & Profiles → **Keys** → `+`.

- Name: `Windmill Sign in with Apple`
- Tick **Sign in with Apple**, then **Configure** → pick the App ID from step 2 as the primary.
- Register → **Download**. You get `AuthKey_XXXXXXXXXX.p8`.

**Apple lets you download this file exactly once.** There is no second chance and no way to re-read
it — if it is lost the key must be revoked and a new one made. Put it somewhere durable (a password
manager) before you close the tab.

## 4. Collect the four values

| Value | Where it comes from | Looks like |
|---|---|---|
| `APPLE_CLIENT_ID` | the bundle id from step 2 | `works.windmill.app` |
| `APPLE_TEAM_ID` | top-right of the developer portal, or Membership details | `A1B2C3D4E5` (10 chars) |
| `APPLE_KEY_ID` | shown on the key from step 3, and in its filename | `ABC123DEFG` (10 chars) |
| `APPLE_PRIVATE_KEY` | the **contents** of the `.p8` file | `-----BEGIN PRIVATE KEY-----\nMIGT…` |

## 5. Put them where the deploy reads them

Secrets go in as GitHub secrets; the deploy workflow renders them into the server's `.env`
(`.github/workflows/deploy.yml`). Run these yourself — I wire the plumbing but never hold the values:

```sh
gh secret set APPLE_CLIENT_ID   --body "works.windmill.app"
gh secret set APPLE_TEAM_ID     --body "YOUR_TEAM_ID"
gh secret set APPLE_KEY_ID      --body "YOUR_KEY_ID"
gh secret set APPLE_PRIVATE_KEY < AuthKey_YOUR_KEY_ID.p8      # the whole file, newlines and all
```

The private key is multi-line. Piping the file in (rather than `--body`) is what keeps the newlines
intact — a flattened key fails to sign, and the failure surfaces as a generic "apple sign-in could
not be completed", which is a bad thing to debug.

Then deploy: `gh workflow run deploy.yml`.

## 6. Tell me, and I turn it on

Two one-line changes on my side once the above is done:

- `apps/ios/project.yml` → `WMAppleSignInEnabled: true`
- add the `com.apple.developer.applesignin` entitlement and the team id to the target

Then it needs a **real device or a signed simulator build** to test end to end — `ASAuthorizationController`
cannot complete against an unsigned simulator app, so this is the one flow I could not verify for you
locally.

---

## What to expect the first time

- **Apple sends the name exactly once**, on the very first authorization for an Apple ID, and never
  again. The app forwards it on that one request; the backend seeds a new account with it and never
  renames an existing one.
- **Hide My Email is normal, not an error.** A relay address is verified and stable for us, so it
  makes a working account — it just cannot find the account that person may already have on the web.
  That is why the app offers "Already use Windmill on the web? Link this account." exactly once,
  right after such a signup.
- **Testing the "first authorization" again:** once you have signed in, your Apple ID remembers the
  app and stops sending the name. To rehearse a true first run, revoke it in
  Settings → your name → Sign-In & Security → Sign in with Apple → Windmill → Stop using.
