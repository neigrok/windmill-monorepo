package works.windmill.gym.domain

import org.junit.Assert.*
import org.junit.Test
import works.windmill.platform.net.WindmillJson

class AnswerReceiptTests {
    @Test
    fun liveAndPastAnswersKeepTheSameAuthoritativeSnapshotsAndProse() {
        val receipt = """{"version":1,"read":{"sets":2,"sessions":1,"weeks":1},"steps":[{"tool":"list_sessions","failed":false},{"tool":"get_session","failed":false},{"tool":"last_time","failed":false},{"tool":"get_session","failed":true}],"proposals":[],"observations":[{"sessionId":"ses_evidence1","startedAt":1700000000000,"finishedAt":1700000900000,"routine":"Push A","tool":"list_sessions","coverage":"summary","setsRead":0,"workout":{"workingSetCount":1,"tonnageKg":400.0,"durationMs":900000}},{"sessionId":"ses_evidence1","startedAt":1700000000000,"finishedAt":1700000900000,"routine":"Push A","tool":"get_session","coverage":"session","setsRead":2,"workout":{"workingSetCount":1,"tonnageKg":400.0,"durationMs":900000}},{"sessionId":"ses_evidence1","startedAt":1700000000000,"finishedAt":1700000900000,"routine":"Push A","tool":"last_time","coverage":"movement","setsRead":1,"exerciseId":"bench-press"}]}"""
        val expected = AnswerReceipt(1, ReadTally(2, 1, 1),
            listOf(AskStep("list_sessions"), AskStep("get_session"), AskStep("last_time"), AskStep("get_session", true)),
            observations = listOf(
                SessionObservation("ses_evidence1", 1700000000000, "list_sessions", "summary", 0, 1700000900000, "Push A", workout = WorkoutObservation(1, 400.0, 900000)),
                SessionObservation("ses_evidence1", 1700000000000, "get_session", "session", 2, 1700000900000, "Push A", workout = WorkoutObservation(1, 400.0, 900000)),
                SessionObservation("ses_evidence1", 1700000000000, "last_time", "movement", 1, 1700000900000, "Push A", "bench-press"),
            ))
        val live = WindmillJson.decodeFromString<AskAnswer>("""{"answer":"You squatted 100 for five.","read":{"sets":2,"sessions":1,"weeks":1},"receipt":$receipt}""")
        val past = WindmillJson.decodeFromString<AskTurn>("""{"from":"coach","text":"You squatted 100 for five.","at":1700001000000,"receipt":$receipt}""")
        assertEquals(AskAnswer("You squatted 100 for five.", ReadTally(2, 1, 1), receipt = expected), live)
        assertEquals(AskTurn("coach", "You squatted 100 for five.", 1700001000000, expected), past)
        assertEquals(listOf(expected.observations[1]), expected.workouts)
        assertEquals(expected, WindmillJson.decodeFromString<AnswerReceipt>(WindmillJson.encodeToString(AnswerReceipt.serializer(), expected)))
    }

    @Test
    fun movementUnknownAndOldEvidenceNeverManufactureWorkoutTotals() {
        val movement = SessionObservation("session", 1000, "last_time", "movement", 1, exerciseId = "bench", workout = WorkoutObservation(9, 2700.0, 2880000))
        val unknown = movement.copy(coverage = "future")
        val invalid = movement.copy(coverage = "session", exerciseId = null, workout = WorkoutObservation(-1, 100.0))
        val receipt = AnswerReceipt(1, ReadTally(1, 1, 1), observations = listOf(movement, unknown, invalid))
        assertEquals(emptyList<SessionObservation>(), receipt.workouts)
        assertEquals(emptyList<SessionObservation>(), receipt.copy(version = 2).observed)
        assertNull(WindmillJson.decodeFromString<AskTurn>("""{"from":"coach","text":"9 working sets, 2700kg."}""").receipt)
        assertNull(WindmillJson.decodeFromString<AskAnswer>("""{"answer":"9 working sets, 2700kg.","read":{"sets":9}}""").receipt)
    }

    @Test
    fun eachSessionKeepsItsOwnLatestWholeSnapshotWithoutAddingOverlappingReads() {
        val first = SessionObservation("a", 1000, "list_sessions", "summary", 0, routine = "Push", workout = WorkoutObservation(2, 960.0))
        val second = SessionObservation("b", 2000, "get_session", "session", 4, routine = "Pull", workout = WorkoutObservation(3, 520.0, 120000))
        val last = first.copy(tool = "get_session", coverage = "session", setsRead = 3, workout = WorkoutObservation(3, 1440.0))
        val receipt = AnswerReceipt(1, ReadTally(7, 2, 1), observations = listOf(first, second, last))
        assertEquals(listOf(second, last), receipt.workouts)
        assertEquals(ReadTally(7, 2, 1), receipt.read)
    }
}
