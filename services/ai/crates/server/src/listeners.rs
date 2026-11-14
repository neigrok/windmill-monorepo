use crate::{config::HEADER_DEADLINE, refusal};
use axum::{
    Router,
    extract::Request,
    middleware::{self, Next},
    response::Response,
};
use futures_util::FutureExt;
use hyper::server::conn::http1;
use hyper_util::{
    rt::{TokioIo, TokioTimer},
    service::TowerToHyperService,
};
use std::{panic::AssertUnwindSafe, time::Duration};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

pub async fn serve(socket: TcpListener, router: Router, stop: CancellationToken) {
    let router = router.layer(middleware::from_fn(panic_boundary));
    let mut http = http1::Builder::new();
    http.timer(TokioTimer::new())
        .header_read_timeout(HEADER_DEADLINE);
    let mut connections = tokio::task::JoinSet::new();
    loop {
        let accepted =
            tokio::select! {accepted=socket.accept()=>accepted,_=stop.cancelled()=>break};
        let stream = match accepted {
            Ok((stream, _)) => stream,
            Err(_) => {
                tracing::warn!(
                    operation = "listener.accept",
                    code = "accept_failed",
                    "listener failed"
                );
                tokio::time::sleep(Duration::from_secs(1)).await;
                continue;
            }
        };
        let connection = http
            .serve_connection(
                TokioIo::new(stream),
                TowerToHyperService::new(router.clone()),
            )
            .with_upgrades();
        let connection_stop = stop.clone();
        connections.spawn(async move {
            tokio::pin!(connection);
            tokio::select! {
                _=&mut connection=>{},
                _=connection_stop.cancelled()=>{
                    connection.as_mut().graceful_shutdown();
                    let _=tokio::time::timeout(Duration::from_secs(5),&mut connection).await;
                }
            }
        });
        while connections.try_join_next().is_some() {}
    }
    drop(socket);
    let _ = tokio::time::timeout(Duration::from_secs(6), async {
        while connections.join_next().await.is_some() {}
    })
    .await;
}

async fn panic_boundary(request: Request, next: Next) -> Response {
    match AssertUnwindSafe(next.run(request)).catch_unwind().await {
        Ok(response) => response,
        Err(_) => refusal("accounting_unavailable", None),
    }
}
