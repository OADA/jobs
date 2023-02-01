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

import type { ConnectionResponse, Json, OADAClient } from '@oada/client';

import { tree } from '../dist/tree.js';

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
      contentType: tree.bookmarks!.services!['*']!.jobs!._type,
    })
    .then((r) => r.headers['content-location']?.replace(/^\//, '') ?? ''); // Get rid of leading slash for link

  // 2: Now post a link to that job
  const key = await oada
    .post({
      path,
      data: { _id },
      contentType: tree.bookmarks!.services!['*']!.jobs!.pending!['*']!._type,
    })
    .then(
      (r) =>
        r.headers['content-location']?.replace(/\/resources\/[^/]+\//, '') ?? ''
    ); // Get rid of resourceId to get the new key

  return { _id, key };
}
