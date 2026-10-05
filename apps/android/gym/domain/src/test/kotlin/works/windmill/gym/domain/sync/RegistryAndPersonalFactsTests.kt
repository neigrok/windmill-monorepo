package works.windmill.gym.domain.sync

import org.junit.Assert.*
import org.junit.Test
import works.windmill.domain.kit.*
import works.windmill.domain.testing.RegistryCheck
import works.windmill.sync.api.Change
import works.windmill.sync.api.RegisterRef
import works.windmill.sync.api.ViewMode
import works.windmill.sync.core.Json
import works.windmill.sync.core.RefusalCode
import works.windmill.sync.schema.Gym
import works.windmill.sync.schema.SyncSchema

class RegistryAndPersonalFactsTests {
    @Test fun everyGymEntityDeclarationMatchesRegistryIncludingReadOnlySessionAndRoutineCreation() {
        val book = GymRules.book
        RegistryCheck.entity(Note, Note(Id("note0001", Note), "Title", "Body"), book)
        RegistryCheck.entity(WeighIn, WeighIn(testMoment.today, 80.0, testMoment.now), book)
        RegistryCheck.entity(Routine, routine, book)
        RegistryCheck.entity(Exercise, Exercise(Id("exercise1", Exercise), "Custom", "squat", "barbell", 2.5), book)
        RegistryCheck.entity(ExerciseName, ExerciseName(Id(squat.record, ExerciseName), "My squat"), book)
        RegistryCheck.entity(TrainingSet, trainingSet(), book)
        RegistryCheck.entity(Preferences, Preferences(), book)
        RegistryCheck.entity(Proposal, Proposal(proposalId, routineId, "revise", "Lower B", "Summary",
            listOf(RoutineChange("kept", squat, EntryTargets(entry), EntryTargets(entry)))), book)
        RegistryCheck.entity(Session, SyncSchema.registry)
        RegistryCheck.entity(RoutineCreation, SyncSchema.registry)
        assertEquals(setOf(Note.type, WeighIn.type, Routine.type, RoutineCreation.type, Exercise.type, ExerciseName.type, TrainingSet.type, Preferences.type, Proposal.type, Session.type),
            book.entities.map { it.type }.toSet())
    }

    @Test fun serverAuthoredMetadataDecodesWithoutEnteringClientWrites() {
        val note = Note(Id("note0001", Note), "Title", "Body")
        val noteRow = row(note).copy(values = note.fields() + ("updatedAt" to Json.of(testMoment.now.ms)))
        val decodedNote = Note.decode(Fields(noteRow))
        assertEquals(note.copy(updatedAt = testMoment.now), decodedNote)
        assertEquals(note.fields(), decodedNote.fields())
        assertEquals(writing(decide(saveNote(note))).plan.gesture(Note.scope, SyncSchema.registry).changes,
            writing(decide(saveNote(decodedNote))).plan.gesture(Note.scope, SyncSchema.registry).changes)
        val noteEdit = SaveDraft.fromDraft(Draft.opening(decodedNote).edit { it.copy(body = "Changed", updatedAt = Instant(1)) }, Note, GymRefusal)
        val noteGesture = writing(decide(noteEdit, reader(listOf(noteRow)))).plan.gesture(Note.scope, SyncSchema.registry)
        assertEquals(listOf(Change.update(Note.type, note.id.record, mapOf("body" to Json.of("Changed")))),
            noteGesture.changes)
        assertEquals(listOf(RegisterRef(Note.type, note.id.record, "body")), noteGesture.guards)

        val routineRow = row(routine).copy(values = routine.fields() + mapOf("revision" to Json.of(7), "createdEntries" to Json.of(0)))
        val decodedRoutine = Routine.decode(Fields(routineRow))
        assertEquals(routine.copy(revision = 7, createdEntries = 0), decodedRoutine)
        assertEquals(routine.fields(), decodedRoutine.fields())
        assertEquals(writing(decide(saveRoutine(routine))).plan.gesture(Routine.scope, SyncSchema.registry).changes,
            writing(decide(saveRoutine(decodedRoutine))).plan.gesture(Routine.scope, SyncSchema.registry).changes)
        val routineEdit = SaveDraft.fromDraft(Draft.opening(decodedRoutine).edit { it.copy(name = "Lower B", revision = 8, createdEntries = 10) }, Routine, GymRefusal)
        val routineGesture = writing(decide(routineEdit, reader(listOf(routineRow)))).plan.gesture(Routine.scope, SyncSchema.registry)
        assertEquals(listOf(Change.update(Routine.type, routineId.record, mapOf("name" to Json.of("Lower B")))),
            routineGesture.changes)
        assertEquals(listOf(RegisterRef(Routine.type, routineId.record, "name")), routineGesture.guards)

        val proposal = Proposal(proposalId, routineId, "revise", "Lower B", "Summary",
            listOf(RoutineChange("kept", squat, EntryTargets(entry), EntryTargets(entry))))
        val proposalRow = row(proposal).copy(values = proposal.fields() + mapOf("baseRevision" to Json.of(7), "baseName" to Json.of("Lower A"), "changeCount" to Json.of(1)))
        val decodedProposal = Proposal.decode(Fields(proposalRow))
        assertEquals(proposal.copy(baseRevision = 7, baseName = "Lower A", changeCount = 1), decodedProposal)
        assertEquals(proposal.fields(), decodedProposal.fields())
        val creation = Plan().apply { create(Valid(decodedProposal, Proposal, at = testMoment)) }.gesture(Proposal.scope, SyncSchema.registry)
        assertEquals(listOf(Change.create(Proposal.type, works.windmill.sync.api.NewID.Given(proposalId.record), proposal.fields())), creation.changes)
        RegistryCheck.entity(Note, decodedNote, GymRules.book)
        RegistryCheck.entity(Routine, decodedRoutine, GymRules.book)
        RegistryCheck.entity(Proposal, decodedProposal, GymRules.book)
    }

    @Test fun missingMetadataRemainsAbsentAndMalformedMetadataFailsAtItsField() {
        val note = Note(Id("note0001", Note), "Title", "Body")
        val proposal = Proposal(proposalId, routineId, "revise", "Lower B", "Summary", emptyList())
        assertEquals(note, Note.decode(Fields(row(note))))
        assertEquals(routine, Routine.decode(Fields(row(routine))))
        assertEquals(proposal, Proposal.decode(Fields(row(proposal))))
        val malformed: List<Pair<String, () -> Unit>> = listOf(
            "updatedAt" to { Note.decode(Fields(row(note).copy(values = note.fields() + ("updatedAt" to Json.of("yesterday"))))) },
            "revision" to { Routine.decode(Fields(row(routine).copy(values = routine.fields() + ("revision" to Json.of(1.5))))) },
            "createdEntries" to { Routine.decode(Fields(row(routine).copy(values = routine.fields() + ("createdEntries" to Json.of("1"))))) },
            "baseRevision" to { Proposal.decode(Fields(row(proposal).copy(values = proposal.fields() + ("baseRevision" to Json.of(1.5))))) },
            "baseName" to { Proposal.decode(Fields(row(proposal).copy(values = proposal.fields() + ("baseName" to Json.of(1))))) },
            "changeCount" to { Proposal.decode(Fields(row(proposal).copy(values = proposal.fields() + ("changeCount" to Json.of("1"))))) },
        )
        for ((field, decode) in malformed) assertEquals(field, assertThrows(DecodeError::class.java) { decode() }.field)
    }

    @Test fun routineCreationIsAReadOnlyIndependentExactSnapshot() {
        val id = Id(routineId.record, RoutineCreation)
        val snapshot = Json.objectOf("id" to routineId.json, "name" to Json.of("Original"), "position" to Json.of(0), "revision" to Json.of(1),
            "entries" to Json.array(Json.objectOf("position" to Json.of(1), "exerciseId" to squat.json)), "extension" to Json.array(Json.Null, Json.of(true)))
        val receipt = row(RoutineCreation, id.record, mapOf("snapshot" to snapshot))
        assertNull(receipt.life)
        assertFalse(EntityFacts(RoutineCreation).isRemovable)
        assertFalse(GymRules.book.entity(RoutineCreation.type) is WritableType<*>)
        for (stored in listOf(listOf(receipt), listOf(receipt, row(routine, visible = false)))) {
            val repository = reader(stored).repository(RoutineCreation)
            assertEquals(RoutineCreation(id, snapshot), repository.find(id, ViewMode.stored))
            assertEquals(listOf(RoutineCreation(id, snapshot)), repository.all(ViewMode.drawn))
        }
        assertEquals("snapshot", assertThrows(DecodeError::class.java) { RoutineCreation.decode(Fields(receipt.copy(values = emptyMap()))) }.field)
    }

    @Test fun everyPublicGymReplicaCommandAppliesSpecsPinnedByRuleBook() {
        val public = setOf(Gym.Commands.start, Gym.Commands.importSession, Gym.Commands.correctSession, Gym.Commands.finish,
            Gym.Commands.applyProposal, Gym.Commands.dismissProposal)
        val registered = SyncSchema.registry.commands.filter { it.member("name").str().startsWith("gym.") &&
            it.member("origins").arr().any { origin -> origin == Json.of("replica") } }.map { it.member("name").str() }.toSet()
        assertEquals(public, registered)
        for (name in public) RegistryCheck.command(GymCommand(name, emptyMap()), GymRules.book)
    }

    @Test fun everyProductRefusalCodeMapsOnPredictionAndNoticePathsWithFullDetails() {
        for (path in Refused.Path.entries) {
            val subject = sessionId.ref
            for ((code, make) in listOf<Pair<String, (Refused) -> GymRefusal>>(
                Gym.Codes.sessionFinished to { GymRefusal.SessionFinished(it) }, Gym.Codes.sessionOpen to { GymRefusal.SessionOpen(it) },
                Gym.Codes.sessionOverlap to { GymRefusal.SessionOverlap(it) }, Gym.Codes.payloadConflict to { GymRefusal.PayloadConflict(it) },
                Gym.Codes.unknownExercise to { GymRefusal.UnknownExercise(it) }, Gym.Codes.badInstant to { GymRefusal.BadInstant(it) },
                Gym.Codes.proposalSettled to { GymRefusal.ProposalSettled(it) }, Gym.Codes.proposalSuperseded to { GymRefusal.ProposalSuperseded(it) })) {
                val refused = Refused(RefusalCode(code), subject, Json.objectOf("reason" to Json.of("stored-detail")), path)
                assertEquals(make(refused), GymRefusal.of(refused))
            }
            for (code in listOf("unknown-record", "record-dead")) assertEquals(GymRefusal.Gone(subject, path), GymRefusal.of(Refused(RefusalCode(code), subject, path = path)))
            for (code in listOf("id-taken", "id-spent")) assertEquals(GymRefusal.Taken(subject, path), GymRefusal.of(Refused(RefusalCode(code), subject, path = path)))
            assertEquals(GymRefusal.Stale(subject, path), GymRefusal.of(Refused(RefusalCode.stale, subject, path = path)))
            assertEquals(GymRefusal.Full(Note.type, 10, path), GymRefusal.of(Refused(RefusalCode.cap, subject,
                Json.objectOf("type" to Json.of(Note.type), "cap" to Json.of(10)), path)))
            val weighin = WeighIn(testMoment.today).id.ref
            assertEquals(GymRefusal.Future(weighin, path), GymRefusal.of(Refused(RefusalCode(Gym.Codes.badInstant), weighin, path = path)))
            val unknown = Refused(RefusalCode("future-code"), subject, Json.of("detail"), path)
            assertEquals(GymRefusal.Other(unknown), GymRefusal.of(unknown))
        }
        assertEquals(GymRules.book.rules.size, GymRules.book.rules.map { it.name }.distinct().size)
        for (rule in GymRules.book.rules) for (code in rule.codes) for (path in Refused.Path.entries) {
            val detail = if (code == RefusalCode.cap) Json.objectOf("type" to Json.of(rule.subject), "cap" to Json.of(10)) else null
            assertFalse("${rule.name} / $code / $path", GymRefusal.isGeneric(GymRefusal.of(Refused(code, sessionId.ref.copy(type = rule.subject), detail, path))))
        }
    }

    @Test fun noteDraftGuardsOnlyEditedFieldsAndDeletionAndReorderAreHeldAndOrdered() {
        val first = Note(Id("note0001", Note), "First", "Body")
        val second = Note(Id("note0002", Note), "Second", "Body")
        val rows = listOf(row(first).copy(values = first.fields() + ("ord" to Json.of("A"))), row(second).copy(values = second.fields() + ("ord" to Json.of("B"))))
        val read = reader(rows)
        val action = SaveDraft.fromDraft(Draft.opening(first).edit { it.copy(body = "  New  ") }, Note, GymRefusal)
        val edit = writing(decide(action, read)).plan.gesture(Note.scope, SyncSchema.registry)
        assertEquals(listOf(Change.update(Note.type, first.id.record, mapOf("body" to Json.of("New")))), edit.changes)
        assertEquals(listOf(RegisterRef(Note.type, first.id.record, "body")), edit.guards)
        assertEquals(Decision.Refuse(GymRefusal.Stale(first.id.ref, Refused.Path.predicted)), decide(action, reader(listOf(row(first.copy(body = "Changed"))))))
        val move = writing(decide(moveNote(second.id, null), read)).plan.gesture(Note.scope, SyncSchema.registry)
        assertEquals(listOf(Change.move(Note.type, second.id.record, works.windmill.sync.api.OrderAnchor("ord", null))), move.changes)
        assertEquals(Decision.Unchanged(Unit), decide(moveNote(second.id, first.id), read))
        assertEquals(0, Note.position(first.id, listOf(first, second)))
        assertEquals(1, Note.position(second.id, listOf(first, second)))
        assertEquals(listOf(0, 1), listOf(second, first).map { Note.position(it.id, listOf(second, first)) })
        assertNull(Note.position(Id("note0003", Note), listOf(first, second)))
        val held = reader(listOf(row(first, held = true), row(second)), listOf(row(second)))
        assertEquals(1, Note.position(second.id, held.repository(Note).all(ViewMode.stored)))
        assertEquals(0, Note.position(second.id, held.repository(Note).all(ViewMode.drawn)))
        val deleted = writing(decide(deleteNote(first.id), read)).plan.gesture(Note.scope, SyncSchema.registry)
        assertEquals(listOf(Change.delete(Note.type, first.id.record)), deleted.changes)
        assertTrue(deleted.hold)
    }

    @Test fun coachNoteSaveDedupePrecedesCapacityAndUsesStoredFactsEvenWhenHeld() {
        val existing = (1..10).map { Note(Id("note" + it.toString().padStart(4, '0'), Note), "Title $it", "Body") }
        val rows = existing.map { row(it) }
        val same = existing.first().copy(id = Id("note9999", Note), title = "  Title 1  ")
        assertEquals(Decision.Unchanged(existing.first().id), decide(SaveNoteCall(same), reader(rows, rows.drop(1))))
        val extra = Note(Id("note9999", Note), "Extra", "Body")
        assertEquals(Decision.Refuse(GymRefusal.Full(Note.type, 10, Refused.Path.predicted)), decide(SaveNoteCall(extra), reader(rows, rows.drop(1))))
        assertEquals(Decision.Unchanged(existing.first().id), decide(SaveNoteCall(existing.first()), reader(rows)))
        val dead = row(existing.first(), visible = false)
        assertTrue(decide(SaveNoteCall(existing.first()), reader(listOf(dead))) is Decision.Write)
    }

    @Test fun weighInWritesOneWholeFactWithCommitMomentAndHeldDeletion() {
        val value = WeighIn(testMoment.today, 80.125, Instant(1))
        val result = writing(decide(saveWeighIn(value))).plan.gesture(WeighIn.scope, SyncSchema.registry)
        assertEquals(listOf(Change.put(WeighIn.type, value.id.record, true, value.copy(kg = 80.13, recordedAt = testMoment.now).fields())), result.changes)
        assertTrue(result.guards.isEmpty())
        val deletion = writing(decide(deleteWeighIn(value.id), reader(listOf(row(value))))).plan.gesture(WeighIn.scope, SyncSchema.registry)
        assertEquals(listOf(Change.put(WeighIn.type, value.id.record, false)), deletion.changes)
        assertTrue(deletion.hold)
        assertEquals(Decision.Unchanged(Unit), decide(deleteWeighIn(value.id), reader(listOf(row(value, visible = false)))))
    }

    @Test fun bodyweightUsesStoredStanceDrawnDotsLocalDaysAndExactChartGapBoundaries() {
        val today = testMoment.today
        val facts = listOf(WeighIn(today.adding(-90), 70.0), WeighIn(today.adding(-89), 71.0),
            WeighIn(today.adding(-82), 72.0), WeighIn(today.adding(-74), 73.0), WeighIn(today.adding(1), 99.0))
        val holding = Bodyweight(reader(facts.map { row(it) }, facts.dropLast(1).drop(1).map { row(it) }))
        val dots = facts.dropLast(1).drop(1).map { Bodyweight.Entry(it.day!!, it.kg!!) }
        assertEquals(Bodyweight.Stance.holding, holding.stance)
        assertEquals(Bodyweight.Reading(dots.last(), 74), holding.reading)
        assertEquals(Bodyweight.Chart(Bodyweight.Window.recent, dots, listOf(Bodyweight.Gap(today.adding(-82), today.adding(-74)))), holding.chart(Bodyweight.Window.recent))
        assertEquals(listOf(dots[1]), holding.entries(today.adding(-82), today.adding(-82)))
        assertEquals(Bodyweight.Stance.unknown, Bodyweight(reader(pulled = false)).stance)
        assertEquals(Bodyweight.Stance.empty, Bodyweight(reader()).stance)
        val pendingOnly = Bodyweight(reader(drawn = listOf(row(WeighIn(today, 80.0), pending = true)), pulled = false))
        assertEquals(Bodyweight.Stance.unknown, pendingOnly.stance)
        assertEquals(Bodyweight.Reading(Bodyweight.Entry(today, 80.0), 0), pendingOnly.reading)
        val futureHidden = Bodyweight(reader(drawn = facts.map { row(it) }))
        assertEquals(facts.dropLast(1).map { Bodyweight.Entry(it.day!!, it.kg!!) }, futureHidden.chart(Bodyweight.Window.all).dots)
    }
}
