import { createApp } from './app.mjs';

const { app, shutdown } = await createApp();
const port = Number(process.env.PORT || 3001);
const server = app.listen(port, '127.0.0.1', () => console.log(`Launchpad API: http://127.0.0.1:${port}`));
let exiting = false;
async function exit() { if (exiting) return; exiting = true; server.close(); await shutdown(); process.exit(0); }
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, exit);
process.on('message', message => { if (message === 'shutdown') void exit(); });
