use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};
use uuid::Uuid;

/// FCM device token registered by a Mobile app. The Desktop is the sender:
/// on agent replies it pushes to every registered token.
///
/// Uses dynamic queries (no compile-time DB needed).
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct PushToken {
    pub id: Uuid,
    pub token: String,
    pub platform: String,
    pub label: Option<String>,
}

impl PushToken {
    pub async fn upsert(
        pool: &SqlitePool,
        token: &str,
        platform: &str,
        label: Option<&str>,
    ) -> Result<Self, sqlx::Error> {
        let token = token.trim().to_string();
        let platform = platform.trim().to_string();
        let platform = if platform.is_empty() {
            "android".to_string()
        } else {
            platform
        };
        sqlx::query_as::<_, PushToken>(
            r#"INSERT INTO device_push_tokens (id, token, platform, label)
               VALUES ($1, $2, $3, $4)
               ON CONFLICT(token) DO UPDATE SET
                   platform = excluded.platform,
                   label = excluded.label,
                   updated_at = datetime('now', 'subsec')
               RETURNING id, token, platform, label"#,
        )
        .bind(Uuid::new_v4())
        .bind(token)
        .bind(platform)
        .bind(label)
        .fetch_one(pool)
        .await
    }

    pub async fn find_all(pool: &SqlitePool) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, PushToken>(
            r#"SELECT id, token, platform, label
               FROM device_push_tokens ORDER BY updated_at DESC"#,
        )
        .fetch_all(pool)
        .await
    }

    pub async fn delete_by_token(pool: &SqlitePool, token: &str) -> Result<(), sqlx::Error> {
        sqlx::query("DELETE FROM device_push_tokens WHERE token = $1")
            .bind(token)
            .execute(pool)
            .await?;
        Ok(())
    }
}
