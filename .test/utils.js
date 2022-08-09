import { tree } from '../dist/tree.js';
export async function deleteResourceAndLinkIfExists(oada, path) {
    try {
        await oada.head({ path });
        await oada.delete({ path });
    }
    catch (e) {
        return;
    }
}
export function keyFromLocation(r) {
    const loc = r?.headers['content-location'];
    if (!loc || typeof loc !== 'string')
        return '';
    return loc.replace(/^\/resources\/[^\/]+\//, '');
}
export async function postJob(oada, path, job) {
    const _id = await oada.post({
        path: '/resources',
        data: job,
        contentType: tree.bookmarks.services['*'].jobs._type,
    }).then(r => r.headers['content-location']?.replace(/^\//, '') || '');
    const key = await oada.post({
        path,
        data: { _id },
        contentType: tree.bookmarks.services['*'].jobs.pending['*']._type,
    }).then(r => r.headers['content-location']?.replace(/\/resources\/[^\/]+\//, '') || '');
    return { _id, key };
}
//# sourceMappingURL=utils.js.map