import { COUNTER_LIMIT, MS_LIMIT } from "../../../../../packages/api-contract/sync/reference/core/constants.js";

export function isCalendarDay(day) {
  if (typeof day !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(day))
    return false;
  const [year, month, date] = day.split("-").map(Number);
  if (year < 1 || month < 1 || month > 12) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return (
    date >= 1 &&
    date <=
      [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
  );
}

export function isDocumentStamp(stamp) {
  return (
    stamp !== null &&
    typeof stamp === "object" &&
    !Array.isArray(stamp) &&
    Object.keys(stamp).sort().join() === "actor,counter,ms" &&
    Number.isSafeInteger(stamp.ms) &&
    stamp.ms >= 0 &&
    stamp.ms < MS_LIMIT &&
    Number.isSafeInteger(stamp.counter) &&
    stamp.counter >= 0 &&
    stamp.counter < COUNTER_LIMIT &&
    typeof stamp.actor === "string" &&
    /^[ -~]{0,64}$/.test(stamp.actor) &&
    (stamp.actor !== "" || (stamp.ms === 0 && stamp.counter === 0))
  );
}

export function compareDocumentStamps(a, b) {
  return (
    a.ms - b.ms ||
    a.counter - b.counter ||
    (a.actor < b.actor ? -1 : a.actor > b.actor ? 1 : 0)
  );
}

// The content clock observes a page's payload, never the engine's envelope clock.
export function nextDocumentStamp({
  pair = { ms: 0, counter: 0 },
  observed,
  now,
  actor,
}) {
  if (typeof actor !== "string" || !/^[ -~]{1,64}$/.test(actor))
    throw new Error("invalid content stamp");
  let { ms, counter } = pair;
  if (
    observed &&
    (observed.ms > ms || (observed.ms === ms && observed.counter > counter))
  )
    ({ ms, counter } = observed);
  if (now > ms) {
    ms = now;
    counter = 0;
  } else if (++counter === COUNTER_LIMIT) {
    ms += 1;
    counter = 0;
  }
  const stamp = { ms, counter, actor };
  if (!isDocumentStamp(stamp)) throw new Error("invalid content stamp");
  return stamp;
}

export function claimBody(account, here) {
  if (account.trim() === "") return here;
  if (here.trim() === "") return account;
  if (here.includes(account.trim())) return here;
  return `${account.trimEnd()}\n\n${here.trimStart()}`;
}

