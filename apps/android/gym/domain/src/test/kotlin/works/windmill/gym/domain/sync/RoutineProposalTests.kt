package works.windmill.gym.domain.sync

import org.junit.Assert.*
import org.junit.Test
import works.windmill.domain.kit.*
import works.windmill.sync.api.Change
import works.windmill.sync.api.RegisterRef
import works.windmill.sync.core.Json
import works.windmill.sync.core.MeasureUnit
import works.windmill.sync.core.RefusalCode
import works.windmill.sync.schema.Gym
import works.windmill.sync.schema.SyncSchema

class RoutineProposalTests {
    val proposal = Proposal(proposalId, routineId, "revise", "Lower B", "More load",
        listOf(RoutineChange("retargeted", squat, EntryTargets(entry), EntryTargets(listOf(SetTarget(5, 82.5)), 120))))

    @Test fun targetAbsencesRoundTripWithoutInventingZerosAndOpenLineRetainsRest() {
        val targets = listOf(SetTarget(), SetTarget(5), SetTarget(weightKg = -20.125), SetTarget(100, 500.0))
        val normalized = listOf(SetTarget(), SetTarget(5), SetTarget(weightKg = -20.13), SetTarget(100, 500.0))
        val open = RoutineEntry(squat, restSeconds = 120)
        assertTrue(open.isOpen)
        assertEquals(Json.objectOf("exerciseId" to squat.json, "restSeconds" to Json.of(120)), open.json)
        assertEquals(open, RoutineEntry.decode(Fields(open.json)).validated(Path("entries.0")))
        val scheme = open.copy(sets = targets)
        assertFalse(scheme.isOpen)
        assertEquals(scheme.copy(sets = normalized), scheme.validated(Path("entries.0")))
        assertEquals(scheme, RoutineEntry.decode(Fields(scheme.json)))
        assertEquals(Json.Obj(emptyList()), targets.first().json)
    }

    @Test fun routineChecksNameThenPositionThenEntryAndTargetBounds() {
        invalid(decide(saveRoutine(routine.copy(name = "\u00a0\n", entries = emptyList()))), "routine.name", "name", Violation.Reason.Blank)
        val normalized = writing(decide(saveRoutine(routine.copy(name = "  Cafe\u0301  ")))).plan.operations.single().values
        assertEquals(Json.of("Café"), normalized["name"])
        for (name in listOf("😀".repeat(60), "x".repeat(60))) assertEquals(name, Valid(routine.copy(name = name), Routine, at = testMoment).value.name)
        invalid(decide(saveRoutine(routine.copy(name = "😀".repeat(61)))), "routine.name", "name", Violation.Reason.TooLong(60, MeasureUnit.chars, 61))
        invalid(decide(saveRoutine(routine.copy(position = -1))), "routine.position", "position", Violation.Reason.Below(0.0))
        assertEquals(Int.MAX_VALUE, Valid(routine.copy(position = Int.MAX_VALUE), Routine, at = testMoment).value.position)
        for ((count, reason) in listOf(0 to Violation.Reason.TooFew(1), 51 to Violation.Reason.TooMany(50)))
            invalid(decide(saveRoutine(routine.copy(entries = List(count) { entry }))), "routine.entries", "entries", reason)
        assertEquals(50, Valid(routine.copy(entries = List(50) { entry }), Routine, at = testMoment).value.entries.size)
        for ((count, reason) in listOf(0 to Violation.Reason.TooFew(1), 21 to Violation.Reason.TooMany(20)))
            invalid(decide(saveRoutine(routine.copy(entries = listOf(entry.copy(sets = List(count) { SetTarget() }))))),
                "routine.entries.sets", "entries.0.sets", reason)
        assertEquals(20, Valid(routine.copy(entries = listOf(entry.copy(sets = List(20) { SetTarget() }))), Routine, at = testMoment).value.entries.single().sets!!.size)
    }

    @Test fun targetsRefuseZerosAndGiveFirstRowRepsBeforeWeight() {
        for (target in listOf(SetTarget(0, 600.0), SetTarget(5, 0.0), SetTarget(5, 0.001))) {
            val path = if (target.reps == 0) "reps" else "weightKg"
            invalidValue("routine.zeroTarget", "sets.0.$path", Violation.Reason.Custom("zeroTarget")) { target.validated(Path("sets.0")) }
        }
        for ((target, path, reason) in listOf(
            Triple(SetTarget(-1, 600.0), "reps", Violation.Reason.Below(1.0)),
            Triple(SetTarget(101, 600.0), "reps", Violation.Reason.Above(100.0)),
            Triple(SetTarget(5, -501.0), "weightKg", Violation.Reason.Below(-500.0)),
            Triple(SetTarget(5, 501.0), "weightKg", Violation.Reason.Above(500.0)),
            Triple(SetTarget(5, Double.NaN), "weightKg", Violation.Reason.NotANumber)))
            invalidValue("routine.entries.sets.$path", "sets.0.$path", reason) { target.validated(Path("sets.0")) }
        for (rest in listOf(15, 900)) assertEquals(rest, entry.copy(restSeconds = rest).validated(Path("entries.0")).restSeconds)
        for ((rest, reason) in listOf(14 to Violation.Reason.Below(15.0), 901 to Violation.Reason.Above(900.0)))
            invalidValue("routine.entries.restSeconds", "entries.0.restSeconds", reason) { entry.copy(restSeconds = rest).validated(Path("entries.0")) }
    }

    @Test fun nestedExerciseIdentitiesCannotStoreNulAndProposalTargetsCannotStoreZero() {
        val id = Id("back\u0000squat", Exercise)
        invalidValue("routine.entries.exerciseId", "entries.0.exerciseId", Violation.Reason.Nul) {
            entry.copy(exerciseId = id).validated(Path("entries.0"))
        }
        invalidValue("proposal.changes.exerciseId", "changes.0.exerciseId", Violation.Reason.Nul) {
            proposal.changes.single().copy(exerciseId = id).validated(Path("changes.0"))
        }
        for (side in listOf("before", "after")) for (target in listOf(SetTarget(0, 80.0), SetTarget(5, 0.001))) {
            val fields = EntryTargets(listOf(target))
            val changed = proposal.changes.single().let { if (side == "before") it.copy(before = fields) else it.copy(after = fields) }
            val field = if (target.reps == 0) "reps" else "weightKg"
            invalidValue("proposal.zeroTarget", "changes.0.$side.sets.0.$field", Violation.Reason.Custom("zeroTarget")) {
                Valid(proposal.copy(changes = listOf(changed)), Proposal, at = testMoment)
            }
        }
    }

    @Test fun routineDraftWritesGuardedTouchedFieldsAndPredictsStaleBase() {
        val draft = Draft.opening(routine).edit { it.copy(name = "Lower B") }
        val save = SaveDraft.fromDraft(draft, Routine, GymRefusal)
        val written = writing(decide(save, reader(listOf(row(routine))))).plan.gesture(Routine.scope, SyncSchema.registry)
        assertEquals(listOf(Change.update(Routine.type, routineId.record, mapOf("name" to Json.of("Lower B")))), written.changes)
        assertEquals(listOf(RegisterRef(Routine.type, routineId.record, "name")), written.guards)
        assertEquals(Decision.Refuse(GymRefusal.Stale(routineId.ref, Refused.Path.predicted)), decide(save, reader(listOf(row(routine.copy(name = "Other"))))))
        assertEquals(Decision.Refuse(GymRefusal.Gone(routineId.ref, Refused.Path.predicted)), decide(save, reader(listOf(row(routine, visible = false)))))
        val unchanged = decide(SaveDraft.fromDraft(Draft.opening(routine), Routine, GymRefusal), reader(listOf(row(routine)))) as Decision.Unchanged
        assertEquals(emptyMap<String, Json>(), unchanged.result.values)
        assertTrue(unchanged.result.exists)
    }

    @Test fun reorderRequiresCompletePermutationAndWritesOnlyPositions() {
        val second = routine.copy(id = Id("routine2", Routine), position = 1)
        val read = reader(listOf(row(routine), row(second)))
        assertEquals(Decision.Unchanged(Unit), decide(ReorderRoutines(listOf(routineId, second.id)), read))
        val reordered = writing(decide(ReorderRoutines(listOf(second.id, routineId)), read)).plan.gesture(Routine.scope, SyncSchema.registry)
        assertEquals(listOf(Change.update(Routine.type, second.id.record, mapOf("position" to Json.of(0))),
            Change.update(Routine.type, routineId.record, mapOf("position" to Json.of(1)))), reordered.changes)
        assertTrue(reordered.atomic)
        assertTrue(reordered.guards.isEmpty())
        for (order in listOf(listOf(routineId), listOf(routineId, routineId), listOf(routineId, Id("routine3", Routine))))
            invalid(decide(ReorderRoutines(order), read), "routine.order", "order", Violation.Reason.Custom("notPermutation"))
        val deleted = writing(decide(deleteRoutine(routineId), read)).plan.gesture(Routine.scope, SyncSchema.registry)
        assertEquals(listOf(Change.delete(Routine.type, routineId.record)), deleted.changes)
        assertTrue(deleted.hold)
    }

    @Test fun snapshotsKeepPerSetShapeAndHistoricalRoutineName() {
        val varied = routine.copy(entries = listOf(entry.copy(sets = listOf(SetTarget(5, 60.0), SetTarget(5, 80.0), SetTarget(3, 90.0), SetTarget(1, 100.0), SetTarget(5, 80.0))),
            RoutineEntry(bench)))
        val snapshot = PlanSnapshot(varied)
        assertEquals(snapshot, PlanSnapshot.decode(snapshot.json))
        assertNull(PlanSnapshot.decode(Json.Null))
        assertEquals("Lower A", Session(sessionId, testMoment.now, plan = snapshot).name)
        assertEquals("New name", Session(sessionId, testMoment.now, plan = snapshot, displayName = "New name").name)
        assertEquals(snapshot, Session.decode(Fields(row(Session(sessionId, testMoment.now, routineId = null, historyRoutineId = routineId, plan = snapshot)))).plan)
    }

    @Test fun proposalDiffMatchesFirstUnmatchedDuplicateAndPutsRemovalsLast() {
        val other = entry.copy(sets = listOf(SetTarget(8, 60.0)))
        val base = listOf(entry, RoutineEntry(bench), other)
        val changed = other.copy(sets = listOf(SetTarget(8, 62.5)))
        val added = RoutineEntry(Id("dip", Exercise))
        assertEquals(listOf(RoutineChange("kept", squat, EntryTargets(entry), EntryTargets(entry)),
            RoutineChange("retargeted", squat, EntryTargets(other), EntryTargets(changed)),
            RoutineChange("added", added.exerciseId, after = EntryTargets(added)),
            RoutineChange("removed", bench, before = EntryTargets(base[1]))), ProposalRules.changesBetween(base, listOf(entry, changed, added)))
        assertEquals(listOf(entry), proposal.copy(changes = listOf(RoutineChange("kept", squat, EntryTargets(entry), EntryTargets(entry)),
            RoutineChange("removed", bench, before = EntryTargets()))).document)
    }

    @Test fun proposalChangeCountIncludesRenameRetargetRemovalAndMovementOrder() {
        val base = routine.copy(entries = listOf(entry, RoutineEntry(bench)))
        val kept = ProposalRules.changesBetween(base.entries, base.entries)
        assertEquals(0, proposal.copy(proposedName = base.name, changes = kept).changeCount(base))
        assertEquals(1, proposal.copy(proposedName = "Renamed", changes = kept).changeCount(base))
        assertEquals(1, proposal.copy(proposedName = base.name, changes = ProposalRules.changesBetween(base.entries,
            listOf(entry.copy(sets = listOf(SetTarget(5, 82.5))), base.entries[1]))).changeCount(base))
        assertEquals(1, proposal.copy(proposedName = base.name, changes = ProposalRules.changesBetween(base.entries, base.entries.reversed())).changeCount(base))
        assertEquals(1, proposal.copy(proposedName = base.name, changes = ProposalRules.changesBetween(base.entries, listOf(entry))).changeCount(base))
    }

    @Test fun proposalCreateUsesStoredBaseAndGuardsBothRegisters() {
        val drawn = routine.copy(name = "Local edit")
        val action = ProposeRoutine(proposalId, routineId, "Lower B", proposal.document, "  More load  ")
        val result = writing(decide(action, reader(listOf(row(routine)), listOf(row(drawn)))))
        val gesture = result.plan.gesture(Proposal.scope, SyncSchema.registry)
        assertEquals(proposalId, result.result)
        assertEquals(listOf(Change.create(Proposal.type, works.windmill.sync.api.NewID.Given(proposalId.record), proposal.fields())), gesture.changes)
        assertEquals(listOf(RegisterRef(Routine.type, routineId.record, "entries"), RegisterRef(Routine.type, routineId.record, "name")), gesture.guards)
        assertEquals(Decision.Unchanged(proposalId), decide(ProposeRoutine(proposalId, routineId, routine.name, routine.entries, "summary"), reader(listOf(row(routine)))))
        assertEquals(Decision.Refuse(GymRefusal.Gone(routineId.ref, Refused.Path.predicted)), decide(action))
        assertTrue((decide(ProposeRoutine(proposalId, routineId, "Lower B", listOf(RoutineEntry(Id("not-owned", Exercise))), "summary"), reader(listOf(row(routine)))) as Decision.Refuse).refusal is GymRefusal.UnknownExercise)
        val remove = writing(decide(ProposeRoutine(proposalId, routineId, "", emptyList(), "Remove", removing = true), reader(listOf(row(routine)))))
        val created = Proposal.decode(Fields(Proposal.type, proposalId.record, remove.plan.operations.first().values))
        assertEquals("remove", created.intent)
        assertEquals("", created.proposedName)
        assertEquals(listOf(RoutineChange("removed", squat, before = EntryTargets(entry))), created.changes)
    }

    @Test fun proposalValidatesReplicaDoorSidesRemovalOrderAndBothTargetDomains() {
        for ((value, field, reason) in listOf(
            Triple(proposal.copy(intent = "edit"), "intent", Violation.Reason.NotOneOf),
            Triple(proposal.copy(door = "mcp"), "door", Violation.Reason.NotOneOf),
            Triple(proposal.copy(connection = "conn"), "connection", Violation.Reason.TooLong(0, MeasureUnit.bytes, 4)),
            Triple(proposal.copy(agent = "agent"), "agent", Violation.Reason.TooLong(0, MeasureUnit.chars, 5)),
            Triple(proposal.copy(summary = "é".repeat(201)), "summary", Violation.Reason.TooLong(400, MeasureUnit.bytes, 402)),
            Triple(proposal.copy(proposedName = "é".repeat(121)), "proposedName", Violation.Reason.TooLong(240, MeasureUnit.bytes, 242))))
            invalidValue("proposal.$field", field, reason) { Valid(value, Proposal, at = testMoment) }
        invalidValue("proposal.changes", "changes.0", Violation.Reason.Custom("side")) {
            Valid(proposal.copy(changes = listOf(RoutineChange("added", squat, EntryTargets(), EntryTargets()))), Proposal, at = testMoment)
        }
        invalidValue("proposal.changes", "changes", Violation.Reason.Custom("removalsLast")) {
            Valid(proposal.copy(changes = listOf(RoutineChange("removed", squat, before = EntryTargets()), RoutineChange("added", squat, after = EntryTargets()))), Proposal, at = testMoment)
        }
        for (side in listOf("before", "after")) {
            val malformed = EntryTargets(listOf(SetTarget(101, 80.0)))
            val change = proposal.changes.single().let { if (side == "before") it.copy(before = malformed) else it.copy(after = malformed) }
            invalidValue("proposal.changes.$side.sets.reps", "changes.0.$side.sets.0.reps", Violation.Reason.Above(100.0)) {
                Valid(proposal.copy(changes = listOf(change)), Proposal, at = testMoment)
            }
            for ((targets, suffix, reason) in listOf(
                Triple(EntryTargets(emptyList()), "sets", Violation.Reason.TooFew(1)),
                Triple(EntryTargets(List(21) { SetTarget() }), "sets", Violation.Reason.TooMany(20)),
                Triple(EntryTargets(listOf(SetTarget(5, 501.0))), "sets.0.weightKg", Violation.Reason.Above(500.0)),
                Triple(EntryTargets(restSeconds = 14), "restSeconds", Violation.Reason.Below(15.0)),
                Triple(EntryTargets(restSeconds = 901), "restSeconds", Violation.Reason.Above(900.0)))) {
                val changeWithTargets = proposal.changes.single().let { if (side == "before") it.copy(before = targets) else it.copy(after = targets) }
                val specSuffix = suffix.replace(".0", "")
                invalidValue("proposal.changes.$side.$specSuffix", "changes.0.$side.$suffix", reason) {
                    Valid(proposal.copy(changes = listOf(changeWithTargets)), Proposal, at = testMoment)
                }
            }
        }
        invalidValue("proposal.changes", "changes", Violation.Reason.TooMany(100)) {
            Valid(proposal.copy(changes = List(101) { proposal.changes.single() }), Proposal, at = testMoment)
        }
        invalidValue("proposal.changes.kind", "changes.0.kind", Violation.Reason.NotOneOf) {
            Valid(proposal.copy(changes = listOf(proposal.changes.single().copy(kind = "changed"))), Proposal, at = testMoment)
        }
    }

    @Test fun applyAndDismissUseStoredStateWithCompletePredictions() {
        val read = reader(listOf(row(routine), proposalRow(proposal)), listOf(row(routine.copy(name = "Local")), proposalRow(proposal.copy(state = "dismissed"))))
        val apply = writing(decide(ApplyProposal(proposalId), read)).plan
        assertEquals(Gym.Commands.applyProposal, apply.command!!.name)
        assertEquals(Json.objectOf("proposalId" to proposalId.json), apply.command!!.args)
        assertEquals(listOf(Prediction.update(Proposal, proposalId, mapOf("state" to Json.of("applied"), "settledAt" to Json.of(testMoment.now.ms))),
            Prediction.update(Routine, routineId, mapOf("name" to Json.of("Lower B"), "entries" to Json.Arr(proposal.document.map { it.json })))), apply.predictions)
        val dismiss = writing(decide(DismissProposal(proposalId), read)).plan
        assertEquals(Gym.Commands.dismissProposal, dismiss.command!!.name)
        assertEquals(listOf(Prediction.update(Proposal, proposalId, mapOf("state" to Json.of("dismissed"), "settledAt" to Json.of(testMoment.now.ms)))), dismiss.predictions)
        val removal = writing(decide(ApplyProposal(proposalId), reader(listOf(row(routine), proposalRow(proposal.copy(intent = "remove", proposedName = "", changes = listOf(RoutineChange("removed", squat, before = EntryTargets(entry))))))))).plan
        assertEquals(Prediction.remove(Routine, routineId), removal.predictions.last())
        assertEquals(Change.delete(Routine.type, routineId.record), removal.gesture(Routine.scope, SyncSchema.registry).predict.last())
        assertFalse(removal.isHeld)
    }

    @Test fun settledAndSupersededProposalRefusalsRetainStateDetailsAndPaths() {
        assertEquals(Decision.Unchanged(Unit), decide(ApplyProposal(proposalId), reader(listOf(proposalRow(proposal.copy(state = "applied"))))))
        assertEquals(Decision.Unchanged(Unit), decide(DismissProposal(proposalId), reader(listOf(proposalRow(proposal.copy(state = "dismissed"))))))
        for ((state, applying) in listOf("dismissed" to true, "applied" to false)) {
            val action = if (applying) ApplyProposal(proposalId) else DismissProposal(proposalId)
            val refused = Refused(RefusalCode(Gym.Codes.proposalSettled), proposalId.ref, Json.objectOf("state" to Json.of(state)), Refused.Path.predicted)
            assertEquals(Decision.Refuse(GymRefusal.ProposalSettled(refused)), decide(action, reader(listOf(proposalRow(proposal.copy(state = state))))))
        }
        val replaced = reader(listOf(row(routine), proposalRow(proposal.copy(state = "superseded", supersededBy = Id("proposal2", Proposal)))))
        val refusal = Refused(RefusalCode(Gym.Codes.proposalSuperseded), proposalId.ref, Json.objectOf("reason" to Json.of("replaced")), Refused.Path.predicted)
        assertEquals(Decision.Refuse(GymRefusal.ProposalSuperseded(refusal)), decide(ApplyProposal(proposalId), replaced))
        assertEquals(Decision.Refuse(GymRefusal.ProposalSuperseded(refusal)), decide(DismissProposal(proposalId), replaced))
        val ambiguous = proposalRow(proposal.copy(state = "superseded"))
        for (read in listOf(reader(listOf(row(routine), ambiguous)), reader(listOf(ambiguous)))) {
            for ((action, command) in listOf(ApplyProposal(proposalId) to Gym.Commands.applyProposal, DismissProposal(proposalId) to Gym.Commands.dismissProposal)) {
                val plan = writing(decide(action, read)).plan
                assertEquals(command, plan.command!!.name)
                assertEquals(Json.objectOf("proposalId" to proposalId.json), plan.command!!.args)
                assertEquals(emptyList<Prediction>(), plan.predictions)
                assertEquals(emptyList<Operation>(), plan.operations)
            }
        }
        val notice = Refused(RefusalCode(Gym.Codes.proposalSuperseded), proposalId.ref, Json.objectOf("reason" to Json.of("routine-changed")), Refused.Path.notice)
        assertEquals(GymRefusal.ProposalSuperseded(notice), GymRefusal.of(notice))
        assertEquals(Decision.Refuse(GymRefusal.Gone(proposalId.ref, Refused.Path.predicted)), decide(ApplyProposal(proposalId)))
        assertEquals(Decision.Refuse(GymRefusal.Gone(routineId.ref, Refused.Path.predicted)), decide(ApplyProposal(proposalId), reader(listOf(proposalRow(proposal)))))
    }
}
