import Promise from 'bluebird';
import debug from 'debug';
import oada from '@oada/oada-cache';
import pqueue from 'p-queue';
import uuid from 'uuid';

import { servicesJobsTree, servicesJobsFailedTree } from './trees.mjs';

const SERVICES_ROOT = '/bookmarks/services';
const SERVICES_META_ROOT = '_meta/services';

// TODO: We should read a config to find all of the job queues for this service.
export class JobQueue {
  constructor(serviceName, service, options) {
    const {
      concurrency = 1,
      domain = 'https://localhost',
      token = 'def'
    } = options;

    this.serviceName = serviceName || 'unknown';
    this.service = service;

    this.info = debug(`${serviceName}:oada-jobs:info`);
    this.trace = debug(`${serviceName}:oada-jobs:trace`);
    this.error = debug(`${serviceName}:oada-jobs:error`);
    this.q = new pqueue.default({ concurrency }); // eslint-disable-line new-cap

    this.q.on('active', () => {
      this.trace(`Queue size: ${this.q.size} pending: ${this.q.pending}`);
    });

    oada.setDbPrefix('./.cache/');
    this.con = oada.connect({
      domain,
      token,
      cache: false // Just want `oada-cache` for its tree stuff
    });
  }

  async start() {
    const con = await this.con;
    const path = `${SERVICES_ROOT}/${this.serviceName}/jobs`;

    // TODO: We should lookup a config to set all the watches
    this.info(`Ensuring ${this.serviceName} job queue exists`);
    await con.put({
      path,
      tree: servicesJobsTree,
      data: {}
    });

    this.info(`Watching ${this.serviceName} job queue`);
    const res = await con.get({
      path,
      watch: {
        callback: async ({ response: { change } }) => {
          this.trace('Change received, change = %O', change);

          if (change.type === 'merge') {
            const data = fixBody(change.body);

            // TODO: Is this my `this`?
            await this._addJobs(data);
          }
        }
      }
    });

    if (res.status !== 200) {
      this.error('Job queue watch failed');
    } else {
      await this._addJobs(res.data);
    }
  }

  _addJobs(data) {
    // `_addJobs` hits oada to get the tasks, so limit the concurrency here too
    return this.q.add(() => this._addJobsAsync(data));
  }

  async _addJobsAsync(data) {
    const con = await this.con;

    Promise.each(
      Object.keys(data || {}).filter((r) => !r.match(/^_/)),
      async (jobid) => {
        const [_, id] = data[jobid]._id.match(/^resources\/(.*)$/);

        let tasks;
        try {
          const r = await con.get({
            path: `/resources/${id}/${SERVICES_META_ROOT}/${this.serviceName}/tasks`
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
          .filter(
            (t) =>
              !t.match(/^_/) &&
              (!tasks[t].status || tasks[t].status === 'pending')
          )
          .map((taskid) => ({ taskid, task: tasks[taskid] }));

        if (!work.length) {
          this.trace(`job ${jobid} has no tasks - creating one (res ${id})`);
          work.push({ taskid: uuid.v4(), task: {} });
        }

        work.forEach((item) => {
          this.trace(`Adding task ${item.taskid} (job ${jobid} res ${id})`);
          this.q.add(() => this._runTask(jobid, item.taskid, item.task, id));
        });
      }
    );
  }

  async _runTask(jobid, taskid, task, id) {
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
        headers: { 'Content-Type': 'application/json' }
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
            _id: `resources/${id}`
          },
          headers: { 'Content-Type': 'application/json' }
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
            time: Date.now() / 1000
          },
          headers: { 'Content-Type': 'application/json' }
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

  async _removeJob(jobid, failed) {
    const con = await this.con;
    const jobPath = `${SERVICES_ROOT}/${this.serviceName}/jobs/${jobid}`;

    await con.delete({
      path: jobPath,
      headers: { 'Content-Type': 'application/json' }
    });
    this.trace(`removed job ${jobid} from service queue`);
  }
}

function fixBody(body) {
  return Object.prototype.hasOwnProperty.call(body, '_rev') ? body : body.data;
}
