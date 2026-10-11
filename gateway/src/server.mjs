// Gateway entry point (Cloud Run or any Node 22 host). Configuration and secrets come from the
// environment only; see docs/GATEWAY_TH.md. Exits if neither feature is configured.
import http from 'node:http';
import { loadConfig } from './config.mjs';
import { createGateway } from './app.mjs';

const config = loadConfig();
if (!config.identity && !config.line) {
  console.error(JSON.stringify({ severity: 'ERROR', event: 'not_configured', message: 'set the identity and/or LINE variables (docs/GATEWAY_TH.md)' }));
  process.exit(1);
}
let identity = null;
if (config.identity) {
  const { createFirebaseVerifier } = await import('./firebase.mjs');
  identity = await createFirebaseVerifier({ projectId: config.identity.projectId, tenantId: config.identity.tenantId });
}
const handler = createGateway({ config, identity });
const server = http.createServer((req, res) => { handler(req, res); });
server.requestTimeout = 60000;
server.headersTimeout = 15000;
server.listen(config.port, () => {
  console.log(JSON.stringify({ severity: 'INFO', event: 'listening', port: config.port, identity: !!config.identity, line: !!config.line }));
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
