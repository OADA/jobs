import { OADAClient } from '@oada/client';
import type { Config } from '@oada/client';
import { assert as assertQueue } from '@oada/types/oada/service/queue.js';

import { debug, error, warn } from './utils.js';

import type { Job } from './Job.js';
import type { Logger } from './Logger.js';
import { Queue } from './Queue.js';
import { Report, ReportConfig, EmailConfigSetup } from './Report.js';

export type Domain = string;
export type Type = string;
export type QueueId = string;
export type JobId = string;

import type { Json } from '.';

export interface WorkerContext {
  jobId: string;
  log: Logger;
  oada: OADAClient;
}
export type WorkerFunction = (
  job: Job,
  context: WorkerContext
) => Promise<Json>;

export interface Worker {
  timeout: number;
  work: WorkerFunction;
}

export interface FinishReporter {
  type: 'slack'; // add more over time
  status: 'success' | 'failure';
  posturl?: string;
}
export interface FinishReporters extends Array<FinishReporter> {}
export interface ServiceOpts {
  finishReporters: FinishReporters;
}
export interface ConstructorArgs {
  name: string,
  oada?: OADAClient | Config,
  opts?: ServiceOpts
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
  public opts: ServiceOpts | undefined;

  private oada: OADAClient;
  private clients: Map<Domain, OADAClient> = new Map();
  private queue?: Queue;
  private workers: Map<Type, Worker> = new Map();
  private reports: Map<string, Report> = new Map();

  /**
   * Creates a Service.  Two possible call signatures:
   *   - new Service(name, domain, token, concurrency, opts?)
   *   - new Service(name, oada, concurrency, opts?)
   * @param name Name of service
   * @param oada Either an existing OADAClient or a connection object used to call oada.connect
   * @param opts ServiceOpts (finish reporter, etc)
   */
  constructor(obj: ConstructorArgs) {
    this.name = obj.name;
    if (obj.oada instanceof OADAClient) {
      debug('Using oada connection passed to contructor');
      this.oada = obj.oada;
    } else {
      debug('Opening OADA connection from domain/token that were passed');
      try {
        this.oada = new OADAClient(obj.oada!);
      } catch (err) {
        throw new Error(`Service constructor requires either an existing OADA client or the connection config to create a new new connection. Attempt to create a new connection with the 'oada' argument failed.`)
      }
    }
    this.domain = this.oada.getDomain();
    this.token = this.oada.getToken()[0]!;
    this.concurrency = this.oada.getConcurrency();
    if (obj.opts) {
      this.opts = obj.opts;
    }
  }

  /**
   * Start the service -- start and manage the configured queue
   */
  private watchRequestId: string | string[] = ''

  public async start(): Promise<void> {
    /*
    this.oada.put({
      path: `/bookmarks/services/${this.name}/_meta`,
      data: {'oada-jobs': { 'last-start': new Date().toISOString()}}
    })
    */
    await this.doQueue();
    this.reports.forEach((r) => r.start())
  }

  public async stop(): Promise<void> {
    // I'm not sure in what scenario requestid would be an array of strings, but that's its type.
    let arr: string[];
    if (Array.isArray(this.watchRequestId)) {
      arr = this.watchRequestId;
    } else {
      arr = [ this.watchRequestId ];
    }
    // Stop all our watches:
    await Promise.all(arr.map(requestid => this.oada.unwatch(requestid)));
    // And stop all the queue's and their watches:
    await this.stopQueue();
    this.reports.forEach((r) => r.stop())
  }

  /**
   * Register a worker for a job type.
   * @param type Type of job the worker is for
   * @param timeout Max worker runtime in ms
   * @param worker Worker function
   */
  public on(type: string, timeout: number, work: WorkerFunction): void {
    this.workers.set(type, { work, timeout });
  }

  /**
   * De-register a worker for a job type.
   * @param type Type of job to de-register worker for
   */
  public off(type: string): void {
    this.workers.delete(type);
  }


  /**
   * Fetch the registered worker for a job type
   * @param type Type of job
   */
  public getWorker(type: string): Worker {
    const worker = this.workers.get(type);

    if (!worker) {
      error('No worker registered for %s', type);
      throw new Error(`No worker registered for ${type}`);
    }

    return worker;
  }

  /**
   * Obtain an OADAClient by domain, creating if needed
   */
  public getClient(domain: string): OADAClient {
    let oada = this.clients.get(domain);
    if (!oada) {
      oada = new OADAClient({
        domain: domain,
        concurrency: this.concurrency,
      });
      this.clients.set(domain, oada);
    }

    return oada;
  }

  /**
   * Helper function to create and start a list of queues
   */
  private async doQueue(): Promise<void> {
    try {
      assertQueue({
        token: this.token,
        domain: this.domain
      });
      if (this.queue) {
        await this.queue?.stop();
      }

      const queue: Queue = new Queue(this, defaultServiceQueueName, this.oada);
      await queue.start();
      this.queue = queue;
    } catch (e) {
      warn('Invalid queue');
      debug('Invalid queue: %O', e);
    }
  }

  private async stopQueue(): Promise<void> {
    try {
      this.queue?.stop()
    } catch (e) {
      warn('Unable to stop queues');
      debug('Unable to stop queue %0', e);
    }
  }

  /**
   * @param name The name of the report
   * @param domain_or_oada The domain of the queue to watch, or an existing oada client.
   * @param reportConfig The configuration used to derive CSV rows from the jobs list.
   * @param frequency A cron-like string describing the frequency of the emailer.
   * @param email A callback used to generate the email job
   * @param type The subservice type to report on
   * @param token Token to use to connect to OADA if necessary
   */
  public addReport(
    name: string,
    domain_or_oada: string | OADAClient,
    reportConfig: ReportConfig,
    frequency: string,
    email: EmailConfigSetup,
    type?: string,
    token?: string
  ): Report {
    let report = new Report(name, domain_or_oada, reportConfig, this, frequency, email, type, token);
    this.reports.set(name, report)
    return report;
  }

  /**
   * Get a registered report
   * @param name The name of the report
   */
  public getReport(name: string): Report | undefined {
    return this.reports.get(name);
  }
}