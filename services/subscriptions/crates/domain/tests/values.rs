use domain::{
    BillingInterval, Environment, Instant, Lineage, Money, Observation, ObservedPeriod, Ownership,
    Plan, ProductId, Renewal, Span, State, Status, Store, StoreSubscriptionId, StoreTransactionId,
    Storefront,
};

#[test]
fn an_observation_formatted_for_debugging_names_no_store_id() {
    let span = Span {
        start: Instant::from_epoch_millis(1_798_797_600_000),
        end: Instant::from_epoch_millis(1_801_476_000_000),
    };
    let price = Money::new("12.00", "USD").expect("a price");
    let observation = Observation {
        lineage: Lineage {
            store: Store::AppStore,
            environment: Environment::Production,
            store_subscription_id: StoreSubscriptionId::new("2000000100000001"),
        },
        observed_at: span.start,
        ownership: Ownership::Purchased,
        status: Status {
            plan: Plan::WindmillOne,
            product_id: ProductId::new("works.windmill.app.one.monthly"),
            billing_interval: BillingInterval::new("P1M"),
            started_at: span.start,
            state: State::Active {
                pause_scheduled_for: None,
            },
            current_period: span,
            renewal: Renewal {
                auto_renew: true,
                next_charge: None,
                next_product_id: None,
                cancel_requested_at: None,
            },
            offer: None,
            price: price.clone(),
            storefront: Some(Storefront::new("USA")),
        },
        periods: vec![ObservedPeriod {
            transaction: StoreTransactionId::new("2000000100000002"),
            span,
            price,
            offer_kind: None,
            refunded_at: None,
        }],
    };

    let printed = format!("{observation:?} {observation:#?}");

    assert!(!printed.contains("2000000100000001"), "{printed}");
    assert!(!printed.contains("2000000100000002"), "{printed}");
    assert!(printed.contains("StoreSubscriptionId(redacted)"));
    assert!(printed.contains("StoreTransactionId(redacted)"));
    assert!(printed.contains("works.windmill.app.one.monthly"));
}

#[test]
fn an_amount_counted_in_units_keeps_the_currencys_minor_units_and_every_digit_stated() {
    let amount = |units, exponent, currency| {
        Money::from_units(units, exponent, currency).map(|money| money.amount().to_owned())
    };

    assert_eq!(amount(12_000, 3, "USD").as_deref(), Some("12.00"));
    assert_eq!(amount(11_990, 3, "EUR").as_deref(), Some("11.99"));
    assert_eq!(amount(0, 3, "USD").as_deref(), Some("0.00"));
    assert_eq!(amount(1_800_000, 3, "JPY").as_deref(), Some("1800"));
    assert_eq!(amount(3_990, 3, "KWD").as_deref(), Some("3.990"));
    assert_eq!(amount(3_995, 3, "USD").as_deref(), Some("3.995"));
    assert_eq!(amount(1_200, 2, "USD").as_deref(), Some("12.00"));
    assert_eq!(amount(12_990_000, 6, "GBP").as_deref(), Some("12.99"));
    assert_eq!(amount(12_000, 3, "usd"), None);
}
