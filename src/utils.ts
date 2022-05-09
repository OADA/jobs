import Debug from 'debug';
import moment from 'moment';
import type { OADAClient, ConnectionResponse, Json } from '@oada/client';
import { serviceTree as tree } from './tree.js';

export const error = Debug('oada-jobs:connection:error');
export const info = Debug('oada-jobs:connection:info');
export const warn = Debug('oada-jobs:connection:warn');
export const debug = Debug('oada-jobs:connection:debug');
export const trace = Debug('oada-jobs:connection:trace');

// Dealing with OADA's `_` keys ... is ... frustrating
export function stripResource<T>(r: T): T {
  /* eslint-disable */
  // @ts-ignore
  delete r._id;
  // @ts-ignore
  delete r._rev;
  // @ts-ignore
  delete r._meta;
  // @ts-ignore
  delete r._type;
  /* eslint-enable */

  return r;
}

export async function deleteResourceAndLinkIfExists(
  oada: OADAClient,
  path: string
):Promise<void> {
  try {
    await oada.head({path});
    // If we get here, it didn't 404
    await oada.delete({path});
  } catch(e) {
    // didn't exist, or some other problem
    return;
  }
}

export function keyFromLocation(r: ConnectionResponse) {
  const loc = r?.headers['content-location'];
  if (!loc || typeof loc !== 'string') return '';
  return loc.replace(/^\/resources\/[^\/]+\//, '');
}

export async function postJob(oada: OADAClient, path: string, job: Json): Promise<{ _id: string, key: string }> {
  // 1:Create a resource for the job and keep resourceid to return
  const _id = await oada.post({
    path: '/resources',
    data: (job as unknown) as Json,
    contentType: tree.bookmarks.services['*'].jobs.pending._type,
  }).then(r => r.headers['content-location']?.replace(/^\//,'') || ''); // get rid of leading slash for link

  // 2: Now post a link to that job
  const key = await oada.post({
    path,
    data: { _id },
    contentType: tree.bookmarks.services['*'].jobs.pending['*']._type,
  }).then(r => r.headers['content-location']?.replace(/\/resources\/[^\/]+\//,'') || ''); // get rid of resourceid to get the new key

  return { _id, key };
}

/**
 * Posts an update message to the Job's OADA object.
 * @param status The value of the current status
 * @param meta Arbitrary JSON serializeable meta data about update
 */
export async function postUpdate(oada: OADAClient, oadaId: string, meta: Json, status: string): Promise<void> {
    await oada.post({
      path: `/${oadaId}/updates`,
      // since we aren't using tree, we HAVE to set the content type or permissions fail
      contentType: tree.bookmarks.services['*'].jobs.pending['*']._type,
      data: {
        status,
        time: moment().toISOString(),
        meta,
      },
    }).catch(e => {
      error('Failed to post update to oada at /'+oadaId+'/updates.  status = ', e.status);
      throw e;
    });
  }
