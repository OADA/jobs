import { OADAClient } from '@oada/client';
import type { Config } from '@oada/client';
import { assert as assertQueue } from '@oada/types/oada/service/queue';

import { debug, error, warn } from './utils';

import type { Job } from './Job';
import type { Logger } from './Logger';
import { Queue } from './Queue';

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
  connect?: Config,
  oada?: OADAClient,
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
  private queue: Queue;
  private workers: Map<Type, Worker> = new Map();

  /**
   * Creates a Service.  Two possible call signatures:
   *   - new Service(name, domain, token, concurrency, opts?) 
   *   - new Service(name, oada, concurrency, opts?)
   * @param name Name of service
   * @param domain_or_oada Domain of configuration OADA store, or an existing OADA connection to use instead
   * @param token_or_concurrency Token for configuration OADA store (if no OADA connection given), or concurrency as maximum number of in-flight requests per domain.
   * @param concurrency_or_opts Maximum number of in-flight requests per domain (if no OADA connection given), or ServiceOpts if an oada connection was given
   * @param opts If no OADA connection given, this is the ServiceOpts (finish reporter, etc)
   */
  constructor(obj: ConstructorArgs) {
    this.name = obj.name;
    if (obj.oada) {
      debug('Using oada connection passed to contructor');
      this.oada = obj.oada;
    } else if (obj.connect) {
      debug('Opening OADA connection from domain/token that were passed');
      this.oada = new OADAClient(obj.connect);
    } else throw new Error(`Service constructor requires either an 'oada' or a 'connect' argument`)
    this.domain = this.oada.getDomain();
    this.token = this.oada.getToken();
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
    await this.doQueue();
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

      let queue: Queue = new Queue(this, defaultServiceQueueName, this.oada);
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
}
