package works.windmill.gym.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import works.windmill.gym.domain.Exercise
import works.windmill.platform.design.WindmillFont
import works.windmill.platform.design.WindmillRadius
import works.windmill.platform.design.WindmillSpace

// THE PICKER — type to filter, live, and a door out at the bottom of every empty result. A movement
// is a stable identity and never a typed string, so the only way to lift something the catalog has
// never heard of is to MINT it here; that is what keeps twelve weeks of "Bench Press" one movement
// instead of four spellings of one.
//
// The empty state is three different silences and they must not share a sentence. A lifter who typed
// a letter the catalog does not hold was once told their signal was out — the app reporting a failure
// that had not happened, and pointing them at the wrong thing to fix. Only an EMPTY catalog may
// mention signal. The native twin of web/src/products/gym/logger/movements.js.
object PickerOptions {
    const val shown = 7

    // The door out belongs to exactly one of the three silences: the one a NAME can answer. A
    // catalog that never loaded comes back with signal, and a catalog already entirely in the
    // session is answered by the jump sheet — minting a duplicate of a movement you are already
    // logging is the one thing the stable-identity rule exists to prevent.
    data class Result(val matches: List<Exercise>, val empty: String?, val create: String?)

    fun matching(query: String, catalog: List<Exercise>, taken: List<String>): Result {
        val term = query.trim()
        val available = catalog.filter { it.id !in taken }
        val matches = available
            .filter { term.isEmpty() || it.name.lowercase().contains(term.lowercase()) }
            .take(shown)
        if (matches.isNotEmpty()) {
            return Result(matches, empty = null, create = null)
        }
        if (catalog.isEmpty()) {
            return Result(emptyList(), empty = "The catalog didn’t load. It comes back when you have signal.",
                          create = null)
        }
        if (available.isEmpty()) {
            return Result(emptyList(), empty = "Every movement in the catalog is already in this session.",
                          create = null)
        }
        // An empty query matches every available movement, so reaching here means something was
        // typed — the button can quote it without asking whether there is anything to quote.
        return Result(emptyList(), empty = "No movement by that name.", create = "Create “$term”")
    }
}

@Composable
fun MovementPicker(
    catalog: List<Exercise>,
    taken: List<String>,
    onPick: (String) -> Unit,
    onCreate: (String) -> Unit,
    onClose: () -> Unit,
) {
    var query by remember { mutableStateOf("") }
    val options = PickerOptions.matching(query, catalog, taken)

    Column(
        Modifier
            .fillMaxWidth()
            .fillMaxHeight(0.92f)
            .background(GymSkin.surface)
            .imePadding()
            .padding(WindmillSpace.x5),
        verticalArrangement = Arrangement.spacedBy(WindmillSpace.x4),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Movements", style = WindmillFont.display(20), color = GymSkin.ink)
            Spacer(Modifier.weight(1f))
            Box(
                Modifier.heightIn(min = GymTap.minimum).clickable(onClick = onClose),
                contentAlignment = Alignment.Center,
            ) {
                Text("Cancel", style = WindmillFont.body(16), color = GymSkin.inkDim)
            }
        }

        BasicTextField(
            value = query,
            onValueChange = { query = it },
            singleLine = true,
            textStyle = WindmillFont.body(17).copy(color = GymSkin.ink),
            cursorBrush = SolidColor(GymSkin.accent),
            keyboardOptions = KeyboardOptions(
                capitalization = KeyboardCapitalization.Words,
                autoCorrectEnabled = false,
            ),
            modifier = Modifier
                .fillMaxWidth()
                .height(GymTap.minimum + 4.dp)
                .clip(RoundedCornerShape(WindmillRadius.md))
                .background(GymSkin.raised),
            decorationBox = { inner ->
                Box(
                    Modifier.fillMaxWidth().padding(horizontal = WindmillSpace.x4),
                    contentAlignment = Alignment.CenterStart,
                ) {
                    if (query.isEmpty()) {
                        Text("Search ${catalog.size} movements", style = WindmillFont.body(17), color = GymSkin.inkFaint)
                    }
                    inner()
                }
            },
        )

        Column(
            Modifier
                .fillMaxWidth()
                .weight(1f)
                .verticalScroll(rememberScrollState()),
        ) {
            options.matches.forEach { movement ->
                Row(
                    Modifier
                        .fillMaxWidth()
                        .heightIn(min = GymTap.minimum + 6.dp)
                        .clickable { onPick(movement.id) },
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(movement.name, style = WindmillFont.body(17), color = GymSkin.ink)
                    Spacer(Modifier.weight(1f))
                    // A movement the lifter minted behaves identically to a seeded one and is
                    // tagged only so they can recognise their own.
                    if (movement.custom) {
                        Text("yours", style = GymType.numeral(11), color = GymSkin.inkFaint)
                    }
                }
                Box(Modifier.fillMaxWidth().height(1.dp).background(GymSkin.line))
            }
        }

        options.empty?.let { empty ->
            Text(empty, style = WindmillFont.body(14), color = GymSkin.inkDim, lineHeight = 20.sp)
        }

        options.create?.let { create ->
            Box(
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = GymTap.minimum + 6.dp)
                    .clip(RoundedCornerShape(WindmillRadius.md))
                    .background(GymSkin.accent)
                    .clickable { onCreate(query.trim()) },
                contentAlignment = Alignment.Center,
            ) {
                Text(create, style = WindmillFont.body(16, FontWeight.SemiBold), color = GymSkin.onAccent)
            }
        }
    }
}
