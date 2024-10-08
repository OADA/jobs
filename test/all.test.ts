/**
 * @license
 * Copyright 2023 Qlever LLC
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

import test from 'ava';

import { domain, token } from './config.js';

import { setTimeout } from 'node:timers/promises';

import debug from 'debug';
import moment from 'moment';

import { type OADAClient, connect } from '@oada/client';
import type OADAJob from '@oada/types/oada/service/job.js';
import { oadaify } from '@oada/oadaify';

import { deleteResourceAndLinkIfExists, postJob } from './utils.js';

import { type Json, Service } from '../dist/index.js';
import { tree } from '../dist/tree.js';

const trace = debug('all.test.ts:trace');
const error = debug('all.test.ts:error');

const name = 'JOBSTEST'; // +(new Date()).getTime();
const root = `/bookmarks/services/${name}`;
const success = `/bookmarks/services/${name}/jobs/success`;
const failure = `/bookmarks/services/${name}/jobs/failure`;
const pending = `/bookmarks/services/${name}/jobs/pending`;
const successjob = {
  service: name,
  type: 'basic',
  config: { do: 'success' },
};
const failjob = {
  ...successjob,
  config: { do: 'fail' },
};
const jobwaittime = 2500; // Ms to wait for job to complete, tune to your oada response time

let oada: OADAClient;
let svc: Service;
test.before(async (t) => {
  t.timeout(10_000);

  // Get global connection to oada for later tests
  oada = await connect({ domain, token });

  // Cleanup any old service tests that didn't get deleted
  const existing = await oada
    .get({ path: '/bookmarks/services' })
    .then((r) => oadaify(r.data as Json));
  if (typeof existing === 'object' && existing) {
    const testservices = Object.keys(existing).filter((servicename) =>
      /^JOBSTEST/.exec(servicename),
    );
    await Promise.all(
      testservices.map(async (servicename) => {
        trace('Found old test job service: ', servicename, ', deleting it');
        await oada.delete({ path: `/bookmarks/services/${servicename}` });
      }),
    );
  }

  await deleteResourceAndLinkIfExists(oada, root);

  // Start the service
  trace('before: starting service ', name);
  svc = new Service({
    name,
    oada,
  });
  // Register a default job handler
  svc.on('basic', 1000, async (job) => {
    trace('received job, job.config = ', job?.config);
    if (!job?.config) {
      error('There is no config on the job.');
      throw new Error('job.config does not exist');
    }

    const command = (job.config as { do?: string }).do;
    switch (command) {
      case 'success': {
        return { success: true } as Json;
      }

      case 'fail': {
        throw new Error('config.do is throw');
      }

      default: {
        throw new Error(`Unknown do command ${command} in job config`);
      }
    }
  });
  await svc.start();
  // Since we can't tree-put, ensure the jobs path exists now
  const exists: boolean = await oada
    .head({ path: `${root}/jobs` })
    .then(() => true)
    .catch(() => false);
  if (!exists) await oada.put({ path: `${root}/jobs`, data: {}, tree });
  trace('Finished with startup,');
});

test.after(async () => {
  await svc.stop();
  // Await deleteResourceAndLinkIfExists(oada,root);
});

test('Should remove job from jobs queue when done', async (t) => {
  const { key } = await postJob(oada, pending, successjob);
  await setTimeout(jobwaittime);
  const jobisgone = await oada
    .get({
      path: `${pending}/${key}`,
    })
    .then(() => false)
    .catch((error_) => error_.status === 404);
  t.is(jobisgone, true);
});

test('Should move successful job to success queue, have status success, and store result verbatim', async (t) => {
  const dayindex = moment().format('YYYY-MM-DD');
  const { key } = await postJob(oada, pending, successjob);
  await setTimeout(jobwaittime);

  try {
    const { data: result } = await oada.get({
      path: `${success}/day-index/${dayindex}/${key}`,
    });
    t.is((result as OADAJob)?.status, 'success');
    t.deepEqual((result as OADAJob)?.result, { success: true }); // This is what the basic service handler returns
  } catch (error_: any) {
    if (error_.status === 404) return; // If it's not there, just return false
    throw error_ as Error; // Any other error, throw it back up
  }
});

test('Should move failed job to failure queue, have status failure', async (t) => {
  const dayindex = moment().format('YYYY-MM-DD');
  const { key } = await postJob(oada, pending, failjob);
  await setTimeout(jobwaittime);

  try {
    const { data: result } = await oada.get({
      path: `${failure}/day-index/${dayindex}/${key}`,
    });
    t.not(result, false); // It should be in the failure queue
    t.is((result as OADAJob)?.status, 'failure');
  } catch (error_: any) {
    if (error_.status === 404) return; // If it's not there, just return false
    throw error_ as Error; // Any other error, throw it back up
  }
});

test('Should fail a posted job that does not look like a job (missing config)', async (t) => {
  const dayindex = moment().format('YYYY-MM-DD');
  const { key } = await postJob(oada, pending, { thisis: 'not a valid job' });
  await setTimeout(jobwaittime);

  try {
    const { data: result } = await oada.get({
      path: `${failure}/day-index/${dayindex}/${key}`,
    });
    t.not(result, false); // It should be in the failure queue
    t.is((result as OADAJob)?.status, 'failure');
  } catch (error_: any) {
    if (error_.status === 404) return; // If it's not there, just return false
    throw error_ as Error; // Any other error, throw it back up
  }
});

test('Should allow job created with a tree put (can lead to empty job content for a moment)', async (t) => {
  const dayindex = moment().format('YYYY-MM-DD');
  const key = 'abc123';
  await oada.put({
    path: `${pending}/${key}`,
    data: successjob,
    tree,
  });
  await setTimeout(jobwaittime);
  try {
    const { data: result } = await oada.get({
      path: `${success}/day-index/${dayindex}/${key}`,
    });

    t.not(result, false); // It should be in the failure queue
    t.is((result as OADAJob)?.status, 'success');
  } catch (error_: any) {
    if (error_.status === 404) return; // If it's not there, just return false
    throw error_ as Error; // Any other error, throw it back up
  }
});

test('Should allow connection with existing OADAClient', async (t) => {
  const con = await connect({ domain, token });
  t.notThrows(() => {
    // eslint-disable-next-line no-new
    new Service({
      name,
      oada: con,
    });
  });
});

test('Testing jobs change', async (t) => {
  const con = await connect({ domain, token });
  t.notThrows(() => {
    // eslint-disable-next-line no-new
    new Service({
      name,
      oada: con,
    });
  });
});
