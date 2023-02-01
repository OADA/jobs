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
const jobwaittime = 7000;
let reportTime;
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
    reportTime = moment().add(1, 'minute');
    let min = reportTime.minute();
    let hr = reportTime.hour();
    let s = reportTime.second();
    svc.addReport(reportname, oada, {
        jobMappings: {
            "Column One": "/config/first",
            "Column Two": "/config/second",
            "Status": "errorMappings",
        },
        errorMappings: {
            "unknown": "Other Error",
            "success": "Success",
            "custom-test": "Another Error"
        }
    }, `${s} ${min} ${hr} * * *`, () => {
        let date = moment().format('YYYY-MM-DD');
        return {
            "from": "noreply@trellis.one",
            "to": {
                "name": "Test Email",
                "email": "sn@centricity.us"
            },
            "subject": `Test Email - ${date}`,
            "text": `Attached is the Test Report for the test service jobs processed on ${date}`,
            "attachments": [{
                    "filename": `TestReport-${date}.csv`,
                    "type": "text/csv",
                    "content": ""
                }]
        };
    }, 'basic');
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
test('Should make a report entry when a job is added to the failure index', async (t) => {
    const { key } = await postJob(oada, pending, failjob);
    await setTimeout(jobwaittime);
    const jobisgone = await oada.get({
        path: `${pending}/${key}`,
    }).then(() => false).catch(e => e.status === 404);
    t.true(jobisgone);
    let date = moment().format('YYYY-MM-DD');
    const report = await oada.get({
        path: `${reportPath}/day-index/${date}/${key}`,
    }).then((r) => r.data).catch(() => false);
    t.truthy(report);
    t.deepEqual(report, { Status: 'Other Error', 'Column One': 'aaa', 'Column Two': 'bbb' });
});
test('Should make a report entry when a job is added to the success index', async (t) => {
    t.timeout(20000);
    const { key } = await postJob(oada, pending, successjob);
    await setTimeout(jobwaittime);
    const jobisgone = await oada.get({
        path: `${pending}/${key}`,
    }).then(() => false).catch(e => e.status === 404);
    t.true(jobisgone);
    let date = moment().format('YYYY-MM-DD');
    const report = await oada.get({
        path: `${reportPath}/day-index/${date}/${key}`,
    }).then((r) => r.data).catch(() => false);
    t.truthy(report);
    t.deepEqual(report, { Status: 'Success', 'Column One': 'abc', 'Column Two': 'def' });
});
test('Should post a job to abalonemail when it is time to report', async (t) => {
    t.timeout(75000);
    const date = moment().format('YYYY-MM-DD');
    let wait = (reportTime - moment());
    await setTimeout(wait > 0 ? wait + 5000 : 0);
    const result = await oada.get({
        path: `${abalonemail}/${date}`,
    }).then(r => r.data);
    t.truthy(result);
    let keys = Object.keys(result).filter(key => key.charAt(0) !== '_');
    keys = keys.sort();
    t.true(keys.length > 0);
    const email = await oada.get({
        path: `${abalonemail}/${date}/${keys[keys.length - 1]}`,
    }).then(r => r.data);
    t.is(email.config.from, "noreply@trellis.one");
    t.is(email.config.subject, `Test Email - ${date}`);
    t.truthy(email.config && email.config.attachments && email.config.attachments[0]);
    t.notDeepEqual(email.config.attachments[0].content, "");
});
//# sourceMappingURL=report.test.js.map