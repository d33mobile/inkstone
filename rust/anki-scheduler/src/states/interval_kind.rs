// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum IntervalKind {
    InSecs(u32),
    InDays(u32),
}

impl IntervalKind {
    /// Convert seconds-based intervals that pass the day barrier into days.
    pub fn maybe_as_days(self, secs_until_rollover: u32) -> Self {
        match self {
            IntervalKind::InSecs(secs) => {
                if secs >= secs_until_rollover {
                    IntervalKind::InDays(((secs - secs_until_rollover) / 86_400) + 1)
                } else {
                    IntervalKind::InSecs(secs)
                }
            }
            other => other,
        }
    }

    pub fn as_seconds(self) -> u32 {
        match self {
            IntervalKind::InSecs(secs) => secs,
            IntervalKind::InDays(days) => days.saturating_mul(86_400),
        }
    }
}
