import { createScopeServer } from '../src/server.mjs';
import { loadSandboxConfiguration, openSandboxRuntime } from '../src/paypal-config.mjs';

const port = Number(process.env.SCOPELINE_PORT ?? 31929);
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('Choose a port from 1024 to 65535.');
const payments = openSandboxRuntime(loadSandboxConfiguration());
const server = createScopeServer({ payments });
server.once('close', () => payments?.close());
server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? 'Port is already in use; keep the existing process or select SCOPELINE_PORT.' : 'The local workspace could not start.');
  payments?.close();
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => console.log(`SCOPELINE Local: http://127.0.0.1:${port}/ (${payments ? 'PayPal Sandbox enabled; fictional catalog only' : 'payments disabled'})`));
const stop = () => { server.close(); server.closeIdleConnections(); };
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
