use chrono::Utc;
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Threshold below which a `memory_search` call's top hit is counted as
/// "weak" (a plausible context-drift signal) in the day's aggregate. Mirrors
/// `WEAK_RELEVANCE_THRESHOLD` in `crates/mcp/src/task_server/tools/mem0.rs`
/// — kept as a separate constant since the two crates don't share a
/// dependency edge in that direction; see
/// docs/ADR/ADR-030-mem0-context-drift-measurement.md.
pub const WEAK_RELEVANCE_THRESHOLD: f64 = 0.3;

/// One day's aggregated `memory_search` relevance, for the Settings → Usage
/// dashboard.
#[derive(Debug, Clone, Serialize, Deserialize, Default, TS)]
pub struct Mem0RelevanceDay {
    pub day: String,
    pub calls: i64,
    /// Calls whose top hit was below [`WEAK_RELEVANCE_THRESHOLD`], or had
    /// hits with no score at all.
    pub weak_calls: i64,
    /// Mean `top_score` across calls that returned a numeric score (`None`
    /// if every call that day had zero hits/no score).
    pub avg_top_score: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, TS)]
pub struct Mem0RelevanceSummary {
    /// Last 30 days, oldest first.
    pub days: Vec<Mem0RelevanceDay>,
    pub total_calls: i64,
    pub total_weak_calls: i64,
}

#[derive(Debug, Default)]
struct DayAccum {
    calls: i64,
    weak_calls: i64,
    score_sum: f64,
    scored_calls: i64,
}

/// In-memory day-bucketed ledger of `memory_search` relevance, reported by
/// the `aurapunk_mcp` process (a separate process from this one — see
/// `POST /api/usage/mem0-relevance`) after each call. Deliberately
/// in-memory only, like [`super::queued_message::QueuedMessageService`]: an
/// observability aid, not data anyone needs to survive a server restart.
#[derive(Clone)]
pub struct Mem0RelevanceService {
    days: std::sync::Arc<DashMap<String, DayAccum>>,
}

impl Mem0RelevanceService {
    pub fn new() -> Self {
        Self {
            days: std::sync::Arc::new(DashMap::new()),
        }
    }

    /// Record one `memory_search` call's relevance outcome. `top_score` is
    /// `None` when the call returned zero hits.
    pub fn record(&self, top_score: Option<f64>) {
        let day = Utc::now().format("%Y-%m-%d").to_string();
        let mut entry = self.days.entry(day).or_default();
        entry.calls += 1;
        let weak = match top_score {
            Some(s) => s < WEAK_RELEVANCE_THRESHOLD,
            None => true,
        };
        if weak {
            entry.weak_calls += 1;
        }
        if let Some(s) = top_score {
            entry.score_sum += s;
            entry.scored_calls += 1;
        }
    }

    /// Last 30 days of aggregates, oldest first, plus totals across the
    /// whole in-memory window (which may be less than 30 days if the
    /// process started recently).
    pub fn summary(&self) -> Mem0RelevanceSummary {
        let mut days: Vec<Mem0RelevanceDay> = self
            .days
            .iter()
            .map(|entry| {
                let day = entry.key().clone();
                let a = entry.value();
                Mem0RelevanceDay {
                    day,
                    calls: a.calls,
                    weak_calls: a.weak_calls,
                    avg_top_score: if a.scored_calls > 0 {
                        Some(a.score_sum / a.scored_calls as f64)
                    } else {
                        None
                    },
                }
            })
            .collect();
        days.sort_by(|a, b| a.day.cmp(&b.day));

        let cutoff = (Utc::now() - chrono::Duration::days(30))
            .format("%Y-%m-%d")
            .to_string();
        days.retain(|d| d.day >= cutoff);

        let total_calls = days.iter().map(|d| d.calls).sum();
        let total_weak_calls = days.iter().map(|d| d.weak_calls).sum();

        Mem0RelevanceSummary {
            days,
            total_calls,
            total_weak_calls,
        }
    }
}

impl Default for Mem0RelevanceService {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_buckets_strong_and_weak_calls_into_today() {
        let svc = Mem0RelevanceService::new();
        svc.record(Some(0.9)); // strong
        svc.record(Some(0.1)); // weak: below threshold
        svc.record(None); // weak: no hits at all

        let summary = svc.summary();
        assert_eq!(summary.total_calls, 3);
        assert_eq!(summary.total_weak_calls, 2);
        assert_eq!(summary.days.len(), 1);

        let today = &summary.days[0];
        assert_eq!(today.calls, 3);
        assert_eq!(today.weak_calls, 2);
        // avg_top_score is the mean over SCORED calls only (0.9, 0.1) — the
        // None call contributes to weak_calls/calls but not to the average.
        assert!((today.avg_top_score.unwrap() - 0.5).abs() < 1e-9);
    }

    #[test]
    fn summary_with_no_calls_has_no_days() {
        let svc = Mem0RelevanceService::new();
        let summary = svc.summary();
        assert_eq!(summary.total_calls, 0);
        assert_eq!(summary.total_weak_calls, 0);
        assert!(summary.days.is_empty());
    }

    #[test]
    fn exactly_at_threshold_is_not_weak() {
        // `s < THRESHOLD`, so a score equal to the threshold counts as strong.
        let svc = Mem0RelevanceService::new();
        svc.record(Some(WEAK_RELEVANCE_THRESHOLD));
        let summary = svc.summary();
        assert_eq!(summary.total_weak_calls, 0);
    }

    #[test]
    fn old_day_is_excluded_from_summary_and_totals() {
        let svc = Mem0RelevanceService::new();
        svc.record(Some(0.8));
        // Manually inject a day well outside the 30-day window to verify the
        // cutoff filter, without waiting real time or depending on the
        // system clock in the test itself.
        svc.days.insert(
            "2000-01-01".to_string(),
            DayAccum {
                calls: 5,
                weak_calls: 5,
                score_sum: 0.0,
                scored_calls: 0,
            },
        );

        let summary = svc.summary();
        assert_eq!(summary.days.len(), 1, "the old day must be filtered out");
        assert_eq!(summary.total_calls, 1);
        assert_eq!(summary.total_weak_calls, 0);
    }
}
