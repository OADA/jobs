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

import type { JsonCompatible } from "./index.js";
import type { Runner } from "./Runner.js";

/**
 * Manages logging updates to a running job.
 */
export class Updater {
  /**
   * Create a Updater.
   * @param _runner The runner of the job
   */
  constructor(private readonly _runner: Runner) {}

  public async info<T extends JsonCompatible<T>>(
    status: string,
    meta: T,
  ): Promise<void> {
    await this._runner.postUpdate(status, meta);
  }

  public async debug<T extends JsonCompatible<T>>(
    status: string,
    meta: T,
  ): Promise<void> {
    if (process.env.OADA_JOBS_LOGGING?.includes("debug")) {
      await this._runner.postUpdate(status, meta);
    }
  }

  public async trace<T extends JsonCompatible<T>>(
    status: string,
    meta: T,
  ): Promise<void> {
    if (process.env.OADA_JOBS_LOGGING?.includes("trace")) {
      await this._runner.postUpdate(status, meta);
    }
  }

  public async error<T extends JsonCompatible<T>>(
    status: string,
    meta: T,
  ): Promise<void> {
    await this._runner.postUpdate(status, meta);
  }
}
