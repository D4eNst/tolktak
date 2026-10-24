export type LaunchState =
  | { kind: 'check' | 'offline' | 'start'; from: string }
  | { kind: 'download'; from: string; to: string; percent: number; transferred: number; total: number; speed: number }
  | { kind: 'install'; from: string; to: string }
  | { kind: 'failed'; from: string; to: string }
  | { kind: 'manual'; from: string; to: string; required: boolean; platform: string };

export type LaunchAction = 'retry' | 'download' | 'later' | 'quit';
