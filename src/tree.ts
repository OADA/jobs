export const serviceTree = {
  bookmarks: {
    _type: 'application/vnd.oada.bookmarks.1+json',
    services: {
      _type: 'application/vnd.oada.services.1+json',
      _rev: 0,
      '*': {
        _type: 'application/vnd.oada.service.1+json',
        _rev: 0,
        queues: {
          _type: 'application/vnd.oada.service.queues+json',
          '*': {
            _type: 'application/vnd.oada.service.queue+json',
          },
        },
        jobs: {
          _type: 'application/vnd.oada.service.jobs+json',
          '*': {
            _type: 'application/vnd.oada.service.job+json',
          },
        },
        'jobs-failure': {
          _type: 'application/vnd.oada.service.jobs-failure+json',
          'day-index': {
            '*': {
              _type: 'application/vnd.oada.service.jobs+json',
              '*': {
                _type: 'application/vnd.oada.service.job+json',
              },
            },
          },
        },
        'jobs-success': {
          _type: 'application/vnd.oada.service.jobs-success+json',
          'day-index': {
            '*': {
              _type: 'application/vnd.oada.service.jobs+json',
              '*': {
                _type: 'application/vnd.oada.service.job+json',
              },
            },
          },
        },
      },
    },
  },
};
