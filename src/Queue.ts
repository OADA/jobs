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
import "@oada/pino-debug";
import type { OADAClient } from "@oada/client";
import type OADAJobs from "@oada/types/oada/service/jobs.js";
import type OADAJobsChange from "@oada/types/oada/service/jobs-change.js";
import type { Link } from "@oada/types/oada.js";
import dayjs from "dayjs";
import PQueue from "p-queue";

// TODO: Fix this type and get it back in here
// import { assert as assertJobs } from '@oada/types/oada/service/jobs-change.js';

import { Job } from "./Job.js";
import { Runner } from "./Runner.js";
import type { Service } from "./Service.js";
import { tree } from "./tree.js";
import { error, info, stripResource, trace } from "./utils.js";

/**
 * Manages watching of a particular job queue
 */
export class Queue {
  #watchRequestId: string | string[] = "";
  readonly #oada: OADAClient;
  readonly #queue: PQueue;
  readonly #service;

  /**
   * Creates queue watcher
   * @param _service The `Service` which the watch is operating under
   * @param token? The token for the queue to watch, or undefined if an OADA client was passed
   */
  constructor(
    _service: Service,
    private readonly _id: string,
  ) {
    this.#service = _service;
    this.#oada = _service.getClient(); // .clone(token ?? '');
    this.#queue = new PQueue({ concurrency: this.#service.concurrency });
  }

  /**
   * Opens the WATCH and begins processing jobs
   */
  public async start(skipQueue = false): Promise<void> {
    const root = `/bookmarks/services/${this.#service.name}`;
    const jobspath = `${root}/jobs/pending`;
    const successpath = `${root}/jobs/success`;
    const failurepath = `${root}/jobs/failure`;

    try {
      await this.#oada.ensure({
        path: jobspath,
        data: {},
        tree,
      });

      await this.#oada.ensure({
        path: failurepath,
        data: {},
        tree,
      });

      await this.#oada.ensure({
        path: successpath,
        data: {},
        tree,
      });

      info(`[QueueId ${this._id}] Getting initial set of jobs`);
      const r = await this.#oada.get({ path: jobspath });

      if (r.status !== 200) {
        throw new Error(
          `[QueueId ${this._id}] Could not retrieve job queue list`,
        );
      }

      // Store the rev before we stripResource to start watch from later
      const watchopts: { path: string; rev?: number } = { path: jobspath };
      if (
        r?.data &&
        typeof r.data === "object" &&
        "_rev" in r.data &&
        typeof r.data._rev === "number"
      ) {
        trace(
          "[QueueId ",
          this._id,
          "] Initial jobs list at rev",
          r.data._rev,
          ", starting watch from that point",
        );
        watchopts.rev = r.data._rev;
      }

      // Watch will be started from rev that we just processed
      const { changes, requestId } = await this.#oada.watch(watchopts);
      this.#watchRequestId = requestId;
      // Wrap for..await in async function that we do not "await";
      (async () => {
        for await (const change of changes) {
          trace("[QueueId %s] received change: ", this._id, change);
          if (change.type !== "merge") continue;

          // Catch error in callback to avoid nodejs crash on error
          try {
            const jobs = stripResource(change.body);
            // AssertJobs(jobs);
            trace(
              "[QueueId %s] jobs found in change:",
              this._id,
              Object.keys(jobs),
            );
            await this.#doJobs(jobs as OADAJobsChange);
          } catch (error_: unknown) {
            trace(error_, "The change was not a `Jobs`");
            // Shouldn't it fail the job?
          }
        }

        error("***ERROR***: the for...await looking for changes has exited");
      })();

      info(`[QueueId ${this._id}] Started WATCH.`);

      // Clean up the resource and grab all existing jobs to run them before starting watch
      trace(`[QueueId ${this._id}] Adding existing jobs`);
      const jobs = stripResource(r.data as Record<string, unknown>);

      if (skipQueue) {
        info("Skipping existing jobs in the queue prior to startup.");
      } else {
        // AssertJobs(jobs);
        await this.#doJobs(jobs as OADAJobs);
        trace(`Existing queue size: ${Object.keys(jobs).length}`);
      }
    } catch (err: unknown) {
      error(err, `[QueueId: ${this._id}] Failed to start WATCH`);
      throw new Error(`Failed to start watch ${this._id}`, { cause: err });
    }
  }

  /**
   * Closes the WATCH
   */
  public async stop(): Promise<void> {
    // I'm not sure in what scenario requestId would be an array of strings, but that's its type.
    const array = Array.isArray(this.#watchRequestId)
      ? this.#watchRequestId
      : [this.#watchRequestId];
    info(`[QueueId: ${this._id}] Stopping WATCH`);
    // Stop all our watches:
    await Promise.all(
      array.map(async (requestId) => {
        if (requestId === "") {
          return;
        }

        return this.#oada.unwatch(requestId);
      }),
    );
    this.#watchRequestId = "";
  }

  /**
   * Helper function to create and start jobs from the queue
   */
  async #doJobs(jobs: OADAJobs | OADAJobsChange): Promise<void> {
    // Queue up the Runners in parallel
    for await (const [jobKey, value] of Object.entries(jobs)) {
      const { _id } = value as Link;
      if (!_id) return;
      // Fetch the job
      const { job, isJob } = await Job.fromOada(this.#oada, _id);

      this.#service.metrics.jobs.inc({
        service: this.#service.name,
        type: job.type,
        state: "queued",
      });

      void this.#queue.add(async () => {
        // Instantiate a runner to manage the job
        const runner = new Runner(this.#service, jobKey, job, this.#oada);

        if (!isJob) {
          await runner.finish("failure", {}, dayjs());
        }

        trace(`[QueueId: ${this._id}] Starting runner for ${jobKey}`);
        await runner.run();
      });
    }
  }
}