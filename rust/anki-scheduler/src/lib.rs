// Anki SM-2 scheduler compiled to WASM.
// Vendored from github.com/ankitects/anki (rslib/src/scheduler/states/).
// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

pub mod states;

use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

use states::steps::LearningSteps;
use states::{NormalState, StateContext};

/// Configuration matching Anki's deck options, passed from JS.
#[derive(Serialize, Deserialize)]
pub struct SchedulerConfig {
    pub learn_steps: Vec<f32>,           // in minutes, e.g. [1.0, 10.0]
    pub relearn_steps: Vec<f32>,         // in minutes, e.g. [10.0]
    pub graduating_interval_good: u32,   // days
    pub graduating_interval_easy: u32,   // days
    pub initial_ease_factor: f32,        // e.g. 2.5
    pub hard_multiplier: f32,            // e.g. 1.2
    pub easy_multiplier: f32,            // e.g. 1.3
    pub interval_multiplier: f32,        // e.g. 1.0
    pub maximum_review_interval: u32,    // days, e.g. 36500
    pub leech_threshold: u32,            // e.g. 8
    pub lapse_multiplier: f32,           // e.g. 0.0
    pub minimum_lapse_interval: u32,     // days, e.g. 1
    #[serde(default)]
    pub fuzz_factor: Option<f32>,        // 0.0..1.0, None disables fuzz
}

impl Default for SchedulerConfig {
    fn default() -> Self {
        Self {
            learn_steps: vec![1.0, 10.0],
            relearn_steps: vec![10.0],
            graduating_interval_good: 1,
            graduating_interval_easy: 4,
            initial_ease_factor: 2.5,
            hard_multiplier: 1.2,
            easy_multiplier: 1.3,
            interval_multiplier: 1.0,
            maximum_review_interval: 36500,
            leech_threshold: 8,
            lapse_multiplier: 0.0,
            minimum_lapse_interval: 1,
            fuzz_factor: None,
        }
    }
}

/// Compute the next states for all four ratings given a current card state
/// and scheduler configuration.
///
/// Arguments are JSON strings; returns a JSON string.
/// - `state_json`: a serialized `NormalState`
/// - `config_json`: a serialized `SchedulerConfig`
///
/// Returns: serialized `SchedulingStates` with current, again, hard, good, easy.
#[wasm_bindgen]
pub fn next_states(state_json: &str, config_json: &str) -> String {
    let state: NormalState = match serde_json::from_str(state_json) {
        Ok(s) => s,
        Err(e) => return format!("{{\"error\":\"{}\"}}", e),
    };
    let config: SchedulerConfig = match serde_json::from_str(config_json) {
        Ok(c) => c,
        Err(e) => return format!("{{\"error\":\"{}\"}}", e),
    };

    let ctx = StateContext {
        fuzz_factor: config.fuzz_factor,
        steps: LearningSteps::new(&config.learn_steps),
        graduating_interval_good: config.graduating_interval_good,
        graduating_interval_easy: config.graduating_interval_easy,
        initial_ease_factor: config.initial_ease_factor,
        hard_multiplier: config.hard_multiplier,
        easy_multiplier: config.easy_multiplier,
        interval_multiplier: config.interval_multiplier,
        maximum_review_interval: config.maximum_review_interval,
        leech_threshold: config.leech_threshold,
        relearn_steps: LearningSteps::new(&config.relearn_steps),
        lapse_multiplier: config.lapse_multiplier,
        minimum_lapse_interval: config.minimum_lapse_interval,
    };

    let scheduling_states = state.next_states(&ctx);
    serde_json::to_string(&scheduling_states).unwrap_or_else(|e| format!("{{\"error\":\"{}\"}}", e))
}

/// Get the interval in seconds for a given card state.
/// Handles both InSecs and InDays interval kinds.
#[wasm_bindgen]
pub fn interval_secs(state_json: &str, secs_until_rollover: u32) -> u32 {
    let state: NormalState = match serde_json::from_str(state_json) {
        Ok(s) => s,
        Err(_) => return 0,
    };
    state
        .interval_kind()
        .maybe_as_days(secs_until_rollover)
        .as_seconds()
}

/// Return the default scheduler config as JSON.
#[wasm_bindgen]
pub fn default_config() -> String {
    serde_json::to_string(&SchedulerConfig::default()).unwrap()
}
