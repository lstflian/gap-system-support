'use strict';

const assert = require('assert/strict');
const path = require('path');
const os = require('os');
const { createContext, SecretStorage, createProfileState } = require('../lmtools/mock-vscode');
const { check, section, summary } = require('../help/helpers');
const { McpCredentials, isMcpToken } = require('../../../out/mcp/credentials');

async function main() {
    const secrets = new SecretStorage();
    const values = new Map();
    const context = createContext(path.join(os.tmpdir(), 'gap-credential-test'), secrets, values);
    const credentials = new McpCredentials(context);

    section('1. Lazy creation and profile-wide reuse');
    check('constructing credentials does not access secret storage', [0, 0],
        [secrets.readCalls, secrets.writeCalls]);
    const initial = await credentials.getToken();
    check('token has 256 bits of random material', true, isMcpToken(initial));
    check('only one secret is stored on first use', 1, secrets.writeCalls);
    const parallel = await Promise.all(Array.from({ length: 10 }, () => credentials.getToken()));
    check('concurrent reads reuse the saved token', true, parallel.every(token => token === initial));
    check('reads never rotate the saved token', 1, secrets.writeCalls);
    const reopened = new McpCredentials(createContext(
        path.join(os.tmpdir(), 'gap-another-workspace'), secrets, values,
    ));
    check('another workspace in the same profile shares the saved token', true,
        await reopened.getToken() === initial);
    check('profile state holds a key, not the credential', false,
        [...values.values()].some(value => value === initial || value === `Bearer ${initial}`));
    const [key] = await secrets.keys();
    check('the matching secret change is recognized', true, credentials.handlesChange(key));
    check('unrelated secret changes are ignored', false, credentials.handlesChange('another-extension-key'));

    section('2. Profile separation and explicit reset');
    const otherProfile = new McpCredentials(createContext(
        path.join(os.tmpdir(), 'gap-other-profile'), secrets,
    ));
    const otherToken = await otherProfile.getToken();
    check('a different profile uses a different token', false, otherToken === initial);
    await credentials.resetToken();
    const reset = await credentials.getToken();
    check('explicit reset replaces the saved token', false, reset === initial);
    check('same-profile instances observe the new token', true, await reopened.getToken() === reset);
    check('reset does not change a different profile token', true, await otherProfile.getToken() === otherToken);
    check('profile token notifications are revalidated even with stale Profile state', true, otherProfile.handlesChange(key));

    section('3. Invalid saved credentials are not silently replaced');
    let activeKey = context.globalState.get('gap.mcp.tokenKey');
    await secrets.store(activeKey, 'invalid');
    const writes = secrets.writeCalls;
    await assert.rejects(() => credentials.getToken(), /saved MCP credential is invalid/);
    check('invalid secret did not cause an automatic token change', writes, secrets.writeCalls);
    await credentials.resetToken();
    check('explicit reset recovers an invalid credential', true, isMcpToken(await credentials.getToken()));

    section('4. Storage failures remain errors and the queue can recover');
    const get = secrets.get;
    secrets.get = async () => { throw new Error('test secret read failure'); };
    try {
        await assert.rejects(() => credentials.getToken(), /test secret read failure/);
    } finally {
        secrets.get = get;
    }
    const saved = await credentials.getToken();
    const store = secrets.store;
    secrets.store = async () => { throw new Error('test secret write failure'); };
    try {
        await assert.rejects(() => credentials.resetToken(), /test secret write failure/);
    } finally {
        secrets.store = store;
    }
    check('failed reset preserves the previous credential', true, await credentials.getToken() === saved);
    activeKey = context.globalState.get('gap.mcp.tokenKey');
    await secrets.delete(activeKey);
    secrets.store = async () => { throw new Error('test secret create failure'); };
    try {
        await assert.rejects(() => credentials.getToken(), /test secret create failure/);
    } finally {
        secrets.store = store;
    }
    check('creation failure never returns an unstored temporary token', undefined, await secrets.get(activeKey));
    check('a later retry creates a valid saved token', true, isMcpToken(await credentials.getToken()));
    for (const invalid of [undefined, '', 'Bearer token', 'x'.repeat(64), '0'.repeat(63), '0'.repeat(65)]) {
        assert.equal(isMcpToken(invalid), false);
    }

    section('5. Concurrent windows converge after delayed Profile updates');
    const profile = createProfileState();
    const sharedSecrets = new SecretStorage();
    const windowA = { secrets: sharedSecrets, globalState: profile.createWindow() };
    const windowB = { secrets: sharedSecrets, globalState: profile.createWindow() };
    const credentialsA = new McpCredentials(windowA);
    const credentialsB = new McpCredentials(windowB);
    const initialCredentials = await Promise.all([credentialsA.getCredential(), credentialsB.getCredential()]);
    profile.flush();
    const converged = await Promise.all([credentialsA.getCredential(), credentialsB.getCredential()]);
    check('independent window caches adopt one authoritative Profile key', true,
        converged[0].key === converged[1].key);
    check('converged windows use the same persistent token', true,
        converged[0].token === converged[1].token);
    check('obsolete first-start snapshots fail the synchronous currentness guard', true,
        initialCredentials.every(credential => credential.key === converged[0].key || !credentialsA.isCurrent(credential.key)));

    section('6. Reset before Profile propagation replaces every first-start namespace');
    const delayedProfile = createProfileState();
    const delayedSecrets = new SecretStorage();
    const oldWindowA = { secrets: delayedSecrets, globalState: delayedProfile.createWindow() };
    const oldWindowB = { secrets: delayedSecrets, globalState: delayedProfile.createWindow() };
    const oldA = new McpCredentials(oldWindowA);
    const oldB = new McpCredentials(oldWindowB);
    const beforeReset = await Promise.all([oldA.getCredential(), oldB.getCredential()]);
    await oldB.resetToken();
    const replacement = await oldB.getCredential();
    check('reset publishes a fresh namespace, not one of the concurrent initial namespaces', true,
        beforeReset.every(credential => credential.key !== replacement.key));
    delayedProfile.flush();
    const afterReset = await Promise.all([oldA.getCredential(), oldB.getCredential()]);
    check('a delayed window rejects all old namespace snapshots', true,
        beforeReset.every(credential => !oldA.isCurrent(credential.key)));
    check('both delayed windows read the explicitly reset credential', true,
        afterReset.every(credential => credential.key === replacement.key && credential.token === replacement.token));

    section('7. A Profile change during a secret read cannot return an obsolete snapshot');
    const read = delayedSecrets.get;
    let reading;
    let release;
    const readEntered = new Promise(resolve => { reading = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    let blocked = false;
    delayedSecrets.get = async function (key) {
        if (key === replacement.key && !blocked) {
            blocked = true;
            const oldValue = await read.call(this, key);
            reading();
            await gate;
            return oldValue;
        }
        return read.call(this, key);
    };
    try {
        const pending = oldA.getCredential();
        await readEntered;
        await oldB.resetToken();
        const latest = await oldB.getCredential();
        delayedProfile.flush();
        release();
        const result = await pending;
        check('an in-flight read retries against the latest Profile namespace', true,
            result.key === latest.key && result.token === latest.token);
    } finally {
        release();
        delayedSecrets.get = read;
    }
    summary();
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
