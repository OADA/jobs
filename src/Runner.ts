import moment, { Moment } from 'moment';
import pTimeout from 'p-timeout';
import { serializeError } from 'serialize-error';
import type { OADAClient } from '@oada/client';

import type { Service } from './Service.js';
import { Job } from './Job.js';
import { Logger } from './Logger.js';

import { info, debug, error, trace } from './utils.js';
import { serviceTree } from './tree.js';
import type { JsonCompatible } from './index.js';

import type { Json } from '.';
import { onFinish as slackOnFinish } from './finishReporters/slack/index.js';

export class JobError extends Error {
  "JobError"?: string;
  constructor(m: string, t?: string) {
    super(m)

    this["JobError"] = t;
  }
}

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
   * Runs the job's associated work function. This function is in charge of
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

      trace('Posting update to start job');
      // Anotate the Runner finishing
      await this.postUpdate('started', 'Runner started');
      trace('Update posted');

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
    } catch (e: any) {
      error(`[job ${this.jobId}] Failed`);
      trace(`[job ${this.jobId}] Error: %O`, e);

      await this.finish('failure', e, moment(), e["JobError"]);
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
      // since we aren't using tree, we HAVE to set the content type or permissions fail
      contentType: serviceTree.bookmarks.services['*'].jobs.pending['*']._type,
      data: {
        status,
        time: moment().toISOString(),
        meta,
      },
    }).catch(e => {
      error('FAILED TO POST UPDATE TO OADA at /'+this.job.oadaId+'/updates.  status = ', e.status);
      throw e;
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
    time: string | Moment,
    failType?: string
  ): Promise<void> {
    // Update job status and result
    let data = undefined as any;
    if (result === null) {
      data = { status };
    } else {
      data = { status, result };
    }
    if (failType) {
      data = {
        status, result: serializeError(result)
      }
    }
    trace('[job ', this.jobId, ']: putting to job resource the final {status,result} = ', data);
    await this.oada.put({
      path: `/${this.job.oadaId}`,
      data
    });

    // Anotate the Runner finishing
    await this.postUpdate(status, 'Runner finshed');
    if (typeof time === 'string' && !isNaN(+time)) time = moment(+time, 'X');

    // Link into success/failure event log
    const date = moment(time).format('YYYY-MM-DD');
    //const finalpath = `/bookmarks/services/${this.service.name}/jobs/${status}/day-index/${date}`;
    let finalpath : any;
    if (status === 'failure') {
      finalpath = failType ?
        `/bookmarks/services/${this.service.name}/jobs/${status}/${failType}/day-index/${date}`
        : `/bookmarks/services/${this.service.name}/jobs/${status}/unknown/day-index/${date}`

    } else if (status === 'success') {
      finalpath = `/bookmarks/services/${this.service.name}/jobs/${status}/unknown/day-index/${date}`
    }
    info('[job ',this.jobId,' ]: linking job to final resting place at ', finalpath);
    await this.oada.put({
      path: finalpath,
      data: {
        [this.jobId]: {
          _id: this.job.oadaId,
        },
      },
      tree: serviceTree
    });

    // Remove from job queue
    trace('[job ',this.jobId,' ]: removing from jobs queue');
    await this.oada.delete({
      path: `/bookmarks/services/${this.service.name}/jobs/pending/${this.jobId}`,
    });

    // Notify the status reporter if there is one
    try {
      const frs = this.service.opts?.finishReporters;
      if (frs) {
        for (const [i, r] of Object.entries(frs)) {
          trace('Checking finishReporters[%d] for proper status', i);
          if (r.status !== status) {
            continue;
          }
          trace('Have matching status, checking r.type === %s', r.type);
          switch (r.type) {
            case 'slack':
              trace(
                'Handling slack finishReporter, getting final job object from OADA'
              );
              const {job: finaljob } = await Job.fromOada(this.oada, this.job.oadaId);
              trace(
                'Have final job object from OADA, sending to slack finishReporter'
              );
              await slackOnFinish({
                config: r,
                service: this.service,
                finalpath,
                job: finaljob,
                jobId: this.jobId,
                status,
              }); // get the whole final job object
              break;
            default:
              error('Only slack finishReporter is supported, not %s', r.type);
              continue;
          } // switch
        } // for
      } // if
    } catch (e) {
      error('#finishReporters: ERROR: uncaught exception = %O', e);
      throw e;
    }
  }
}