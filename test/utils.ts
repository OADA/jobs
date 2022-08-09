import type { OADAClient, ConnectionResponse, Json } from '@oada/client';
import { tree } from '../dist/tree.js';

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
    contentType: tree.bookmarks!.services!['*']!.jobs!._type,
  }).then(r => r.headers['content-location']?.replace(/^\//,'') || '') // get rid of leading slash for link

  // 2: Now post a link to that job
  const key = await oada.post({
    path,
    data: { _id },
    contentType: tree.bookmarks!.services!['*']!.jobs!.pending!['*']!._type,
  }).then(r => r.headers['content-location']?.replace(/\/resources\/[^\/]+\//,'') || '') // get rid of resourceid to get the new key

  return { _id, key };
}