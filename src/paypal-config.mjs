import { readFileSync, lstatSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import { OrderLedger, isProviderId } from './order-ledger.mjs';
import { createPayPalSandboxTransport } from './paypal-sandbox.mjs';

const PRIVATE_FILE = fileURLToPath(new URL('../private.env', import.meta.url));
const PRIVATE_LEDGER = fileURLToPath(new URL('../.private/paypal-ledger/', import.meta.url));
const configurationError = () => new Error('Invalid private PayPal Sandbox configuration. Check the documented sandbox-only settings without printing them.');

/** Only the trusted local launcher reads this explicitly named private file.
 * Nothing reads an OS credential store. The default disabled path performs no
 * OAuth request and opens no journal. Do not log the returned configuration.
 */
export function loadSandboxConfiguration({ env = process.env, privateFile = PRIVATE_FILE } = {}) {
  let local = {};
  try {
    const stat = lstatSync(privateFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) throw configurationError();
    local = parseEnv(readFileSync(privateFile, 'utf8'));
  } catch (error) { if (error.code !== 'ENOENT') throw configurationError(); }
  const value = name => env[name] ?? local[name];
  const enabled = value('SCOPELINE_PAYPAL_SANDBOX_ENABLED');
  if (enabled === undefined || enabled === '0') return null;
  if (enabled !== '1') throw configurationError();
  const clientId = value('PAYPAL_SANDBOX_CLIENT_ID');
  const clientSecret = value('PAYPAL_SANDBOX_CLIENT_SECRET');
  const merchantId = value('PAYPAL_SANDBOX_MERCHANT_ID');
  if (typeof clientId !== 'string' || !/^[A-Za-z0-9_-]{8,256}$/.test(clientId)
    || typeof clientSecret !== 'string' || !/^[\x21-\x7e]{8,512}$/.test(clientSecret)
    || !isProviderId(merchantId)) throw configurationError();
  // There is intentionally no configurable API origin or live environment.
  return Object.freeze({ clientId, clientSecret, merchantId });
}

export function openSandboxRuntime(configuration) {
  if (configuration === null) return null;
  const transport = createPayPalSandboxTransport(configuration);
  const ledger = OrderLedger.open(PRIVATE_LEDGER);
  return { ledger, merchantId: configuration.merchantId, transport, close: () => ledger.close() };
}
