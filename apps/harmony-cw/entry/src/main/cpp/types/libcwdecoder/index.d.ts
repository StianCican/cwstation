export interface Snapshot {
  text: string;
  running: boolean;
  level: number;
  peak: number;
  droppedSamples: number;
  truncated: number;
  error: string;
  format: string;
}
export const start: () => Promise<void>;
export const stop: () => Promise<void>;
export const drain: () => Snapshot;
export const clear: () => void;
