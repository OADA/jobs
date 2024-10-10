/**
 * @license
 * Copyright 2023 Open Ag Data Alliance
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

/* eslint-disable sonarjs/no-duplicate-string */

import type Tree from '@oada/types/oada/tree/v1.js';

export const tree = {
  bookmarks: {
    _type: 'application/vnd.oada.bookmarks.1+json',
    services: {
      '_type': 'application/vnd.oada.services.1+json',
      '_rev': 0,
      '*': {
        _type: 'application/vnd.oada.service.1+json',
        _rev: 0,
        queues: {
          '_type': 'application/vnd.oada.service.queues.1+json',
          '*': {
            _type: 'application/vnd.oada.service.queue.1+json',
          },
        },
        jobs: {
          '_type': 'application/vnd.oada.service.jobs.1+json',
          'pending': {
            '_type': 'application/vnd.oada.service.jobs.1+json',
            '*': {
              _type: 'application/vnd.oada.service.job.1+json',
            },
          },
          'success': {
            '_type': 'application/vnd.oada.service.jobs.1+json',
            '_rev': 0,
            'day-index': {
              '*': {
                '_type': 'application/vnd.oada.service.jobs.1+json',
                '_rev': 0,
                '*': {
                  _type: 'application/vnd.oada.service.job.1+json',
                  _rev: 0,
                },
              },
            },
          },
          'failure': {
            '_type': 'application/vnd.oada.service.jobs.1+json',
            '_rev': 0,
            'day-index': {
              '*': {
                '_type': 'application/vnd.oada.service.jobs.1+json',
                '_rev': 0,
                '*': {
                  _type: 'application/vnd.oada.service.job.1+json',
                  _rev: 0,
                },
              },
            },
          },
          'typed-failure': {
            '*': {
              '_type': 'application/vnd.oada.service.jobs.1+json',
              '_rev': 0,
              'day-index': {
                '*': {
                  '_rev': 0,
                  '_type': 'application/vnd.oada.service.jobs.1+json',
                  '*': {
                    _type: 'application/vnd.oada.service.job.1+json',
                    _rev: 0,
                  },
                },
              },
            },
          },
          'reports': {
            '_type': 'application/vnd.oada.service.reports.1+json',
            '*': {
              '_type': 'application/vnd.oada.service.report.1+json',
              'day-index': {
                '*': {
                  _type: 'application/vnd.oada.service.jobs.1+json',
                },
              },
            },
          },
        },
      },
    },
  },
} as const satisfies Tree;
