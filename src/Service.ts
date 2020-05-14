import { OADAClient } from '@oada/client';

import Queues, {
  assert as assertQueues,
} from '@oada/types/oada/service/queues';
import { assert as assertQueue } from '@oada/types/oada/service/queue';

import { serviceTree } from './tree';
import { stripResource, debug, info, error } from './utils';

import { Job } from './Job';
import { Logger } from './Logger';
import { Queue } from './Queue';

export type Domain = string;
export type Type = string;
export type QueueId = string;
export type JobId = string;

import { Json } from '.';
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
  type: "slack"; // add more over time
  status: "success" | "failure";
  posturl?: string;
}
export interface FinishReporters extends Array<FinishReporter>{};
export interface ServiceOpts {
  finishReporters: FinishReporters;
}

/**
 * Manages an @oada/jobs based service's queue endpoints. This Service class
 * manages:
 *    1. Watching a configurable list of Job queues,
 *    2. Calling worker functions based on job types,
 *    3. Updating and filing job objects based on the worker's output.
 */
export class Service {
  public name: string;
  public domain: string;
  public concurrency: number;
  public token: string;
  public opts: ServiceOpts | undefined;

  private oada: OADAClient;
  private clients: Map<Domain, OADAClient> = new Map();
  // NOTE: The truly unique key is something like `<domain>:<token>:<queueid>`
  // but we treat `queueId` as sufficiently random that it is globally unique.
  // TODO: Check that this simplification is really helpful in later layers?
  private queues: Map<QueueId, Queue> = new Map();
  private workers: Map<Type, Worker> = new Map();

  /**
   * Creates a Service
   * @param name Name of service
   * @param domain Domain of configuration OADA store
   * @param token Token for configuration OADA store
   * @param concurrency Maximum number of in-flight requests per domain
   */
  constructor(
    name: string,
    domain: string,
    token: string,
    concurrency: number,
    opts?: ServiceOpts,
  ) {
    this.name = name;
    this.domain = domain;
    this.concurrency = concurrency;
    this.token = token;
    this.opts = opts;

    info(`Connecting to ${this.domain}`);
    this.oada = new OADAClient({ domain, token, concurrency: 1 });
  }

  /**
   * Start the service -- start and manage the configured queues
   */
  public async start(): Promise<void> {
    info(`Ensure service queue tree exists`);
    await this.oada.put({
      path: `/bookmarks/services/${this.name}/queues`,
      data: {},
      tree: serviceTree,
    });

    info('Getting initial set of queues');
    const r = await this.oada.get({
      path: `/bookmarks/services/${this.name}/queues`,
      watchCallback: (change) => {
        const queues = stripResource(change.body);
        switch (change.type) {
          // New/update queue
          case 'merge':
            try {
              assertQueues(queues);
              this.doQueues(queues);
            } catch (e) {
              debug('Received a change that was not a `Queues`, %O', e);
            }
            break;

          // Stop watching queue
          case 'delete':
            assertQueues(queues);
            for (const queueId in queues) {
              this.queues.get(queueId)?.stop();
              this.queues.delete(queueId);
            }
            break;
        }
      },
    });

    if (r.status !== 200) {
      throw new Error('Could not retrieve service queue list');
    }

    stripResource(r.data);
    assertQueues(r.data);
    r.data['default-service-queue'] = {
      domain: this.domain,
      token: this.token,
    };

    await this.doQueues(r.data);
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
      error(`No worker registered for ${type}`);
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
  private async doQueues(queues: Queues): Promise<void> {
    for (const queueId in queues) {
      const w = queues[queueId];
      assertQueue(w);

      if (this.queues.has(queueId)) {
        await this.queues.get(queueId)?.stop();
      }

      const queue = new Queue(this, queueId, w.domain, w.token);
      await queue.start();

      this.queues.set(queueId, queue);
    }
  }
}
