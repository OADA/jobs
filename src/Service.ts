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

import type { Config } from "@oada/client";
import { OADAClient } from "@oada/client";
import { Gauge, Histogram } from "@oada/lib-prom";
import { type Logger, pino } from "@oada/pino-debug";
import { assert as assertQueue } from "@oada/types/oada/service/queue.js";
import type { Json } from "./index.js";
import type { Job } from "./Job.js";
import { Queue } from "./Queue.js";
import { Report, type ReportConstructor } from "./Report.js";

export type Domain = string;
export type Type = string;
export type QueueId = string;
export type JobId = string;

export interface WorkerContext {
  jobId: string;
  log: Logger;
  oada: OADAClient;
}
export type WorkerFunction = (
  job: Job,
  context: WorkerContext,
) => Promise<Json>;

export interface Worker {
  timeout: number;
  work: WorkerFunction;
}

export interface FinishReporter {
  type: "slack"; // Add more over time
  status: "success" | "failure";
  posturl?: string;
}
export interface FinishReporters extends Array<FinishReporter> {}
export interface ServiceOptions {
  finishReporters?: FinishReporters;
  skipQueueOnStartup?: boolean;
}
export interface ConstructorArguments {
  name: string;
  oada?: OADAClient | Config;
  concurrency?: number;
  opts?: ServiceOptions;
  log?: Logger;
}

export const defaultServiceQueueName = "default-service-queue";

/**
 * Manages an @oada/jobs based service's queue endpoints. This Service class
 * manages:
 *    1. Watching a configurable list of Job queues,
 *    2. Calling worker functions based on job types,
 *    3. Updating and filing job objects based on the worker's output.
 */
export class Service {
  public name: string;
  public concurrency: number;
  // You either need to give a domain/token for the main service, or an oada connection.
  // Note that if you have multiple queues beyond the default service queue, you will get
  // a separate oada connection for each.
  public domain: string;
  public token: string;
  public opts: ServiceOptions | undefined;
  public metrics;
  public log: Logger;

  readonly #oada: OADAClient;
  // Readonly #clients = new Map<Domain, OADAClient>();
  readonly #workers = new Map<Type, Worker>();
  readonly #reports = new Map<string, Report>();
  #queue?: Queue;

  /**
   * Creates a Service.  Two possible call signatures:
   *   - new Service(name, domain, token, concurrency, opts?)
   *   - new Service(name, oada, concurrency, opts?)
   * @param name Name of service
   * @param oada Either an existing OADAClient or a connection object used to call oada.connect
   * @param opts ServiceOpts (finish reporter, etc)
   */
  constructor(object: ConstructorArguments) {
    this.name = object.name;
    this.log = object.log ?? pino({ base: { service: this.name } });

    if (
      // @ts-expect-error instanceof OADAClient does not work
      object.oada?.getDomain !== undefined &&
      // @ts-expect-error instanceof OADAClient does not work
      object.oada?.getToken !== undefined
    ) {
      this.log.debug("Using oada connection passed to constructor");
      // @ts-expect-error instanceof OADAClient does not work
      this.#oada = object.oada;
    } else {
      this.log.debug(
        "Opening OADA connection from domain/token that were passed",
      );
      try {
        // @ts-expect-error instanceof OADAClient does not work
        this.#oada = new OADAClient(object.oada!);
      } catch (error: unknown) {
        throw new Error(
          `Service constructor requires either an existing OADA client or the connection config to create a new new connection. Attempt to create a new connection with the 'oada' argument failed.`,
          { cause: error },
        );
      }
    }

    this.domain = this.#oada.getDomain();
    this.token = this.#oada.getToken()[0]!;
    this.concurrency = object.concurrency ?? this.#oada.getConcurrency();
    // TODO: Get total pending jobs in collect callback?
    this.metrics = {
      jobs: new Gauge({
        name: "oada_jobs_total",
        help: "Number of OADA jobs",
        labelNames: ["service", "type", "state"] as const,
      }),
      "job-times": new Histogram({
        name: "job_times",
        help: "Histogram of job times",
        labelNames: ["service", "type", "status"] as const,
        buckets: [
          1, // 1 second
          2, // 2 seconds
          4, // 4 seconds
          8, // 8 seconds
          16, // 16 seconds
          32, // 32 seconds
          64, // 1.06 minutes
          128, // 2.13 minutes
          256, // 4.26 minutes
          512, // 8.53 minutes
          1024, // 17.07 minutes
          2048, // 34.13 minutes
          4096, // 1.14 hours
          8192, // 2.28 hours
          16384, // 4.55 hours
          32768, // 9.1 hours
          65536, // 18.2 hours
          131072, // 1.52 days
          262144, // 3.04 days
          524288, // 6.08 days
        ],
      }),
    };

    if (object.opts) {
      this.opts = object.opts;
    }
  }

  /**
   * Add a report to the service. See ReportConstructor for parameters.
   */
  public addReport(rc: Omit<ReportConstructor, "service">) {
    const report = new Report({
      ...rc,
      service: this,
    });
    this.#reports.set(rc.name, report);
    return report;
  }

  /**
   * Get a registered report
   * @param name The name of the report
   */
  public getReport(name: string): Report | undefined {
    return this.#reports.get(name);
  }

  /**
   * Start the service -- start and manage the configured queue
   */
  get #watchRequestId() {
    return "";
  }

  public async start(): Promise<void> {
    await this.#doQueue();
    for (const r of this.#reports.values()) {
      r.start();
    }
  }

  public async stop(): Promise<void> {
    // I'm not sure in what scenario requestId would be an array of strings, but that's its type.
    const array = Array.isArray(this.#watchRequestId)
      ? this.#watchRequestId
      : [this.#watchRequestId];
    // Stop all our watches:
    await Promise.all(
      array.map(async (requestId) => this.#oada.unwatch(`${requestId}`)),
    );
    // And stop all the queue's and their watches:
    await this.#stopQueue();
    for await (const r of this.#reports.values()) {
      await r.stop();
    }
  }

  /**
   * Register a worker for a job type.
   * @param type Type of job the worker is for
   * @param timeout Max worker runtime in ms
   * @param worker Worker function
   */
  public on(type: string, timeout: number, work: WorkerFunction): void {
    this.#workers.set(type, { work, timeout });
    // Initialize the jobs metrics
    this.metrics.jobs.set(
      {
        service: this.name,
        type,
        state: "queued",
      },
      0,
    );
    this.metrics.jobs.set(
      {
        service: this.name,
        type,
        state: "running",
      },
      0,
    );
    this.metrics.jobs.set(
      {
        service: this.name,
        type,
        state: "success",
      },
      0,
    );
    this.metrics.jobs.set(
      {
        service: this.name,
        type,
        state: "failure",
      },
      0,
    );
    this.metrics["job-times"].zero({
      service: this.name,
      type,
      status: "success",
    });
    this.metrics["job-times"].zero({
      service: this.name,
      type,
      status: "failure",
    });
  }

  /**
   * De-register a worker for a job type.
   * @param type Type of job to de-register worker for
   */
  public off(type: string): void {
    this.#workers.delete(type);
  }

  /**
   * Fetch the registered worker for a job type
   * @param type Type of job
   */
  public getWorker(type: string): Worker {
    const worker = this.#workers.get(type);

    if (!worker) {
      this.log.error("No worker registered for %s", type);
      throw new Error(`No worker registered for ${type}`);
    }

    return worker;
  }

  /**
   * Obtain an OADAClient by domain, creating if needed
   */
  public getClient(): OADAClient {
    return this.#oada;
    /*
    Oada = this.#clients.get(domain);
    if (!oada) {
      oada = new OADAClient({
        domain,
        concurrency: this.concurrency,
      });
      this.#clients.set(domain, oada);
    }

    return oada;
    */
  }

  /**
   * Helper function to create and start a list of queues
   */
  async #doQueue(): Promise<void> {
    try {
      assertQueue({
        token: this.token,
        domain: this.domain,
      });
      if (this.#queue) {
        await this.#queue?.stop();
      }

      const queue: Queue = new Queue(this, defaultServiceQueueName); // This.#oada);
      await queue.start(this.opts?.skipQueueOnStartup);
      this.#queue = queue;
    } catch (err: unknown) {
      this.log.error(err, "Invalid queue");
    }
  }

  async #stopQueue(): Promise<void> {
    try {
      await this.#queue?.stop();
    } catch (err: unknown) {
      this.log.warn(err, "Unable to stop queue");
    }
  }
}