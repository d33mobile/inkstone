// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html
//
// SM-2 paths only — FSRS branches removed for WASM compilation.

use serde::{Deserialize, Serialize};

use super::interval_kind::IntervalKind;
use super::CardState;
use super::ReviewState;
use super::SchedulingStates;
use super::StateContext;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct LearnState {
    pub remaining_steps: u32,
    pub scheduled_secs: u32,
    pub elapsed_secs: u32,
}

impl LearnState {
    pub fn interval_kind(self) -> IntervalKind {
        IntervalKind::InSecs(self.scheduled_secs)
    }

    pub fn next_states(self, ctx: &StateContext) -> SchedulingStates {
        SchedulingStates {
            current: self.into(),
            again: self.answer_again(ctx),
            hard: self.answer_hard(ctx),
            good: self.answer_good(ctx),
            easy: self.answer_easy(ctx).into(),
        }
    }

    fn answer_again(self, ctx: &StateContext) -> CardState {
        if let Some(again_delay) = ctx.steps.again_delay_secs_learn() {
            LearnState {
                remaining_steps: ctx.steps.remaining_for_failed(),
                scheduled_secs: again_delay,
                elapsed_secs: 0,
            }
            .into()
        } else {
            // no steps; graduate immediately
            let (minimum, maximum) = ctx.min_and_max_review_intervals(1);
            let interval = ctx.graduating_interval_good as f32;
            ReviewState {
                scheduled_days: ctx.with_review_fuzz(
                    interval.round().max(1.0),
                    minimum,
                    maximum,
                ),
                ease_factor: ctx.initial_ease_factor,
                ..Default::default()
            }
            .into()
        }
    }

    fn answer_hard(self, ctx: &StateContext) -> CardState {
        if let Some(hard_delay) = ctx.steps.hard_delay_secs(self.remaining_steps) {
            LearnState {
                scheduled_secs: hard_delay,
                elapsed_secs: 0,
                ..self
            }
            .into()
        } else {
            // no steps; graduate immediately
            let (minimum, maximum) = ctx.min_and_max_review_intervals(1);
            let interval = ctx.graduating_interval_good as f32;
            ReviewState {
                scheduled_days: ctx.with_review_fuzz(
                    interval.round().max(1.0),
                    minimum,
                    maximum,
                ),
                ease_factor: ctx.initial_ease_factor,
                ..Default::default()
            }
            .into()
        }
    }

    fn answer_good(self, ctx: &StateContext) -> CardState {
        if let Some(good_delay) = ctx.steps.good_delay_secs(self.remaining_steps) {
            LearnState {
                remaining_steps: ctx.steps.remaining_for_good(self.remaining_steps),
                scheduled_secs: good_delay,
                elapsed_secs: 0,
            }
            .into()
        } else {
            // no more steps; graduate
            let (minimum, maximum) = ctx.min_and_max_review_intervals(1);
            let interval = ctx.graduating_interval_good as f32;
            ReviewState {
                scheduled_days: ctx.with_review_fuzz(
                    interval.round().max(1.0),
                    minimum,
                    maximum,
                ),
                ease_factor: ctx.initial_ease_factor,
                ..Default::default()
            }
            .into()
        }
    }

    fn answer_easy(self, ctx: &StateContext) -> ReviewState {
        let (minimum, maximum) = ctx.min_and_max_review_intervals(1);
        let interval = ctx.graduating_interval_easy;
        ReviewState {
            scheduled_days: ctx.with_review_fuzz(interval as f32, minimum, maximum),
            ease_factor: ctx.initial_ease_factor,
            ..Default::default()
        }
    }
}
