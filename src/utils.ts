import Debug from 'debug';

export const info = Debug('oada-jobs:connection:info');
export const debug = Debug('oada-jobs:connection:debug');
export const error = Debug('oada-jobs:connection:error');
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
