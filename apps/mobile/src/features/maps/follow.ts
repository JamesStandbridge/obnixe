/** Camera follow on the live map (MAP-011): a gesture suspends it until a recenter or 15 s without gestures. */

export const followResumeDelayMs = 15_000;

export interface FollowState {
  readonly following: boolean;
  readonly lastGestureAt: number | null;
}

export type FollowEvent = { readonly type: "gesture"; readonly at: number } | { readonly type: "recenter" } | { readonly type: "tick"; readonly at: number };

export const initialFollow: FollowState = { following: true, lastGestureAt: null };

export function follow(state: FollowState, event: FollowEvent): FollowState {
  switch (event.type) {
    case "gesture":
      return { following: false, lastGestureAt: event.at };
    case "recenter":
      return state.following ? state : { following: true, lastGestureAt: null };
    case "tick":
      if (state.following || state.lastGestureAt === null || event.at - state.lastGestureAt < followResumeDelayMs) return state;
      return { following: true, lastGestureAt: null };
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
}
