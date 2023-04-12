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

import { type JsonObject, type OADAClient, connect } from '@oada/client';
import type Job from '@oada/types/oada/service/job.js';
import { oadaify } from '@oada/oadaify';

import { deleteResourceAndLinkIfExists, postJob } from './utils.js';

import { type Json, Service } from '../dist/index.js';
import { tree } from '../dist/tree.js';

const trace = debug('all.test.ts:trace');
const error = debug('all.test.ts:error');

const name = 'JOBSTEST'; // +(new Date()).getTime();
const root = `/bookmarks/services/${name}`;
const pending = `/bookmarks/services/${name}/jobs/pending`;
const reportname = 'test-report';
const reportPath = `bookmarks/services/${name}/jobs/reports/${reportname}`;
const abalonemail = `bookmarks/services/abalonemail/jobs/success/day-index`;
const successjob = {
  service: name,
  type: 'basic',
  config: { do: 'success', first: 'abc', second: 'def' },
};
const failjob = {
  ...successjob,
  config: { do: 'fail', first: 'aaa', second: 'bbb' },
};
const jobwaittime = 7000; // Ms to wait for job to complete, tune to your oada response time
let reportTime: any;

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
      /^JOBSTEST/.exec(servicename)
    );
    await Promise.all(
      testservices.map(async (servicename) => {
        trace('Found old test job service: ', servicename, ', deleting it');
        await oada.delete({ path: `/bookmarks/services/${servicename}` });
      })
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
  // Get the current time and set it to execute on the Xth minute of the Yth hour
  // such that it happens in one minute from now
  reportTime = moment().add(1, 'minute');
  const min = reportTime.minute();
  const hr = reportTime.hour();
  const s = reportTime.second();
  svc.addReport(
    reportname,
    oada,
    {
      jobMappings: {
        'Column One': '/config/first',
        'Column Two': '/config/second',
        'Status': 'errorMappings',
      },
      errorMappings: {
        'unknown': 'Other Error',
        'success': 'Success',
        'custom-test': 'Another Error',
      },
    },
    `${s} ${min} ${hr} * * *`,
    () => {
      const date = moment().format('YYYY-MM-DD');
      return {
        from: 'noreply@trellis.one',
        to: {
          name: 'Test Email',
          email: 'sn@centricity.us',
        },
        subject: `Test Email - ${date}`,
        text: `Attached is the Test Report for the test service jobs processed on ${date}`,
        attachments: [
          {
            filename: `TestReport-${date}.csv`,
            type: 'text/csv',
            content: '',
          },
        ],
      };
    },
    'basic'
  );

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

test('Should make a report entry when a job is added to the failure index', async (t) => {
  const { key } = await postJob(oada, pending, failjob);
  await setTimeout(jobwaittime);
  const jobisgone = await oada
    .get({
      path: `${pending}/${key}`,
    })
    .then(() => false)
    .catch((error_) => error_.status === 404);
  t.true(jobisgone);

  const date = moment().format('YYYY-MM-DD');
  const report = await oada
    .get({
      path: `${reportPath}/day-index/${date}/${key}`,
    })
    .then((r) => r.data)
    .catch(() => false);
  t.truthy(report);
  t.deepEqual(report, {
    'Status': 'Other Error',
    'Column One': 'aaa',
    'Column Two': 'bbb',
  });
});

test('Should make a report entry when a job is added to the success index', async (t) => {
  t.timeout(20_000);
  const { key } = await postJob(oada, pending, successjob);
  await setTimeout(jobwaittime);
  const jobisgone = await oada
    .get({
      path: `${pending}/${key}`,
    })
    .then(() => false)
    .catch((error_) => error_.status === 404);
  t.true(jobisgone);

  const date = moment().format('YYYY-MM-DD');
  const report = await oada
    .get({
      path: `${reportPath}/day-index/${date}/${key}`,
    })
    .then((r) => r.data)
    .catch(() => false);
  t.truthy(report);
  t.deepEqual(report, {
    'Status': 'Success',
    'Column One': 'abc',
    'Column Two': 'def',
  });
});

test('Should post a job to abalonemail when it is time to report', async (t) => {
  t.timeout(75_000);
  const date = moment().format('YYYY-MM-DD');
  // @ts-expect-error
  const wait = reportTime - moment();
  await setTimeout(wait > 0 ? wait + 5000 : 0);

  const result = await oada
    .get({
      path: `${abalonemail}/${date}`,
    })
    .then((r) => r.data as unknown as JsonObject);
  t.truthy(result);

  let keys = Object.keys(result).filter((key) => !key.startsWith('_'));

  keys = keys.sort();
  t.true(keys.length > 0);

  const email = await oada
    .get({
      path: `${abalonemail}/${date}/${keys[keys.length - 1]}`,
    })
    .then((r) => r.data as unknown as Job);
  t.is(email.config!.from, 'noreply@trellis.one');
  t.is(email.config!.subject, `Test Email - ${date}`);
  t.truthy(
    // @ts-expect-error skip for now
    email.config && email.config.attachments && email.config.attachments[0]
  );
  // @ts-expect-error
  t.not(email.config.attachments[0].content, '');
});

/*
Test('Should not generate an abalonemail job when the report data is empty', async (t) => {
  t.timeout(75_000);
  const date = moment().format('YYYY-MM-DD');
  //@ts-ignore
  let wait = (reportTime - moment());
  await setTimeout(wait > 0 ? wait+5000 : 0);

  const result = await oada.get({
    path: `${abalonemail}/${date}`,
  }).then(r=>r.data as unknown as JsonObject);
  t.truthy(result)

  let keys = Object.keys(result).filter(key => key.charAt(0) !== '_');

  keys = keys.sort();
  t.true(keys.length > 0)

  const email = await oada.get({
    path: `${abalonemail}/${date}/${keys[keys.length-1]}`,
  }).then(r=>r.data as unknown as Job);
  t.is(email.config!.from, "noreply@trellis.one");
  t.is(email.config!.subject, `Test Email - ${date}`);
  //@ts-ignore
  t.truthy(email.config && email.config.attachments && email.config.attachments[0]);
  //@ts-ignore
  t.notDeepEqual(email.config.attachments[0].content, "");
  });
*/