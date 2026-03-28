/* tslint:disable */
/* eslint-disable */

/**
 * Return the default scheduler config as JSON.
 */
export function default_config(): string;

/**
 * Get the interval in seconds for a given card state.
 * Handles both InSecs and InDays interval kinds.
 */
export function interval_secs(state_json: string, secs_until_rollover: number): number;

/**
 * Compute the next states for all four ratings given a current card state
 * and scheduler configuration.
 *
 * Arguments are JSON strings; returns a JSON string.
 * - `state_json`: a serialized `NormalState`
 * - `config_json`: a serialized `SchedulerConfig`
 *
 * Returns: serialized `SchedulingStates` with current, again, hard, good, easy.
 */
export function next_states(state_json: string, config_json: string): string;
