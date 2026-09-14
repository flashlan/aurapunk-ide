//! Firebase Cloud Messaging (HTTP v1) sender for Mobile push.
//!
//! Credentials come from `AURAPUNK_FCM_CREDENTIALS` (path to a Firebase
//! service-account JSON, or the inline JSON itself). When unset, every send
//! is a silent no-op so Desktop works fine without push configured.

use std::{
    collections::HashMap,
    sync::{LazyLock, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
struct ServiceAccount {
    project_id: String,
    private_key: String,
    client_email: String,
}

struct CachedToken {
    token: String,
    expires_at: Instant,
}

static TOKEN_CACHE: LazyLock<Mutex<Option<CachedToken>>> = LazyLock::new(|| Mutex::new(None));

#[derive(Debug)]
pub enum FcmError {
    NotConfigured,
    InvalidToken,
    Failed(String),
}

fn load_credentials() -> Result<ServiceAccount, FcmError> {
    let raw = std::env::var("AURAPUNK_FCM_CREDENTIALS").map_err(|_| FcmError::NotConfigured)?;
    let json_text = if raw.trim_start().starts_with('{') {
        raw
    } else {
        std::fs::read_to_string(raw.trim())
            .map_err(|e| FcmError::Failed(format!("read FCM credentials: {e}")))?
    };
    serde_json::from_str::<ServiceAccount>(&json_text)
        .map_err(|e| FcmError::Failed(format!("parse FCM credentials: {e}")))
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

async fn access_token(
    client: &reqwest::Client,
    creds: &ServiceAccount,
) -> Result<String, FcmError> {
    if let Ok(guard) = TOKEN_CACHE.lock()
        && let Some(cached) = guard.as_ref()
        && cached.expires_at > Instant::now() + Duration::from_secs(60)
    {
        return Ok(cached.token.clone());
    }

    #[derive(Serialize)]
    struct Claims<'a> {
        iss: &'a str,
        scope: &'a str,
        aud: &'a str,
        exp: u64,
        iat: u64,
    }
    let claims = Claims {
        iss: &creds.client_email,
        scope: "https://www.googleapis.com/auth/firebase.messaging",
        aud: "https://oauth2.googleapis.com/token",
        exp: now_secs() + 3600,
        iat: now_secs(),
    };
    let key = jsonwebtoken::EncodingKey::from_rsa_pem(creds.private_key.as_bytes())
        .map_err(|e| FcmError::Failed(format!("FCM key: {e}")))?;
    let jwt = jsonwebtoken::encode(
        &jsonwebtoken::Header::new(jsonwebtoken::Algorithm::RS256),
        &claims,
        &key,
    )
    .map_err(|e| FcmError::Failed(format!("FCM sign: {e}")))?;

    #[derive(Deserialize)]
    struct TokenResponse {
        access_token: String,
        #[serde(default)]
        expires_in: u64,
    }
    // JWT é base64url (sem escaping); o grant_type vai pré-codificado.
    let form_body =
        format!("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion={jwt}");
    let response: TokenResponse = client
        .post("https://oauth2.googleapis.com/token")
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(form_body)
        .send()
        .await
        .map_err(|e| FcmError::Failed(format!("FCM token exchange: {e}")))?
        .error_for_status()
        .map_err(|e| FcmError::Failed(format!("FCM token exchange: {e}")))?
        .json()
        .await
        .map_err(|e| FcmError::Failed(format!("FCM token parse: {e}")))?;

    let ttl = Duration::from_secs(response.expires_in.max(300));
    if let Ok(mut guard) = TOKEN_CACHE.lock() {
        *guard = Some(CachedToken {
            token: response.access_token.clone(),
            expires_at: Instant::now() + ttl,
        });
    }
    Ok(response.access_token)
}

/// Send a data+notification push. Returns [`FcmError::InvalidToken`] when
/// FCM reports the token as gone so the caller can prune it.
pub async fn send_to_token(
    device_token: &str,
    title: &str,
    body: &str,
    data: &HashMap<String, String>,
) -> Result<(), FcmError> {
    let creds = load_credentials()?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| FcmError::Failed(format!("FCM client: {e}")))?;
    let access = access_token(&client, &creds).await?;

    let payload = serde_json::json!({
        "message": {
            "token": device_token,
            "notification": { "title": title, "body": body },
            "data": data,
            "android": { "priority": "HIGH" },
        }
    });
    let url = format!(
        "https://fcm.googleapis.com/v1/projects/{}/messages:send",
        creds.project_id
    );
    let response = client
        .post(url)
        .bearer_auth(access)
        .json(&payload)
        .send()
        .await
        .map_err(|e| FcmError::Failed(format!("FCM send: {e}")))?;

    if response.status().is_success() {
        return Ok(());
    }
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    let gone = status.as_u16() == 404
        || text.contains("UNREGISTERED")
        || text.contains("INVALID_ARGUMENT");
    if gone {
        return Err(FcmError::InvalidToken);
    }
    Err(FcmError::Failed(format!(
        "FCM send HTTP {status}: {}",
        text.chars().take(200).collect::<String>()
    )))
}
