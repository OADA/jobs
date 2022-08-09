declare global {
  interface SymbolConstructor {
    readonly observable: symbol;
  }
}

export { Service, WorkerFunction, JobId, FinishReporter } from './Service.js';
export { JobError } from './Runner.js';
export { Job } from './Job.js';
export { Logger } from './Logger.js';
export { ReportConfig } from './Report.js';
export { postJob, postUpdate } from './utils.js';

export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [prop: string]: Json };

export type JsonCompatible<T> = {
  [P in keyof T]: T[P] extends Json
    ? T[P]
    : Pick<T, P> extends Required<Pick<T, P>>
    ? never
    : T[P] extends (() => unknown) | undefined
    ? never
    : JsonCompatible<T[P]>;
};