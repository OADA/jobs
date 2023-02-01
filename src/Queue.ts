import bluebird from 'bluebird';
import moment from 'moment';
import type { OADAClient } from '@oada/client';
import OADAJobs, { assert as assertJobs } from '@oada/types/oada/service/jobs.js';

import type { Service } from './Service.js';
import { Job } from './Job.js';
import { Runner } from './Runner.js';

import { stripResource, error, info, debug, trace } from './utils.js';
import { tree } from './tree.js';

/**
 * Manages watching of a particular job queue
 */
export class Queue {
  private id: string;
  private oada: OADAClient;
  private service: Service;

  /**
   * Creates queue watcher
   * @param service The `Service` which the watch is operating under
   * @param domain_or_oada The domain of the queue to watch, or an existing OADA client to use
   * @param token? The token for the queue to watch, or undefined if an OADA client was passed
   */
  constructor(service: Service, id: string, domain_or_oada: string | OADAClient, token?: string) {
    this.id = id;
    this.service = service;
    if (typeof domain_or_oada === 'string') {
      this.oada = service.getClient(domain_or_oada).clone(token || '');
    } else {
      debug('[Queue ',id,']: Using default existing OADA connection for default queue');
      this.oada = domain_or_oada;
    }
  }

  /**
   * Opens the WATCH and begins procesing jobs
   */
  private watchRequestId: string | string[] = '';
  public async start(skipQueue: boolean=false): Promise<void> {
    const root = `/bookmarks/services/${this.service.name}`;
    const jobspath = `${root}/jobs/pending`;
    const successpath = `${root}/jobs/success`;
    const failurepath = `${root}/jobs/failure`;

    try {
      // Ensure the job queue exists
      await this.oada.head({ path: jobspath }).catch(async (e: any) => {
        if (e.status !== 404) throw e;
        await this.oada.put({path: jobspath, data: {}, tree });
      });
      // Ensure the success list exists
      await this.oada.head({ path: successpath }).catch(async (e: any) => {
        if (e.status !== 404) throw e;
        await this.oada.put({path: successpath, data: {}, tree });
      });
      // Ensure the failure list exists
      await this.oada.head({ path: failurepath }).catch(async (e: any) => {
        if (e.status !== 404) throw e;
        await this.oada.put({path: failurepath, data: {}, tree });
      });

      let r: any;

      if (!skipQueue) {

        info(`[QueueId ${this.id}] Getting initial set of jobs`);
        r = await this.oada.get({path: jobspath});

        if (r.status !== 200) {
          throw new Error(
            `[QueueId ${this.id}] Could not retrieve job queue list`
          );
        }

        // Clean up the resource and grab all existing jobs to run them before starting watch
        trace(`[QueueId ${this.id}] Adding existing jobs`);
        stripResource(r.data);
        assertJobs(r.data);
        this.doJobs(r.data);
        trace(Object.keys(r.data).length, " existing jobs added and doJobs is complete, starting watch.");
      } else {
        info('Skipping existing jobs in the queue prior to startup.');
      }

      // Store the rev before we stripResource to start watch from later
      const watchopts: { path: string, rev?: number } = { path: jobspath };
      if (r?.data && typeof r.data ==='object' && '_rev' in r.data && typeof r.data._rev === 'number') {
        trace('[QueueId ',this.id,'] Initial jobs list at rev', r.data._rev,', starting watch from that point');
        watchopts.rev = r.data._rev;
      }

      // Watch will be started from rev that we just processed
      const { changes, requestId } = await this.oada.watch(watchopts);
      this.watchRequestId = requestId;
      // Wrap for..await in async funciton that we do not "await";
      (async () => {
        for await (const change of changes) {
          trace('[QueueId %s] received change: ', this.id, change);
          if (change.type !== 'merge') continue;

          // catch error in callback to avoid nodejs crash on error
          try {
            const jobs = stripResource(change.body);
            assertJobs(jobs);
            trace('[QueueId %s] jobs found in change:', this.id, Object.keys(jobs));
            this.doJobs(jobs);
          } catch (e) {
            trace('The change was not a `Jobs`, %O', e);
            // Shouldn't it fail the job?
          }
        }
        error('***ERROR***: the for...await looking for changes has exited');
      })();
      info(`[QueueId ${this.id}] Started WATCH.`);

    } catch (e) {
      error(`[QueueId: ${this.id}] Failed to start WATCH, %O`, e);
      throw new Error(`Failed to start watch ${this.id}`);
    }
    return;
  }

  /**
   * Closes the WATCH
   */
  public async stop(): Promise<void> {
    // I'm not sure in what scenario requestid would be an array of strings, but that's its type.
    let arr: string[];
    if (Array.isArray(this.watchRequestId)) {
      arr = this.watchRequestId;
    } else {
      arr = [ this.watchRequestId ];
    }
    info(`[QueueId: ${this.id}] Stopping WATCH`);
    // Stop all our watches:
    await Promise.all(arr.map(requestid => {
      if (requestid === '') return;
      return this.oada.unwatch(requestid);
    }));
    this.watchRequestId = '';
  }

  /**
   * Helper function to create and start jobs from the queue
   */
  private async doJobs(jobs: OADAJobs): Promise<void> {
    // Queue up the Runners in parallel
    await bluebird.map(
      Object.keys(jobs),
      async (jobId) => {
        // Fetch the job
        const { job, isJob } = await Job.fromOada(this.oada, jobs[jobId]!._id);

        // Instantiate a runner to manage the job
        const runner = new Runner(this.service, jobId, job, this.oada);

        if (!isJob) {
          runner.finish('failure', {}, moment())
        }

        trace(`[QueueId: ${this.id}] Starting runner for ${jobId}`);
        await runner.run();
      },
      { concurrency: 100 }
    );
  }
}