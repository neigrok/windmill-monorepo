# Account linking — one account, many doors

How Sign in with Apple on the iPhone reaches the account a person already has, and how a signed-in
person adds Apple to it. Companion to `superapp-flow.md` §6 (the Keep sheet, the one sign-in door)
and `superapp-shell.md` §6 (You). The server contract is `backend/AUTH.md`, "Identities — one
account, many doors". The drawings of record are section
[4b · Apple sign-in · one account](https://www.figma.com/design/qoOwNbWOYE1GFi0yR5uGY2/?node-id=194-3698)
of the Figma page [iOS · First run](https://www.figma.com/design/qoOwNbWOYE1GFi0yR5uGY2/?node-id=112-2),
with its rows in the state matrix and three paths in the flow map.

---

## 1. The rules

1. **Continue with Apple never makes a second account by surprise.** When Apple finds no Windmill
   account, nothing is created until the person answers one question.
2. **Accounts that both hold data never merge.** A door moves to another account only when the
   account it leaves holds nothing.
3. **Nothing is said about an address until the person proves it with a code.** No screen reveals
   whether an address has a Windmill account to someone who has not read that address's mail.
4. **The email door always exists.** Every account is an email address, so Apple is added beside
   email and can be removed without locking anyone out.

The fixture every board draws from: Sam made an account on the web with `sam@example.com`, and it
holds 142 pages. Sam's Apple ID uses Hide My Email. Signed out on the iPhone, Sam wrote one page
today. In 23e · B Sam types `sam@icloud.com`, which opens no account.

## 2. Continue with Apple, signed out

The Keep sheet, You (16a) and Where to start's Sign in (02b) share one door, so all of this holds
from each of them.

| Apple finds | What happens | Board |
|---|---|---|
| The Apple ID's own door | Straight in | — |
| An account whose address is the verified email Apple shares | Straight in; Apple is added to that account on the way | — |
| Nothing | **Already on Windmill?**, before anything is created | 23a |

**A sign-in that finds the account says nothing extra.** The person's own pages arrive (Bringing it
back, or the room), and You lists Apple under How you sign in. Signing in then continues exactly as
`superapp-flow.md` §6 says, the sign-in question included.

### Already on Windmill? (23a)

> **Already on Windmill?**
> This Apple ID doesn't open a Windmill account yet. If you have one, confirm its email and Apple
> will open it too.
> **Use my account** · **Create account**

- **It must come before anything exists.** Until an answer, the server holds no account for this
  Apple ID and the phone holds no session, so no answer can leave an empty account behind.
- The Keep sheet's own `.medium` detent. Apple's system sheet closes, then the sheet's content
  cross-fades to the question (280 ms, ease-out).
- **Two `.bordered` buttons of equal weight** in brand ink: neither filled, neither destructive.
  `.selection` haptic on either.
- **Changing one's mind is free.** xmark returns to the doors, and a swipe down closes the sheet.
  Nothing has been created, and the page on the phone is untouched. The next Continue with Apple
  asks again.
- **A paused session skips the question.** When the phone already knows its account (backup
  paused), Apple can only resume that account, so the sheet opens at 23b with its address filled.

**Create account** creates the account this Apple ID opens and signs in. The new account holds
nothing, so the page written signed out joins it silently (`superapp-flow.md` §6), and the sheet
dismisses into the room.

### Use my account (23b → 15 → 23c)

> **Your Windmill email**
> We'll send a code to confirm it's yours.
> [ sam@example.com ] **Send code**

- Pushed inside the same sheet, `.large` detent. The field is `.emailAddress` with
  `.textContentType(.username)`, so QuickType offers the person's own addresses.
- **It asks for the account's address, never a "personal email"**, so a Hide My Email choice is
  never overridden.
- **Send code always says sent.** The code goes out whether or not an account uses the address.
- The code step is board 15, unchanged: *Check your email* · *Sent to sam@example.com* · **Change**,
  the `.oneTimeCode` field, *It works once and lasts 15 minutes.*, and the resend countdown.
- **The sixth digit sends.** The field holds, with an activity indicator only past 800 ms.

On a valid code the account at that address gains the Apple door and the phone signs in to it. The
sheet shows one receipt (23c):

> **Apple added**
> Apple now opens sam@example.com.

- The keyboard lowers, the envelope becomes `checkmark.circle` with Draw On, the title
  cross-fades, `.success` haptic. Held 1.2 s, with no button. Reduce Motion: a 200 ms fade.
- The address is the account's, never Apple's relay.
- Then the sign-in continues by `superapp-flow.md` §6: Sam's account already has pages, so the
  sign-in question follows (23d, canon copy, singular: *1 page from before you signed in is only on
  this phone, and your account already has pages. Add it, or discard it for good.*). An account with
  no pages takes the page silently, and the sheet dismisses into the room.

## 3. Order of operations

This must be true on every Apple sign-in, because anything the server's account footprint counts —
a page, or the `sync_replicas` row an engine request writes — makes an account no longer empty:

1. Apple authorizes; the server resolves the subject, then the verified email.
2. Nothing found: the server answers with a short-lived Apple ticket and creates nothing.
3. The phone asks 23a.
4. Only once an account is chosen — **Create account**, or a valid code under **Use my account** —
   does the phone receive a session, start the engine sign-in, and ask any sign-in question it owes.

## 4. Edge states (23e)

| State | Where | Copy | Then |
|---|---|---|---|
| A · The code didn't work | Code step (15) | *That code didn't work. Check the digits, or send a fresh one.* | **Resend code** after 30 s |
| B · No account at this email | After a valid code only | **No account at this email** · *sam@icloud.com doesn't open a Windmill account. Try the address you signed up with, or create one with Apple.* | **Try another email** · **Create account** |
| C · Offline | Any step | *Can't reach windmill.works. Nothing was created, and your pages stay on this phone.* | The step's own buttons retry it |
| D · The Apple sign-in ran out | After 15 minutes | **Continue with Apple again** · *Apple's sign-in lasts 15 minutes, and this one ran out. Nothing was created.* | The doors |

- **A** is one answer for a wrong, expired, used or exhausted code, so the endpoint still cannot be
  probed — but it never calls a typo *expired*.
- **B** appears only after the person proved the address, so it tells no one else anything. Nothing
  is created at that address.
- Errors are brand ink, never red (`roadmap/guidelines/auth.md` §3).

## 5. Signed in — How you sign in (24a–24d)

You, signed in, lists the account's doors in a group after the profile and before **Your data**.
Signed out the group does not exist: You shows the doors to sign in instead (16a).

| Row | Value |
|---|---|
| **Email** | The account's address. An account Apple made with Hide My Email shows Apple's relay address here, because that is where its codes go and where the person can find it. |
| **Apple** | What Apple shared: an address, or *Hide My Email*. Present only when the account has the Apple door. |

Footer, one line: *Apple will open this same account.* while Apple is not added; *Either one opens
this account.* once it is.

**Adding Apple (24a).** `SignInWithAppleButton(.continue)` — white on dark, black on light — full
width under the group. Signed in, an Apple authorization adds the door to this account; it never
signs in elsewhere.

| The Apple ID | Outcome |
|---|---|
| Opens no account | Apple is added: the row appears, `.success` (24b) |
| Already opens this account | The row is already there; nothing changes |
| Opens another account that holds nothing | Its door moves here and the empty account closes. Nothing is lost, so nothing is asked (24b). |
| Opens another account that holds data | **Apple ID already in use** (24d) |
| The person cancels Apple's sheet | Nothing |

> **Apple ID already in use**
> It opens another Windmill account with its own data. Windmill doesn't merge accounts. Remove
> Apple there first.
> **OK**

**Removing Apple (24c).** Tapping the Apple row, or swiping it left, opens a confirmation dialog.
The rows are facts and Remove is the only verb, so the group draws no button for it.

> **Remove Apple?**
> You'll sign in with sam@example.com instead. Apple won't open this account.
> **Remove Apple** (destructive) · **Cancel**

When the account's email is an Apple relay address, the message names that address; Apple keeps
forwarding mail sent there.

## 6. Other surfaces

Apple signs in only in the iOS app, so only the iOS You adds or removes it. Every surface that
shows an account lists its doors, read-only, in the same order and words: web settings Profile,
*How you sign in* (`roadmap/guidelines/auth.md` §5), and Android's You.

## 7. Copy — every string

| Where | String |
|---|---|
| 23a | "Already on Windmill?" · "This Apple ID doesn't open a Windmill account yet. If you have one, confirm its email and Apple will open it too." · "Use my account" · "Create account" |
| 23b | "Your Windmill email" · "We'll send a code to confirm it's yours." · "Send code" |
| 23c | "Apple added" · "Apple now opens {account email}." |
| 23e · A | "That code didn't work. Check the digits, or send a fresh one." · "Resend code" |
| 23e · B | "No account at this email" · "{email} doesn't open a Windmill account. Try the address you signed up with, or create one with Apple." · "Try another email" · "Create account" |
| 23e · C | "Can't reach windmill.works. Nothing was created, and your pages stay on this phone." |
| 23e · D | "Continue with Apple again" · "Apple's sign-in lasts 15 minutes, and this one ran out. Nothing was created." |
| 24a–24b | "How you sign in" · "Email" · "Apple" · "Hide My Email" · "Apple will open this same account." · "Either one opens this account." |
| 24c | "Remove Apple?" · "You'll sign in with {account email} instead. Apple won't open this account." · "Remove Apple" · "Cancel" |
| 24d | "Apple ID already in use" · "It opens another Windmill account with its own data. Windmill doesn't merge accounts. Remove Apple there first." · "OK" |

## 8. What this requires of the build

**Required**

1. **Apple resolves before it creates.** When neither the subject nor the verified email finds an
   account, the Apple door creates nothing, binds nothing and mints no session. It answers with an
   Apple ticket instead: single use, 15 minutes, stored as a digest, carrying the subject, the
   verified email, the relay flag and the once-only name. Both Apple doors (`/v1/auth/apple`,
   `/v1/auth/apple/native`) share this through `respondApple`.
2. **Create from a ticket.** One call turns a live ticket into the account the Apple ID opens and
   signs in. A spent or expired ticket answers one refusal that carries 23e · D's copy.
3. **The code door carries the ticket.** `/v1/auth/verify-code` accepts the ticket. The ticket is
   checked first, so an expired one never spends the code. Then the code, with its one collapsed
   refusal. Then: an account at the address signs in and gains the Apple door; a subject bound
   elsewhere in the meantime answers `409 identity-taken`; no account answers a `no-account`
   refusal, creating nothing and keeping the ticket. `/v1/auth/magic-link` stays as it is.
4. **The phone asks before it signs in.** The iOS client decodes the ticket answer, shows 23a, and
   starts the engine sign-in and the adoption question only once an account is chosen (§3). The
   ticket lives in memory only.
5. **Signed in, Apple attaches.** The iOS client sends its session as `Authorization: Bearer` on the
   Apple door when signed in, and decodes `attached` and `409 identity-taken`.
6. **Attach takes over an empty account's door.** When the Apple ID already opens another account
   and `AccountFootprint::anyData` is false for it, the door moves to the caller, the empty
   account's sessions are revoked and it is deleted — the link door's own rule. With data, the
   `409` stands.
7. **The doors are readable.** `GET /v1/me` lists the account's doors: the email address, and each
   bound provider with what it shared (`email_at_link`) and whether that is a relay address.
8. **The Apple door is removable.** A signed-in call unbinds the caller's Apple door. It never
   touches the account, and the email door remains.
9. **A typo is not "expired".** `/v1/auth/verify-code`'s one refusal reads *That code didn't work* ·
   *Check the digits, or send a fresh one.* (23e · A). The collapse stays.
10. **The fork-guard footnote leaves with the question's arrival.** The Keep sheet's footnote is
    removed in the same change that ships 23a, never before: until then it is the only guard.

**Optional**

1. Telemetry: screen names for 23a, 23b and 23c, and a `linked` outcome on `auth_signed_in`, added
   to the iOS event allowlist (`docs/IOS_OBSERVABILITY.md`).
2. Web settings and Android's You list the doors read-only (§6), once requirement 7 exists.
3. The web's **Continue with Google** asks the same question when it would create an account.
4. Apple's server-to-server `consent-revoked` notification unbinds the Apple door
   (`consistency.md` 8d).

## 9. Held open

- **The question costs a new person one tap.** The HIG asks an app to welcome a new Apple account
  at once; 23a is asked only when the server would otherwise create one, which is also the only
  moment a web account can still be kept whole.
- **Whether matched sign-ins deserve a line.** No acknowledgement is drawn for the two
  straight-in rows of §2; the receipt exists only after linking (23c).
