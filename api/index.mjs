import { createCloudHandler } from '../server/cloud/handler.mjs';

export const config = { maxDuration: 300 };
export default createCloudHandler();
