// The review's words that are said outside its screen too (Review.tsx): by `tachi review` (sandbox/copies.ts), the
// launch (clilib.ts) and the session's end (app/queue.ts). Here, in a file that draws nothing, so a run without a screen
// loads no screen code to say them (cleanup plan, step 14a).

// The plan's words (release 7 plan, Task 20).
export const discardAsked = (keys: string) => `Discard the copy and every change in it? [${keys}]`;
// The rest are Task 20's drafts, for the user's approval.
export const leftOut = (rel: string, why: string) => `Left out, never applied: ${rel} (${why})`; // the launch's too (clilib.ts)
export const kept = (session: string) => `The copy is kept; tachi review ${session} opens it again.`;
export const DISCARDED = "The copy was discarded.";
export const removing = (n: number) => `Removing the copy (${n} file${n === 1 ? "" : "s"})...`;
export const notRemoved = (why: string, folder: string) => `The copy could not be removed (${why}); delete ${folder} by hand.`;
