// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html
//
// SM-2 scheduler states — FSRS, filtered decks, and load balancer stripped
// for standalone WASM compilation.

pub mod fuzz;
pub mod interval_kind;
pub mod learning;
pub mod new;
pub mod normal;
pub mod relearning;
pub mod review;
pub mod steps;

pub use interval_kind::IntervalKind;
pub use learning::LearnState;
pub use new::NewState;
pub use normal::NormalState;
pub use relearning::RelearnState;
pub use review::ReviewState;

use serde::{Deserialize, Serialize};

use self::steps::LearningSteps;

// CardState is now just NormalState (no filtered deck wrapping).
pub type CardState = NormalState;

/// Info required during state transitions.
pub struct StateContext<'a> {
    /// In range `0.0..1.0`. Used to pick the final interval from the fuzz
    /// range.
    pub fuzz_factor: Option<f32>,
    // learning
    pub steps: LearningSteps<'a>,
    pub graduating_interval_good: u32,
    pub graduating_interval_easy: u32,
    pub initial_ease_factor: f32,

    // reviewing
    pub hard_multiplier: f32,
    pub easy_multiplier: f32,
    pub interval_multiplier: f32,
    pub maximum_review_interval: u32,
    pub leech_threshold: u32,

    // relearning
    pub relearn_steps: LearningSteps<'a>,
    pub lapse_multiplier: f32,
    pub minimum_lapse_interval: u32,
}

impl StateContext<'_> {
    /// Return the minimum and maximum review intervals.
    /// - `maximum` is `self.maximum_review_interval`, but at least 1.
    /// - `minimum` is as passed, but at least 1, and at most `maximum`.
    pub fn min_and_max_review_intervals(&self, minimum: u32) -> (u32, u32) {
        let maximum = self.maximum_review_interval.max(1);
        let minimum = minimum.clamp(1, maximum);
        (minimum, maximum)
    }

    #[cfg(test)]
    pub fn defaults_for_testing() -> Self {
        Self {
            fuzz_factor: None,
            steps: LearningSteps::new(&[1.0, 10.0]),
            graduating_interval_good: 1,
            graduating_interval_easy: 4,
            initial_ease_factor: 2.5,
            hard_multiplier: 1.2,
            easy_multiplier: 1.3,
            interval_multiplier: 1.0,
            maximum_review_interval: 36500,
            leech_threshold: 8,
            relearn_steps: LearningSteps::new(&[10.0]),
            lapse_multiplier: 0.0,
            minimum_lapse_interval: 1,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchedulingStates {
    pub current: CardState,
    pub again: CardState,
    pub hard: CardState,
    pub good: CardState,
    pub easy: CardState,
}

// From impls are defined in normal.rs (CardState = NormalState)

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn min_and_max_review_intervals() {
        let mut ctx = StateContext::defaults_for_testing();
        ctx.maximum_review_interval = 0;
        assert_eq!(ctx.min_and_max_review_intervals(0), (1, 1));
        assert_eq!(ctx.min_and_max_review_intervals(2), (1, 1));
        ctx.maximum_review_interval = 3;
        assert_eq!(ctx.min_and_max_review_intervals(0), (1, 3));
        assert_eq!(ctx.min_and_max_review_intervals(2), (2, 3));
        assert_eq!(ctx.min_and_max_review_intervals(4), (3, 3));
    }
}
