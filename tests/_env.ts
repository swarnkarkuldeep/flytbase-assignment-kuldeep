// Imported FIRST by tests that run the sync queue: module-level settings (the call gap) are read when lib/plan.ts
// loads, so the environment has to be set before any lib import runs. ES imports evaluate in order.
process.env.AQ_MIN_GAP_MS = "80";
process.env.AQ_WRITE_NOTES = "0";
process.env.AQ_TOKEN = "test-token";
