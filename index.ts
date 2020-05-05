import debug, { Debugger } from 'debug';
import oada, { OADAClient } from '@oada/client';
import { assert as assertChange } from '@oada/types/oada/websockets/change';

import PQueue from 'p-queue';
import is from '@sindresorhus/is';
import KSUID from 'ksuid';

import { servicesJobsTree, servicesJobsFailedTree } from './trees';

const SERVICES_ROOT = '/bookmarks/services';
const SERVICES_META_ROOT = '_meta/services';

type Service = (id: string, task: unknown, con: OADAClient) => Promise<void>;

interface Options {
  domain: string;
  token: string;
  concurrency?: number;
}

// TODO: We should read a config to find all of the job queues for this service.
export class JobQueue {
  private serviceName: string;
  private service: Service;

  private info: Debugger;
  private trace: Debugger;
  private error: Debugger;

  private q: PQueue;

  private con: Promise<OADAClient>;

  constructor(serviceName: string, service: Service, options: Options) {
    const {
      concurrency = 1,
      domain = 'https://localhost',
      token = 'def',
    } = options;

    this.serviceName = serviceName || 'unknown';
    this.service = service;

    this.info = debug(`${serviceName}:oada-jobs:info`);
    this.trace = debug(`${serviceName}:oada-jobs:trace`);
    this.error = debug(`${serviceName}:oada-jobs:error`);

    this.q = new PQueue({ concurrency });

    this.q.on('active', () => {
      this.trace(`Queue size: ${this.q.size} pending: ${this.q.pending}`);
    });

    this.con = oada.connect({
      domain,
      token,
    });
  }

  async start(): Promise<void> {
    const con = await this.con;
    const path = `${SERVICES_ROOT}/${this.serviceName}/jobs`;

    // TODO: We should lookup a config to set all the watches
    this.info(`Ensuring ${this.serviceName} job queue exists`);
    await con.put({
      path,
      tree: servicesJobsTree,
      data: {},
    });

    this.info(`Watching ${this.serviceName} job queue`);
    const res = await con.get({
      path,
      watchCallback: async (r) => {
        assertChange(r);
        if (!is.plainObject(r.data)) {
          this.error('Change feed is not a plain object?');
          throw new Error('Invalid change document');
        }

        const change = r.data.change;

        if (!is.plainObject(change) || !change.type) {
          this.error('Recieved an invalid change document', r);
          throw new Error('Invalid change document');
        }

        this.trace('Change received, change = %O', change);

        if (change.type === 'merge') {
          await this._addJobs(change.body);
        }
      },
    });

    if (res.status !== 200) {
      this.error('Job queue watch failed');
    } else {
      await this._addJobs(res.data);
    }
  }

  async _addJobs(data: unknown): Promise<void> {
    return this.q.add(() => this._addJobsAsync(data));
  }

  async _addJobsAsync(data: unknown): Promise<void> {
    const con = await this.con;

    if (!is.plainObject(data)) {
      throw new Error('Job data not plain object.');
    }

    Promise.all(
      Object.keys(data)
        .filter((r) => !r.match(/^_/))
        .map(
          async (jobid: string): Promise<void> => {
            const job = data[jobid];
            if (!is.plainObject(job) || !is.string(job._id)) {
              throw new Error(`Jobid ${jobid} invalid.`);
            }

            const id = job._id.replace('resources/', '');

            let tasks = {};
            try {
              const r = await con.get({
                path: `/resources/${id}/${SERVICES_META_ROOT}/${this.serviceName}/tasks`,
              });
              tasks = r.data;
            } catch (e) {
              if (e.response.status !== 404) {
                this.info(`error fetching job ${jobid} tasks. Removing.`, e);
                return this._removeJob(jobid);
              }
            }

            // Add each available task to the queue
            const work = Object.keys(tasks || {})
              .filter((t) => !t.startsWith('_'))
              .map((t) => {
                if (!is.plainObject(tasks)) {
                  return undefined;
                }

                const task = tasks[t];
                if (!is.plainObject(task)) {
                  return undefined;
                }

                return task;
              })
              .filter((task) => !task?.status || task?.status === 'pending')
              .map((task) => ({ taskid: task?._id, task }));

            if (!work.length) {
              this.trace(
                `job ${jobid} has no tasks - creating one (res ${id})`
              );
              work.push({ taskid: KSUID.randomSync().string, task: {} });
            }

            work.forEach((item) => {
              this.trace(`Adding task ${item.taskid} (job ${jobid} res ${id})`);
              const taskid = item.taskid;
              if (is.string(taskid)) {
                this.q.add(() => this._runTask(jobid, taskid, item.task, id));
              }
            });
          }
        )
    );
  }

  async _runTask(
    jobid: string,
    taskid: string,
    task: unknown,
    id: string
  ): Promise<void> {
    const con = await this.con;
    const taskPath = `/resources/${id}/${SERVICES_META_ROOT}/${this.serviceName}/tasks/${taskid}`;

    try {
      this.info(`starting task ${taskid} (job ${jobid} res ${id})`);
      // Run job's task
      const r = await this.service(id, task, con);
      this.info(`task success ${taskid} (job ${jobid} res ${id})`);

      // Update task status
      await con.put({
        path: taskPath,
        data: Object.assign(r, { status: 'success', time: Date.now() / 1000 }),
        contentType: 'application/json',
      });
      this.trace(`task status = 'success' ${taskid} (job ${jobid} res ${id})`);
    } catch (e) {
      this.info(`task errored ${taskid} (job ${jobid} res ${id})`);
      this.trace(`task errored ${taskid} err = %O`, e);

      try {
        await con.put({
          path: `${SERVICES_ROOT}/${this.serviceName}/jobs-failed/${jobid}`,
          tree: servicesJobsFailedTree,
          data: {
            _id: `resources/${id}`,
          },
          contentType: 'application/json',
        });
        this.trace(`moved job ${jobid} to failed queue (res ${id})`);
      } catch (e) {
        this.error(
          `failed to move job ${jobid} to failed queue (res ${id} err = %O)`,
          e
        );
      }

      try {
        await con.put({
          path: taskPath,
          data: {
            status: 'error',
            error: e.toString(),
            time: Date.now() / 1000,
          },
          contentType: 'application/json',
        });
        this.trace(`task status = 'error' ${taskid} (job ${jobid} res ${id})`);
      } catch (e) {
        this.error(
          `task status update error ${taskid} (job ${jobid} res ${id} err = %O)`,
          e
        );
      }
    } finally {
      this.trace(`removing job ${jobid} (res ${id})`);
      await this._removeJob(jobid);
    }
  }

  async _removeJob(jobid: string): Promise<void> {
    const con = await this.con;
    const jobPath = `${SERVICES_ROOT}/${this.serviceName}/jobs/${jobid}`;

    await con.delete({
      path: jobPath,
    });
    this.trace(`removed job ${jobid} from service queue`);
  }
}
