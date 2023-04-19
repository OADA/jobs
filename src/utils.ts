/**
 * @license
 * Copyright 2023 Qlever LLC
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

import _debug from 'debug';
import moment from 'moment';

import type { ConnectionResponse, Json, OADAClient } from '@oada/client';

import { tree } from './tree.js';

export const error = _debug('oada-jobs:connection:error');
export const info = _debug('oada-jobs:connection:info');
export const warn = _debug('oada-jobs:connection:warn');
export const debug = _debug('oada-jobs:connection:debug');
export const trace = _debug('oada-jobs:connection:trace');

// Dealing with OADA's `_` keys ... is ... frustrating
export function stripResource<T extends Record<string, unknown>>({
  _id,
  _rev,
  _meta,
  _type,
  ...r
}: T) {
  return r;
}

export async function deleteResourceAndLinkIfExists(
  oada: OADAClient,
  path: string
): Promise<void> {
  try {
    await oada.head({ path });
    // If we get here, it didn't 404
    await oada.delete({ path });
  } catch {
    // Didn't exist, or some other problem
  }
}

export function keyFromLocation(r: ConnectionResponse) {
  const loc = r?.headers['content-location'];
  if (!loc || typeof loc !== 'string') return '';
  return loc.replace(/^\/resources\/[^/]+\//, '');
}

export async function postJob(
  oada: OADAClient,
  path: string,
  job: Json
): Promise<{ _id: string; key: string }> {
  // 1:Create a resource for the job and keep resourceid to return
  const _id = await oada
    .post({
      path: '/resources',
      data: job as unknown as Json,
      contentType: tree.bookmarks!.services!['*']!.jobs!.pending!._type,
    })
    .then((r) => r.headers['content-location']?.replace(/^\//, '') ?? ''); // Get rid of leading slash for link

  // 2: Now post a link to that job
  const key = _id.replace(/^resources\//, '');
  await oada.put({
    path: `${path}/${key}`,
    data: { _id },
    contentType: tree.bookmarks!.services!['*']!.jobs!.pending!['*']!._type,
  });

  return { _id, key };
}

/**
 * Posts an update message to the Job's OADA object.
 * @param status The value of the current status
 * @param meta Arbitrary JSON serializeable meta data about update
 */
export async function postUpdate(
  oada: OADAClient,
  oadaId: string,
  meta: Json,
  status: string
): Promise<void> {
  try {
    await oada.post({
      path: `/${oadaId}/updates`,
      // Since we aren't using tree, we HAVE to set the content type or permissions fail
      contentType: tree.bookmarks!.services!['*']!.jobs!.pending!['*']!._type,
      data: {
        status,
        time: moment().toISOString(),
        meta,
      },
    });
  } catch (error_: any) {
    error(
      `Failed to post update to oada at /${oadaId}/updates.  status = `,
      error_.status
    );
    throw error_;
  }
}