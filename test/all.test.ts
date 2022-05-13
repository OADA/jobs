import { expect } from 'chai';
import { domain, token } from './config.js';
import { connect, OADAClient } from '@oada/client';
import { setTimeout } from 'timers/promises';
import { oadaify } from '@oada/oadaify';
import type OADAJob from '@oada/types/oada/service/job.js';
import debug from 'debug';
import moment from 'moment';

import { deleteResourceAndLinkIfExists, postJob } from './utils.js';

import { Service, Json } from '../dist/index.js';
import { serviceTree as tree } from '../dist/tree.js';

const trace = debug('all.test.ts:trace');
const error = debug('all.test.ts:error');

const name = 'JOBSTEST'; //+(new Date()).getTime();
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
}
const jobwaittime = 2500; // ms to wait for job to complete, tune to your oada response time

describe('Overall functional tests: all.test.js', function() {
  this.timeout(10_000);

  let oada: OADAClient;
  let svc: Service;
  before(async () => {
    // Get global connection to oada for later tests
    oada = await connect({domain,token});

    // Cleanup any old service tests that didn't get deleted
    const existing = await oada.get({ path: '/bookmarks/services' })
    .then(r => oadaify(r.data as Json));
    if (typeof existing === 'object' && existing) {
      const testservices = Object.keys(existing)
      .filter(servicename => servicename.match(/^JOBSTEST/));
      await Promise.all(testservices.map(async (servicename) => {
        trace('Found old test job service: ', servicename, ', deleting it');
        await oada.delete({ path: `/bookmarks/services/${servicename}`});
      }));
    }
    await deleteResourceAndLinkIfExists(oada,root);

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
      switch(command) {
        case 'success': return { success: true } as Json;
        case 'fail': throw new Error('config.do is throw');
        default: throw new Error(`Unknown do command ${command} in job config`);
      }
    });
    await svc.start();
    // Since we can't tree-put, ensure the jobs path exists now
    const exists: boolean = await oada.head({ path: `${root}/jobs` })
      .then(()=>true).catch(()=>false);
    if (!exists) await oada.put({ path: `${root}/jobs`, data: {}, tree });
    trace('Finished with startup,');
  });

  after(async () => {
    await svc.stop();
    // await deleteResourceAndLinkIfExists(oada,root);
  });



  it('Should remove job from jobs queue when done', async() => {
    const { key } = await postJob(oada, pending, successjob);
    await setTimeout(jobwaittime);
    const jobisgone = await oada.get({
      path: `${pending}/${key}`,
    }).then(()=>false).catch(e => e.status === 404);
    expect(jobisgone).to.equal(true);
  });


  it('Should move successful job to success queue, have status success, and store result verbatim', async () => {
    const dayindex = moment().format('YYYY-MM-DD');
    const { key } = await postJob(oada, pending, successjob);
    await setTimeout(jobwaittime);

    const result = await oada.get({
      path: `${success}/day-index/${dayindex}/${key}`,
    }).then(r=>r.data).catch(e => {
      if (e.status === 404) return false; // if it's not there, just return false
      throw e;                              // any other error, throw it back up
    });
    expect((result as OADAJob)?.status).to.equal('success');
    expect((result as OADAJob)?.result).to.deep.equal({ success: true}); // this is what the basic service handler returns
  });


  it('Should move failed job to failure queue, have status failure', async() => {
    const dayindex = moment().format('YYYY-MM-DD');
    const { key } = await postJob(oada, pending, failjob);
    await setTimeout(jobwaittime);

    const result = await oada.get({
      path: `${failure}/day-index/${dayindex}/${key}`,
    }).then(r=>r.data).catch(e => {
      if (e.status === 404) return false; // if it's not there, just return false
      throw e;                              // any other error, throw it back up
    });
    expect(result).to.not.equal(false); // it should be in the failure queue
    expect((result as OADAJob)?.status).to.equal('failure');
  });


  it('Should fail a posted job that does not look like a job (missing config)', async () => {
    const dayindex = moment().format('YYYY-MM-DD');
    const { key } = await postJob(oada, pending, { thisis: 'not a valid job' });
    await setTimeout(jobwaittime);

    const result = await oada.get({
      path: `${failure}/day-index/${dayindex}/${key}`,
    }).then(r=>r.data).catch(e => {
      if (e.status === 404) return false; // if it's not there, just return false
      throw e;                              // any other error, throw it back up
    });
    expect(result).to.not.equal(false); // it should be in the failure queue
    expect((result as OADAJob)?.status).to.equal('failure');
  });

  it('Should allow job created with a tree put (can lead to empty job content for a moment))', async () => {
    const dayindex = moment().format('YYYY-MM-DD');
    const key = 'abc123'
    await oada.put({
      path: `${pending}/${key}`,
      data: successjob,
      tree
    })
    await setTimeout(jobwaittime);

    const result = await oada.get({
      path: `${success}/day-index/${dayindex}/${key}`,
    }).then(r=>r.data).catch(e => {
      if (e.status === 404) return false; // if it's not there, just return false
      throw e;                              // any other error, throw it back up
    });
    expect(result).to.not.equal(false); // it should be in the failure queue
    expect((result as OADAJob)?.status).to.equal('success');
  });

  it('Should allow connection with existing OADAClient', async () => {
    let con = await connect({domain,token});
    expect(
      () => {
        new Service({
          name,
          oada: con,
        })
      }
    ).to.not.throw();
  });

  it('Should allow connection with new connection Config', async () => {
    expect(
     () => {
       new Service({
         name,
         oada: {domain,token}
       })
     }
    ).to.not.throw();
  });
});