package works.windmill.gym.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import works.windmill.gym.domain.ConnectedLog
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillRadius
import works.windmill.platform.design.WindmillSpace

// THE INVITATION (§D screen 12, with its price deleted — ConnectedLog says why). It is one concrete
// exchange: what a lifter types in their own tool on Sunday, and the object that lands in gym on
// Monday. Nothing on it is a gate, so nothing on it wears a lock, a tier chip or a price, and no tap
// on it leads to a checkout — there is no checkout to lead to.
//
// IT IS AN INVITATION AND MAY BE WALKED PAST FOREVER. Nothing counts how often it was, nothing gets
// louder, and there is no dismiss control — a card that had to be put away would be a card that was
// asking for something.
//
// IT IS NOT WITHHELD FROM A LIFTER WHO HAS ALREADY CONNECTED ONE, and that is a known cost rather
// than an oversight: the account's connections are the shell's and this room does not read them
// (ConnectedLog). The one hint it could go on — a pending proposal that came through the MCP door —
// comes and goes as diffs are decided, so a card keyed on it would appear and vanish for reasons a
// lifter could not follow. A quiet card read twice is the cheaper failure.
//
// WHERE IT IS NOT: mid-session, which on this phone is structure rather than a check — a live
// session takes the whole screen (GymRoom), so no tab is drawn under one. And never over the empty
// home: the pitch is about training already logged, and it sits under the list of days it would
// write against.
@Composable
fun ConnectInvitation(origin: String) {
    // Told to fail QUIETLY, exactly as Ask's own free door is: a phone with no browser at all is the
    // only way this misses, and everything the card says is still true and still the point.
    val web = LocalUriHandler.current
    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x3),
        modifier = Modifier
            .fillMaxWidth()
            .background(GymSkin.surface, RoundedCornerShape(WindmillRadius.lg))
            .border(1.dp, GymSkin.line, RoundedCornerShape(WindmillRadius.lg))
            .padding(WindmillSpace.x4),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(WindmillSpace.x2)) {
            Text(ConnectedLog.head, style = WindmillFont.display(21), color = GymSkin.ink)
            Text(
                ConnectedLog.sub,
                style = WindmillFont.body(14).copy(lineHeight = 21.sp),
                color = GymSkin.inkDim,
            )
        }

        // The exchange, and the arrow between its halves — the question in the room's own quiet
        // surface, the answer in the accent this product spells a proposal in everywhere else, so
        // the card and the real card a lifter meets are recognisably one object.
        Beat(ConnectedLog.sundayLabel, ConnectedLog.sundayLine, GymSkin.inkFaint, GymSkin.raised, GymSkin.line)
        Text(
            "↓",
            style = WindmillFont.body(15),
            color = GymSkin.inkFaint,
            modifier = Modifier.fillMaxWidth().padding(start = WindmillSpace.x2),
        )
        Beat(ConnectedLog.mondayLabel, ConnectedLog.mondayLine, GymSkin.accent, GymSkin.accentSoft, GymSkin.accent)

        Column(verticalArrangement = Arrangement.spacedBy(WindmillSpace.x2)) {
            ConnectedLog.truths.forEach { line ->
                Row(horizontalArrangement = Arrangement.spacedBy(WindmillSpace.x2)) {
                    Text("·", style = GymType.numeral(13, FontWeight.Bold), color = GymSkin.setDone)
                    Text(
                        line,
                        style = WindmillFont.body(13).copy(lineHeight = 20.sp),
                        color = GymSkin.inkDim,
                    )
                }
            }
        }

        // The precondition, sunk into the card rather than dropped under it: it is the sentence that
        // tells some readers this is not for them, and it must not read as small print.
        Text(
            ConnectedLog.precondition,
            style = GymType.numeral(12).copy(lineHeight = 18.sp),
            color = GymSkin.inkFaint,
            modifier = Modifier
                .fillMaxWidth()
                .background(GymSkin.canvas, RoundedCornerShape(WindmillRadius.md))
                .border(1.dp, GymSkin.line, RoundedCornerShape(WindmillRadius.md))
                .padding(WindmillSpace.x3),
        )

        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = GymTap.primary - 8.dp)
                .background(GymSkin.accent, RoundedCornerShape(WindmillRadius.lg))
                .clickable { runCatching { web.openUri(ConnectedLog.setupUrl(origin)) } },
        ) {
            Text(ConnectedLog.connect, style = WindmillFont.body(16, FontWeight.Bold), color = GymSkin.onAccent)
        }
        Column(verticalArrangement = Arrangement.spacedBy(WindmillSpace.x1)) {
            Text(ConnectedLog.onTheWeb, style = GymType.numeral(11), color = GymSkin.inkFaint)
            // Where §D put the price. It is the last line of the card on purpose: it is the answer
            // to the question the whole card raises, and it is one sentence long because it is
            // simple.
            Text(
                ConnectedLog.free,
                style = GymType.numeral(11).copy(lineHeight = 17.sp),
                color = GymSkin.inkFaint,
            )
        }
    }
}

// One half of the exchange: whose turn it is, and what is said in it.
@Composable
private fun Beat(label: String, line: String, labelInk: Color, fill: Color, edge: Color) {
    Column(
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x2),
        modifier = Modifier
            .fillMaxWidth()
            .background(fill, RoundedCornerShape(WindmillRadius.md))
            .border(1.dp, edge, RoundedCornerShape(WindmillRadius.md))
            .padding(WindmillSpace.x3),
    ) {
        Text(label, style = GymType.numeral(10, FontWeight.Bold), color = labelInk)
        Text(line, style = WindmillFont.body(14).copy(lineHeight = 21.sp), color = GymSkin.ink)
    }
}
