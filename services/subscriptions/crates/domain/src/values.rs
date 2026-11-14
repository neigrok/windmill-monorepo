use std::fmt;
use std::ops::Add;
use std::time::Duration;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Instant(i64);

impl Instant {
    pub const fn from_epoch_millis(millis: i64) -> Instant {
        Instant(millis)
    }

    pub const fn epoch_millis(self) -> i64 {
        self.0
    }
}

impl Add<Duration> for Instant {
    type Output = Instant;

    fn add(self, duration: Duration) -> Instant {
        let millis = i64::try_from(duration.as_millis()).unwrap_or(i64::MAX);
        Instant(self.0.saturating_add(millis))
    }
}

// [start, end): a period's stretch, or the period in force.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Span {
    pub start: Instant,
    pub end: Instant,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Money {
    amount: String,
    currency: String,
}

impl Money {
    pub fn new(amount: &str, currency: &str) -> Option<Money> {
        let digits =
            |part: &str| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit());
        let decimal = match amount.split_once('.') {
            Some((units, fraction)) => digits(units) && digits(fraction),
            None => digits(amount),
        };
        let iso_4217 =
            currency.len() == 3 && currency.bytes().all(|byte| byte.is_ascii_uppercase());
        (decimal && iso_4217).then(|| Money {
            amount: amount.to_owned(),
            currency: currency.to_owned(),
        })
    }

    // An exact amount in units of 10^-exponent, with the currency's ISO 4217 minor units; a further digit is never rounded away.
    pub fn from_units(units: u64, exponent: u32, currency: &str) -> Option<Money> {
        let minor_units = match currency {
            "BIF" | "CLP" | "DJF" | "GNF" | "ISK" | "JPY" | "KMF" | "KRW" | "PYG" | "RWF"
            | "UGX" | "UYI" | "VND" | "VUV" | "XAF" | "XOF" | "XPF" => 0,
            "BHD" | "IQD" | "JOD" | "KWD" | "LYD" | "OMR" | "TND" => 3,
            "CLF" | "UYW" => 4,
            _ => 2,
        };
        let exponent = usize::try_from(exponent).ok()?;
        let digits = format!("{units:0>width$}", width = exponent + 1);
        let (whole, fraction) = digits.split_at(digits.len() - exponent);
        let fraction = format!("{:0<minor_units$}", fraction.trim_end_matches('0'));
        if fraction.is_empty() {
            return Money::new(whole, currency);
        }
        Money::new(&format!("{whole}.{fraction}"), currency)
    }

    pub fn amount(&self) -> &str {
        &self.amount
    }

    pub fn currency(&self) -> &str {
        &self.currency
    }
}

macro_rules! text_values {
    ($($name:ident),+ $(,)?) => {$(
        #[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
        pub struct $name(String);

        impl $name {
            pub fn new(text: impl Into<String>) -> $name {
                $name(text.into())
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }
    )+};
}

text_values!(
    SubscriptionId,
    PeriodId,
    AccountId,
    StoreSubscriptionId,
    StoreTransactionId,
    ProductId,
    BillingInterval,
    Storefront,
);

macro_rules! shown_in_debug {
    ($($name:ident),+ $(,)?) => {$(
        impl fmt::Debug for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.debug_tuple(stringify!($name)).field(&self.0).finish()
            }
        }
    )+};
}

// §10: a store's ids name a purchase and stay out of every log line and panic message.
macro_rules! redacted_in_debug {
    ($($name:ident),+ $(,)?) => {$(
        impl fmt::Debug for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str(concat!(stringify!($name), "(redacted)"))
            }
        }
    )+};
}

shown_in_debug!(
    SubscriptionId,
    PeriodId,
    AccountId,
    ProductId,
    BillingInterval,
    Storefront,
);

redacted_in_debug!(StoreSubscriptionId, StoreTransactionId);

macro_rules! closed_names {
    ($(pub enum $name:ident { $($variant:ident = $text:literal),+ $(,)? })+) => {$(
        #[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
        pub enum $name {
            $($variant),+
        }

        impl $name {
            pub const ALL: &[$name] = &[$($name::$variant),+];

            pub fn name(self) -> &'static str {
                match self {
                    $($name::$variant => $text),+
                }
            }

            pub fn from_name(name: &str) -> Option<$name> {
                match name {
                    $($text => Some($name::$variant),)+
                    _ => None,
                }
            }
        }
    )+};
}

pub(crate) use closed_names;

closed_names! {
    pub enum Store {
        AppStore = "app_store",
        PlayStore = "play_store",
        Paddle = "paddle",
    }

    pub enum Environment {
        Production = "production",
        Sandbox = "sandbox",
    }

    pub enum Plan {
        WindmillOne = "windmill_one",
    }
}
