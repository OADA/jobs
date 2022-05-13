import type { OADAClient } from '@oada/client';
import OADAJob, { assert as assertOADAJob, is as isOADAJob } from '@oada/types/oada/service/job.js';
import { error } from './utils.js';

import type { Json } from './index.js';

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
  public readonly oadaId: string;
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
  constructor(oadaId: string, job: OADAJob) {
    this.oadaId = oadaId;
    this.service = job.service;
    // TODO: Ask @bcherny/json-schema-to-typescript to use Json type
    this.config = job.config as Json;
    this.type = job.type;
    this.status = job.status;
    this.updates = job.updates;
  }

  /**
   * Fetch a Job from an OADA resource ID
   * @param oada Authenticated OADAClient to fetch Job object
   * @param id OADA resource ID of job
   */
  public static async fromOada(oada: OADAClient, oadaId: string): Promise<FromOada> {
    let r = await oada.get({
      path: `/${oadaId}`,
    });
    // There is an odd bug with tree puts that the resource could be empty the first time
    // you get it b/c the change is emitted BEFORE the actual job data is written.
    // Therefore, if this job does not pass the assertion, try getting it a second time
    // before giving up on it.
    try {
      assertOADAJob(r.data);
    } catch(e) {
      // Try a second time...
      r = await oada.get({
        path: `/${oadaId}`,
      });
    }

    // Now do the *real* assertion
    const job = r.data;
    let isJob = isOADAJob(job);
    if (!isJob) {
      error('Job at '+oadaId+' FAILED OADAJob type assertion: ', job);
    }

    // @ts-ignore
    // Because its an oada resource, job will be an object. The job
    // constructor shouldn't explode as is.
    return {job: new Job(oadaId, job), isJob}
  }
}