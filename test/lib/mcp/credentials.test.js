'use strict';

const assert = require('assert/strict');
const path = require('path');
const os = require('os');
const crypto = require('node:crypto');
const { createContext, SecretStorage, createProfileState } = require('../lmtools/mock-vscode');
const { check, section, summary } = require('../help/helpers');
const { McpCredentials, isMcpToken } = require('../../../out/mcp/credentials');
const { credentialKey } = require('./helpers');

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
    check('reset removes the replaced secret', undefined, await secrets.get(key));
    check('reset retains one token per Profile', 2, (await secrets.keys()).length);
    check('same-profile instances observe the new token', true, await reopened.getToken() === reset);
    check('reset does not change a different profile token', true, await otherProfile.getToken() === otherToken);
    check('profile token notifications are revalidated even with stale Profile state', true, otherProfile.handlesChange(key));

    section('3. Invalid saved credentials are not silently replaced');
    let activeKey = credentialKey(context);
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
    activeKey = credentialKey(context);
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
    section('8. Legacy credentials retain their secret and reset publishes one atomic snapshot');
    const legacyKey = 'gap.mcp.token.legacy';
    const legacyToken = 'a'.repeat(64);
    const legacySecrets = new SecretStorage();
    await legacySecrets.store(legacyKey, legacyToken);
    const legacyValues = new Map([['gap.mcp.tokenKey', legacyKey], ['gap.mcp.credentialRevision', 7]]);
    const legacyContext = createContext(path.join(os.tmpdir(), 'gap-legacy-credential-test'), legacySecrets, legacyValues);
    const legacy = new McpCredentials(legacyContext);
    check('legacy key and revision reuse the saved token', { key: legacyKey, revision: 7, token: legacyToken },
        await legacy.getCredential());
    check('reading legacy storage does not rotate or rewrite the token', 1, legacySecrets.writeCalls);
    const update = legacyContext.globalState.update;
    const published = [];
    legacyContext.globalState.update = async (key, value) => {
        published.push({ key, value });
        await update(key, value);
    };
    await legacy.resetToken();
    const atomic = await legacy.getCredential();
    check('reset publishes the key and revision in exactly one Profile update', [{
        key: 'gap.mcp.tokenKey', value: { key: atomic.key, revision: atomic.revision },
    }], published);
    check('reset still replaces the legacy token explicitly', false, atomic.token === legacyToken);
    legacyValues.set('gap.mcp.credentialRevision', atomic.revision + 1);
    check('a legacy revision notification cannot relabel the current token', atomic, await legacy.getCredential());
    legacyContext.globalState.update = async () => { throw new Error('test Profile write failure'); };
    await assert.rejects(() => legacy.resetToken(), /test Profile write failure/);
    check('a failed Profile publication preserves the previous valid credential', atomic, await legacy.getCredential());
    check('a failed Profile publication removes its unused replacement secret', [atomic.key], await legacySecrets.keys());
    legacyContext.globalState.update = update;

    section('9. Repeated reset cleans known generations without touching other Profiles');
    for (let attempt = 0; attempt < 3; attempt++) await legacy.resetToken();
    const retained = await legacy.getCredential();
    check('only the newest token remains in this Profile lineage', [retained.key], await legacySecrets.keys());
    check('the original legacy token was physically deleted', undefined, await legacySecrets.get(legacyKey));

    section('10. A delayed window adopts the replacement instead of recreating a deleted secret');
    const staleSecrets = new SecretStorage();
    const staleValues = new Map();
    const freshContext = createContext(path.join(os.tmpdir(), 'gap-token-reset-current'), staleSecrets, staleValues);
    const fresh = new McpCredentials(freshContext);
    const staleOriginal = await fresh.getCredential();
    const oldValues = new Map(staleValues);
    const staleWindow = new McpCredentials(createContext(path.join(os.tmpdir(), 'gap-token-reset-delayed'), staleSecrets, oldValues));
    await fresh.resetToken();
    const newest = await fresh.getCredential();
    check('a stale Profile cache discovers the current generation', newest, await staleWindow.getCredential());
    check('reading stale state does not resurrect the retired secret', [newest.key], await staleSecrets.keys());
    check('the deleted old secret remains absent', undefined, await staleSecrets.get(staleOriginal.key));

    section('11. A reset racing secret creation does not leave a recreated old generation');
    await staleSecrets.delete(newest.key);
    const latestValues = new Map(staleValues);
    const racing = new McpCredentials(createContext(path.join(os.tmpdir(), 'gap-token-create-race'), staleSecrets, latestValues));
    const originalStore = staleSecrets.store;
    let enterStore;
    let continueStore;
    const storeEntered = new Promise(resolve => { enterStore = resolve; });
    const storeGate = new Promise(resolve => { continueStore = resolve; });
    let paused = false;
    staleSecrets.store = async function (key, value) {
        if (key === newest.key && !paused) { paused = true; enterStore(); await storeGate; }
        return originalStore.call(this, key, value);
    };
    const creating = racing.getCredential();
    try {
        await storeEntered;
        await fresh.resetToken();
        const replacement = await fresh.getCredential();
        continueStore();
        check('a creation that finishes after reset adopts the replacement', replacement, await creating);
        check('the recreated obsolete key is deleted again', [replacement.key], await staleSecrets.keys());
    } finally { continueStore(); staleSecrets.store = originalStore; }

    section('12. Cleanup failure reports the changed state and can be retried');
    const deleteSecret = staleSecrets.delete;
    staleSecrets.delete = async () => { throw new Error('test secret delete failure'); };
    try {
        await assert.rejects(() => fresh.resetToken(), /new MCP access token was saved.*cleanup failed.*test secret delete failure/);
    } finally { staleSecrets.delete = deleteSecret; }
    check('cleanup failure leaves the new active token readable', true, isMcpToken(await fresh.getToken()));
    await fresh.resetToken();
    const cleaned = await fresh.getCredential();
    check('a later reset also removes generations left by failed cleanup', [cleaned.key], await staleSecrets.keys());

    section('13. Concurrent resets converge without deleting the surviving token');
    const parallelContexts = [staleValues, new Map(staleValues)].map(cache =>
        createContext(path.join(os.tmpdir(), 'gap-token-parallel-reset'), staleSecrets, cache));
    const simultaneous = parallelContexts.map(context => new McpCredentials(context));
    const now = Date.now;
    const sameTime = Math.max(now(), cleaned.revision + 1);
    try {
        Date.now = () => sameTime;
        await Promise.all(simultaneous.map(value => value.resetToken()));
    } finally { Date.now = now; }
    const survivors = await Promise.all(simultaneous.map(value => value.getCredential()));
    check('simultaneous resets settle on the same saved credential', survivors[0], survivors[1]);
    check('concurrent cleanup retains exactly that token', [survivors[0].key], await staleSecrets.keys());

    section('14. An unpublished reset cannot become another window\'s active successor');
    const publicationSecrets = new SecretStorage();
    const publicationValues = new Map();
    const publicationContext = createContext(path.join(os.tmpdir(), 'gap-token-publication'), publicationSecrets, publicationValues);
    const publicationB = new McpCredentials(publicationContext);
    await publicationB.getCredential();
    const failedContext = createContext(path.join(os.tmpdir(), 'gap-token-unpublished'), publicationSecrets, new Map(publicationValues));
    const publicationA = new McpCredentials(failedContext);
    let enterPublication;
    let failPublication;
    let attemptedState;
    const publicationEntered = new Promise(resolve => { enterPublication = resolve; });
    const publicationGate = new Promise(resolve => { failPublication = resolve; });
    failedContext.globalState.update = async (_key, value) => {
        attemptedState = value;
        enterPublication();
        await publicationGate;
        throw new Error('test delayed Profile publication failure');
    };
    const listKeys = publicationSecrets.keys;
    let scans = 0;
    let releaseScans;
    const scanGate = new Promise(resolve => { releaseScans = resolve; });
    publicationSecrets.keys = async function () {
        const snapshot = await listKeys.call(this);
        if (++scans <= 2) { if (scans === 2) releaseScans(); await scanGate; }
        return snapshot;
    };
    const uuid = crypto.randomUUID;
    const resetTime = Date.now;
    const timestamp = resetTime();
    const uuids = ['ffffffff-ffff-4fff-8fff-ffffffffffff', '00000000-0000-4000-8000-000000000000'];
    let failedReset;
    let successfulReset;
    try {
        Date.now = () => timestamp;
        crypto.randomUUID = () => uuids.shift();
        failedReset = publicationA.resetToken();
        const failedPublication = assert.rejects(failedReset, /test delayed Profile publication failure/);
        successfulReset = publicationB.resetToken();
        await publicationEntered;
        await successfulReset;
        const published = await publicationB.getCredential();
        check('successful reset does not adopt the other window\'s pending key', false, published.key === attemptedState.key);
        failPublication();
        await failedPublication;
        check('failed publication cannot delete the successfully published token', published, await publicationB.getCredential());
        check('unpublished token cleanup leaves the valid token as the only secret', [published.key], await publicationSecrets.keys());
    } finally {
        failPublication();
        releaseScans();
        await Promise.allSettled([failedReset, successfulReset]);
        Date.now = resetTime;
        crypto.randomUUID = uuid;
        publicationSecrets.keys = listKeys;
    }

    section('15. A reset after the creation check is followed instead of reporting a missing token');
    const rereadSecrets = new SecretStorage();
    const rereadValues = new Map();
    const rereadContext = createContext(path.join(os.tmpdir(), 'gap-token-reread'), rereadSecrets, rereadValues);
    const resetting = new McpCredentials(rereadContext);
    const firstRead = await resetting.getCredential();
    await rereadSecrets.delete(firstRead.key);
    const lateReader = new McpCredentials(createContext(path.join(os.tmpdir(), 'gap-token-reread-stale'), rereadSecrets, new Map(rereadValues)));
    const enumerate = rereadSecrets.keys;
    let enteredReread;
    let finishReread;
    const rereadEntered = new Promise(resolve => { enteredReread = resolve; });
    const rereadGate = new Promise(resolve => { finishReread = resolve; });
    let enumerations = 0;
    rereadSecrets.keys = async function () {
        const snapshot = await enumerate.call(this);
        if (++enumerations === 2) { enteredReread(); await rereadGate; }
        return snapshot;
    };
    const rereading = lateReader.getCredential();
    try {
        await rereadEntered;
        await resetting.resetToken();
        const active = await resetting.getCredential();
        finishReread();
        check('a final reread of a deleted key adopts the live replacement', active, await rereading);
        check('the extra reread keeps one current token', [active.key], await rereadSecrets.keys());
    } finally { finishReread(); rereadSecrets.keys = enumerate; }
    section('16. A published token remains readable while its final secret write is pending or fails');
    const stagedSecrets = new SecretStorage();
    const stagedValues = new Map();
    const stagedContext = createContext(path.join(os.tmpdir(), 'gap-token-staged'), stagedSecrets, stagedValues);
    const staged = new McpCredentials(stagedContext);
    await staged.getCredential();
    const persist = stagedSecrets.store;
    let enteredFinalWrite;
    let releaseFinalWrite;
    const finalWriteEntered = new Promise(resolve => { enteredFinalWrite = resolve; });
    const finalWriteGate = new Promise(resolve => { releaseFinalWrite = resolve; });
    stagedSecrets.store = async function (key, value) {
        if (!key.endsWith('.pending')) { enteredFinalWrite(); await finalWriteGate; }
        return persist.call(this, key, value);
    };
    const stagedReset = staged.resetToken();
    try {
        await finalWriteEntered;
        const observer = new McpCredentials(stagedContext);
        const during = await observer.getCredential();
        check('the published marker reads exactly its staged token', during.token,
            await stagedSecrets.get(during.key + '.pending'));
        releaseFinalWrite();
        await stagedReset;
        check('the committed token matches the token already observed', during, await observer.getCredential());
        check('successful commit removes staging and prior credentials', [during.key], await stagedSecrets.keys());
    } finally { releaseFinalWrite(); await stagedReset; stagedSecrets.store = persist; }
    stagedSecrets.store = async function (key, value) {
        if (!key.endsWith('.pending')) throw new Error('test final secret write failure');
        return persist.call(this, key, value);
    };
    try { await assert.rejects(() => staged.resetToken(), /test final secret write failure/); }
    finally { stagedSecrets.store = persist; }
    const recoverable = await staged.getCredential();
    check('failed final publication retains the same recoverable staged token', recoverable.token,
        await stagedSecrets.get(recoverable.key + '.pending'));
    await staged.resetToken();
    check('the next successful reset cleans prior staging as well', [(await staged.getCredential()).key], await stagedSecrets.keys());

    section('17. A final/pending handoff cannot silently replace the committed token');
    let enterHandoffStore;
    let continueHandoffStore;
    let handoffKey;
    const handoffStoreEntered = new Promise(resolve => { enterHandoffStore = resolve; });
    const handoffStoreGate = new Promise(resolve => { continueHandoffStore = resolve; });
    stagedSecrets.store = async function (key, value) {
        if (!key.endsWith('.pending')) { handoffKey = key; enterHandoffStore(); await handoffStoreGate; }
        return persist.call(this, key, value);
    };
    const readSecret = stagedSecrets.get;
    let enterHandoffRead;
    let continueHandoffRead;
    const handoffReadEntered = new Promise(resolve => { enterHandoffRead = resolve; });
    const handoffReadGate = new Promise(resolve => { continueHandoffRead = resolve; });
    let handoffPaused = false;
    stagedSecrets.get = async function (key) {
        const value = await readSecret.call(this, key);
        if (key === handoffKey && !handoffPaused) {
            handoffPaused = true;
            enterHandoffRead();
            await handoffReadGate;
        }
        return value;
    };
    const handoffReset = staged.resetToken();
    let handoffReading;
    try {
        await handoffStoreEntered;
        handoffReading = new McpCredentials(stagedContext).getCredential();
        await handoffReadEntered;
        continueHandoffStore();
        await handoffReset;
        const committed = await readSecret.call(stagedSecrets, handoffKey);
        continueHandoffRead();
        const observed = await handoffReading;
        check('a reader spanning final publication returns the original published token', committed, observed.token);
        check('the spanning read does not overwrite the committed value', committed, await stagedSecrets.get(handoffKey));
        check('the handoff also retains one stored credential', [handoffKey], await stagedSecrets.keys());
    } finally {
        continueHandoffStore();
        continueHandoffRead();
        await Promise.allSettled([handoffReset, handoffReading]);
        stagedSecrets.store = persist;
        stagedSecrets.get = readSecret;
    }
    summary();
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
