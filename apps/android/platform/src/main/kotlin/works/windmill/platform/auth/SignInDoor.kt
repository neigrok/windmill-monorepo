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
// same sentence is already on the app doors of both platforms and one sentence lives in one place.
//
// The mail carries a 6-DIGIT CODE (the mint rides `door: "app"`), because a code finishes the
// sign-in on the phone that asked for it — a magic link would open the web app and burn itself
// there, which is why this door used to instruct people to copy-not-tap. The code field still
// takes a pasted link or bare token as the fallback: older mails, and links minted from another
// surface, stay usable.

@Composable
fun SignInDoor(auth: AuthStore, onDone: () -> Unit = {}) {
    var email by remember { mutableStateOf("") }
    var typed by remember { mutableStateOf("") }
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
                if (working) "Sending…" else "Email me a code",
                ActionWeight.Primary,
                enabled = !working && email.isNotEmpty(),
            ) { requestLink() }

            refusal?.let { RefusalLine(it) }

            // Since the gym runs signed out and the claim replay carries what it made onto the
            // account, the footnote can finally say the simple half that holds everywhere.
            Text(
                "No password. What you make on this device is claimed by your account when you sign in.",
                style = WindmillFont.body(13),
                color = WindmillColor.textTertiary.color,
            )
        } else {
            Text("Check your email", style = WindmillFont.display(22), color = WindmillColor.textPrimary.color)

            Text(
                "We sent a code to $address. It works once and lasts 15 minutes.",
                style = WindmillFont.body(15),
                color = WindmillColor.textSecondary.color,
            )

            HorizontalDivider(color = WindmillColor.borderSubtle.color)

            // The number pad is for the code the mail just sent; pasting still lands whole links
            // and bare tokens in the same field, and exactly six digits is what tells them apart.
            DoorField("6-digit code", typed, keyboardType = KeyboardType.Number) { typed = it }

            ActionCapsule(
                "Sign in",
                ActionWeight.Primary,
                enabled = !working && typed.isNotEmpty(),
            ) {
                scope.launch {
                    working = true
                    refusal = null
                    val entry = typed.trim()
                    val code = entry.takeIf { it.length == 6 && it.all(Char::isDigit) }
                    try {
                        if (code != null) auth.completeCode(address, code) else auth.completeLink(entry)
                        onDone()
                    } catch (refused: WindmillApiException) {
                        refusal = MagicLink.refusal(refused, ofCode = code != null)
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
                        typed = ""
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

// The one field this door uses, in both places it needs one (the address, and the code).
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
