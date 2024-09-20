# @oada/oada-jobs

A library that abstracts away managing an OADA services job queue.

## Install

`$ yarn add @oada/oada-jobs`

## Notes / Todos

1. Only use **unversioned links** in job queues (which is really what you want
   anyway). It is a TODO to deal with change notifications other than merging
   and deleting links into the queue.
2. The promise your work function returns should implement the `cancel` method
   to have job timeouts work as expected. If a promise is timed out, but the
   work function continues, the job will still be moved to `jobs-failure` and
   the status set to `failure`. However; updates from the work function that
   occur after the timeout will still be committed. The result of the work
   function is lost.
3. Add a list of resources which should have the jobs linked to in their meta at
   completion. This is a side effect, but often useful.

## Basic usage

```typescript
const apiKey = process.env.apiKey;
assert(apiKey, 'set ENV `apiKey` to the service sendgrid API key');
import { config } from 'dotenv';
import debug from 'debug';

import { Service, Json } from '@oada/jobs';

config();
const domain = process.env.domain;
assert(domain, 'Set ENV `domain` to domain storing the service configuration');
const token = process.env.token;
assert(token, 'Set ENV `token` to the service token');

const info = debug('service-name:info');

// Allow up to 10 in-flight OADA requests at once
const service = new Service('service-name', domain, token, 10);

// Run work function on all "email" type jobs. Timeout in 10 seconds.
service.on(
  'email',
  10 * 1000,
  async (job, { jobId, log, oada }): Promise<Json> => {
    info(`[Job ${jobId}] μservice triggered`);

    log.info('started', 'Job started');
    const config = job.config;

    assertConfig(config);
    log.trace('confirmed', 'Job config confirmed');

    info(`[Job ${jobId}] Doing work`);
    log.debug('working', 'Working');

    // `oada` already has the correct token loaded
    const r = await oada.get({
      path: `/bookmarks/thing`,
    });

    return { coolThing: r.data.thing };
  },
);

service.start().catch((e: unknown) => {
  console.error(e);
});
```

### Configuring queues

Service queues configuration lives at
`/bookmarks/services/<service-name/queueus` with the service token
(`process.env.token` from the example above). To tell @oada/jobs to watch a
queue POST something like:

```json
{
  "domain": "oada.example.org",
  "token": "jfdjxkfassr3423544511243fzdgsd"
}
```

To stop watching a queue, DELETE the queue object in the queues list `DELETE /bookmarks/services/<service-name>/queues/<queue-id>`.

### Adding jobs

@oada/jobs will call the registered work function for the type of any job added
to one of its queues. The return value is stored on the job object. Any logged
value is stored on the job object. When the work function returns, the job will
be moved to the `jobs-success` or `jobs-failure` lists.

Be sure to set the `OADA_JOBS_LOGGING` environmental variable if you want to log
"debug" and/or "trace" logs.

## Batch jobs

It seems unlikely `@oada/jobs` can reasonable manage "batch" jobs for you -- its
not clear there is a single "correct" batch management.

However, one COULD imagine something like:

```typescript
  Service.getJobs(type: string, batchWork: (queueId: QueueId, jobs: Array<{job: Job, context: WorkerContext}>) => Promise<Json>)`
```

This would be used in place of `Service.on(type, work)`.

The implementor of a batch service would need to develop a work function
processes all Jobs in `jobs` at once, uses the WorkerContext to update each job,
and then result a overall result which will be applied to all jobs in the batch.

The service would need to schedule calls to `getJobs` however it sees fit.

## General idea

The `Service` class manages the overall service. You register work functions of
certain job types with it. The `Service` class watches a list of service queues
(`/bookmarks/services/<service-name>/queues`) using the service token. Each
queue item (a domain and token) results in a `Queue` class.

The `Queue` class watches a particular job queue
(`/bookmarks/services/<service-name>/jobs`) using the associated token from the
Service queue list. Each job that created results in a `Runner` class.

The `Runner` class is sort of like a Promise for an OADA job. It runs the work
function and maintains the Job's state in the OADA store. Note, the OADAClient
that `Runner` provides to the work function is already adjusted for the correct
token. The `work` function should just use the OADAClient without regard for the
token.

Some other useful classes:

`Logger` -- Given to the work function. This exposes methods to add updates to
the Job object in the OADA store. Set OADA_JOBS_LOGGING to something like
"debug,trace" to enable the debug and trace logs, respectively.

`Job` -- Given to the work function. Stores the job type, config, etc.
