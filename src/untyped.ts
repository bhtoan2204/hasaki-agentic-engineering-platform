/** Values typed only by convention at a data boundary: pg rows, JSON request bodies, JSONB step outputs. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- typing these at the source would touch thousands of call sites
export type Untyped = any;
