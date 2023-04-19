/**
 * @license
 * Copyright 2023 Qlever LLC
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

import moment, { type Moment } from 'moment';
import pTimeout, { TimeoutError } from 'p-timeout';
import { serializeError } from 'serialize-error';

import type { OADAClient } from '@oada/client';

import type { Json, JsonCompatible } from './index.js';
import { debug, error, info, trace } from './utils.js';
import { Job } from './Job.js';
import { Logger } from './Logger.js';
import type { Service } from './Service.js';
import { tree } from './tree.js';

import { onFinish as slackOnFinish } from './finishReporters/slack/index.js';

export class JobError extends Error {
  'JobError'?: string;
  'constructor'(m: string, t?: string) {
    super(m);

    this.JobError = t;
  }
}

/**
 * Manages a job and updates the associated job object as needed
 */
export class Runner {
  readonly #service: Service;
  readonly #jobKey: string;
  readonly #job: Job;
  readonly #oada: OADAClient;

  /**
   * Create a Runner
   * @param service The service which the Runner is completing a job for
   * @param jobKey The key used in the lists of the Job
   * @param job The associated job
   * @param oada The OADAClient to use when runing the job
   */
  constructor(
    service: Service,
    jobKey: string,
    job: Job,
    oada: OADAClient,
  ) {
    this.#service = service;
    this.#jobKey = jobKey;
    this.#job = job;
    this.#oada = oada;
  }

  /**
   * Runs the job's associated work function. This function is in charge of
   * detecting success failure and updating the Job object and event logs as
   * appropriate.
   */
  public async run(): Promise<void> {
    // A quick check to ensure job isn't already completed
    if (this.#job.status === 'success' || this.#job.status === 'failure') {
      debug(`[Runner ${this.#job.oadaId}] Job already complete.`);

      // Look for an update associated with the current status. Move to correct
      // event log.
      for (const [, update] of Object.entries(this.#job.updates ?? {})) {
        if (update.status === this.#job.status) {
          trace(`[Runner ${this.#job.oadaId}] Found job completion time.`);

          return this.finish(this.#job.status, {}, update.time);
        }
      }

      trace(`[Runner ${this.#job.oadaId}] No completion time found. Using now.`);
      return this.finish(this.#job.status, {}, moment());
    }

    try {
      info(`[job ${this.#job.oadaId}] Starting`);

      const worker = this.#service.getWorker(this.#job.type);

      trace('Posting update to start job');
      // Annotate the Runner finishing
      await this.postUpdate('started', 'Runner started');
      trace('Update posted');

      // NOTE: pTimeout will reject after `worker.timeout` ms and attempt
      // `cancel()` the promise returned by `worker.work`; However, if that
      // promise does not support `cancel()`, then it could still complete even
      // though the event log will show a failure.
      const r = await pTimeout(
        worker.work(this.#job, {
          jobId: this.#job.oadaId,
          log: new Logger(this),
          oada: this.#oada,
        }),
        {
          milliseconds: worker.timeout,
          message: `Job exceeded the allowed ${worker.timeout} ms running limit`,
        }
      );

      info(`[job ${this.#job.oadaId}] Successful`);
      await this.finish('success', r, moment());
    } catch (error_: any) {
      error(`[job ${this.#job.oadaId}] Failed`);
      trace(`[job ${this.#job.oadaId}] Error: %O`, error_);

      await (error_ instanceof TimeoutError
        ? this.finish('failure', error_, moment(), 'timeout')
        : this.finish('failure', error_, moment(), error_.JobError));
    }
  }

  /**
   * Posts an update message to the Job's OADA object.
   * @param status The value of the current status
   * @param meta Arbitrary JSON serializeable meta data about update
   */
  public async postUpdate(status: string, meta: Json): Promise<void> {
    try {
      await this.#oada.post({
        path: `/${this.#job.oadaId}/updates`,
        // Since we aren't using tree, we HAVE to set the content type or permissions fail
        contentType: tree.bookmarks!.services!['*']!.jobs!.pending!['*']!._type,
        data: {
          status,
          time: moment().toISOString(),
          meta,
        },
      });
    } catch (error_: any) {
      error(
        `FAILED TO POST UPDATE TO OADA at /${
          this.#job.oadaId
        }/updates.  status = `,
        error_.status
      );
      throw error_ as Error;
    }
  }

  /**
   * Wrap up a job by finalizing the status, storing the result, and moving to
   * the correct event log.
   * @param status Final finish state of the job
   * @param result Arbitrary JSON serializeable result data
   * @param time Finish time of the job
   */
  public async finish<T extends Json | JsonCompatible<T>>(
    status: 'success' | 'failure',
    result: T,
    time: string | Moment,
    failType?: string
  ): Promise<void> {
    // Update job status and result
    let data;
    data = result === null ? { status } : { status, result };
    if (failType ?? result instanceof Error) {
      data = {
        status,
        result: serializeError(result),
      };
    }

    trace(
      `[job ${this.#job.oadaId} ]: putting to job resource the final {status,result} = ${data}`);
    await this.#oada.put({
      path: `/${this.#job.oadaId}`,
      data,
    });

    // Annotate the Runner finishing
    await this.postUpdate(status, 'Runner finshed');
    if (typeof time === 'string' && !Number.isNaN(Number(time))) {
      time = moment(Number(time), 'X');
    }

    // Link into success/failure event log
    const date = moment(time).format('YYYY-MM-DD');
    // Const finalpath = `/bookmarks/services/${this.service.name}/jobs/${status}/day-index/${date}`;
    let finalpath: string | undefined;
    if (status === 'failure') {
      finalpath = failType
        ? `/bookmarks/services/${
            this.#service.name
          }/jobs/${status}/${failType}/day-index/${date}`
        : `/bookmarks/services/${
            this.#service.name
          }/jobs/${status}/unknown/day-index/${date}`;
    } else if (status === 'success') {
      finalpath = `/bookmarks/services/${
        this.#service.name
      }/jobs/${status}/day-index/${date}`;
    }

    info(`[job ${this.#job.oadaId} ]: linking job to final resting place at ${finalpath}`);
    await this.#oada.put({
      path: finalpath!,
      data: {
        [this.#jobKey]: {
          _id: this.#job.oadaId,
          _rev: 0,
        },
      },
      tree,
    });

    // Remove from job queue
    trace(`[job ${this.#job.oadaId} ]: removing from jobs queue`);
    await this.#oada.delete({
      path: `/bookmarks/services/${this.#service.name}/jobs/pending/${
        this.#jobKey
      }`,
    });

    // Notify the status reporter if there is one
    try {
      const frs = this.#service.opts?.finishReporters;
      if (frs) {
        for await (const [index, r] of Object.entries(frs)) {
          trace('Checking finishReporters[%d] for proper status', index);
          if (r.status !== status) {
            continue;
          }

          trace('Have matching status, checking r.type === %s', r.type);
          // eslint-disable-next-line sonarjs/no-small-switch
          switch (r.type) {
            case 'slack': {
              trace(
                'Handling slack finishReporter, getting final job object from OADA'
              );
              const { job: finaljob } = await Job.fromOada(
                this.#oada,
                this.#job.oadaId
              );
              trace(
                'Have final job object from OADA, sending to slack finishReporter'
              );
              await slackOnFinish({
                config: r,
                service: this.#service,
                finalpath: finalpath!,
                job: finaljob,
                jobId: this.#job.oadaId,
                status,
              }); // Get the whole final job object
              break;
            }

            default: {
              error('Only slack finishReporter is supported, not %s', r.type);
              continue;
            }
          } // Switch
        } // For
      } // If
    } catch (error_) {
      error('#finishReporters: ERROR: uncaught exception = %O', error_);
      throw error_;
    }
  }
}
