import { OADAClient } from '@oada/client';
import OADAJobs, { assert as assertJobs } from '@oada/types/oada/service/jobs';

import { Service } from './Service';
import { Job } from './Job';
import { Runner } from './Runner';

import { stripResource, error, info, debug, trace } from './utils';
import { serviceTree } from './tree';

/**
 * Manages watching of a particular job queue
 */
export class Queue {
  private id: string;
  private oada: OADAClient;
  private service: Service;
  private requestId?: string;

  /**
   * Creates queue watcher
   * @param service The `Service` which the watch is operating under
   * @param domain The domain of the queue to watch
   * @param token The token for the queue to watch
   */
  constructor(service: Service, id: string, domain: string, token: string) {
    this.id = id;
    this.service = service;
    this.oada = service.getClient(domain).clone(token);
  }

  /**
   * Opens the WATCH and begins procesing jobs
   */
  public async start(): Promise<void> {
    const path = `/bookmarks/services/${this.service.name}/jobs`;

    try {
      // Ensure the job queue exists
      await this.oada.put({
        path,
        data: {},
        tree: serviceTree,
      });

      info(`[QueueId ${this.id}] Getting initial set of jobs`);
      const r = await this.oada.get({
        path,
        watchCallback: (change) => {
          if (change.type !== 'merge') {
            return;
          }

          // catch error in callback to avoid nodejs crash on error
          try {
            const jobs = stripResource(change.body);
            assertJobs(jobs);
            this.doJobs(jobs);
          } catch (e) {
            debug('Received a change that was not a `Jobs`, %O', e);
          }
        },
      });
      info(`[QueueId ${this.id}] Started WATCH.`);

      if (r.status !== 200) {
        throw new Error(
          `[QueueId ${this.id}] Could not retrieve job queue list`
        );
      }

      trace(`[QueueId ${this.id}] Adding existing jobs`);
      stripResource(r.data);
      assertJobs(r.data);
      await this.doJobs(r.data);
    } catch (e) {
      error(`[QueueId: ${this.id}] Failed to start WATCH, %O`, e);
      throw new Error(`Failed to start watch ${this.id}: ${e}`);
    }
  }

  /**
   * Closes the WATCH
   */
  public async stop(): Promise<void> {
    if (this.requestId) {
      info(`[QueueId: ${this.id}] Stopping WATCH`);
      await this.oada.unwatch(this.requestId);
      this.requestId = undefined;
    }
  }

  /**
   * Helper function to create and start jobs from the queue
   */
  private async doJobs(jobs: OADAJobs): Promise<void> {
    // Queue up the Runners in parallel
    await Promise.all(
      Object.keys(jobs).map(async (jobId) => {
        // Fetch the job
        const job = await Job.fromOada(this.oada, jobs[jobId]._id);

        // Instantiate a runner to manage the job
        const runner = new Runner(this.service, jobId, job, this.oada);

        trace(`[QueueId: ${this.id}] Starting runner for ${jobId}`);
        await runner.run();
      })
    );
  }
}
