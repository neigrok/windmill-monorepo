#!/usr/bin/env python3
# A reference of Journal Talk's pure parts, from docs/foundation/journal-talk.md §5 and this folder's README.
# check.py requires it to give every output a story states by hand. It reads no expectation and writes no file.
import datetime
import hashlib

TAKE_MAX, OPEN_WAIT, BRIDGE_WAIT, BRIDGE_RETRY, END_WAIT, RESULT_POLL, RECOVER_FOR = 600000, 15000, 10000, 2000, 15000, 5000, 600000
FRAME, SAMPLES, PAUSE, MIN_TURN, SPEECH_MIN, MAX_BRIDGES, PAGE_MAX, DAY = 100, 2400, 7, 10, 10737, 3, 131072, 86400000
# ECMAScript's WhiteSpace and LineTerminator, as the journal corpus trims: U+0085 is content.
WHITESPACE = '\t\n\v\f\r                  　﻿'
# Deadlines of one instant take effect in this order: those that end a take or a session's reading, then the others.
DEADLINES = ['dayEnd', 'limit', 'openWait', 'bridgeWait', 'endWait', 'expiry', 'retry', 'poll']
ORDERS = ['microphone', 'close', 'open', 'read']
ENDS = {'end': 'person', 'background': 'background', 'microphoneTaken': 'microphone', 'captureFailed': 'capture'}


def utf8(text):
    return len(text.encode())


def utf16(text):
    return len(text.encode('utf-16-le')) // 2


def digest(text):
    return hashlib.sha256(text.encode()).hexdigest()[:16]


def holds_text(text):
    return text.strip(WHITESPACE) != ''


def joined(texts):
    return ' '.join(text for text in texts if holds_text(text))


def expand(items):
    return [value for item in items for value in ([item[0]] * item[1] if isinstance(item, list) else [item])]


def local_day(at, offset):
    return (datetime.date(1970, 1, 1) + datetime.timedelta(days=(at + offset * 1000) // DAY)).isoformat()


def day_end(at, offset):
    return ((at + offset * 1000) // DAY + 1) * DAY - offset * 1000


def energy(samples):
    return sum(sample * sample for sample in samples) // SAMPLES


# §5.2, one session's counters.
class PauseRule:
    def __init__(self):
        self.blocks, self.block, self.speech, self.quiet = [], [], 0, 0

    def commits_after(self, level):
        floor = min(self.blocks[-10:], default=0)
        self.block.append(level)
        if len(self.block) == 10:
            self.blocks.append(sum(self.block) // 10)
            self.block = []
        if level >= 10 * floor and level >= SPEECH_MIN:
            self.speech, self.quiet = self.speech + 1, 0
        else:
            self.quiet += 1
        if self.quiet < PAUSE or self.speech < MIN_TURN:
            return False
        self.speech = self.quiet = 0
        return True


def commits(energies):
    rule = PauseRule()
    return [number for number, level in enumerate(energies, 1) if rule.commits_after(level)]


# The day's page and the mark as the device holds them, written as SaveSpoken writes them.
class Store:
    def __init__(self, page, mark):
        self.page, self.mark = page, mark

    def text(self):
        return self.page['body'] if self.page else ''

    def save(self, body, source, mark, while_page=None):
        if while_page is not None and digest(self.text()) != while_page:
            return False
        if body is not None:
            self.page = {'body': body, 'source': source} if holds_text(body) else None
        self.mark = mark
        return True


# §5.5 step 5: the sessions whose results are still to come, and when each is read again.
class Reading:
    def __init__(self):
        self.calls, self.polls, self.gone = [], {}, set()

    def stop(self, call):
        self.calls.remove(call)
        self.polls.pop(call, None)

    def answer(self, at, call, answer):
        if 'message' in answer:
            self.stop(call)
            return 'text'
        again = answer.get('unread') or answer['code'] == 'conflict' or (answer['code'] == 'result_gone' and call not in self.gone)
        if not again:
            self.stop(call)
            return 'kept'
        if answer.get('code') == 'result_gone':
            self.gone.add(call)
        self.polls[call] = at + RESULT_POLL
        return 'again'


class Session:
    def __init__(self, call, at):
        self.call, self.heard, self.door, self.started, self.last, self.lost = call, at, True, False, None, False
        self.turns, self.rule, self.commits, self.saved, self.answered, self.arrived = {}, PauseRule(), 0, '', False, False

    def words(self):
        if self.last is not None:
            return [(self.last, False)] if holds_text(self.last) else []
        return [(turn['text'], not turn['settled'] and not self.arrived) for _, turn in sorted(self.turns.items()) if holds_text(turn['text'])]

    def part(self):
        return joined(text for text, unsettled in self.words() if not unsettled)


class Take:
    def __init__(self, store, offset, calls):
        self.store, self.offset, self.calls = store, offset, calls
        self.phase, self.sessions, self.reading, self.do, self.send = None, [], Reading(), [], []
        self.frames, self.kept, self.microphone, self.end_owed = 0, [], False, False
        self.cause, self.code, self.bridges, self.full, self.wrote, self.undone = None, None, 0, False, False, False
        self.bridge_ends = self.retry_at = self.end_sent = self.refusal = None

    def press(self, at):
        self.pressed, self.day, self.day_ends = at, local_day(at, self.offset), day_end(at, self.offset)
        self.given, self.before, self.view = self.store.page, self.store.text(), self.store.page
        self.head, self.written = self.before.rstrip(WHITESPACE), self.before
        if at >= self.day_ends - END_WAIT:
            return self.stop('dayEnd')
        if self.head and utf8(self.head) + 3 > PAGE_MAX:
            return self.stop('pageFull')
        self.open_session(at)
        self.store.save(None, None, self.mark())
        self.phase = 'connecting'

    def because(self, cause, code=None):
        if self.cause is None:
            self.cause, self.code = cause, code

    def stop(self, cause, code=None):
        self.because(cause, code)
        self.phase = 'ended'

    def open_session(self, at):
        self.current = Session(self.calls.pop(0), at)
        self.sessions.append(self.current)
        self.do.append({'open': self.current.call})

    def mark(self):
        return {'day': self.day, 'bytesBefore': utf8(self.head), 'pageDigest': digest(self.written),
                'sessions': [{'callId': session.call, 'bytesSaved': utf8(session.saved), 'heardAt': session.heard} for session in self.sessions]}

    def parts(self):
        return [session.saved if self.full and session.last is None else session.part() for session in self.sessions]

    # The page a save would write now: the passage after the page's text, the page as it was once a passage that was
    # saved holds no text, and nothing while no passage has been saved.
    def page(self):
        passage = joined(self.parts())
        if passage:
            return (self.head + '\n\n' if self.head else '') + passage, 'spoken'
        if self.wrote:
            return self.before, self.given['source'] if self.given else 'typed'
        return None, None

    def save(self, clear=False):
        body, source = self.page()
        if body is not None and utf8(body) > PAGE_MAX:
            return False
        for session, part in zip(self.sessions, self.parts()):
            session.saved = part
        if body is not None:
            self.written, self.wrote = body, bool(joined(self.parts()))
        self.store.save(body, source, None if clear else self.mark())
        if body is not None:
            self.view = self.store.page
        return True

    def place(self, session, text):
        session.last, session.answered = text, True
        body, _ = self.page()
        if body is not None and utf8(body) > PAGE_MAX:
            session.last = session.saved

    def finish(self):
        if self.microphone:
            self.do.append({'microphone': 'closed'})
        for session in self.sessions:
            session.arrived = True
        self.phase, self.microphone, self.kept, self.end_owed, self.reading = 'ended', False, [], False, Reading()
        self.bridge_ends = self.retry_at = self.end_sent = None
        unanswered = any(not session.answered for session in self.sessions)
        if not self.save(clear=not unanswered):
            self.store.save(None, None, self.mark() if unanswered else None)

    def end(self, at, cause):
        if cause == 'background' and self.bridge_ends is not None:
            return self.leave_bridge()
        if self.phase in ('ending', 'ended'):
            return
        if self.phase == 'connecting':
            self.do.append({'close': self.current.call})
            self.store.save(None, None, None)
            return self.stop(cause)
        self.because(cause)
        self.do.append({'microphone': 'closed'})
        self.phase, self.microphone = 'ending', False
        if self.bridge_ends is None:
            return self.send_end(at)
        self.end_owed = True

    # INV-3: a bridge does not go on in the background. Its kept frames are dropped and its opening is closed.
    def leave_bridge(self):
        session = self.current
        if session.door:
            self.do.append({'close': session.call})
        session.lost, session.door = True, False
        self.because('background')
        self.finish()

    def send_end(self, at):
        self.send.append({'type': 'end'})
        self.end_sent, self.end_owed = at, False

    def frame(self, level):
        if not self.microphone:
            return
        self.frames += 1
        if self.phase == 'listening':
            return self.send_audio(self.frames, level)
        self.kept.append((self.frames, level))

    def send_audio(self, number, level):
        if self.send and self.send[-1].get('audio', [0, 0])[1] == number - 1:
            self.send[-1]['audio'][1] = number
        else:
            self.send.append({'audio': [number, number]})
        if self.current.rule.commits_after(level):
            self.send.append({'type': 'commit'})
            self.current.commits += 1

    def hears(self, call):
        session = self.current
        return self.phase != 'ended' and call == session.call and session.last is None and not session.lost

    def heard(self, at, call, message):
        session = self.current
        if not self.hears(call):
            return
        session.heard = at
        if message['type'] == 'started':
            return self.started(at, session)
        if message['type'] in ('text', 'turn'):
            return self.words(at, session, message)
        if not session.started:
            return self.refused(at, session, message['code'])
        self.place(session, message['text'])
        if message['code'] == 'provider_failed' and self.phase == 'listening':
            return self.bridge(at, written=True)
        if self.phase == 'listening':
            self.because('service', message['code'])
        self.code = message['code'] or self.code
        self.finish()

    def started(self, at, session):
        if session.started:
            return self.defect(session)
        session.started = True
        self.bridge_ends = self.retry_at = self.refusal = None
        if len(self.sessions) == 1:
            self.do.append({'microphone': 'open'})
            self.phase, self.microphone = 'listening', True
            return
        for number, level in self.kept:
            self.send_audio(number, level)
        self.kept = []
        if self.end_owed:
            return self.send_end(at)
        self.phase = 'listening'

    def words(self, at, session, message):
        turn = session.turns.setdefault(message['turn'], {'text': '', 'settled': False})
        if message['type'] == 'text' and not turn['settled']:
            turn['text'] += message['delta']
        if message['type'] == 'text' or self.full:
            return
        turn['text'], turn['settled'] = message['text'], True
        if self.save():
            return
        self.full = True
        self.end(at, 'pageFull')

    def refused(self, at, session, code):
        session.door = False
        if code != 'concurrency_exhausted' or len(self.sessions) == 1:
            return self.give_up(session, code)
        self.refusal = code
        self.retry_at = at + BRIDGE_RETRY if at + BRIDGE_RETRY < self.bridge_ends else None

    def give_up(self, session, code):
        if len(self.sessions) == 1:
            self.store.save(None, None, None)
            return self.stop('refused', code)
        session.answered = True
        self.because('bridge', code)
        self.finish()

    def unopened(self, call, code):
        session = self.current
        if self.phase == 'ended' or call != session.call or session.started:
            return
        session.door = False
        self.give_up(session, code)

    def defect(self, session):
        self.do.append({'close': session.call})
        if self.phase == 'connecting':
            self.store.save(None, None, None)
            return self.stop('defect')
        session.lost = True
        self.because('defect')
        self.finish()

    def unreadable(self, call):
        if self.hears(call):
            self.defect(self.current)

    def lost(self, at, call):
        session = self.current
        if not self.hears(call):
            return
        session.lost, session.door = True, False
        if self.phase == 'connecting':
            self.store.save(None, None, None)
            return self.stop('refused')
        if self.end_sent is not None:
            return self.finish()
        self.bridge(at, written=False)

    def bridge(self, at, written):
        lost = self.current
        if self.bridges == MAX_BRIDGES:
            self.because('bridge')
            return self.finish()
        self.bridges += 1
        self.open_session(at)
        if lost.lost:
            self.reading.calls.append(lost.call)
            self.do.append({'read': lost.call})
        if self.bridge_ends is None:
            self.bridge_ends = at + BRIDGE_WAIT
        self.retry_at = self.refusal = None
        self.phase = 'bridging' if self.phase == 'listening' else self.phase
        if not written or not self.save():
            self.store.save(None, None, self.mark())

    def result(self, at, answer):
        call = answer['callId']
        if self.phase == 'ended' or call not in self.reading.calls:
            return
        outcome = self.reading.answer(at, call, answer)
        if outcome == 'again':
            return
        session = next(session for session in self.sessions if session.call == call)
        session.answered = session.arrived = True
        if outcome == 'text':
            self.place(session, answer['message']['text'])
        self.save()

    def deadlines(self):
        if self.phase in (None, 'ended'):
            return []
        waits = [(at, 'poll', call) for call, at in self.reading.polls.items()]
        if self.phase != 'ending':
            waits += [(self.day_ends - END_WAIT, 'dayEnd', None), (self.pressed + TAKE_MAX, 'limit', None)]
        if self.phase == 'connecting':
            waits.append((self.pressed + OPEN_WAIT, 'openWait', None))
        if self.bridge_ends is not None:
            waits.append((self.bridge_ends, 'bridgeWait', None))
        if self.retry_at is not None:
            waits.append((self.retry_at, 'retry', None))
        if self.end_sent is not None:
            waits.append((min(self.end_sent + END_WAIT, self.day_ends - 1), 'endWait', None))
        return waits

    def fire(self, at, kind, call):
        session = self.current
        if kind in ('dayEnd', 'limit'):
            return self.end(at, kind)
        if kind == 'poll':
            del self.reading.polls[call]
            return self.do.append({'read': call})
        if kind == 'retry':
            self.retry_at = self.refusal = None
            session.door = True
            return self.do.append({'open': session.call})
        if session.door:
            self.do.append({'close': session.call})
        if kind == 'openWait':
            self.store.save(None, None, None)
            return self.stop('refused')
        if kind == 'bridgeWait':
            session.answered = True
            self.because('bridge', self.refusal)
        else:
            session.lost = True
        self.finish()

    def undo(self, guard):
        if self.phase != 'ended' or self.undone or not self.sessions:
            return False
        self.undone = True
        given = self.given or {'body': '', 'source': 'typed'}
        if not self.store.save(given['body'], given['source'], None, while_page=guard):
            return False
        self.view, self.written = self.given, self.before
        return True

    def shows(self):
        if self.phase == 'ended' or self.full:
            return {'text': self.view['body'] if self.view else '', 'unsettled': []}
        words = [word for session in self.sessions for word in session.words()]
        if not words:
            return {'text': self.before, 'unsettled': []}
        text, ranges = self.head + '\n\n' if self.head else '', []
        for index, (word, unsettled) in enumerate(words):
            text += ' ' if index else ''
            ranges += [[utf16(text), utf16(text + word)]] if unsettled else []
            text += word
        return {'text': text, 'unsettled': ranges}

    def ends(self):
        if self.phase != 'ended':
            return None
        last = self.sessions[-1] if self.sessions else None
        return {'cause': self.cause, 'code': self.code, 'heard': bool(last and last.started and last.answered and not last.lost),
                'turns': sum(holds_text(turn['text']) for session in self.sessions for turn in session.turns.values()),
                'commits': sum(session.commits for session in self.sessions), 'bridges': self.bridges}


class Recovery:
    def __init__(self, store, offset, at):
        self.store, self.offset, self.reading, self.do = store, offset, Reading(), []
        self.answered, self.outcome, self.written, self.phase = 0, None, None, 'recovering'
        mark = store.mark
        if mark is None or mark['day'] != local_day(at, offset) or not mark['sessions']:
            return self.drop()
        for session in mark['sessions']:
            if at < session['heardAt'] + RECOVER_FOR:
                self.reading.calls.append(session['callId'])
                self.do.append({'read': session['callId']})
        self.settle()

    def drop(self):
        self.store.save(None, None, None)
        self.end('dropped')

    def end(self, cause):
        self.phase, self.reading, self.outcome = 'recovered', Reading(), {'cause': cause, 'answered': self.answered}

    def settle(self):
        if self.phase == 'recovering' and not self.reading.calls:
            self.store.save(None, None, None)
            self.end('recovered')

    def check_day(self, at):
        if self.phase == 'recovering' and self.store.mark['day'] != local_day(at, self.offset):
            self.drop()

    def deadlines(self):
        if self.phase != 'recovering':
            return []
        heard = {session['callId']: session['heardAt'] for session in self.store.mark['sessions']}
        return [(at, 'poll', call) for call, at in self.reading.polls.items()] + [(heard[call] + RECOVER_FOR, 'expiry', call) for call in self.reading.calls]

    def fire(self, at, kind, call):
        if kind == 'poll':
            del self.reading.polls[call]
            return self.do.append({'read': call})
        self.reading.stop(call)
        self.settle()

    def result(self, at, answer):
        call = answer['callId']
        if self.phase != 'recovering' or call not in self.reading.calls:
            return
        outcome = self.reading.answer(at, call, answer)
        if outcome == 'text':
            self.answered += 1
            self.replace(call, answer['message']['text'])
        self.settle()

    # D-5: a page that has the mark's digest is read by the mark's lengths, and the answered session's part replaced.
    def replace(self, call, text):
        mark, page = self.store.mark, self.store.text().encode()
        lengths = [session['bytesSaved'] for session in mark['sessions']]
        head, parts = page[:mark['bytesBefore']].decode(errors='replace'), []
        cursor = mark['bytesBefore'] + (2 if mark['bytesBefore'] and any(lengths) else 0)
        for length in lengths:
            cursor += 1 if length and any(parts) else 0
            parts.append(page[cursor:cursor + length].decode(errors='replace'))
            cursor += length
        index = [session['callId'] for session in mark['sessions']].index(call)
        parts[index] = text if holds_text(text) else ''
        passage = joined(parts)
        body = (head + '\n\n' if head else '') + passage
        if not passage or utf8(body) > PAGE_MAX:
            return
        sessions = [dict(session, bytesSaved=utf8(part)) for session, part in zip(mark['sessions'], parts)]
        if self.store.save(body, 'spoken', dict(mark, pageDigest=digest(body), sessions=sessions), while_page=mark['pageDigest']):
            self.written = body

    def shows(self):
        return {'text': self.store.text(), 'unsettled': []}


# The device around the pure parts: it holds the store, hands each input to the take or the recovery, and lets the
# deadlines due at an input's instant take effect before the input.
class Driver:
    def __init__(self, given):
        self.store, self.offset, self.calls = Store(given['page'], given['mark']), given['offsetSeconds'], list(given['callIds'])
        self.take = self.recovery = self.acting = self.shown = None

    def step(self, at, given):
        (name, value), = given.items()
        for part in (self.take, self.recovery):
            if part is not None:
                part.do = []
        if self.take is not None:
            self.take.send = []
        frames = expand(value) if name == 'frames' else [None]
        for index, level in enumerate(frames):
            self.advance(at + FRAME * index)
            self.hand(at + FRAME * index, name, level if name == 'frames' else value)
        return self.out(name)

    def advance(self, at):
        part = self.acting
        if part is None:
            return
        if part is self.recovery:
            part.check_day(at)
        marked = [session['callId'] for session in (self.store.mark or {'sessions': []})['sessions']]
        while True:
            due = [(instant, DEADLINES.index(kind), marked.index(call) if call in marked else 0, kind, call)
                   for instant, kind, call in part.deadlines() if instant <= at]
            if not due:
                return
            instant, _, _, kind, call = min(due)
            part.fire(instant, kind, call)

    def hand(self, at, name, value):
        take, recovery = self.take, self.recovery
        if name == 'changed':
            self.store.page = value
        elif name == 'press':
            self.take = Take(self.store, self.offset, self.calls)
            self.take.press(at)
            if self.take.phase == 'ended' and self.acting is not None:
                return
            if recovery is not None and recovery.phase == 'recovering':
                recovery.end('press')
            self.acting = self.take
        elif name == 'recover':
            self.recovery = self.acting = Recovery(self.store, self.offset, at)
        elif name == 'undo':
            follows = self.acting is recovery and recovery.written is not None
            if take.undo(digest(recovery.written if follows else take.written)) and self.acting is recovery and recovery.phase == 'recovering':
                recovery.end('undo')
        elif name == 'result':
            self.acting.result(at, value)
        elif name == 'frames':
            take.frame(value)
        elif name in ENDS:
            take.end(at, ENDS[name])
        elif name == 'heard':
            take.heard(at, value['callId'], value['message'])
        elif name == 'lost':
            take.lost(at, value['callId'])
        elif name == 'unopened':
            take.unopened(value['callId'], value['code'])
        elif name == 'unreadable':
            take.unreadable(value['callId'])

    def out(self, name):
        part, orders = self.acting, [order for part in (self.take, self.recovery) if part is not None for order in part.do]
        if name != 'changed':
            self.shown = part.shows()
        return {'phase': part.phase, 'do': sorted(orders, key=lambda order: ORDERS.index(next(iter(order)))),
                'send': self.take.send if self.take is not None else [], 'page': self.shown, 'saved': self.store.page,
                'mark': self.store.mark, 'wakeAt': min((instant for instant, _, _ in part.deadlines()), default=None)}


def play(story):
    driver = Driver(story['given'])
    outs = [driver.step(step['at'], step['in']) for step in story['steps']]
    return outs, driver.take.ends() if driver.take is not None else None, driver.recovery.outcome if driver.recovery is not None else None
