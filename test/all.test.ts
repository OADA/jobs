import { expect } from 'chai';
import { domain, token } from './config';
import { connect, OADAClient } from '@oada/client';
import { setTimeout } from 'timers/promises';
import { oadaify } from '@oada/oadaify';
import type OADAJob from '@oada/types/oada/service/job';
import debug from 'debug';
import moment from 'moment';

import { deleteResourceAndLinkIfExists, postJob } from './utils';

import { Service, Json } from '../src';
import { serviceTree as tree } from '../src/tree';

const trace = debug('all.test.ts:trace');
const error = debug('all.test.ts:error');

const name = 'JOBSTEST'; //+(new Date()).getTime();
const root = `/bookmarks/services/${name}`;
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
    svc = new Service(name, oada, 1);
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
    await postJob(oada, `${root}/jobs`, successjob);
    const { key } = await postJob(oada, `${root}/jobs`, successjob);
    await setTimeout(jobwaittime);
    const jobisgone = await oada.get({ 
      path: `${root}/jobs/${key}`,
    }).then(()=>false).catch(e => e.status === 404);
    expect(jobisgone).to.equal(true);
  });


  it('Should move successful job to success queue, have status success, and store result verbatim', async () => {
    const dayindex = moment().format('YYYY-MM-DD');
    const { key } = await postJob(oada, `${root}/jobs`, successjob);
    await setTimeout(jobwaittime);

    const result = await oada.get({ 
      path: `${root}/jobs-success/day-index/${dayindex}/${key}`,
    }).then(r=>r.data).catch(e => {
      if (e.status === 404) return false; // if it's not there, just return false
      throw e;                              // any other error, throw it back up
    });
    expect((result as OADAJob)?.status).to.equal('success');
    expect((result as OADAJob)?.result).to.deep.equal({ success: true}); // this is what the basic service handler returns
  });


  it('Should move failed job to failure queue, have status failure', async() => {
    const dayindex = moment().format('YYYY-MM-DD');
    const { key } = await postJob(oada, `${root}/jobs`, failjob);
    await setTimeout(jobwaittime);

    const result = await oada.get({ 
      path: `${root}/jobs-failure/day-index/${dayindex}/${key}`,
    }).then(r=>r.data).catch(e => {
      if (e.status === 404) return false; // if it's not there, just return false
      throw e;                              // any other error, throw it back up
    });
    expect(result).to.not.equal(false); // it should be in the failure queue
    expect((result as OADAJob)?.status).to.equal('failure');
  });


  it('Should fail a posted job that does not look like a job (missing config)', async () => {
    const dayindex = moment().format('YYYY-MM-DD');
    const { key } = await postJob(oada, `${root}/jobs`, { thisis: 'not a valid job' });
    await setTimeout(jobwaittime);

    const result = await oada.get({ 
      path: `${root}/jobs-failure/day-index/${dayindex}/${key}`,
    }).then(r=>r.data).catch(e => {
      if (e.status === 404) return false; // if it's not there, just return false
      throw e;                              // any other error, throw it back up
    });
    expect(result).to.not.equal(false); // it should be in the failure queue
    expect((result as OADAJob)?.status).to.equal('failure');
  });

});
