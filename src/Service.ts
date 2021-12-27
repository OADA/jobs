import { OADAClient } from '@oada/client';
import Queues, {
  assert as assertQueues,
} from '@oada/types/oada/service/queues';
import { assert as assertQueue } from '@oada/types/oada/service/queue';

import { serviceTree as tree } from './tree';
import { stripResource, debug, info, error, warn } from './utils';

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
  // NOTE: The truly unique key is something like `<domain>:<token>:<queueid>`
  // but we treat `queueId` as sufficiently random that it is globally unique.
  // TODO: Check that this simplification is really helpful in later layers?
  private queues: Map<QueueId, Queue> = new Map();
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
  constructor(
    name: string,
    domain_or_oada: string | OADAClient,
    token_or_concurrency: string | number,
    concurrency_or_opts?: number | ServiceOpts,
    opts?: ServiceOpts
  ) {
    this.name = name;
    // new Service(name, domain, token, concurrency, opts?)
    if (typeof domain_or_oada === 'string') {
      this.domain = domain_or_oada as string;
      this.token = token_or_concurrency as string;
      this.concurrency = concurrency_or_opts as number;
      this.opts = opts;
      debug('Opening OADA connection from domain/token that were passed');
      this.oada = new OADAClient({ domain: this.domain, token: this.token });

    // new Service(name, oada, concurrency, opts?)
    } else {
      this.oada = domain_or_oada as OADAClient;
      this.domain = this.oada.getDomain();
      this.token = this.oada.getToken();
      debug('Using oada connection passed to contructor');
      this.concurrency = token_or_concurrency as number;
      this.opts = concurrency_or_opts as ServiceOpts;
    }
  }

  /**
   * Start the service -- start and manage the configured queues
   */
  private watchRequestId: string | string[] = ''

  public async start(): Promise<void> {
    const path = `/bookmarks/services/${this.name}/queues`;
    info('Ensure service queue tree exists');
    const exists = await this.oada.head({path}).then(()=>true).catch(() => false);
    if (!exists) await this.oada.put({path, data: {}, tree});

    info('Getting initial set of queues');
    const r = await this.oada.get({path});
    if (r.status !== 200) {
      throw new Error('Could not retrieve service queue list');
    }
    // Store the rev before we stripResource to start watch from later
    const watchopts: { path: string, rev?: number } = { path };
    if (r?.data && typeof r.data ==='object' && '_rev' in r.data && typeof r.data._rev === 'number') {
      watchopts.rev = r.data._rev;
    }

    stripResource(r.data);
    assertQueues(r.data);
    // @ts-ignore the Queue type is messed up
    // because the schema abuse patternProperties
    r.data[defaultServiceQueueName] = {
      domain: this.domain,
      token: this.token,
    };
   await this.doQueues(r.data);

    const { changes, requestId } = await this.oada.watch(watchopts);
    this.watchRequestId = requestId;
    // Run the change watcher as a detached async function (don't wait on it)
    (async () => {
      for await (const change of changes) {
        const queues: unknown = stripResource(change.body);
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
            warn('WARNING: received delete for queues: ', queues, ', stopping them');
            assertQueues(queues);
            for (const queueId in queues) {
              this.queues.get(queueId)?.stop();
              this.queues.delete(queueId);
            }
            break;
        }
      }
      error('***ERROR***: Service for..await has exited from the watch and it should not');
    })();
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
    await this.stopQueues();
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
  private async doQueues(queues: Queues): Promise<void> {
    for (const [queueId, w] of Object.entries(queues)) {
      try {
        assertQueue(w);
        if (this.queues.has(queueId)) {
          await this.queues.get(queueId)?.stop();
        }

        let queue: Queue;
        // For default service queue, use the default oada connection (no need to clone)
        if (queueId === defaultServiceQueueName) {
          queue = new Queue(this, queueId, this.oada);
        // Otherwise, let the queue clone it for the new domain and token
        } else {
          queue = new Queue(this, queueId, w.domain, w.token);
        }
        await queue.start();

        this.queues.set(queueId, queue);
      } catch (e) {
        warn('Invalid queue %s', queueId);
        debug('Invalid queue %s: %O', queueId, e);
      }
    }
  }

  private async stopQueues(): Promise<void> {
    try {
      await Promise.all(Array.from(this.queues.keys())
        .map(async (queueId: string) => this.queues.get(queueId)?.stop())
      );
    } catch (e) {
      warn('Unable to stop queues');
      debug('Unable to stop queue %0', e);
    }
  }
}
