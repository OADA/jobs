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

import {
  type JobSchema,
  assert as assertOADAJob,
  is as isOADAJob,
} from '@oada/types/oada/service/job.js';
import type { OADAClient } from '@oada/client';
import type OADAJob from '@oada/types/oada/service/job.js';

import type { Json } from './index.js';
import { error } from './utils.js';

export interface FromOada {
  job: Job;
  isJob: boolean;
}

export interface JobUpdate {
  status: string;
  time: string;
  // TODO: Ask @bcherny/json-schema-to-typescript to use Json type
  meta?: unknown;
}

/**
 * Holds job data
 */
export class Job {
  /**
   * Fetch a Job from an OADA resource ID
   * @param oada Authenticated OADAClient to fetch Job object
   * @param id OADA resource ID of job
   */
  public static async fromOada(
    oada: OADAClient,
    oadaId: string,
  ): Promise<FromOada> {
    let r = await oada.get({
      path: `/${oadaId}`,
    });
    // There is an odd bug with tree puts that the resource could be empty the first time
    // you get it b/c the change is emitted BEFORE the actual job data is written.
    // Therefore, if this job does not pass the assertion, try getting it a second time
    // before giving up on it.
    try {
      assertOADAJob(r.data);
    } catch {
      // Try a second time...
      r = await oada.get({
        path: `/${oadaId}`,
      });
    }

    // Now do the *real* assertion
    const job = r.data;
    const isJob = isOADAJob(job);
    if (!isJob) {
      error({ job }, `Job at ${oadaId} FAILED OADAJob type assertion`);
    }

    // Because its an oada resource, job will be an object. The job
    // constructor shouldn't explode as is.
    return { job: new Job(oadaId, job as unknown as JobSchema), isJob };
  }

  public readonly service: string;
  public readonly type: string;
  public readonly config: Json;
  public readonly status?: string;
  public readonly updates?: Record<string, JobUpdate>;

  /**
   * Creates a Job class
   * @param oadaId Job ID
   * @param job OADA Job object
   */
  constructor(
    public readonly oadaId: string,
    job: OADAJob,
  ) {
    this.service = job.service;
    // TODO: Ask @bcherny/json-schema-to-typescript to use Json type
    this.config = job.config as Json;
    this.type = job.type;
    this.status = job.status;
    this.updates = job.updates;
  }
}
