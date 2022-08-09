import { config as load } from 'dotenv';
load();
export const domain = process.env.DOMAIN || 'localhost';
export const token = process.env.TOKEN || 'abc';
//# sourceMappingURL=config.js.map