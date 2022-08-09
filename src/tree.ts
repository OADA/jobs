import type { Tree } from '@oada/list-lib';

export const tree: Tree = {
  bookmarks: {
    _type: 'application/vnd.oada.bookmarks.1+json',
    services: {
      '_type': 'application/vnd.oada.services.1+json',
      '_rev': 0,
      '*': {
        '_type': 'application/vnd.oada.service.1+json',
        '_rev': 0,
        'queues': {
          '_type': 'application/vnd.oada.service.queues.1+json',
          '*': {
            _type: 'application/vnd.oada.service.queue.1+json',
          },
        },
        'jobs': {
          '_type': 'application/vnd.oada.service.jobs.1+json',
          'pending': {
            '_type': 'application/vnd.oada.service.jobs.1+json',
            '*': {
              _type: 'application/vnd.oada.service.job.1+json',
            }
          },
          'success': {
            '_type': 'application/vnd.oada.service.jobs.1+json',
            'day-index': {
              '*': {
                '_type': 'application/vnd.oada.service.jobs.1+json',
                '_rev': 0,
                '*': {
                  _type: 'application/vnd.oada.service.job.1+json',
                  '_rev': 0,
                },
              },
            },
          },
          'failure': {
            '_type': 'application/vnd.oada.service.jobs.1+json',
            'day-index': {
              '*': {
                '_type': 'application/vnd.oada.service.jobs.1+json',
                '_rev': 0,
                '*': {
                  _type: 'application/vnd.oada.service.job.1+json',
                  '_rev': 0,
                },
              },
            },
            '*': {
              '_type': 'application/vnd.oada.service.jobs.1+json',
              '_rev': 0,
              'day-index': {
                '*': {
                  '_rev': 0,
                  '_type': 'application/vnd.oada.service.jobs.1+json',
                  '*': {
                    _type: 'application/vnd.oada.service.job.1+json',
                    '_rev': 0,
                  },
                },
              },
            }
          },
          'reports': {
            '_type': 'application/vnd.oada.service.reports.1+json',
            '*': {
              _type: 'application/vnd.oada.service.report.1+json',
              'day-index': {
                '*': {
                  '_type': 'application/vnd.oada.service.jobs.1+json',
                },
              },
            },
          },
        },
      },
    },
  },
};