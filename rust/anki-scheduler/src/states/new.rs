// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

use serde::{Deserialize, Serialize};

use super::interval_kind::IntervalKind;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct NewState {
    pub position: u32,
}

impl NewState {
    pub fn interval_kind(self) -> IntervalKind {
        IntervalKind::InSecs(0)
    }
}
