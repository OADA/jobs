#! /usr/bin/env node
import oadaclient from '@oada/client';
import minimist from 'minimist';
import debug from 'debug';
import Promise from 'bluebird';
import moment from 'moment';
import chalk from 'chalk';
import colorjson from 'color-json';

const trace = debug('@oada/jobs#cli:trace');
const info = console.log;
const error = console.error;

let token = 'god-proxy';
let domain = 'proxy';
let queue = '';
let oada = null;

(async () => {

  const argv = minimist(process.argv.slice(2));

  // Sanity check args
  if (   argv['?'] || argv.help || !argv.q
      // or retry must have jobid
      || (argv._[0] === 'retry' && argv._.length < 2)
      // or print must have which to search for jobid and jobid
      || (argv._[0] === 'print' && (argv._.length < 3 || !argv._[1].match(/^jobs/)))) {
    return usage();
  }

  // Fill in from flags
  if (argv.t) token = argv.t;
  if (argv.d) domain = argv.d;
  if (!domain.match(/^http/)) domain = 'https://'+domain;
  queue = argv.q.replace('/$',''); // no trailing slash

  // Connect to oada globally
  oada = await oadaclient.connect({token,domain});

  // Commands: retry
  if (argv._[0] === 'retry') return retryJob(argv._[1]);

  // Commands: print
  if (argv._[0] === 'print') return printJob(argv._[2], argv._[1]);

  // Commands: list
  else return list()

})().then(() => process.exit(0))
.catch(e => {
  error(chalk.red("FAILED: ERROR was "), e)
  process.exit(1);
});

function usage() {
  console.log('USAGE: oada-jobs [-t token] [-d domain] -q <queuepath> (list|retry <jobid>|print <jobs|jobs-success|jobs-failure> <jobid>)')
  console.log('');
  console.log('     list: prints list of all jobids in current jobs queue and latest success/fail ');
  console.log('           queues.  By default, this will list if no command passed.');
  console.log('');
  console.log('     print <jobs|jobs-success|jobs-failure> <jobid>: prints contents of a job, either in ');
  console.log('                                                     jobs, jobs-success, or jobs-failure list');
  console.log('');
  console.log('     retry <jobid>: retry jobid by re-posting a new job with same job config.  ');
  console.log('                    Job must be in failure queue.');
}



//---------------------------------------------------
// print
//---------------------------------------------------

async function printJob(jid, which) {
  const { job } = await findJobByJobId(jid, which);
  if (!job) {
    return info(chalk.red('FAIL: could not find job by id ', jid, ' in ', which));
  }
  info(chalk.cyan(`Printing job: ${jid}`));
  info(colorjson(job));
}


//---------------------------------------------------
// retry
//---------------------------------------------------

async function retryJob(jobid) {
  const { job, day } = await findJobByJobId(jobid, 'jobs-failure');
  const oldjob = job;
  info(`Re-posting job config from job ${jobid} that failed on ${day}`);
  trace(`Old job config = `, oldjob.config);
  // Create the new job resource
  const reskey = await oada.post({ 
    path: `/resources`, 
    data: { 
      type: oldjob.type,
      service: oldjob.service,
      config: oldjob.config,
    },
    _type: 'application/vnd.oada.service.job.1+json'
  }).then(r=>r.headers['content-location'].replace(/^\/resources\//,''));
  // Post to jobs queue
  await oada.put({ 
    path: `${queue}/jobs`, 
    data: { [reskey]: { _id: `resources/${reskey}` } }, 
    _type: 'application/vnd.oada.service.jobs.1+json' 
  });
  info(`Successfully re-posted original job to new jobid ${reskey} at ${queue}/jobs/${reskey}`);
}

async function findJobByJobId(jid,which) {
  if (which === 'jobs') {
    trace(`findJobByJobId: asked for jobs queue, returning job`);
    return { 
      job: await oada.get({ path: `${queue}/jobs/${jid}`}).then(r=>d.data).catch(e => null),
    };
  }

  // Otherwise, have to look in day-index under success and failure
  const base = `${queue}/${which}/day-index`;
  // Retrieve the list of day-indexes:
  const daylist = await oada.get({ path: base }).then(r=>r.data);
  // Sort the days from most to least recent, start pulling 10 at a time
  const days = Object.keys(daylist).sort().reverse();
  trace(`findJobByJobId: days list is `, days);

  // For now to avoid server load, we'll fetch them one day at a time
  for(let di in days) {
    const d = days[di];
    const daybase = `${base}/${d}`; // day-index/2020-07-21
    trace(`Looking for jobid ${jid} in ${daybase}`);
    const jobids = await oada.get({ path: daybase }).then(r=>r.data);
    if (jobids[jid]) {
      trace(`Found jobid ${jid} under ${daybase}`);
      return {
        job: await oada.get({ path: `${daybase}/${jid}` }).then(r=>r.data),
        day: d,
      };
    }
  }
  throw new Error(`ERROR: Failed to find the job ID after searching all the day-indexes in ${which}!`);
}


//-------------------------------------------------------------
// list
//-------------------------------------------------------------

async function list() {
  const latest_success = await getMostRecentDayIndex('jobs-success');
  const latest_failure = await getMostRecentDayIndex('jobs-failure');
  const { jobs, success, failure } = await Promise.props({
       jobs: oada.get({ path: `${queue}/jobs` }).then(r=>r.data),
    success: oada.get({ path: `${queue}/jobs-success/day-index/${latest_success}` }).then(r=>r.data),
    failure: oada.get({ path: `${queue}/jobs-failure/day-index/${latest_failure}` }).then(r=>r.data),
  });
  trace(`jobs = `, jobs);
  trace(`success = `, success);
  trace(`failure = `, failure);
  const re = chalk.red;
  const gr = chalk.green;
  const wh = chalk.white;
  const cy = chalk.cyan;
  const ye = chalk.yellow;

  info(wh(`Listing jobs for queue ${queue}`));
  info(wh(`-------------------------------`));
  printJobs(   jobs, 'Current', chalk.yellow);
  printJobs(success, 'Success', chalk.green , latest_success);
  printJobs(failure, 'Failure', chalk.red   , latest_failure);
}

function printJobs(jobs,label,color,day) {
  let jobids = Object.keys(jobs).filter(k => !k.match(/^_/));
  info(color(`${label} Jobs${day?` (${day})`:''}: ${jobids.length}`));
  for (let j in jobids) {
    info(color(`  ${jobids[j]}: ${JSON.stringify(jobs[jobids[j]])}`));
  }
  info();
  info(chalk.white(`-------------------------------`));
}

async function getMostRecentDayIndex(which) {
  const list = await oada.get({path: `${queue}/${which}/day-index`}).then(r=>r.data);
  const days = Object.keys(list).sort().reverse();
  if (days.length < 1) return null;
  return days[0];
}
