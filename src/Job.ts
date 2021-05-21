import type { OADAClient } from '@oada/client';
import OADAJob, { assert as assertOADAJob } from '@oada/types/oada/service/job';

import type { Json } from '.';

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
  public static async fromOada(oada: OADAClient, oadaId: string): Promise<Job> {
    const r = await oada.get({
      path: `/${oadaId}`,
    });

    const job = r.data;
    assertOADAJob(job);

    return new Job(oadaId, job);
  }
}
