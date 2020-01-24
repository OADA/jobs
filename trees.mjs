export const servicesJobsTree = {
  bookmarks: {
    _type: 'application/vnd.oada.bookmarks.1+json',
    services: {
      _type: 'application/vnd.oada.services.1+json',
      _rev: 0,
      '*': {
        _type: 'application/vnd.oada.service.1+json',
        _rev: 0,
        jobs: {
          _type: 'application/vnd.oada.service.jobs.1+json'
        }
      }
    }
  }
};

export const servicesJobsFailedTree = {
  bookmarks: {
    _type: 'application/vnd.oada.bookmarks.1+json',
    services: {
      _type: 'application/vnd.oada.services.1+json',
      _rev: 0,
      '*': {
        _type: 'application/vnd.oada.service.1+json',
        _rev: 0,
        'jobs-failed': {
          _type: 'application/vnd.oada.service.jobs.1+json'
        }
      }
    }
  }
};
