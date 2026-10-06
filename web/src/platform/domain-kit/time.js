// @ts-check
// §5 time: an instant in epoch milliseconds, a Gregorian local day, a zone and the moment that joins them.
// Every day computation is §5.2's integer arithmetic; nothing here reads a clock.

import { precondition } from './values.js';

const MS_PER_DAY = 86_400_000;
const DAY_TEXT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u;

/**
 * @param {number} a
 * @param {number} b
 */
function floorDivide(a, b) {
  const quotient = Math.floor(a / b);
  return quotient * b > a ? quotient - 1 : quotient;
}

/**
 * @param {number} year
 * @param {number} month
 */
function monthLength(year, month) {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
}

export class Instant {
  /** @param {number} ms */
  constructor(ms) {
    precondition(Number.isSafeInteger(ms), `an instant is integer milliseconds, not ${ms}`);
    this.ms = ms;
    Object.freeze(this);
  }

  /**
   * @param {Instant} a
   * @param {Instant} b
   */
  static compare(a, b) {
    return Math.sign(a.ms - b.ms);
  }
}

/** @typedef {{ offsetSeconds(at: Instant): number }} Zone */

export class FixedZone {
  /** @param {number} seconds */
  constructor(seconds) {
    this.seconds = seconds;
    Object.freeze(this);
  }

  /** @param {Instant} at */
  offsetSeconds(at) {
    return this.seconds;
  }
}

export class LocalDay {
  /**
   * @param {number} year
   * @param {number} month
   * @param {number} day
   */
  constructor(year, month, day) {
    this.year = year;
    this.month = month;
    this.day = day;
    Object.freeze(this);
  }

  // "YYYY-MM-DD", a real day of years 0001–9999, or null.
  /** @param {string} text */
  static parse(text) {
    if (!DAY_TEXT.test(text)) return null;
    const year = Number(text.slice(0, 4));
    const month = Number(text.slice(5, 7));
    const day = Number(text.slice(8, 10));
    if (year < 1 || month < 1 || month > 12 || day < 1 || day > monthLength(year, month)) return null;
    return new LocalDay(year, month, day);
  }

  /**
   * @param {Instant} instant
   * @param {number} offsetSeconds
   */
  static from(instant, offsetSeconds) {
    return LocalDay.civil(floorDivide(instant.ms + offsetSeconds * 1000, MS_PER_DAY));
  }

  /**
   * @param {Instant} instant
   * @param {Zone} zone
   */
  static in(instant, zone) {
    return LocalDay.from(instant, zone.offsetSeconds(instant));
  }

  // §5.2 civil(days): the proleptic Gregorian date of a day count since 1970-01-01.
  /** @param {number} days */
  static civil(days) {
    const z = days + 719_468;
    const era = floorDivide(z, 146_097);
    const doe = z - era * 146_097;
    const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365);
    const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
    const mp = Math.floor((5 * doy + 2) / 153);
    const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
    const month = mp < 10 ? mp + 3 : mp - 9;
    const year = yoe + era * 400 + (month <= 2 ? 1 : 0);
    return new LocalDay(year, month, day);
  }

  get daysSinceEpoch() {
    const y = this.month <= 2 ? this.year - 1 : this.year;
    const era = floorDivide(y, 400);
    const yoe = y - era * 400;
    const mp = this.month > 2 ? this.month - 3 : this.month + 9;
    const doy = Math.floor((153 * mp + 2) / 5) + this.day - 1;
    const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
    return era * 146_097 + doe - 719_468;
  }

  get text() {
    const pad = (/** @type {number} */ value, /** @type {number} */ width) => String(value).padStart(width, '0');
    return `${pad(this.year, 4)}-${pad(this.month, 2)}-${pad(this.day, 2)}`;
  }

  // ISO weekday: Monday 1 … Sunday 7, by floor modulo so days before the epoch count the same way.
  get weekday() {
    const shifted = this.daysSinceEpoch + 3;
    return shifted - floorDivide(shifted, 7) * 7 + 1;
  }

  /** @param {number} days */
  adding(days) {
    return LocalDay.civil(this.daysSinceEpoch + days);
  }

  /** @param {LocalDay} other */
  daysUntil(other) {
    return other.daysSinceEpoch - this.daysSinceEpoch;
  }

  /**
   * @param {LocalDay} a
   * @param {LocalDay} b
   */
  static compare(a, b) {
    return Math.sign(a.daysSinceEpoch - b.daysSinceEpoch);
  }
}

export class Moment {
  /**
   * @param {Instant} now
   * @param {Zone} zone
   */
  constructor(now, zone) {
    this.now = now;
    this.zone = zone;
    Object.freeze(this);
  }

  get today() {
    return LocalDay.in(this.now, this.zone);
  }
}
