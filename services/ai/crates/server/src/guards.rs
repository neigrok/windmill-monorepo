use std::{
    collections::{HashMap, VecDeque},
    sync::Mutex,
    time::{Duration, Instant},
};

pub struct Rates {
    entries: Mutex<HashMap<(String, bool), VecDeque<Instant>>>,
}

impl Default for Rates {
    fn default() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
        }
    }
}

impl Rates {
    pub fn allow(&self, principal: String, start: bool, limit: usize) -> bool {
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        let window = Duration::from_secs(60);
        entries.retain(|_, hits| {
            while hits.front().is_some_and(|at| at.elapsed() >= window) {
                hits.pop_front();
            }
            !hits.is_empty()
        });
        let hits = entries.entry((principal, start)).or_default();
        if hits.len() >= limit {
            return false;
        }
        hits.push_back(Instant::now());
        true
    }
}

pub struct Refusals {
    counts: Mutex<HashMap<&'static str, u64>>,
}
impl Default for Refusals {
    fn default() -> Self {
        Self {
            counts: Mutex::new(HashMap::new()),
        }
    }
}
impl Refusals {
    pub fn count(&self, code: &'static str) {
        *self
            .counts
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(code)
            .or_default() += 1;
    }
    pub fn flush(&self) {
        for (code, count) in self
            .counts
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .drain()
        {
            tracing::info!(operation = "request.refused", code, count, "refusals");
        }
    }
}
