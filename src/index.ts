/**
 * @license
 * Copyright 2023 Open Ag Data Alliance
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

declare global {
  interface SymbolConstructor {
    readonly observable: symbol;
  }
}

export {
  Service,
  type WorkerFunction,
  type JobId,
  type FinishReporter,
} from './Service.js';
export { JobError } from './Runner.js';
export { Job } from './Job.js';
export { Logger } from './Logger.js';
export { reportOnItem, type ReportConfig } from './Report.js';
export { postJob, postUpdate } from './utils.js';

export type Json =
  | boolean
  | number
  | string
  | Json[]
  | { [prop: string]: Json | undefined };

export type JsonCompatible<T> = {
  [P in keyof T]: T[P] extends Json
    ? T[P]
    : T[P] extends (() => unknown) | undefined
    ? never
    : Pick<T, P> extends Required<Pick<T, P>>
    ? never
    : JsonCompatible<T[P]>;
};
