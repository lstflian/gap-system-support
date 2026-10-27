'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { pathToFileURL, fileURLToPath } = require('url');
const { installMock, vscodeMock } = require('../highlight/mock-vscode');
const manifest = require('../../../package.json');

class Disposable {
    constructor(callback = () => {}) {
        this.callback = callback;
        this.disposed = false;
    }
    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.callback();
    }
    static from(...values) {
        return new Disposable(() => values.forEach(value => value.dispose()));
    }
}

class EventEmitter {
    constructor() {
        this.listeners = new Set();
        this.event = (callback, thisArg, disposables) => {
            const listener = thisArg ? callback.bind(thisArg) : callback;
            this.listeners.add(listener);
            const disposable = new Disposable(() => this.listeners.delete(listener));
            disposables?.push(disposable);
            return disposable;
        };
    }
    fire(value) {
        for (const listener of [...this.listeners]) listener(value);
    }
    dispose() {
        this.listeners.clear();
    }
}

class CancellationTokenSource {
    constructor() {
        this.emitter = new EventEmitter();
        this.token = {
            isCancellationRequested: false,
            onCancellationRequested: this.emitter.event,
        };
    }
    cancel() {
        if (this.token.isCancellationRequested) return;
        this.token.isCancellationRequested = true;
        this.emitter.fire();
    }
    dispose() {
        this.emitter.dispose();
    }
}

class CancellationError extends Error {
    constructor() {
        super('Canceled');
        this.name = 'Canceled';
    }
}

class Uri {
    constructor(value) {
        this.value = value;
        this.scheme = new URL(value).protocol.slice(0, -1);
        this.fsPath = this.scheme === 'file' ? fileURLToPath(value) : new URL(value).pathname;
    }
    toString() { return this.value; }
    static file(filePath) { return new Uri(pathToFileURL(filePath).href); }
    static parse(value) { return new Uri(value); }
    static joinPath(base, ...segments) { return Uri.file(path.join(base.fsPath, ...segments)); }
}

class McpHttpServerDefinition {
    constructor(label, uri, headers = {}, version) {
        Object.assign(this, { label, uri, headers, version });
    }
}

class LanguageModelTextPart {
    constructor(value) { this.value = value; }
}

class LanguageModelToolResult {
    constructor(content) { this.content = content; }
}

class SecretStorage {
    constructor() {
        this.values = new Map();
        this.changed = new EventEmitter();
        this.onDidChange = this.changed.event;
        this.readCalls = 0;
        this.writeCalls = 0;
    }
    async keys() { return [...this.values.keys()]; }
    async get(key) {
        this.readCalls++;
        return this.values.get(key);
    }
    async store(key, value) {
        this.writeCalls++;
        this.values.set(key, value);
        this.changed.fire({ key });
    }
    async delete(key) {
        this.values.delete(key);
        this.changed.fire({ key });
    }
}

function createProfileState() {
    let stored = new Map();
    const windows = [];
    const notifications = [];
    return {
        createWindow() {
            const cache = new Map(stored);
            windows.push(cache);
            return {
                get: (key, fallback) => cache.has(key) ? cache.get(key) : fallback,
                async update(key, value) {
                    if (value === undefined) cache.delete(key);
                    else cache.set(key, value);
                    stored = new Map(cache);
                    const snapshot = new Map(stored);
                    notifications.push(() => {
                        for (const window of windows) {
                            window.clear();
                            for (const [key, value] of snapshot) window.set(key, value);
                        }
                    });
                },
            };
        },
        flush() {
            for (const notification of notifications.splice(0)) notification();
        },
    };
}

const user = new Map();
const workspace = new Map();
const configuration = new EventEmitter();
const trust = new EventEmitter();
const opened = new EventEmitter();
const closed = new EventEmitter();
const changed = new EventEmitter();
const saved = new EventEmitter();
const noEvent = new EventEmitter();
const state = {
    tools: new Map(),
    providers: new Map(),
    commands: new Map(),
    messages: [],
    executed: [],
    clipboard: '',
    toolRegistrations: 0,
    providerRegistrations: 0,
    languageRegistrations: 0,
};

function setting(key, fallback) {
    if (workspace.has(key)) return workspace.get(key);
    if (user.has(key)) return user.get(key);
    return manifest.contributes.configuration.properties[key]?.default ?? fallback;
}

function setConfiguration(values, target = 'workspace') {
    const settings = target === 'user' ? user : workspace;
    for (const [key, value] of Object.entries(values)) {
        if (value === undefined) settings.delete(key);
        else settings.set(key, value);
    }
    configuration.fire({
        affectsConfiguration: name => Object.keys(values).some(key =>
            key === name || key.startsWith(`${name}.`) || name.startsWith(`${key}.`)),
    });
}

function register(map, name, value) {
    if (map.has(name)) throw new Error(`Duplicate registration: ${name}`);
    map.set(name, value);
    return new Disposable(() => map.delete(name));
}

Object.assign(vscodeMock, {
    Disposable,
    EventEmitter,
    CancellationTokenSource,
    CancellationError,
    Uri,
    McpHttpServerDefinition,
    LanguageModelTextPart,
    LanguageModelToolResult,
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3 },
    DiagnosticSeverity: { Error: 0 },
    workspace: {
        isTrusted: true,
        textDocuments: [],
        workspaceFolders: [],
        getConfiguration: section => ({
            get: (key, fallback) => setting(`${section}.${key}`, fallback),
            update: (key, value, target) => {
                setConfiguration({ [`${section}.${key}`]: value }, target === 1 ? 'user' : 'workspace');
                return Promise.resolve();
            },
        }),
        onDidChangeConfiguration: configuration.event,
        onDidGrantWorkspaceTrust: trust.event,
        onDidOpenTextDocument: opened.event,
        onDidCloseTextDocument: closed.event,
        onDidChangeTextDocument: changed.event,
        onDidSaveTextDocument: saved.event,
        onDidCreateFiles: noEvent.event,
        onDidDeleteFiles: noEvent.event,
        onDidRenameFiles: noEvent.event,
        onDidChangeWorkspaceFolders: noEvent.event,
        findFiles: async () => [],
        getWorkspaceFolder: () => undefined,
        asRelativePath: uri => uri.fsPath,
        createFileSystemWatcher: () => ({
            onDidCreate: noEvent.event,
            onDidChange: noEvent.event,
            onDidDelete: noEvent.event,
            dispose() {},
        }),
        fs: { readFile: uri => fs.promises.readFile(uri.fsPath) },
    },
    lm: {
        registerTool(name, tool) {
            state.toolRegistrations++;
            return register(state.tools, name, tool);
        },
        registerMcpServerDefinitionProvider(name, provider) {
            state.providerRegistrations++;
            return register(state.providers, name, provider);
        },
    },
    commands: {
        registerCommand: (name, callback) => register(state.commands, name, callback),
        async executeCommand(name, ...args) {
            state.executed.push(name);
            return state.commands.get(name)?.(...args);
        },
    },
    env: {
        clipboard: { async writeText(value) { state.clipboard = value; } },
        async openExternal() { return true; },
    },
    window: {
        activeTextEditor: undefined,
        activeColorTheme: { kind: 1 },
        onDidCloseTerminal: noEvent.event,
        onDidChangeActiveColorTheme: noEvent.event,
        showErrorMessage: async message => { state.messages.push({ type: 'error', message }); },
        showWarningMessage: async message => { state.messages.push({ type: 'warning', message }); },
        showInformationMessage: async message => { state.messages.push({ type: 'info', message }); },
    },
    languages: {
        createDiagnosticCollection: () => ({ set() {}, delete() {}, clear() {}, dispose() {} }),
    },
});

for (const name of [
    'registerDocumentRangeSemanticTokensProvider', 'registerCompletionItemProvider',
    'registerHoverProvider', 'registerReferenceProvider', 'registerDefinitionProvider', 'registerFoldingRangeProvider',
]) {
    vscodeMock.languages[name] = () => {
        state.languageRegistrations++;
        return new Disposable(() => state.languageRegistrations--);
    };
}

function createContext(storagePath, secrets = new SecretStorage(), values = new Map()) {
    return {
        extension: { packageJSON: manifest },
        extensionPath: path.resolve(__dirname, '..', '..', '..'),
        extensionUri: Uri.file(path.resolve(__dirname, '..', '..', '..')),
        globalStorageUri: Uri.file(storagePath),
        secrets,
        globalState: {
            get: (key, fallback) => values.has(key) ? values.get(key) : fallback,
            async update(key, value) { values.set(key, value); },
        },
        subscriptions: [],
    };
}

function grantTrust() {
    vscodeMock.workspace.isTrusted = true;
    trust.fire();
}

function createFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gap-tools-'));
    const context = createContext(path.join(root, 'storage'));
    const index = path.join(context.globalStorageUri.fsPath, 'data', 'helpIndex');
    const docPath = path.join(root, 'doc');
    const pkgPath = path.join(root, 'pkg');
    const helpFile = path.join(docPath, 'ref', 'chap1.html');
    const tutorial = path.join(docPath, 'tut', 'chap1.html');
    fs.mkdirSync(index, { recursive: true });
    fs.mkdirSync(path.dirname(helpFile), { recursive: true });
    fs.mkdirSync(path.dirname(tutorial), { recursive: true });
    fs.mkdirSync(pkgPath, { recursive: true });
    fs.writeFileSync(helpFile, '<html>\n<body>\n<h1 id="Group">Group</h1>\n<h2 id="GroupSize">GroupSize</h2>\n</body>\n</html>');
    fs.writeFileSync(tutorial, '<html>\n<h1 id="Tutorial">Group tutorial</h1>\n</html>');
    fs.writeFileSync(path.join(index, 'export_gapdoc.txt'), '');
    fs.writeFileSync(path.join(index, 'export_text.txt'), '');
    fs.writeFileSync(path.join(index, 'export_default.txt'), [
        '/doc/ref|/doc/ref/chap1.html#Group|Group|group|Reference|1|1|F|Reference manual',
        '/doc/ref|/doc/ref/chap1.html#GroupSize|GroupSize|groupsize|Reference|1|2|F|Reference manual',
        '/doc/tut|/doc/tut/chap1.html#Tutorial|Group tutorial|group tutorial|Tutorial|1|1|S|Tutorial manual',
    ].join('\n'));
    const sourceFile = path.join(root, 'example.g');
    fs.writeFileSync(sourceFile, 'x := 1;\n');
    setConfiguration({ 'gap.docPath': docPath, 'gap.pkgPath': pkgPath });
    return {
        root, context, docPath, pkgPath, helpFile, sourceFile,
        inputs: {
            search_gap_help: { topic: 'Group', mode: 'prefix', range: [1, 1] },
            list_gap_books: {},
            gap_resolve_link: { filePath: helpFile, relativePath: '../tut/chap1.html', anchor: 'Tutorial' },
            check_gap_syntax: { filePath: sourceFile },
        },
        cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
    };
}

installMock();

module.exports = {
    vscodeMock, state, setConfiguration, createContext, grantTrust,
    opened, closed, changed, saved, CancellationTokenSource, Disposable, SecretStorage, createProfileState, createFixture,
};
