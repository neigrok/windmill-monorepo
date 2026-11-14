use crate::config::{LINGER_PER_PRINCIPAL, LINGER_TOTAL, RESULT_LINGER};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Instant,
};
use tokio::sync::Notify;

#[derive(Clone)]
pub struct Event {
    pub id: u64,
    pub name: &'static str,
    pub data: String,
}

pub struct ResultEntry {
    pub principal: String,
    pub transcription: bool,
    pub reader: AtomicU64,
    pub changed: Notify,
    data: Mutex<ResultData>,
}

struct ResultData {
    events: Vec<Event>,
    bytes: usize,
    ended: Option<Instant>,
    created: Instant,
    evicted: bool,
}

impl ResultEntry {
    pub fn attach(&self) -> u64 {
        let reader = self.reader.fetch_add(1, Ordering::SeqCst) + 1;
        self.changed.notify_waiters();
        reader
    }

    pub fn next(&self, after: u64, reader: u64) -> (Option<Event>, bool) {
        let data = self.data.lock().unwrap_or_else(|e| e.into_inner());
        if data.evicted || self.reader.load(Ordering::SeqCst) != reader {
            return (None, true);
        }
        (
            data.events.iter().find(|event| event.id > after).cloned(),
            data.ended.is_some(),
        )
    }

    pub fn last(&self) -> Option<String> {
        let data = self.data.lock().unwrap_or_else(|e| e.into_inner());
        if data.ended.is_none() || data.evicted {
            return None;
        }
        data.events.last().map(|event| event.data.clone())
    }

    pub fn is_running(&self) -> bool {
        self.data
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .ended
            .is_none()
    }
}

pub struct Results {
    entries: Mutex<HashMap<String, Arc<ResultEntry>>>,
    principal_limit: usize,
    total_limit: usize,
}

impl Default for Results {
    fn default() -> Self {
        Self::new(LINGER_PER_PRINCIPAL, LINGER_TOTAL)
    }
}

impl Results {
    pub fn new(principal_limit: usize, total_limit: usize) -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            principal_limit,
            total_limit,
        }
    }

    pub fn create(&self, id: String, principal: String, transcription: bool) -> Arc<ResultEntry> {
        let entry = Arc::new(ResultEntry {
            principal,
            transcription,
            reader: AtomicU64::new(0),
            changed: Notify::new(),
            data: Mutex::new(ResultData {
                events: vec![],
                bytes: 0,
                ended: None,
                created: Instant::now(),
                evicted: false,
            }),
        });
        self.entries
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id, entry.clone());
        entry
    }

    pub fn get(&self, id: &str) -> Option<Arc<ResultEntry>> {
        self.prune();
        self.entries
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .cloned()
    }

    pub fn push(
        &self,
        entry: &ResultEntry,
        name: &'static str,
        value: serde_json::Value,
        end: bool,
    ) {
        let data = value.to_string();
        {
            let mut state = entry.data.lock().unwrap_or_else(|e| e.into_inner());
            if state.evicted {
                return;
            }
            let id = state.events.last().map_or(1, |event| event.id + 1);
            state.bytes += data.len() + name.len() + 32;
            state.events.push(Event { id, name, data });
            if end {
                state.ended = Some(Instant::now());
            }
        }
        entry.changed.notify_waiters();
        self.prune();
        let entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        let total: usize = entries
            .values()
            .map(|value| value.data.lock().unwrap_or_else(|e| e.into_inner()).bytes)
            .sum();
        if total > self.total_limit {
            let mut data = entry.data.lock().unwrap_or_else(|e| e.into_inner());
            data.evicted = true;
            data.events.clear();
            data.bytes = 0;
            entry.changed.notify_waiters();
        }
    }

    pub fn prune(&self) {
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        let mut totals = HashMap::<String, usize>::new();
        let mut ended = vec![];
        for (id, entry) in entries.iter() {
            let data = entry.data.lock().unwrap_or_else(|e| e.into_inner());
            *totals.entry(entry.principal.clone()).or_default() += data.bytes;
            ended.push((
                data.created,
                id.clone(),
                entry.principal.clone(),
                data.bytes,
                data.ended.is_some_and(|at| at.elapsed() >= RESULT_LINGER) || data.evicted,
            ));
        }
        ended.sort_by_key(|row| row.0);
        let mut remove = vec![];
        for (_, id, principal, bytes, expired) in &ended {
            if *expired || totals[principal] > self.principal_limit {
                remove.push(id.clone());
                *totals.get_mut(principal).unwrap() -= bytes;
            }
        }
        for id in remove {
            if let Some(entry) = entries.remove(&id) {
                let mut data = entry.data.lock().unwrap_or_else(|e| e.into_inner());
                data.evicted = true;
                data.events.clear();
                data.bytes = 0;
                entry.changed.notify_waiters();
            }
        }
    }
}
