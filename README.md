# @oada/oada-jobs

A library that abstracts away managing an OADA services job queue.

## Instal

`$ yarn add @oada/oada-jobs`

## Basic usage

```js
import { JobQueue } from '@oada/oada-jobs';

async function work(id, task, con) {
  await con.put({
    path: `/resources/${id}`,
    data: { touch: true },
    header: { 'Content-Type': 'application/json' }
  });

  return {
    result: 'storage'
  };
}

const service = new JobQueue('example-service', work, {
  concurrency: 1,
  domain: 'https://localhost',
  token: 'abc'
});

(async () => {
  try {
    await service.start();
  } catch (e) {
    console.error(e);
  }
})();
```

Where:
- `id` is the resource id linked in the job
- `task` is task config object stored at `/resources/<id>/_meta/services/<service-name>/task/<task-id>`
- `con` is a pre-configured `oada-cache` instance

`work` is run once for each job/task combination. What is it returns is merged
with the task's config the resource's `_meta` document.
