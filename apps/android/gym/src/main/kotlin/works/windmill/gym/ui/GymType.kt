package works.windmill.gym.ui

import androidx.compose.foundation.text.TextAutoSize
import androidx.compose.material3.Typography
import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.sp
import works.windmill.gym.R
import works.windmill.platform.design.WindmillFont

// The faces the room bundles. Nunito and JetBrains Mono stand in for the brand's body and readout faces; Inter sets
// the onboarding glimpses' specimens and Baloo 2 the brand word.
object GymFonts {
    val nunito = FontFamily(
        Font(R.font.nunito_regular, FontWeight.Normal),
        Font(R.font.nunito_bold, FontWeight.Bold),
        Font(R.font.nunito_extrabold, FontWeight.ExtraBold),
    )
    val jetBrainsMono = FontFamily(
        Font(R.font.jetbrains_mono_regular, FontWeight.Normal),
        Font(R.font.jetbrains_mono_medium, FontWeight.Medium),
    )
    val inter = FontFamily(
        Font(R.font.inter_regular, FontWeight.Normal),
        Font(R.font.inter_medium, FontWeight.Medium),
        Font(R.font.inter_semibold, FontWeight.SemiBold),
    )
    val baloo2 = FontFamily(Font(R.font.baloo2_bold, FontWeight.Bold))
}

// The Material roles Material's own parts read. Native system faces with tabular figures keep changing weights and
// clocks steady.
val gymTypography: Typography = Typography(
    displayLarge = WindmillFont.display(44).tabular(),
    displayMedium = WindmillFont.display(38).tabular(),
    displaySmall = WindmillFont.display(32).tabular(),
    headlineLarge = WindmillFont.display(30).tabular(),
    headlineMedium = WindmillFont.display(26).tabular(),
    headlineSmall = WindmillFont.display(22).tabular(),
    titleLarge = WindmillFont.display(24).tabular(),
    titleMedium = WindmillFont.display(17).tabular(),
    titleSmall = WindmillFont.display(15).tabular(),
    bodyLarge = WindmillFont.body(16).tabular(),
    bodyMedium = WindmillFont.body(15).tabular(),
    bodySmall = WindmillFont.body(13).tabular(),
    labelLarge = WindmillFont.body(16, FontWeight.Bold).tabular(),
    labelMedium = WindmillFont.body(14, FontWeight.Bold).tabular(),
    labelSmall = WindmillFont.body(12, FontWeight.Bold).tabular(),
)

// The platform's own outlined-field type: body-large for what is typed, body-small for the label once it floats.
fun Typography.withStockFields(family: FontFamily): Typography = copy(
    bodyLarge = TextStyle(fontFamily = family, fontSize = 16.sp, lineHeight = 24.sp, letterSpacing = .5.sp),
    bodySmall = TextStyle(fontFamily = family, fontSize = 12.sp, lineHeight = 16.sp, letterSpacing = .4.sp),
)

// The platform's own snackbar type: its supporting text and its action.
fun Typography.withStockSnackbar(): Typography = copy(
    bodyMedium = bodyMedium.copy(fontSize = 14.sp, lineHeight = 20.sp, letterSpacing = .25.sp),
    labelLarge = labelLarge.copy(fontSize = 14.sp, lineHeight = 20.sp, letterSpacing = .1.sp, fontWeight = FontWeight.Medium),
)

// Where the room's layouts reflow for the system text size: past its 130 % step a layout opens up (the receipt fills
// its sheet, a set row stacks its readout), and from 150 % side-by-side parts stack.
object GymTextScale {
    val large: Boolean @Composable @ReadOnlyComposable get() = LocalDensity.current.fontScale > 1.3f
    val stacked: Boolean @Composable @ReadOnlyComposable get() = LocalDensity.current.fontScale >= 1.5f
}

// Every text role a gym screen draws that Material has no slot for, at the size, weight and line height it is drawn.
// Prose shared with the shell reads `WindmillType`. Every numeral is tabular, or a column of sets shimmers.
object GymType {
    // The room's chrome: top bar, account seat, navigation, the status line under a screen.
    val topBarTitle = nunito(22, FontWeight.Bold, leading = 28)
    val topBarAction = nunito(14, FontWeight.Bold, leading = 20, tracking = .1)
    val accountInitial = nunito(16, FontWeight.Bold, leading = 20)
    val navigationLabel = nunito(12, FontWeight.Bold, leading = 16, tracking = .5)
    val statusLine = TextStyle(fontFamily = GymFonts.jetBrainsMono, fontSize = 12.sp, lineHeight = 16.sp)

    // Native controls and the rows that sit among them, in Nunito.
    val button = TextStyle(fontFamily = GymFonts.nunito, fontWeight = FontWeight.Bold, fontSize = 16.sp, lineHeight = 22.sp)
    val extendedFabLabel = button.copy(lineHeight = 24.sp)
    val nativeRowTitle = button
    val noteTitle = button.copy(fontSize = 15.sp)
    val nativeBody = TextStyle(fontFamily = GymFonts.nunito, fontSize = 16.sp, lineHeight = 24.sp)
    val nativeSupporting = TextStyle(fontFamily = GymFonts.nunito, fontSize = 14.sp, lineHeight = 20.sp)
    val nativeDetail = TextStyle(fontFamily = GymFonts.nunito, fontSize = 13.sp, lineHeight = 18.sp)
    val connectionRow = nativeBody.copy(fontSize = 17.sp, fontWeight = FontWeight.Bold, letterSpacing = .5.sp)
    val connectionDetail = nativeSupporting.copy(letterSpacing = .25.sp)
    val segmentLabel = nativeSupporting.copy(letterSpacing = .1.sp, fontWeight = FontWeight.Medium)
    val emptyRoutinesTitle = TextStyle(fontFamily = GymFonts.nunito, fontWeight = FontWeight.ExtraBold, fontSize = 24.sp,
        lineHeight = 32.sp)

    // The number stepper: its value at display and inline size, its unit, label and refusal.
    val stepperDisplay = TextStyle(fontFamily = GymFonts.nunito, fontWeight = FontWeight.ExtraBold, fontSize = 88.sp,
        lineHeight = 92.sp, fontFeatureSettings = tabular)
    val stepperInline = TextStyle(fontFamily = GymFonts.jetBrainsMono, fontWeight = FontWeight.Medium, fontSize = 20.sp,
        lineHeight = 24.sp, fontFeatureSettings = tabular)
    val stepperUnitDisplay = TextStyle(fontFamily = GymFonts.nunito, fontSize = 22.sp, lineHeight = 28.sp)
    val stepperUnitInline = nativeBody
    val stepperLabel = TextStyle(fontFamily = FontFamily.SansSerif, fontSize = 12.sp, lineHeight = 16.sp)
    val stepperRefusal = nativeSupporting
    val stockFieldInput = TextStyle(fontFamily = FontFamily.SansSerif, fontSize = 16.sp, lineHeight = 24.sp, letterSpacing = .5.sp)

    // Readouts in the system mono.
    val numeral = numeral(13)
    val numeralSmall = numeral(12)
    val numeralTiny = numeral(11)
    val numeralMedium = numeral(14)
    val numeralLarge = numeral(16)
    val numeralDetail = numeral(13).copy(lineHeight = 18.sp)
    val numeralReadout = numeral(15).copy(lineHeight = 20.sp)
    val dismiss = numeral(11, FontWeight.Bold)
    val setPosition = numeral(12).copy(lineHeight = 16.sp)
    val setLoad = numeral(18, FontWeight.Medium).copy(lineHeight = 24.sp)
    val setLoadFit = TextAutoSize.StepBased(minFontSize = 14.sp, maxFontSize = setLoad.fontSize)

    // The workout: the rack's primary, the movement in hand, the band under a stranded set.
    val logSet = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.Bold, fontSize = 16.sp,
        fontFeatureSettings = tabular)
    val movementName = sans(22, FontWeight.Bold)
    val strandedLine = gymTypography.bodySmall.copy(lineHeight = 17.sp)
    val sheetHeadline = sans(28, FontWeight.Bold, leading = 36)
    val subtitle = sans(16, leading = 21)
    val movementRow = sans(17, FontWeight.Bold, leading = 24)
    val sheetAction = sans(17, FontWeight.Bold)
    val supportingTight = sans(14, leading = 18)
    val noteInput = gymTypography.bodyLarge.copy(lineHeight = 24.sp)

    // Finish: the receipt's headline, facts and actions.
    val finishHeadline = sans(44, FontWeight.ExtraBold, leading = 52)
    val finishSubhead = sans(18, leading = 24)
    val finishSentence = sans(17, leading = 24)
    val finishStat = sans(32, FontWeight.ExtraBold, leading = 40).copy(textAlign = TextAlign.Center)
    val finishStatFloor = finishStat.copy(fontSize = 16.sp, lineHeight = 20.sp)
    val finishStatFit = TextAutoSize.StepBased(minFontSize = finishStatFloor.fontSize, maxFontSize = finishStat.fontSize)
    val emptyFinishLine = sans(16, leading = 23)
    val performedName = sans(15)
    val actionLabel = gymTypography.labelLarge.copy(lineHeight = 22.sp)

    // The log, a workout, the record and the weigh-ins.
    val emptyLogTitle = sans(28, FontWeight.Bold, leading = 39)
    val heading = sans(18, FontWeight.Bold, leading = 24)
    val headingCompact = sans(18, FontWeight.Bold)
    val listHeading = sans(18, FontWeight.Bold, leading = 25)
    val screenHeading = sans(24, FontWeight.Bold)
    val cardTitle = sans(20, FontWeight.Bold)
    val sessionVolume = sans(34, FontWeight.ExtraBold, leading = 40)
    val recordTile = sans(30, FontWeight.ExtraBold, leading = 36)
    val statValue = sans(22, FontWeight.Bold, leading = 30)
    val captionLoose = sans(12, leading = 17)
    val chartAxis = sans(11, leading = 14)
    val smallParagraph = sans(13, leading = 20)
    val groupLabel = sans(14, FontWeight.Bold)
    val weighInTitle = sans(22, FontWeight.ExtraBold, leading = 30)
    val weighInListTitle = sans(18, FontWeight.ExtraBold, leading = 24)
    val weighInInput = gymTypography.bodyLarge.copy(fontFamily = FontFamily.Default, lineHeight = 24.sp)
    val windowOption = gymTypography.labelLarge.copy(fontSize = 14.sp, lineHeight = 20.sp)

    // Routines, the routine editor and its questions.
    val routineSheetTitle = sans(28, FontWeight.Bold)
    val movementTarget = sans(15, leading = 21)
    val historyTitle = sans(17, FontWeight.Bold, leading = 23)
    val discardRoutineTitle = gymTypography.headlineSmall.merge(TextStyle(fontFamily = FontFamily.Default,
        fontWeight = FontWeight.Normal, fontSize = 24.sp, lineHeight = 32.sp))
    val discardWorkoutTitle = gymTypography.headlineSmall.merge(TextStyle(fontFamily = FontFamily.Default, fontSize = 24.sp,
        lineHeight = 32.sp))
    val discardText = gymTypography.bodyMedium.merge(TextStyle(fontFamily = FontFamily.Default, fontWeight = FontWeight.Normal,
        fontSize = 14.sp, lineHeight = 20.sp))
    val discardAction = gymTypography.labelLarge.merge(TextStyle(fontFamily = FontFamily.Default, fontWeight = FontWeight.Medium,
        fontSize = 14.sp, lineHeight = 20.sp))

    // Confirmations, proposals and sharing.
    val confirmTitle = sans(19, FontWeight.Bold)
    val quietParagraph = sans(14, leading = 21)
    val strongAction = sans(15, FontWeight.Bold)
    val quietAction = sans(15, FontWeight.SemiBold)
    val proposalTitle = sans(26, FontWeight.Bold, leading = 36)
    val proposalSummary = sans(20, FontWeight.Bold, leading = 28)
    val proposalBadge = sans(12, FontWeight.SemiBold)
    val retry = sans(14, FontWeight.SemiBold)
    val shareTitle = sans(26, FontWeight.ExtraBold)

    // Coach, in Nunito: its answers, choices, sources, access and history.
    val coachParagraph = nunito(16, leading = 22)
    val coachListMarker = coachParagraph.copy(fontFeatureSettings = tabular)
    val coachHeading = nunito(17, FontWeight.Bold, leading = 24)
    val coachTitle = nunito(16, FontWeight.Bold, leading = 24)
    val coachDraft = nunito(16, leading = 24)
    val coachComposer = nunito(16, leading = 24, tracking = .5)
    val coachSupporting = nunito(14, leading = 20)
    val coachStrong = nunito(14, FontWeight.Bold, leading = 20)
    val coachAction = nunito(14, FontWeight.Bold, leading = 20, tracking = .1)
    val coachGroupLabel = nunito(14, FontWeight.Bold)
    val coachLine = nunito(14)
    val coachNone = nunito(15)
    val coachNote = nunito(12)
    val coachBubbleLabel = nunito(12, FontWeight.Bold, leading = 16)
    val coachChoice = gymTypography.labelLarge.merge(TextStyle(fontFamily = FontFamily.Default, fontWeight = FontWeight.Medium,
        fontSize = 14.sp, lineHeight = 20.sp, letterSpacing = .1.sp))
    val coachCode = WindmillFont.mono(15)
    val coachSourcesTitle = nunito(28, FontWeight.ExtraBold, leading = 36)
    val coachSourceTitle = nunito(15, FontWeight.Bold, leading = 20)
    val coachSourceLine = nunito(13, leading = 18)
    val coachAccessTitle = nunito(22, FontWeight.ExtraBold, leading = 28)
    val coachAccessLine = nunito(16, leading = 23)
    val coachAccessNote = nunito(18, leading = 26)
    val coachElsewhere = nunito(15, leading = 23)
    val coachDeleteTitle = nunito(24, FontWeight.Bold, leading = 32)

    // Onboarding.
    val wordmark = TextStyle(fontFamily = GymFonts.baloo2, fontWeight = FontWeight.Bold, fontSize = 30.sp, lineHeight = 36.sp)
    val onboardingBackGlyph = gymTypography.labelLarge.copy(fontSize = 32.sp)
    val onboardingKicker = WindmillFont.mono(11, FontWeight.Medium).copy(lineHeight = 16.sp, letterSpacing = 2.2.sp)
    val onboardingTitle = gymTypography.headlineLarge.copy(lineHeight = 38.sp)
    val onboardingBody = gymTypography.bodyLarge.copy(lineHeight = 24.sp)
    val onboardingChip = gymTypography.labelSmall.copy(lineHeight = 16.sp, letterSpacing = .1.sp)

    // The debug native-parts specimen's captions.
    val specimenCaption = TextStyle(fontFamily = GymFonts.jetBrainsMono, fontWeight = FontWeight.Medium, fontSize = 11.sp,
        lineHeight = 15.sp, letterSpacing = 0.sp)
}

private const val tabular = "tnum"

private fun TextStyle.tabular(): TextStyle = copy(fontFeatureSettings = tabular)

private fun sans(size: Int, weight: FontWeight = FontWeight.Normal, leading: Int? = null): TextStyle =
    WindmillFont.body(size, weight).let { if (leading == null) it else it.copy(lineHeight = leading.sp) }

private fun nunito(size: Int, weight: FontWeight = FontWeight.Normal, leading: Int? = null, tracking: Double? = null): TextStyle =
    sans(size, weight, leading).copy(fontFamily = GymFonts.nunito)
        .let { if (tracking == null) it else it.copy(letterSpacing = tracking.sp) }

private fun numeral(size: Int, weight: FontWeight = FontWeight.Normal): TextStyle =
    TextStyle(fontFamily = FontFamily.Monospace, fontWeight = weight, fontSize = size.sp, fontFeatureSettings = tabular)
