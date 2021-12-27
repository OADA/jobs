import { config as load } from 'dotenv';

load();

export const domain: string = process.env.DOMAIN || 'localhost';
export const token: string = process.env.TOKEN || 'abc';

