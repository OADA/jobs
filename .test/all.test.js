import test from 'ava';
import { domain, token } from './config.js';
import { connect } from '@oada/client';
import { setTimeout } from 'timers/promises';
import { oadaify } from '@oada/oadaify';
import debug from 'debug';
import moment from 'moment';
import { deleteResourceAndLinkIfExists, postJob } from './utils.js';
import { Service } from '../dist/index.js';
import { tree } from '../dist/tree.js';
const trace = debug('all.test.ts:trace');
const error = debug('all.test.ts:error');
const name = 'JOBSTEST';
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
const jobwaittime = 2500;
let oada;
let svc;
test.before(async (t) => {
    t.timeout(10000);
    oada = await connect({ domain, token });
    const existing = await oada.get({ path: '/bookmarks/services' })
        .then(r => oadaify(r.data));
    if (typeof existing === 'object' && existing) {
        const testservices = Object.keys(existing)
            .filter(servicename => servicename.match(/^JOBSTEST/));
        await Promise.all(testservices.map(async (servicename) => {
            trace('Found old test job service: ', servicename, ', deleting it');
            await oada.delete({ path: `/bookmarks/services/${servicename}` });
        }));
    }
    await deleteResourceAndLinkIfExists(oada, root);
    trace('before: starting service ', name);
    svc = new Service({
        name,
        oada,
    });
    svc.on('basic', 1000, async (job) => {
        trace('received job, job.config = ', job?.config);
        if (!job?.config) {
            error('There is no config on the job.');
            throw new Error('job.config does not exist');
        }
        const command = job.config.do;
        switch (command) {
            case 'success': return { success: true };
            case 'fail': throw new Error('config.do is throw');
            default: throw new Error(`Unknown do command ${command} in job config`);
        }
    });
    await svc.start();
    const exists = await oada.head({ path: `${root}/jobs` })
        .then(() => true).catch(() => false);
    if (!exists)
        await oada.put({ path: `${root}/jobs`, data: {}, tree });
    trace('Finished with startup,');
});
test.after(async () => {
    await svc.stop();
});
test('Should remove job from jobs queue when done', async (t) => {
    const { key } = await postJob(oada, pending, successjob);
    await setTimeout(jobwaittime);
    const jobisgone = await oada.get({
        path: `${pending}/${key}`,
    }).then(() => false).catch(e => e.status === 404);
    t.is(jobisgone, true);
});
test('Should move successful job to success queue, have status success, and store result verbatim', async (t) => {
    const dayindex = moment().format('YYYY-MM-DD');
    const { key } = await postJob(oada, pending, successjob);
    await setTimeout(jobwaittime);
    const result = await oada.get({
        path: `${success}/day-index/${dayindex}/${key}`,
    }).then(r => r.data).catch(e => {
        if (e.status === 404)
            return false;
        throw e;
    });
    t.is(result?.status, 'success');
    t.deepEqual(result?.result, { success: true });
});
test('Should move failed job to failure queue, have status failure', async (t) => {
    const dayindex = moment().format('YYYY-MM-DD');
    const { key } = await postJob(oada, pending, failjob);
    await setTimeout(jobwaittime);
    const result = await oada.get({
        path: `${failure}/day-index/${dayindex}/${key}`,
    }).then(r => r.data).catch(e => {
        if (e.status === 404)
            return false;
        throw e;
    });
    t.not(result, false);
    t.is(result?.status, 'failure');
});
test('Should fail a posted job that does not look like a job (missing config)', async (t) => {
    const dayindex = moment().format('YYYY-MM-DD');
    const { key } = await postJob(oada, pending, { thisis: 'not a valid job' });
    await setTimeout(jobwaittime);
    const result = await oada.get({
        path: `${failure}/day-index/${dayindex}/${key}`,
    }).then(r => r.data).catch(e => {
        if (e.status === 404)
            return false;
        throw e;
    });
    t.not(result, false);
    t.is(result?.status, 'failure');
});
test('Should allow job created with a tree put (can lead to empty job content for a moment)', async (t) => {
    const dayindex = moment().format('YYYY-MM-DD');
    const key = 'abc123';
    await oada.put({
        path: `${pending}/${key}`,
        data: successjob,
        tree
    });
    await setTimeout(jobwaittime);
    const result = await oada.get({
        path: `${success}/day-index/${dayindex}/${key}`,
    }).then(r => r.data).catch(e => {
        if (e.status === 404)
            return false;
        throw e;
    });
    t.not(result, false);
    t.is(result?.status, 'success');
});
test('Should allow connection with existing OADAClient', async (t) => {
    let con = await connect({ domain, token });
    t.notThrows(() => {
        new Service({
            name,
            oada: con,
        });
    });
});
test('Should allow connection with new connection Config', async (t) => {
    t.notThrows(() => {
        new Service({
            name,
            oada: { domain, token }
        });
    });
});
//# sourceMappingURL=all.test.js.map