#!/usr/bin/env node

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

/* eslint-disable no-console, no-process-exit -- this is a CLI */

import Bluebird from 'bluebird';
import chalk from 'chalk';
import colorjson from 'color-json';
import debug from 'debug';
import minimist from 'minimist';

import { connect } from '@oada/client';

const trace = debug('@oada/jobs#cli:trace');
const info = console.log;
const { error } = console;

let token = 'god-proxy';
let domain = 'proxy';
let queue = '';
let oada = null;

try {
  const argv = minimist(process.argv.slice(2));

  // Sanity check args
  if (
    argv['?'] ||
    argv.help ||
    !argv.q ||
    // Or retry must have jobid
    (argv._[0] === 'retry' && argv._.length < 2) ||
    // Or print must have which to search for jobid and jobid
    (argv._[0] === 'print' &&
      (argv._.length < 3 || !argv._[1].startsWith('jobs')))
  ) {
    await usage();
    process.exit(0);
  }

  // Fill in from flags
  if (argv.t) token = argv.t;
  if (argv.d) domain = argv.d;
  if (!domain.startsWith('http')) domain = `https://${domain}`;
  queue = argv.q.replace('/$', ''); // No trailing slash

  // Connect to oada globally
  oada = await connect({ token, domain });

  switch (argv._[0]) {
    // Commands: retry
    case 'retry': {
      await retryJob(argv._[1]);
      break;
    }

    // Commands: print
    case 'print': {
      await printJob(argv._[2], argv._[1]);
      break;
    }

    // Commands: list
    default: {
      await list();
    }
  }
} catch (error_) {
  error(chalk.red('FAILED: ERROR was '), error_);
  process.exit(1);
}

process.exit(0);

function usage() {
  console.log(
    'USAGE: oada-jobs [-t token] [-d domain] -q <queuepath> (list|retry <jobid>|print <pending|success|failure> <jobid>)'
  );
  console.log('');
  console.log(
    '     list: prints list of all jobids in current jobs queue and latest success/fail '
  );
  console.log(
    '           queues.  By default, this will list if no command passed.'
  );
  console.log('');
  console.log(
    '     print <pending|success|failure> <jobid>: prints contents of a job, either in '
  );
  console.log(
    '                                                     pending, success, or failure list'
  );
  console.log('');
  console.log(
    '     retry <jobid>: retry jobid by re-posting a new job with same job config.  '
  );
  console.log('                    Job must be in failure queue.');
}

// ---------------------------------------------------
// print
// ---------------------------------------------------

async function printJob(jid, which) {
  const { job } = await findJobByJobId(jid, which);
  if (!job) {
    return info(
      chalk.red('FAIL: could not find job by id ', jid, ' in ', which)
    );
  }

  info(chalk.cyan(`Printing job: ${jid}`));
  info(colorjson(job));
}

// ---------------------------------------------------
// retry
// ---------------------------------------------------

async function retryJob(jobid) {
  const { job, day } = await findJobByJobId(jobid, 'jobs/failure');
  const oldjob = job;
  info(`Re-posting job config from job ${jobid} that failed on ${day}`);
  trace(`Old job config = `, oldjob.config);
  // Create the new job resource
  const reskey = await oada
    .post({
      path: `/resources`,
      data: {
        type: oldjob.type,
        service: oldjob.service,
        config: oldjob.config,
      },
      _type: 'application/vnd.oada.service.job.1+json',
    })
    .then((r) => r.headers['content-location'].replace(/^\/resources\//, ''));
  // Post to jobs queue
  await oada.put({
    path: `${queue}/jobs/pending`,
    data: { [reskey]: { _id: `resources/${reskey}` } },
    _type: 'application/vnd.oada.service.jobs.1+json',
  });
  info(
    `Successfully re-posted original job to new jobid ${reskey} at ${queue}/jobs/pending/${reskey}`
  );
}

async function findJobByJobId(jid, which) {
  if (which === 'jobs') {
    trace(`findJobByJobId: asked for jobs queue, returning job`);
    return {
      job: await oada
        .get({ path: `${queue}/jobs/pending/${jid}` })
        .then((r) => d.data)
        .catch((error_) => null),
    };
  }

  // Otherwise, have to look in day-index under success and failure
  const base = `${queue}/${which}/day-index`;
  // Retrieve the list of day-indexes:
  const daylist = await oada.get({ path: base }).then((r) => r.data);
  // Sort the days from most to least recent, start pulling 10 at a time
  const days = Object.keys(daylist).sort().reverse();
  trace(`findJobByJobId: days list is `, days);

  // For now to avoid server load, we'll fetch them one day at a time
  for (const di in days) {
    const d = days[di];
    const daybase = `${base}/${d}`; // Day-index/2020-07-21
    trace(`Looking for jobid ${jid} in ${daybase}`);
    const jobids = await oada.get({ path: daybase }).then((r) => r.data);
    if (jobids[jid]) {
      trace(`Found jobid ${jid} under ${daybase}`);
      return {
        job: await oada.get({ path: `${daybase}/${jid}` }).then((r) => r.data),
        day: d,
      };
    }
  }

  throw new Error(
    `ERROR: Failed to find the job ID after searching all the day-indexes in ${which}!`
  );
}

// -------------------------------------------------------------
// list
// -------------------------------------------------------------

async function list() {
  const latest_success = await getMostRecentDayIndex('jobs/success');
  const latest_failure = await getMostRecentDayIndex('jobs/failure');
  const { jobs, success, failure } = await Bluebird.props({
    jobs: oada.get({ path: `${queue}/jobs/pending` }).then((r) => r.data),
    success: oada
      .get({ path: `${queue}/jobs/success/day-index/${latest_success}` })
      .then((r) => r.data),
    failure: oada
      .get({ path: `${queue}/jobs/failure/day-index/${latest_failure}` })
      .then((r) => r.data),
  });
  trace(`jobs = `, jobs);
  trace(`success = `, success);
  trace(`failure = `, failure);
  const wh = chalk.white;

  info(wh(`Listing jobs for queue ${queue}`));
  info(wh(`-------------------------------`));
  printJobs(jobs, 'Current', chalk.yellow);
  printJobs(success, 'Success', chalk.green, latest_success);
  printJobs(failure, 'Failure', chalk.red, latest_failure);
}

function printJobs(jobs, label, color, day) {
  const jobids = Object.keys(jobs).filter((k) => !k.startsWith('_'));
  info(color(`${label} Jobs${day ? ` (${day})` : ''}: ${jobids.length}`));
  for (const index in jobids) {
    info(color(`  ${jobids[index]}: ${JSON.stringify(jobs[jobids[index]])}`));
  }

  info();
  info(chalk.white(`-------------------------------`));
}

async function getMostRecentDayIndex(which) {
  const { data: list } = await oada.get({
    path: `${queue}/${which}/day-index`,
  });
  const days = Object.keys(list).sort().reverse();
  if (days.length === 0) return null;
  return days[0];
}
