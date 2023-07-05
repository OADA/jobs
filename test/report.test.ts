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

import { type Json, Service } from '../dist/index.js';
import { type JsonObject, type OADAClient, connect, doJob } from '@oada/client';
import { domain, token } from './config.js';
import type EmailJob from '@oada/types/trellis/service/abalonemail/email.js';
import debug from 'debug';
import moment from 'moment';
import { postJob } from './utils.js';
import { setTimeout } from 'node:timers/promises';
import test from 'ava';
import { parseAttachment } from '../dist/Report.js';

const trace = debug('all.test.ts:trace');
const error = debug('all.test.ts:error');

const name = 'JOBSTEST';
const root = `/bookmarks/services/${name}`;
const pending = `/bookmarks/services/${name}/jobs/pending`;
const reportname = 'test-report';
const reportPath = `bookmarks/services/${name}/jobs/reports/${reportname}`;
const successJobs = `bookmarks/services/abalonemail/jobs/success/day-index`;
const successjob = {
  service: name,
  type: 'basic',
  config: { result: 'success', first: 'abc', second: 'def' },
};
const failjob = {
  ...successjob,
  config: { result: 'fail', first: 'aaa', second: 'bbb' },
};
const jobwaittime = 7000; // Ms to wait for job to complete, tune to your oada response time
let reportTime: any;

let oada: OADAClient;
let svc: Service;
test.before(async () => {
  // Get global connection to oada for later tests
  oada = await connect({ domain, token });
  await oada.delete({
    path: root,
  });

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

    const { result } = job.config as any;
    switch (result) {
      case 'success': {
        return { success: true } as Json;
      }

      case 'fail': {
        throw new Error('config.result is fail');
      }

      default: {
        throw new Error(`Unknown result ${result} in job config`);
      }
    }
  });
  // Get the current time and set it to execute on the Xth minute of the Yth hour
  // such that it happens in one minute from now
  reportTime = moment().add(1, 'minute');
  const min = reportTime.minute();
  const hr = reportTime.hour();
  const s = reportTime.second();
  svc.addReport({
    name: reportname,
    reportConfig: {
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
    frequency: `${s} ${min} ${hr} * * *`,
    email: () => {
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
    type: 'basic',
  });

  await svc.start();
});

test.after(async () => {
  await svc.stop();
  await oada.delete({
    path: root,
  });
});

test.afterEach(async () => {
  const { data: jobs } = (await oada.get({
    path: `/bookmarks/services/abalonemail/jobs/pending`,
  })) as unknown as { data: Record<string, any> };
  const keys = Object.keys(jobs).filter((key) => !key.startsWith('_'));
  for await (const key of keys) {
    await oada.delete({
      path: `/bookmarks/services/abalonemail/jobs/pending/${key}`,
    });
  }
});

test('Should make a report entry when a job is added to the failure index', async (t) => {
  t.timeout(30_000);
  const { key } = await postJob(oada, pending, failjob);
  await setTimeout(12_000);
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
  const wait = reportTime - Date.now();
  await setTimeout(wait > 0 ? wait + 5000 : 0);

  const { data: result } = (await oada.get({
    path: `${successJobs}/${date}`,
  })) as unknown as { data: JsonObject };
  t.truthy(result);

  let keys = Object.keys(result).filter((key) => !key.startsWith('_'));

  keys = keys.sort();
  t.true(keys.length > 0);

  const { data: email } = (await oada.get({
    path: `${successJobs}/${date}/${keys[keys.length - 1]}`,
  })) as unknown as { data: EmailJob };
  t.is(email.config.from, 'noreply@trellis.one');
  t.is(email.config.subject, `Test Email - ${date}`);
  t.truthy(email.config.attachments?.[0]);
  t.not(email.config.attachments?.[0]?.content, '');
});

// TODO: needs finished
test.skip('Should produce non-overlapping times (and results) in each report', async (t) => {
  t.timeout(75_000);
  await setTimeout(5000);
});

test.only('parseAttachments should be able to reconstruct the csv object', async (t) => {
  t.timeout(75_000);
  const thisReportName = 'this-test-report';

  const wait = 25;
  const dt = new Date();
  dt.setSeconds(dt.getSeconds() + wait);
  svc.addReport({
    name: thisReportName,
    reportConfig: {
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
    frequency: `${dt.getSeconds()} ${dt.getMinutes()} ${dt.getHours()} * * ${dt.getDay()}`,
    email: () => {
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
    type: 'basic',
  });
  await svc.start();

  const res = await doJob(oada, successjob);
  await setTimeout(30_000);

  const { data: result } = (await oada.get({
    path: `/bookmarks/services/abalonemail/jobs/pending`,
  })) as unknown as { data: JsonObject };
  t.truthy(result);
  const keys = Object.keys(result)
    .filter((key) => !key.startsWith('_'))
    .sort();
  t.assert(keys.length > 0);
  const key = keys[0];

  const { data: content } = (await oada.get({
    path: `/bookmarks/services/abalonemail/jobs/pending/${key}/config/attachments/0/content`,
  })) as unknown as { data: any };

  const tableData = parseAttachment(content) as any;
  t.assert(tableData[0]['Column One']);
  t.assert(tableData[0]['Column Two']);
  t.assert(tableData[0].Status);
});

test.skip('Should not generate an abalonemail job when the report data is empty', async (t) => {
  t.timeout(75_000);
  const thisReportName = 'this-test-report';

  const wait = 3;
  const dt = new Date();
  dt.setSeconds(dt.getSeconds() + wait);
  svc.addReport({
    name: thisReportName,
    reportConfig: {
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
    frequency: `${dt.getSeconds()} ${dt.getMinutes()} ${dt.getHours()} * * ${dt.getDay()}`,
    email: () => {
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
    type: 'basic',
  });

  // Don't do any jobs. This should create no attachment content
  await setTimeout(wait * 2 * 1000);

  const { data: result } = (await oada.get({
    path: `/bookmarks/services/abalonemail/jobs/pending`,
  })) as unknown as { data: JsonObject };
  t.truthy(result);
  const keys = Object.keys(result)
    .filter((key) => !key.startsWith('_'))
    .sort();
  t.true(keys.length === 0);
});

test.skip('Should generate an abalonemail job when the report data is empty and sendEmpty is true', async (t) => {
  t.timeout(75_000);
  const thisReportName = 'this-test-report';

  const wait = 3;
  const dt = new Date();
  dt.setSeconds(dt.getSeconds() + wait);
  svc.addReport({
    name: thisReportName,
    sendEmpty: true,
    reportConfig: {
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
    frequency: `${dt.getSeconds()} ${dt.getMinutes()} ${dt.getHours()} * * ${dt.getDay()}`,
    email: () => {
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
    type: 'basic',
  });

  // Don't do any jobs. This should create no attachment content
  await setTimeout((wait + 3) * 1000);

  const { data: result } = (await oada.get({
    path: `/bookmarks/services/abalonemail/jobs/pending`,
  })) as unknown as { data: JsonObject };
  t.truthy(result);
  const keys = Object.keys(result)
    .filter((key) => !key.startsWith('_'))
    .sort();
  t.true(keys.length > 0);
});
