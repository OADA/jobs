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

import type { Config } from '@oada/client';
import { OADAClient } from '@oada/client';
import { assert as assertQueue } from '@oada/types/oada/service/queue.js';
import { Gauge } from '@oada/lib-prom';

import { Report, type ReportConstructor } from './Report.js';
import { debug, error, warn } from './utils.js';
import type { Job } from './Job.js';
import type { Json } from './index.js';
import type { Logger } from './Logger.js';
import moment from 'moment';
import { Queue } from './Queue.js';

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
  type: 'slack'; // Add more over time
  status: 'success' | 'failure';
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
}

export interface ServiceMetrics {
  [key: string]: any;
}

export const defaultServiceQueueName = 'default-service-queue';

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
  public metrics: ServiceMetrics;

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
    if (
      // @ts-expect-error instanceof OADAClient does not work
      object.oada?.getDomain !== undefined &&
      // @ts-expect-error instanceof OADAClient does not work
      object.oada?.getToken !== undefined
    ) {
      debug('Using oada connection passed to constructor');
      // @ts-expect-error instanceof OADAClient does not work
      this.#oada = object.oada;
    } else {
      debug('Opening OADA connection from domain/token that were passed');
      try {
        // @ts-expect-error instanceof OADAClient does not work
        this.#oada = new OADAClient(object.oada!);
      } catch {
        throw new Error(
          `Service constructor requires either an existing OADA client or the connection config to create a new new connection. Attempt to create a new connection with the 'oada' argument failed.`,
        );
      }
    }

    this.domain = this.#oada.getDomain();
    this.token = this.#oada.getToken()[0]!;
    this.concurrency = object.concurrency ?? this.#oada.getConcurrency();
    this.metrics = {
      [`${this.name}_total_failure`]: new  Gauge({
        name: `${this.name}_total_failure`,
        help: `Number of ${this.name} jobs that failed`,
        labelNames: ['service', this.name],
      }),
      [`${this.name}_total_queued`]: new Gauge({
        name: `${this.name}_total_queued`,
        help: `Number of ${this.name} jobs that were queued`,
        labelNames: ['service', 'type'],
      }),
      [`${this.name}_total_success`]: new  Gauge({
        name: `${this.name}_total_success`,
        help: `Number of ${this.name} jobs that succeeded`,
        labelNames: ['service', this.name],
      }),
      [`${this.name}_total_running`]: new  Gauge({
        name: `${this.name}_total_running`,
        help: `Number of ${this.name} jobs that are running`,
        labelNames: ['service', this.name],
      }),

    }
    if (object.opts) {
      this.opts = object.opts;
    }
  }

  /**
   * Add a report to the service. See ReportConstructor for parameters.
   */
  public addReport(rc: Omit<ReportConstructor, 'service'>) {
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
    return '';
  }

  public async start(): Promise<void> {
    await this.#initTotalMetrics();
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
    this.#ensureMetrics(type);
    this.#initTypedMetrics(type);
    this.#workers.set(type, { work, timeout });
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
      error('No worker registered for %s', type);
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
    } catch (error_) {
      warn('Invalid queue');
      debug('Invalid queue: %O', error_);
    }
  }

  async #stopQueue(): Promise<void> {
    try {
      await this.#queue?.stop();
    } catch (error_) {
      warn('Unable to stop queues');
      debug('Unable to stop queue %0', error_);
    }
  }

  /**
   * Create the metrics
   */
  #ensureMetrics(type: string): void {
    const statuses = ['queued', 'running', 'success', 'failure'];
    for (const status of statuses) {
      let mtype = type.replaceAll('-', '_').replaceAll(' ', '_');
      const name = `${this.name}_${status}_${mtype}`;
      if (!this.metrics[name]) {
        this.metrics[name] = new Gauge({
          name: name,
          help: `Number of ${this.name} jobs of type "${type}" that are of status "${status}"`,
          labelNames: ['service', mtype, status],
        });
      }
    }
  }

  async #initTotalMetrics(): Promise<void> {
    const date = moment().format('YYYY-MM-DD');
    for await (const status of ['success', 'failure']) {
      try {
        let { data } = await this.#oada.get({
          path: `/bookmarks/services/${this.name}/jobs/${status}/day-index/${date}`
        })
        let keys = Object.keys(data as Record<string, any>).filter(key => !key.startsWith('_'));
        this.metrics[`${this.name}_total_${status}`].set(keys.length);
      } catch(err) {
        this.metrics[`${this.name}_total_${status}`].set(0);
      }
    }
  }

  async #initTypedMetrics(type: string): Promise<void> {
    let mtype = type.replaceAll('-', '_').replaceAll(' ', '_');
    const date = moment().format('YYYY-MM-DD');
    for await (const status of ['success', 'failure']) {
      try {
        this.metrics[`${this.name}_${status}_${mtype}`].set(0);
        let { data } = await this.#oada.get({
          path: `/bookmarks/services/${this.name}/jobs/${status}/day-index/${date}`
        })
        for await (const job of Object.keys(data as Record<string, any>)) {
          let { data: j } = await this.#oada.get({
            path: `/bookmarks/services/${this.name}/jobs/${status}/day-index/${date}/${job}`
          }) as unknown as { data: { j: string, [k: string]: any } };
          if (j.type === type) this.metrics[`${this.name}_${status}_${mtype}`].inc();
        }
      } catch(err) {
      }
    }
  }
}
