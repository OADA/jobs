import moment, { Moment } from 'moment';
import pTimeout from 'p-timeout';
import { OADAClient } from '@oada/client';

import { Service } from './Service';
import { Job } from './Job';
import { Logger } from './Logger';

import { info, debug, error, trace } from './utils';
import { serviceTree } from './tree';
import { JsonCompatible } from '.';

import { Json } from '.';

/**
 * Manages a job and updates the associated job object as needed
 */
export class Runner {
  private service: Service;
  private jobId: string;
  private job: Job;
  private oada: OADAClient;

  /**
   * Create a Runner
   * @param service The service which the Runner is completing a job for
   * @param jobId The ID of the Job
   * @param job The associated job
   * @param oada The OADAClient to use when runing the job
   */
  constructor(service: Service, jobId: string, job: Job, oada: OADAClient) {
    this.service = service;
    this.jobId = jobId;
    this.job = job;
    this.oada = oada;
  }

  /**
   * Runes the job's associated work function. This function is in charge of
   * detecting success failure and updating the Job object and event logs as
   * appropriate.
   */
  public async run(): Promise<void> {
    // A quick check to ensure job isn't already completed
    if (this.job.status === 'success' || this.job.status === 'failure') {
      debug(`[Runner ${this.jobId}] Job already complete.`);

      // Look for an update associated with the current status. Move to correct
      // event log.
      for (const [, update] of Object.entries(this.job.updates || {})) {
        if (update.status === this.job.status) {
          trace(`[Runner ${this.jobId}] Found job completion time.`);

          return this.finish(this.job.status, {}, update.time);
        }
      }

      trace(`[Runner ${this.jobId}] No completion time found. Using now.`);
      return this.finish(this.job.status, {}, moment());
    }

    try {
      info(`[job ${this.jobId}] Starting`);

      const worker = this.service.getWorker(this.job.type);

      // Anotate the Runner finishing
      await this.postUpdate('started', 'Runner started');

      // NOTE: pTimeout will reject after `worker.timeout` ms and attempt
      // `cancel()` the promise returned by `worker.work`; However, if that
      // promise does not support `cancel()`, then it could still complete even
      // though the event log will show a failure.
      const r = await pTimeout(
        worker.work(this.job, {
          jobId: this.jobId,
          log: new Logger(this),
          oada: this.oada,
        }),
        worker.timeout,
        `Job exceeded the allowed ${worker.timeout} ms running limit`
      );

      info(`[job ${this.jobId}] Successful`);
      await this.finish('success', r, moment());
    } catch (e) {
      error(`[job ${this.jobId}] Failed`);
      trace(`[job ${this.jobId}] Error: %O`, e);

      await this.finish('failure', e, moment());
    }
  }

  /**
   * Posts an update message to the Job's OADA object.
   * @param status The value of the current status
   * @param meta Arbitrary JSON serializeable meta data about update
   */
  public async postUpdate(status: string, meta: Json): Promise<void> {
    await this.oada.post({
      path: `/${this.job.oadaId}/updates`,
      data: {
        status,
        time: moment().toISOString(),
        meta,
      },
    });
  }

  /**
   * Wrap up a job by finalizing the status, storing the result, and moving to
   * the correct event log.
   * @param status Final finish state of the job
   * @param result Arbitrary JSON serializeable result data
   * @param time Finish time of the job
   */
  public async finish<T extends JsonCompatible<T>>(
    status: 'success' | 'failure',
    result: T,
    time: string | Moment
  ): Promise<void> {
    // Update job status and result
    await this.oada.put({
      path: `/${this.job.oadaId}`,
      data: { status, result },
    });

    // Anotate the Runner finishing
    await this.postUpdate(status, 'Runner finshed');

    // Link into success/failure event log
    const date = moment(time).format('YYYY-MM-DD');
    await this.oada.put({
      path: `/bookmarks/services/${this.service.name}/jobs-${status}/day-index/${date}`,
      data: {
        [this.jobId]: {
          _id: this.job.oadaId,
        },
      },
      tree: serviceTree,
    });

    // Remove from job queue
    await this.oada.delete({
      path: `/bookmarks/services/${this.service.name}/jobs/${this.jobId}`,
    });
  }
}
