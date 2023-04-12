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

import Bluebird from 'bluebird';
import moment from 'moment';

import type { Link } from '@oada/types/oada.js';
import type { OADAClient } from '@oada/client';
import type OADAJobs from '@oada/types/oada/service/jobs.js';
import type OADAJobsChange from '@oada/types/oada/service/jobs-change.js';
//TODO: Fix this type and get it back in here
//import { assert as assertJobs } from '@oada/types/oada/service/jobs-change.js';

import { Job } from './Job.js';
import { Runner } from './Runner.js';
import type { Service } from './Service.js';

import { debug, error, info, stripResource, trace } from './utils.js';
import { tree } from './tree.js';

/**
 * Manages watching of a particular job queue
 */
export class Queue {
  private readonly id: string;
  private readonly oada: OADAClient;
  private readonly service: Service;

  /**
   * Creates queue watcher
   * @param service The `Service` which the watch is operating under
   * @param domainOrOada The domain of the queue to watch, or an existing OADA client to use
   * @param token? The token for the queue to watch, or undefined if an OADA client was passed
   */
  constructor(
    service: Service,
    id: string,
    domainOrOada: string | OADAClient,
    token?: string
  ) {
    this.id = id;
    this.service = service;
    if (typeof domainOrOada === 'string') {
      this.oada = service.getClient(domainOrOada).clone(token ?? '');
    } else {
      debug(
        '[Queue ',
        id,
        ']: Using default existing OADA connection for default queue'
      );
      this.oada = domainOrOada;
    }
  }

  /**
   * Opens the WATCH and begins procesing jobs
   */
  private watchRequestId: string | string[] = '';
  public async start(skipQueue = false): Promise<void> {
    const root = `/bookmarks/services/${this.service.name}`;
    const jobspath = `${root}/jobs/pending`;
    const successpath = `${root}/jobs/success`;
    const failurepath = `${root}/jobs/failure`;

    try {
      // Ensure the job queue exists
      try {
        await this.oada.head({ path: jobspath });
      } catch (error_: any) {
        if (error_.status !== 404) {
          throw error_ as Error;
        }

        await this.oada.put({ path: jobspath, data: {}, tree });
      }

      // Ensure the success list exists
      try {
        await this.oada.head({ path: successpath });
      } catch (error_: any) {
        if (error_.status !== 404) {
          throw error_ as Error;
        }

        await this.oada.put({ path: successpath, data: {}, tree });
      }

      // Ensure the failure list exists
      try {
        await this.oada.head({ path: failurepath });
      } catch (error_: any) {
        if (error_.status !== 404) {
          throw error_ as Error;
        }

        await this.oada.put({ path: failurepath, data: {}, tree });
      }

      let r: any;

      if (skipQueue) {
        info('Skipping existing jobs in the queue prior to startup.');
      } else {
        info(`[QueueId ${this.id}] Getting initial set of jobs`);
        r = await this.oada.get({ path: jobspath });

        if (r.status !== 200) {
          throw new Error(
            `[QueueId ${this.id}] Could not retrieve job queue list`
          );
        }

        // Clean up the resource and grab all existing jobs to run them before starting watch
        trace(`[QueueId ${this.id}] Adding existing jobs`);
        const jobs = stripResource(r.data);
        //assertJobs(jobs);
        this.#doJobs(jobs);
        trace(
          Object.keys(jobs).length,
          ' existing jobs added and doJobs is complete, starting watch.'
        );
      }

      // Store the rev before we stripResource to start watch from later
      const watchopts: { path: string; rev?: number } = { path: jobspath };
      if (
        r?.data &&
        typeof r.data === 'object' &&
        '_rev' in r.data &&
        typeof r.data._rev === 'number'
      ) {
        trace(
          '[QueueId ',
          this.id,
          '] Initial jobs list at rev',
          r.data._rev,
          ', starting watch from that point'
        );
        watchopts.rev = r.data._rev;
      }

      // Watch will be started from rev that we just processed
      const { changes, requestId } = await this.oada.watch(watchopts);
      this.watchRequestId = requestId;
      // Wrap for..await in async function that we do not "await";
      (async () => {
        for await (const change of changes) {
          trace('[QueueId %s] received change: ', this.id, change);
          if (change.type !== 'merge') continue;

          // Catch error in callback to avoid nodejs crash on error
          try {
            const jobs = stripResource(change.body);
            //assertJobs(jobs);
            trace(
              '[QueueId %s] jobs found in change:',
              this.id,
              Object.keys(jobs)
            );
            this.#doJobs(jobs as OADAJobsChange);
          } catch (error_) {
            trace('The change was not a `Jobs`, %O', error_);
            // Shouldn't it fail the job?
          }
        }

        error('***ERROR***: the for...await looking for changes has exited');
      })();

      info(`[QueueId ${this.id}] Started WATCH.`);
    } catch (error_) {
      error(`[QueueId: ${this.id}] Failed to start WATCH, %O`, error_);
      throw new Error(`Failed to start watch ${this.id}`);
    }
  }

  /**
   * Closes the WATCH
   */
  public async stop(): Promise<void> {
    // I'm not sure in what scenario requestid would be an array of strings, but that's its type.
    const array = Array.isArray(this.watchRequestId)
      ? this.watchRequestId
      : [this.watchRequestId];
    info(`[QueueId: ${this.id}] Stopping WATCH`);
    // Stop all our watches:
    await Promise.all(
      array.map((requestid) => {
        if (requestid === '') return;
        return this.oada.unwatch(requestid);
      })
    );
    this.watchRequestId = '';
  }

  /**
   * Helper function to create and start jobs from the queue
   */
  async #doJobs(jobs: OADAJobs | OADAJobsChange): Promise<void> {
    // Queue up the Runners in parallel
    await Bluebird.map(
      Object.entries(jobs),
      async ([jobId, value]) => {
        const { _id } = value as Link;
        if (!_id) return;
        // Fetch the job
        const { job, isJob } = await Job.fromOada(this.oada, _id);

        // Instantiate a runner to manage the job
        const runner = new Runner(this.service, jobId, job, this.oada);

        if (!isJob) {
          runner.finish('failure', {}, moment());
        }

        trace(`[QueueId: ${this.id}] Starting runner for ${jobId}`);
        await runner.run();
      },
      { concurrency: 100 }
    );
  }
}