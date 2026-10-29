'use strict';
const assert = require('node:assert/strict');

function toolOutput(result) {
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.equal(result.content.length, 1, 'MCP tools return one content item');
    assert.equal(result.content[0].type, 'text');
    assert.equal(Object.hasOwn(result, 'structuredContent'), false, 'MCP results must not duplicate the text output');
    return JSON.parse(result.content[0].text);
}

function credentialKey(context) {
    const value = context.globalState.get('gap.mcp.tokenKey');
    return typeof value === 'string' ? value : value?.key;
}

module.exports = { toolOutput, credentialKey };
