use crate::api::errors::ApiError;
use axum::Json;
use axum::body::Body;
use axum::extract::Request;
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use tracing::warn;

const SIGNATURE_HEADER: &str = "x-api-signature";
const TIMESTAMP_HEADER: &str = "x-api-timestamp";
const TIMESTAMP_TOLERANCE_SECS: i64 = 60;
const MAX_BODY_SIZE: usize = 1024 * 1024;

// signature -> unix time it stops being replayable. Only ever populated
// with signatures that already passed HMAC verification, so an attacker
// without the secret can't grow this by spamming bogus ones
static SEEN_SIGNATURES: LazyLock<Mutex<HashMap<Vec<u8>, i64>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

// Restricts the API to callers that know the configured "authSecret", by
// requiring an HMAC-SHA256 of "<ts><method><path><body>", keyed by that
// secret, as a header pair. Mirrors the equivalent middleware in the Node.js
// API server ("lib/api/v2/Auth.ts"), since nginx splits "/v2/*" between the
// two. Opt-in: with no "authSecret" configured, the API stays open as
// before. The timestamp bounds how long a captured request stays
// replayable, and binding method+path stops a signature captured for one
// endpoint being replayed against another that happens to accept a
// similarly-shaped body
pub async fn auth_middleware(
    secret: Option<Arc<String>>,
    request: Request<Body>,
    next: Next,
) -> Response<Body> {
    let Some(secret) = secret else {
        return next.run(request).await;
    };

    let method = request.method().clone();
    let path = request
        .uri()
        .path_and_query()
        .map(|path_and_query| path_and_query.as_str().to_string())
        .unwrap_or_else(|| request.uri().path().to_string());

    let ts = request
        .headers()
        .get(TIMESTAMP_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_string());
    let provided = request
        .headers()
        .get(SIGNATURE_HEADER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| hex::decode(value).ok());

    let (parts, body) = request.into_parts();
    let body_bytes = match axum::body::to_bytes(body, MAX_BODY_SIZE).await {
        Ok(bytes) => bytes,
        Err(_) => return unauthorized(),
    };

    let verified = match (&ts, &provided) {
        (Some(ts), Some(provided)) => match check_timestamp(ts) {
            Some(ts_num) => {
                verify(&secret, ts, method.as_str(), &path, &body_bytes, provided)
                    && check_replay(provided, ts_num)
            }
            None => false,
        },
        _ => false,
    };

    if !verified {
        warn!("Unauthorized request to {} {}", method, path);
        return unauthorized();
    }

    next.run(Request::from_parts(parts, Body::from(body_bytes)))
        .await
}

fn check_timestamp(ts: &str) -> Option<i64> {
    let provided = ts.parse::<i64>().ok()?;
    let now = chrono::Utc::now().timestamp();

    if now.abs_diff(provided) <= TIMESTAMP_TOLERANCE_SECS as u64 {
        Some(provided)
    } else {
        None
    }
}

fn verify(secret: &str, ts: &str, method: &str, path: &str, body: &[u8], provided: &[u8]) -> bool {
    let Ok(mut mac) = Hmac::<Sha256>::new_from_slice(secret.as_bytes()) else {
        return false;
    };
    mac.update(ts.as_bytes());
    mac.update(method.as_bytes());
    mac.update(path.as_bytes());
    mac.update(body);
    mac.verify_slice(provided).is_ok()
}

fn check_replay(signature: &[u8], ts: i64) -> bool {
    let now = chrono::Utc::now().timestamp();
    let mut seen = SEEN_SIGNATURES.lock().unwrap();
    seen.retain(|_, expiry| *expiry > now);

    if seen.contains_key(signature) {
        return false;
    }

    // Past this point a replay would fail check_timestamp on its own anyway
    seen.insert(signature.to_vec(), ts + TIMESTAMP_TOLERANCE_SECS);
    true
}

fn unauthorized() -> Response<Body> {
    (
        StatusCode::UNAUTHORIZED,
        Json(ApiError {
            error: "unauthorized".to_string(),
        }),
    )
        .into_response()
}

#[cfg(test)]
mod test {
    use super::*;
    use axum::Router;
    use axum::routing::post;
    use http_body_util::BodyExt;
    use tower::util::ServiceExt;

    fn router(secret: Option<Arc<String>>) -> Router {
        Router::new()
            .route("/", post(|| async { "ok" }))
            .layer(axum::middleware::from_fn(move |req, next| {
                let secret = secret.clone();
                async move { auth_middleware(secret, req, next).await }
            }))
    }

    fn sign(secret: &str, ts: &str, method: &str, path: &str, body: &str) -> String {
        let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).unwrap();
        mac.update(ts.as_bytes());
        mac.update(method.as_bytes());
        mac.update(path.as_bytes());
        mac.update(body.as_bytes());
        hex::encode(mac.finalize().into_bytes())
    }

    fn now() -> String {
        chrono::Utc::now().timestamp().to_string()
    }

    #[tokio::test]
    async fn test_no_secret_configured_allows_request() {
        let res = router(None)
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/")
                    .body(Body::from("some body"))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(res.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn test_missing_timestamp_rejected() {
        let secret = "secret";
        let res = router(Some(Arc::new(secret.to_string())))
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/")
                    .header(
                        SIGNATURE_HEADER,
                        sign(secret, &now(), "POST", "/", "some body"),
                    )
                    .body(Body::from("some body"))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn test_stale_timestamp_rejected() {
        let secret = "secret";
        let stale_ts = (chrono::Utc::now().timestamp() - 120).to_string();

        let res = router(Some(Arc::new(secret.to_string())))
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/")
                    .header(TIMESTAMP_HEADER, &stale_ts)
                    .header(
                        SIGNATURE_HEADER,
                        sign(secret, &stale_ts, "POST", "/", "some body"),
                    )
                    .body(Body::from("some body"))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn test_missing_signature_rejected() {
        let res = router(Some(Arc::new("secret".to_string())))
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/")
                    .header(TIMESTAMP_HEADER, now())
                    .body(Body::from("some body"))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn test_wrong_signature_rejected() {
        let res = router(Some(Arc::new("secret".to_string())))
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/")
                    .header(TIMESTAMP_HEADER, now())
                    .header(SIGNATURE_HEADER, "deadbeef")
                    .body(Body::from("some body"))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn test_correct_signature_accepted() {
        let secret = "secret";
        let body = "correct signature test body";
        let ts = now();

        let res = router(Some(Arc::new(secret.to_string())))
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/")
                    .header(TIMESTAMP_HEADER, &ts)
                    .header(SIGNATURE_HEADER, sign(secret, &ts, "POST", "/", body))
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(res.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn test_signature_for_different_body_rejected() {
        let secret = "secret";
        let ts = now();

        let res = router(Some(Arc::new(secret.to_string())))
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/")
                    .header(TIMESTAMP_HEADER, &ts)
                    .header(
                        SIGNATURE_HEADER,
                        sign(secret, &ts, "POST", "/", "other body"),
                    )
                    .body(Body::from("some body"))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
        let body = res.into_body().collect().await.unwrap().to_bytes();
        let body: ApiError = serde_json::from_slice(&body).unwrap();
        assert_eq!(body.error, "unauthorized");
    }

    #[tokio::test]
    async fn test_signature_for_different_path_rejected() {
        let secret = "secret";
        let ts = now();
        let body = "some body";
        // Signed for a different endpoint with the same body shape
        let signature = sign(secret, &ts, "POST", "/other", body);

        let res = router(Some(Arc::new(secret.to_string())))
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/")
                    .header(TIMESTAMP_HEADER, &ts)
                    .header(SIGNATURE_HEADER, signature)
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn test_replayed_signature_rejected() {
        let secret = "secret";
        let ts = now();
        let body = "replayed signature test body";
        let signature = sign(secret, &ts, "POST", "/", body);

        let app = router(Some(Arc::new(secret.to_string())));

        let first = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/")
                    .header(TIMESTAMP_HEADER, &ts)
                    .header(SIGNATURE_HEADER, &signature)
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(first.status(), StatusCode::OK);

        let second = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/")
                    .header(TIMESTAMP_HEADER, &ts)
                    .header(SIGNATURE_HEADER, &signature)
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(second.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn test_distinct_signatures_not_treated_as_replays() {
        let secret = "secret";
        let ts = now();

        let app = router(Some(Arc::new(secret.to_string())));

        let first = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/")
                    .header(TIMESTAMP_HEADER, &ts)
                    .header(
                        SIGNATURE_HEADER,
                        sign(
                            secret,
                            &ts,
                            "POST",
                            "/",
                            "distinct signatures test body one",
                        ),
                    )
                    .body(Body::from("distinct signatures test body one"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(first.status(), StatusCode::OK);

        let second = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/")
                    .header(TIMESTAMP_HEADER, &ts)
                    .header(
                        SIGNATURE_HEADER,
                        sign(
                            secret,
                            &ts,
                            "POST",
                            "/",
                            "distinct signatures test body two",
                        ),
                    )
                    .body(Body::from("distinct signatures test body two"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(second.status(), StatusCode::OK);
    }
}
