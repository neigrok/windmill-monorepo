package works.windmill.platform.auth

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import works.windmill.platform.design.ActionCapsule
import works.windmill.platform.design.ActionWeight
import works.windmill.platform.design.WindmillColor
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillRadius
import works.windmill.platform.design.WindmillSpace
import works.windmill.platform.net.WindmillApiException

// One door (auth canon §1): no sign-in/sign-up fork, no tabs, no passwords — the email decides, and
// the account is created the first time. Every string below is the canon's, verbatim, because the
// same sentence is already on the web and one sentence lives in one place.
//
// What is native rather than canon is the last step. On iOS a universal link can one day finish
// the sign-in in-app; this app claims no links yet (android-plan.md: paste flow only), and a link
// works exactly once — tapping it opens the web app and BURNS it. So the honest instruction is to
// copy rather than tap, and when app links arrive the sentence changes with them.

@Composable
fun SignInDoor(auth: AuthStore, onDone: () -> Unit = {}) {
    var email by remember { mutableStateOf("") }
    var pasted by remember { mutableStateOf("") }
    var sentTo by remember { mutableStateOf<String?>(null) }
    var working by remember { mutableStateOf(false) }
    var canResend by remember { mutableStateOf(false) }
    var refusal by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    fun requestLink() {
        scope.launch {
            working = true
            refusal = null
            try {
                auth.requestLink(email)
                sentTo = auth.linkSentTo
                canResend = false
                scope.launch {
                    delay(30_000)
                    canResend = true
                }
            } catch (refused: WindmillApiException) {
                refusal = refused.line
            } finally {
                working = false
            }
        }
    }

    Column(
        Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .imePadding()
            .padding(WindmillSpace.x6),
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x5),
    ) {
        val address = sentTo
        if (address == null) {
            Text("Sign in", style = WindmillFont.display(22), color = WindmillColor.textPrimary.color)

            Text(
                "New here? Same door — your account is created the first time.",
                style = WindmillFont.body(15),
                color = WindmillColor.textSecondary.color,
            )

            DoorField("you@example.com", email, keyboardType = KeyboardType.Email) { email = it }

            ActionCapsule(
                if (working) "Sending…" else "Email me a link",
                ActionWeight.Primary,
                enabled = !working && email.isNotEmpty(),
            ) { requestLink() }

            refusal?.let { RefusalLine(it) }

            // This read "Signed out, Windmill still works — what you write lives on this device",
            // the same sentence the web door carried. One door stands in front of every room, and
            // that claim was only true of the ones that write to disk before they sync: the
            // training log does not open at all without an account. The shell may not name which
            // room is which, so the door says the half that holds in all of them.
            Text(
                "No password. Whatever you have already made on this device is claimed when you sign in — and some rooms only open once you have an account.",
                style = WindmillFont.body(13),
                color = WindmillColor.textTertiary.color,
            )
        } else {
            Text("Check your email", style = WindmillFont.display(22), color = WindmillColor.textPrimary.color)

            Text(
                "We sent a link to $address. It works once and lasts 15 minutes.",
                style = WindmillFont.body(15),
                color = WindmillColor.textSecondary.color,
            )

            HorizontalDivider(color = WindmillColor.borderSubtle.color)

            // THE ONE SENTENCE THAT CHANGES when this app claims windmill.works links, and it
            // changes because the right ADVICE changes: while the link opens the web app, tapping
            // it signs you in over there and leaves this phone with a spent link.
            Text(
                "Copy the link rather than tapping it — a link works once, and tapping it opens the web app instead of this one. Paste it here to finish on this phone.",
                style = WindmillFont.body(15),
                color = WindmillColor.textSecondary.color,
            )

            DoorField("Paste the link", pasted) { pasted = it }

            ActionCapsule(
                "Sign in",
                ActionWeight.Primary,
                enabled = !working && pasted.isNotEmpty(),
            ) {
                scope.launch {
                    working = true
                    refusal = null
                    try {
                        auth.completeLink(pasted)
                        onDone()
                    } catch (refused: WindmillApiException) {
                        refusal = MagicLink.refusal(refused)
                    } finally {
                        working = false
                    }
                }
            }

            refusal?.let { RefusalLine(it) }

            Row(horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x5)) {
                Text(
                    "Use a different email",
                    style = WindmillFont.body(14),
                    color = WindmillColor.textSecondary.color,
                    modifier = Modifier.clickable {
                        sentTo = null
                        refusal = null
                        pasted = ""
                    },
                )
                // Absent while it would only invite a double send; it appears at 30 seconds.
                if (canResend) {
                    Text(
                        "Resend",
                        style = WindmillFont.body(14),
                        color = WindmillColor.textSecondary.color,
                        modifier = Modifier.clickable { requestLink() },
                    )
                }
            }
        }
    }
}

// Every failure ends in a next step, and none of them is a wall — the remedy is always the field
// or the button directly above this line. Directly: it sits under the action capsule in both
// stages, because a phone-height column pushed anything below the footnote off the screen.
@Composable
private fun RefusalLine(line: String) {
    Text(
        line,
        style = WindmillFont.body(14),
        color = WindmillColor.neutral700.color,
        modifier = Modifier
            .fillMaxWidth()
            .background(WindmillColor.gold400.copy(alpha = 0.14f), RoundedCornerShape(WindmillRadius.sm))
            .padding(WindmillSpace.x3),
    )
}

// The one field this door uses, in both places it needs one (the address, and the pasted link).
// The placeholder is DRAWN in the decoration rather than left to any component default, so what
// colour it is is never the platform's guess — the iOS door learned that when a sheet built
// entirely out of brand neutrals came up with a system-blue prompt sitting in the middle of it.
@Composable
private fun DoorField(
    placeholder: String,
    value: String,
    keyboardType: KeyboardType = KeyboardType.Text,
    onChange: (String) -> Unit,
) {
    val shape = RoundedCornerShape(WindmillRadius.sm)
    BasicTextField(
        value = value,
        onValueChange = onChange,
        textStyle = WindmillFont.body(16).copy(color = WindmillColor.textPrimary.color),
        cursorBrush = SolidColor(WindmillColor.neutral900.color),
        singleLine = true,
        keyboardOptions = KeyboardOptions(
            capitalization = KeyboardCapitalization.None,
            autoCorrectEnabled = false,
            keyboardType = keyboardType,
        ),
        decorationBox = { inner ->
            Box(
                Modifier
                    .fillMaxWidth()
                    .background(WindmillColor.surfaceCard.color, shape)
                    .border(1.dp, WindmillColor.borderDefault.color, shape)
                    .padding(WindmillSpace.x3),
            ) {
                if (value.isEmpty()) {
                    Text(placeholder, style = WindmillFont.body(16), color = WindmillColor.textTertiary.color)
                }
                inner()
            }
        },
    )
}
