/**
 * Mock for the vscode module.
 */

'use strict';
const path = require('path');
const Module = require('module');

class SemanticTokensLegend {
    constructor(tokenTypes, tokenModifiers) {
        this.tokenTypes = tokenTypes;
        this.tokenModifiers = tokenModifiers;
    }
}

class Position {
    constructor(line, character) {
        this.line = line;
        this.character = character;
    }
}

class Range {
    constructor(a, b, c, d) {
        if (typeof a === 'number') {
            this.start = new Position(a, b);
            this.end = new Position(c, d);
        } else {
            this.start = a;
            this.end = b;
        }
    }
}

class Location {
    constructor(uri, range) {
        this.uri = uri;
        this.range = range;
    }
}

class SemanticTokensBuilder {
    constructor(legend) {
        this.legend = legend;
        this.tokens = [];
    }
    push(range, type, modifiers) {
        this.tokens.push({ range, type, modifiers });
    }
    build() {
        return this.tokens;
    }
}

const vscodeMock = {
    SemanticTokensLegend,
    Position,
    Range,
    Location,
    SemanticTokensBuilder,
    Uri: {
        joinPath(base, ...segments) {
            const basePath = typeof base === 'string' ? base : base.fsPath;
            return { fsPath: path.join(basePath, ...segments) };
        },
        file(fsPath) {
            return { fsPath };
        },
    },
};

// Unknown members return a generic stub.
const vscodeProxy = new Proxy(vscodeMock, {
    get(target, prop) {
        if (prop in target) return target[prop];
        return class Stub {};
    },
});

/**
 * Intercept require('vscode') calls.
 */
function installMock() {
    const originalLoad = Module._load;
    Module._load = function (request, parent, isMain) {
        if (request === 'vscode') {
            return vscodeProxy;
        }
        return originalLoad.apply(this, arguments);
    };
}

module.exports = { installMock, vscodeMock };
