use crate::StaticCode;
use std::fmt;

#[derive(Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub struct NanoUsd(i64);

impl NanoUsd {
    pub const ZERO: Self = Self(0);

    pub fn new(value: i64) -> Result<Self, StaticCode> {
        if value < 0 {
            return Err(StaticCode::InvalidRequest);
        }
        Ok(Self(value))
    }

    pub const fn nanos(self) -> i64 {
        self.0
    }

    pub fn from_usd(value: &str) -> Result<Self, StaticCode> {
        let (whole, fraction) = value.split_once('.').unwrap_or((value, ""));
        if whole.is_empty()
            || !whole.bytes().all(|c| c.is_ascii_digit())
            || fraction.len() > 9
            || !fraction.bytes().all(|c| c.is_ascii_digit())
            || value.ends_with('.')
        {
            return Err(StaticCode::InvalidRequest);
        }
        let whole = whole
            .parse::<i64>()
            .map_err(|_| StaticCode::InvalidRequest)?;
        let fraction = if fraction.is_empty() {
            0
        } else {
            fraction
                .parse::<i64>()
                .map_err(|_| StaticCode::InvalidRequest)?
                .checked_mul(10_i64.pow(9 - fraction.len() as u32))
                .ok_or(StaticCode::InvalidRequest)?
        };
        Self::new(
            whole
                .checked_mul(1_000_000_000)
                .and_then(|v| v.checked_add(fraction))
                .ok_or(StaticCode::InvalidRequest)?,
        )
    }

    pub fn usd(self) -> String {
        let whole = self.0 / 1_000_000_000;
        let fraction = self.0 % 1_000_000_000;
        if fraction == 0 {
            return whole.to_string();
        }
        format!("{whole}.{fraction:09}")
            .trim_end_matches('0')
            .to_owned()
    }

    pub fn checked_add(self, other: Self) -> Result<Self, StaticCode> {
        Self::new(
            self.0
                .checked_add(other.0)
                .ok_or(StaticCode::InvalidRequest)?,
        )
    }

    pub fn checked_sub(self, other: Self) -> Result<Self, StaticCode> {
        Self::new(
            self.0
                .checked_sub(other.0)
                .ok_or(StaticCode::InvalidRequest)?,
        )
    }

    pub fn checked_mul(self, count: u64) -> Result<Self, StaticCode> {
        let count = i64::try_from(count).map_err(|_| StaticCode::InvalidRequest)?;
        Self::new(
            self.0
                .checked_mul(count)
                .ok_or(StaticCode::InvalidRequest)?,
        )
    }

    pub fn ratio_ceil(self, numerator: u64, denominator: u64) -> Result<Self, StaticCode> {
        if denominator == 0 {
            return Err(StaticCode::InvalidRequest);
        }
        let product = i128::from(self.0) * i128::from(numerator);
        let value = (product + i128::from(denominator) - 1) / i128::from(denominator);
        Self::new(i64::try_from(value).map_err(|_| StaticCode::InvalidRequest)?)
    }

    pub fn remaining(self, spent: Self, held: Self) -> Result<Self, StaticCode> {
        let used = spent.checked_add(held)?;
        Ok(Self(self.0.saturating_sub(used.0).max(0)))
    }
}

impl fmt::Display for NanoUsd {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.usd())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Period {
    pub start: i64,
    pub end: i64,
}

impl Period {
    pub fn new(start: i64, end: i64) -> Result<Self, StaticCode> {
        if start < 0 || start >= end {
            return Err(StaticCode::InvalidRequest);
        }
        Ok(Self { start, end })
    }

    pub fn contains(self, now: i64) -> bool {
        self.start <= now && now < self.end
    }

    pub fn overlaps(self, other: Self) -> bool {
        self.start < other.end && other.start < self.end
    }

    pub fn day(now: i64) -> Result<Self, StaticCode> {
        if now < 0 {
            return Err(StaticCode::InvalidRequest);
        }
        let start = now / 86_400_000 * 86_400_000;
        Self::new(
            start,
            start
                .checked_add(86_400_000)
                .ok_or(StaticCode::InvalidRequest)?,
        )
    }

    pub fn month(now: i64) -> Result<Self, StaticCode> {
        if now < 0 {
            return Err(StaticCode::InvalidRequest);
        }
        let days = now / 86_400_000 + 719468;
        let era = days / 146097;
        let day_of_era = days - era * 146097;
        let year_of_era =
            (day_of_era - day_of_era / 1460 + day_of_era / 36524 - day_of_era / 146096) / 365;
        let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
        let shifted_month = (5 * day_of_year + 2) / 153;
        let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
        let month = shifted_month + if shifted_month < 10 { 3 } else { -9 };
        let year = year_of_era + era * 400 + i64::from(month <= 2);
        let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
        let length = match month {
            2 => {
                if leap {
                    29
                } else {
                    28
                }
            }
            4 | 6 | 9 | 11 => 30,
            _ => 31,
        };
        let start = (now / 86_400_000 - day + 1) * 86_400_000;
        Self::new(
            start,
            start
                .checked_add(length * 86_400_000)
                .ok_or(StaticCode::InvalidRequest)?,
        )
    }
}
