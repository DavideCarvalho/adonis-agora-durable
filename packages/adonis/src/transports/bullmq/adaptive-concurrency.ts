// The adaptive controller is transport-neutral (the queue transport drives it too); it lives in
// `../adaptive-concurrency.ts`. Re-exported here so existing imports keep working.
export * from '../adaptive-concurrency.js';
