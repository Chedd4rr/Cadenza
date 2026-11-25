//! A small key-value store for the page (cached playlist tags, Up Next, true-shuffle lists…), saved as
//! store.json. Changes are written a second later, all at once, on a background thread.

use serde_json::{Map, Value};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::files;

pub struct Store {
    data: Mutex<Map<String, Value>>,
    scheduled: Mutex<bool>,
}

impl Store {
    pub fn load() -> Arc<Self> {
        let mut data = match files::read_json("store.json") { Some(Value::Object(m)) => m, _ => Map::new() };
        // Older builds kept a copy of every playlist version ("trueShuffle:<id>:<version>" as a plain list).
        data.retain(|k, v| !(k.starts_with("trueShuffle:") && v.is_array()));
        Arc::new(Store { data: Mutex::new(data), scheduled: Mutex::new(false) })
    }

    pub fn get(&self, key: &str) -> Value {
        self.data.lock().unwrap().get(key).cloned().unwrap_or(Value::Null)
    }

    pub fn set(self: &Arc<Self>, key: &str, value: Value) {
        {
            let mut d = self.data.lock().unwrap();
            if value.is_null() { d.remove(key); } else { d.insert(key.into(), value); }
        }
        let mut s = self.scheduled.lock().unwrap();
        if *s { return; }
        *s = true;
        let me = Arc::clone(self);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(1));
            me.flush();
        });
    }

    /// Write anything pending right away (also used when Cadenza quits).
    pub fn flush(&self) {
        *self.scheduled.lock().unwrap() = false;
        let snapshot = Value::Object(self.data.lock().unwrap().clone());
        files::write_json("store.json", &snapshot);
    }
}
