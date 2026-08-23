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

@Composable
fun ConnectInvitation(origin: String) {
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
            Text(
                ConnectedLog.free,
                style = GymType.numeral(11).copy(lineHeight = 17.sp),
                color = GymSkin.inkFaint,
            )
        }
    }
}

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
