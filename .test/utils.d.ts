import type { OADAClient, ConnectionResponse, Json } from '@oada/client';
export declare function deleteResourceAndLinkIfExists(oada: OADAClient, path: string): Promise<void>;
export declare function keyFromLocation(r: ConnectionResponse): string;
export declare function postJob(oada: OADAClient, path: string, job: Json): Promise<{
    _id: string;
    key: string;
}>;
