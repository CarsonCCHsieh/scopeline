import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadSandboxConfiguration, openSandboxRuntime } from '../src/paypal-config.mjs';

const fake = {
  SCOPELINE_PAYPAL_SANDBOX_ENABLED: '1',
  PAYPAL_SANDBOX_CLIENT_ID: 'FAKE_SANDBOX_CLIENT_ID',
  PAYPAL_SANDBOX_CLIENT_SECRET: 'FAKE_SANDBOX_SECRET_ONLY_FOR_TESTS',
  PAYPAL_SANDBOX_MERCHANT_ID: 'FAKEMERCHANT1',
};
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'scopeline-config-test-'));
  t.after(async () => {
    const target = resolve(directory);
    assert.ok(target.startsWith(resolve(tmpdir()) + '\\') || target.startsWith(resolve(tmpdir()) + '/'));
    assert.match(target, /scopeline-config-test-[^\\/]+$/);
    await rm(target, { recursive: true, force: true });
  });
  return { directory, privateFile: join(directory, 'private.env') };
}
const envText = values => Object.entries(values).map(([name, value]) => `${name}=${value}`).join('\n');

test('sandbox config is disabled without explicit opt-in and opens no runtime', async t => {
  const { privateFile } = await fixture(t);
  assert.equal(loadSandboxConfiguration({ env: {}, privateFile }), null);
  assert.equal(loadSandboxConfiguration({ env: { ...fake, SCOPELINE_PAYPAL_SANDBOX_ENABLED: '0' }, privateFile }), null);
  assert.equal(openSandboxRuntime(null), null);
});

test('sandbox config reads only its explicit bounded file; environment values take precedence', async t => {
  const { privateFile } = await fixture(t);
  await writeFile(privateFile, envText(fake));
  const config = loadSandboxConfiguration({ env: {}, privateFile });
  assert.deepEqual(config, { clientId: fake.PAYPAL_SANDBOX_CLIENT_ID, clientSecret: fake.PAYPAL_SANDBOX_CLIENT_SECRET, merchantId: fake.PAYPAL_SANDBOX_MERCHANT_ID });
  assert.equal(Object.isFrozen(config), true);
  assert.equal(loadSandboxConfiguration({ env: { SCOPELINE_PAYPAL_SANDBOX_ENABLED: '0' }, privateFile }), null);
  assert.equal(loadSandboxConfiguration({ env: { PAYPAL_SANDBOX_CLIENT_ID: 'OTHER_FAKE_CLIENT_ID' }, privateFile }).clientId, 'OTHER_FAKE_CLIENT_ID');
});

test('sandbox config rejects ambiguous flags and invalid secrets without including their values', async t => {
  const { privateFile } = await fixture(t);
  for (const changed of [
    { SCOPELINE_PAYPAL_SANDBOX_ENABLED: 'true' },
    { SCOPELINE_PAYPAL_SANDBOX_ENABLED: '' },
    { PAYPAL_SANDBOX_CLIENT_ID: 'https://api-m.paypal.com' },
    { PAYPAL_SANDBOX_CLIENT_SECRET: 'PRIVATE_TEST_SECRET\nWITH_NEWLINE' },
    { PAYPAL_SANDBOX_MERCHANT_ID: 'live@example.invalid' },
    { PAYPAL_SANDBOX_MERCHANT_ID: '' },
  ]) {
    assert.throws(() => loadSandboxConfiguration({ env: { ...fake, ...changed }, privateFile }), error => {
      assert.equal(error.message, 'Invalid private PayPal Sandbox configuration. Check the documented sandbox-only settings without printing them.');
      assert.doesNotMatch(error.message, /PRIVATE_TEST_SECRET|example|api-m\.paypal/);
      return true;
    });
  }
  assert.throws(() => loadSandboxConfiguration({ env: { SCOPELINE_PAYPAL_SANDBOX_ENABLED: '1' }, privateFile }));
});

test('sandbox config rejects oversized files and non-file paths without reading unrelated configuration', async t => {
  const { privateFile, directory } = await fixture(t);
  await writeFile(privateFile, '#'.repeat(8193));
  assert.throws(() => loadSandboxConfiguration({ env: {}, privateFile }), /Invalid private PayPal Sandbox configuration/);
  const folder = join(directory, 'not-a-file'); await mkdir(folder);
  assert.throws(() => loadSandboxConfiguration({ env: {}, privateFile: folder }), /Invalid private PayPal Sandbox configuration/);
});
