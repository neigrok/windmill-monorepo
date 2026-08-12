package works.windmill.gym.domain

import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.sign

// THE LADDER — the one place in gym where a weight moves by a tap. There are three copies of this
// rule in Windmill — this one, apps/ios Ladder.swift and web/src/products/gym/logger/ladder.js —
// because there are three languages. What keeps them one rule is
// packages/api-contract/gym-ladder.json: every copy reads that file as a test, so a change here
// that the other copies do not make fails CI.
//
// The bands are read off the MAGNITUDE, so the ladder behaves the same on the negative side of
// zero — band-assisted pull-ups sit at −20 kg, a point on the number line and never a mode. The
// step buttons do not clamp; only typed entry is bounded.

object Ladder {
    data class Band(val under: Double?, val small: Double, val large: Double)

    data class Steps(val small: Double, val large: Double)

    // The golden's `bands` array, same rows in the same order. A band added there and not here is
    // exactly the drift LadderTests exists to catch.
    //
    // RETIERED 2026-08-11: the FINE button is the program step and the COARSE button is a plate
    // change. The mined tiers put ±2 and ±5 in the middle band and ±5/±10 above it, which left the
    // +2.5 kg step a barbell program is written in off the ladder entirely above 50 kg — 85 was not
    // reachable from 82.5 at any depth, only through the keypad.
    val bands = listOf(
        Band(under = 20.0, small = 1.0, large = 2.5),
        Band(under = 50.0, small = 2.5, large = 5.0),
        Band(under = null, small = 2.5, large = 10.0),
    )

    // A move that lightens the load reads the band JUST BELOW the magnitude, so the +1 that carried
    // you 19 → 20 is answered by a −1 back to 19 rather than a −2.5 down to 17.5. That is the whole
    // difference, and it is one comparison: `<` tightens to `<=`. It is the limit of `magnitude − ε`
    // with no epsilon to pick. It buys reversibility at the edge and nowhere else: 19.5 +1→ 20.5
    // −2.5→ 18 crosses a boundary rather than landing on it, and does not come back.
    fun steps(magnitude: Double, lightening: Boolean): Steps {
        // The open top band (`under: null`) answers true without comparing, so it catches NaN too and
        // the fallback is unreachable — it is written out because the compiler cannot know that. The
        // web copy spells its top band `Infinity` and DOES compare, so NaN falls through there and it
        // needs a live fallback. No surface may throw on a weight rehydrated from storage.
        val band = bands.firstOrNull { band ->
            val under = band.under ?: return@firstOrNull true
            if (lightening) magnitude <= under else magnitude < under
        } ?: bands.last()
        return Steps(band.small, band.large)
    }

    // Half away from zero, spelled out on IEEE doubles — and it is a law, not a default, because it
    // is the mirror symmetry one level down: round(−x) must equal −round(x). `Math.round` is half-UP
    // and breaks that on the negative side, and `kotlin.math.round` is half-to-even at a tie, so the
    // magnitude is rounded by hand and the sign reapplied. No ladder step ever reaches a tie; typed
    // entry does — a lifter keying −2.505 is what makes two surfaces disagree, and `roundCases` in
    // the golden pins them.
    fun round(weight: Double): Double {
        val hundredths = floor(abs(weight) * 100.0 + 0.5)
        return (hundredths / 100.0) * sign(weight)
    }

    fun bump(weight: Double, direction: Int, big: Boolean): Double {
        val step = steps(abs(weight), lightening = direction * weight < 0)
        return round(weight + direction * (if (big) step.large else step.small))
    }

    fun labels(weight: Double): List<String> {
        val down = steps(abs(weight), lightening = weight > 0)
        val up = steps(abs(weight), lightening = weight < 0)
        return listOf("−${text(down.large)}", "−${text(down.small)}", "+${text(up.small)}", "+${text(up.large)}")
    }

    // §K'S CAPTION UNDER THE BUTTONS, read off the band table rather than typed beside it: `over 50
    // kg · fine 2.5 · plate 10`. It exists because the labels re-render as the load climbs and a
    // lifter watching −5 become −10 deserves to know why — and it is composed from `bands` for the
    // same reason the labels are, so a retier moves the caption with the buttons or moves neither.
    //
    // The band is read the way a LIFT reads it (`<`), because the caption says where you are
    // standing rather than what the down key will do — at exactly 20 the down key answers 19 out of
    // the band below, and a caption that followed it would name a tier the lifter has already left.
    fun tier(weight: Double): String {
        val magnitude = abs(weight)
        val index = bands.indices.first { at ->
            val under = bands[at].under ?: return@first true
            magnitude < under
        }
        val band = bands[index]
        val where = when (index) {
            0 -> "under ${text(band.under ?: 0.0)} kg"
            bands.size - 1 -> "over ${text(bands[index - 1].under ?: 0.0)} kg"
            else -> "${text(bands[index - 1].under ?: 0.0)}–${text(band.under ?: 0.0)} kg"
        }
        return "$where · fine ${text(band.small)} · plate ${text(band.large)}"
    }

    // Steps print bare: the golden reads "−5" and "+10", never "−5.0". The minus is U+2212, the
    // plus is ASCII — every copy must agree on the glyph, not just the number.
    internal fun text(step: Double): String {
        if (step == floor(step)) return step.toInt().toString()
        return step.toString()
    }

    // A set of zero reps is not a set, and the server says so — Training.cpp refuses reps < 1 — so a
    // ladder that floored at 0 offered a tap the log could only answer with a refusal. The floor is a
    // CLAMP INTO the range and never a hold at the value: a stored 0 from an older build is climbed
    // out of by whichever button the thumb finds first. repCases pins that answer for every language.
    fun bumpReps(reps: Int, direction: Int): Int {
        if (direction < 0) return max(1, reps - 1)
        return reps + 1
    }
}
