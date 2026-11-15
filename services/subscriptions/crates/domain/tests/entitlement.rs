use domain::{
    AccountEntitlement, AccountId, BillingInterval, Binding, BoundBy, EndReason, Ending,
    Environment, Instant, Lineage, Money, Plan, ProductId, Renewal, Span, State, Status, Store,
    StoreSubscriptionId, Subscription, SubscriptionId,
};
use proptest::collection::vec;
use proptest::option;
use proptest::prelude::*;
use proptest::sample::select;

proptest! {
    #![proptest_config(ProptestConfig::with_cases(2000))]

    #[test]
    fn an_entitlement_folded_again_over_the_subscriptions_it_carries_is_the_same(held in held()) {
        let entitlement = AccountEntitlement::of(AccountId::new("account"), held);
        let carried = entitlement.subscriptions().cloned().collect();

        prop_assert_eq!(AccountEntitlement::of(AccountId::new("account"), carried), entitlement);
    }

    #[test]
    fn it_carries_the_account_s_subscriptions_in_force_and_one_governing_one_for_each_environment(held in held()) {
        let entitlement = AccountEntitlement::of(AccountId::new("account"), held.clone());
        let mut carried: Vec<&str> = entitlement.subscriptions().map(|subscription| subscription.id.as_str()).collect();
        carried.sort_unstable();

        let mut expected: Vec<&str> = held
            .iter()
            .filter(|subscription| subscription.account_id() == Some(&AccountId::new("account")))
            .filter(|subscription| {
                !subscription.status.state.has_ended()
                    || [&entitlement.production, &entitlement.sandbox]
                        .iter()
                        .any(|block| block.governing.as_ref() == Some(subscription))
            })
            .map(|subscription| subscription.id.as_str())
            .collect();
        expected.sort_unstable();
        prop_assert_eq!(carried, expected);
    }
}

// Up to a dozen subscriptions, bound to the account, to another or to no one, in either environment, at instants
// drawn from a few minutes so that the fold's ties are met often.
fn held() -> impl Strategy<Value = Vec<Subscription>> {
    vec(
        (
            select(vec![Some("account"), Some("another"), None]),
            select(Environment::ALL),
            status(),
        ),
        0..12,
    )
    .prop_map(|subscriptions| {
        subscriptions
            .into_iter()
            .enumerate()
            .map(|(index, (account, environment, status))| Subscription {
                id: SubscriptionId::new(format!("{index:02}")),
                lineage: Lineage {
                    store: Store::AppStore,
                    environment,
                    store_subscription_id: StoreSubscriptionId::new(format!("lineage {index}")),
                },
                binding: account.map(|account| Binding {
                    account_id: AccountId::new(account),
                    bound_at: at(0),
                    bound_by: BoundBy::Purchase,
                }),
                status,
                observed_at: at(0),
                cancellation_observed_at: None,
            })
            .collect()
    })
}

fn status() -> impl Strategy<Value = Status> {
    let minute = || (0..6i64).prop_map(at);
    let state = prop_oneof![
        Just(State::Active {
            pause_scheduled_for: None
        }),
        (minute(), minute()).prop_map(|(payment_failed_at, grace_ends_at)| State::Grace {
            payment_failed_at,
            grace_ends_at
        }),
        minute().prop_map(|payment_failed_at| State::OnHold { payment_failed_at }),
        (minute(), option::of(minute())).prop_map(|(paused_at, resumes_at)| State::Paused {
            paused_at,
            resumes_at
        }),
        (minute(), select(EndReason::ALL))
            .prop_map(|(at, reason)| State::Expired(Ending { at, reason })),
        (minute(), select(EndReason::ALL))
            .prop_map(|(at, reason)| State::Revoked(Ending { at, reason })),
    ];
    (state, minute(), minute(), any::<bool>()).prop_map(
        |(state, started_at, period_end, auto_renew)| Status {
            plan: Plan::WindmillOne,
            product_id: ProductId::new("works.windmill.app.one.monthly"),
            billing_interval: BillingInterval::new("P1M"),
            started_at,
            state,
            current_period: Span {
                start: started_at,
                end: period_end,
            },
            renewal: Renewal {
                auto_renew,
                next_charge: None,
                next_product_id: None,
                cancel_requested_at: None,
            },
            offer: None,
            price: Money::new("12.00", "USD").expect("a price"),
            storefront: None,
        },
    )
}

fn at(minute: i64) -> Instant {
    Instant::from_epoch_millis(1_798_761_600_000 + minute * 60_000)
}
