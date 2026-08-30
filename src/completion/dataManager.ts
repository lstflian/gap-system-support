/**
 * Completion data manager.
 * Owns the function name set in memory and the data files.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { toShellPath } from '../path';
import { waitTerminalClose } from '../shared/terminal';

let functionNames: Set<string> | null = null;
let generating = false;
const GENERATION_TIMEOUT_MS = 300_000;

const DONE_MARKER = 'Data generation done, ready to convert';

/** The txt file state after the gap process exited. */
type TxtState = 'missing' | 'complete' | 'incomplete';

/** Check the txt file: missing, complete with the marker, or incomplete. */
function checkTxt(txtPath: string): TxtState {
    if (!fs.existsSync(txtPath)) {
        return 'missing';
    }
    // Read only the tail, the marker is near the end.
    const TAIL_BYTES = 200;
    let fd: number;
    try {
        fd = fs.openSync(txtPath, 'r');
    } catch {
        return 'missing';
    }
    try {
        const size = fs.fstatSync(fd).size;
        const start = Math.max(0, size - TAIL_BYTES);
        const buf = Buffer.alloc(size - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        const tail = buf.toString('utf8').trimEnd().split('\n').pop();
        return tail === DONE_MARKER ? 'complete' : 'incomplete';
    } catch {
        // The file vanished or became unreadable; treat it as missing.
        return 'missing';
    } finally {
        fs.closeSync(fd);
    }
}

function convertTxtToJson(txtPath: string, jsonPath: string): void {
    const text = fs.readFileSync(txtPath, 'utf8');
    const names = text.split(/\r?\n/)
        .filter((l) => l.trim() !== '' && l.trim() !== DONE_MARKER)
        .sort();
    if (names.length === 0) {
        throw new Error('generated data is empty');
    }
    const data = {
        generatedAt: new Date().toISOString(),
        count: names.length,
        names,
    };
    // Write a tmp file first, then rename it over the json.
    const tmpPath = jsonPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
    try {
        fs.renameSync(tmpPath, jsonPath);
    } catch (err) {
        try {
            fs.unlinkSync(tmpPath);
        } catch {}
        throw err;
    }
    try {
        fs.unlinkSync(txtPath);
    } catch {}
}

function loadJsonIntoMemory(jsonPath: string): number {
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    if (!Array.isArray(data.names)) {
        throw new Error('invalid data format');
    }
    functionNames = new Set(data.names as string[]);
    return functionNames.size;
}

export function getFunctionNames(): Set<string> | null {
    return functionNames;
}

function getGlobalRoot(context: vscode.ExtensionContext): string {
    return context.globalStorageUri.fsPath;
}

function getGlobalDataDir(context: vscode.ExtensionContext): string {
    return vscode.Uri.joinPath(context.globalStorageUri, 'data', 'completionData').fsPath;
}

function getBuiltinDataFile(context: vscode.ExtensionContext): string {
    return vscode.Uri.joinPath(context.extensionUri, 'data', 'completionData', 'functions-all.json').fsPath;
}

function copyBuiltinData(context: vscode.ExtensionContext, dataDir: string, jsonPath: string): void {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.copyFileSync(getBuiltinDataFile(context), jsonPath);
}

export function ensureData(context: vscode.ExtensionContext): void {
    const dataDir = getGlobalDataDir(context);
    const jsonPath = path.join(dataDir, 'functions-all.json');

    if (!fs.existsSync(jsonPath)) {
        copyBuiltinData(context, dataDir, jsonPath);
    }
    loadJsonIntoMemory(jsonPath);
}

/**
 * Generate the completion data with the local GAP, then reload it.
 * Returns true on success.
 */
export async function generateData(context: vscode.ExtensionContext): Promise<boolean> {
    if (generating) {
        vscode.window.showInformationMessage('GAP: data generation is already running');
        return false;
    }
    generating = true;
    try {
        const dataDir = getGlobalDataDir(context);
        const txtPath = path.join(dataDir, 'functions-all.txt');
        const jsonPath = path.join(dataDir, 'functions-all.json');
        fs.mkdirSync(dataDir, { recursive: true });

        // Remove a stale txt.
        if (fs.existsSync(txtPath)) {
            try {
                fs.unlinkSync(txtPath);
            } catch {}
        }

        const scriptUri = vscode.Uri.joinPath(context.extensionUri, 'scripts', 'gapFunctions', 'collect-all-functions.g');
        const terminal = vscode.window.createTerminal({
            name: 'GAP Completion Data',
            cwd: getGlobalRoot(context),
            hideFromUser: true,
        });

        // Register the close listener, then send the command.
        const closed = waitTerminalClose(terminal, GENERATION_TIMEOUT_MS);
        terminal.sendText(`gap --nointeract ${toShellPath(scriptUri.fsPath, scriptUri)}`);
        terminal.sendText('exit');

        const item = vscode.window.createStatusBarItem(
            'gap.generateCompletionData', vscode.StatusBarAlignment.Left, 90);
        item.text = '$(sync~spin) GAP: generating completion data…';
        item.show();
        let outcome: 'ok' | 'timeout' | 'convert-failed' | 'gap-exited';
        try {
            outcome = await (async (): Promise<'ok' | 'timeout' | 'convert-failed' | 'gap-exited'> => {
                // The terminal closes when the gap process exits.
                // Wait, then check the txt file.
                try {
                    await closed;
                } catch {
                    // The terminal never closed, the gap process hung.
                    return 'timeout';
                }
                await new Promise((r) => setTimeout(r, 1000));
                const state = checkTxt(txtPath);
                if (state === 'missing' || state === 'incomplete') {
                    return 'gap-exited';
                }
                try {
                    convertTxtToJson(txtPath, jsonPath);
                    loadJsonIntoMemory(jsonPath);
                    return 'ok';
                } catch (err) {
                    // Remove the leftover txt.
                    if (fs.existsSync(txtPath)) {
                        try {
                            fs.unlinkSync(txtPath);
                        } catch {}
                    }
                    return 'convert-failed';
                }
            })();
        } finally {
            item.dispose();
            terminal.dispose();
        }

        // Notify after the progress finished.
        if (outcome === 'timeout' || outcome === 'convert-failed' || outcome === 'gap-exited') {
            vscode.window.showErrorMessage('GAP: data generation failed');
            return false;
        }
        const count = functionNames?.size ?? 0;
        vscode.window.showInformationMessage(`GAP: completion data generated (${count} functions)`);
        return true;
    } finally {
        generating = false;
    }
}

/**
 * Restore the default data, then reload it.
 * Returns true on success.
 */
export function resetData(context: vscode.ExtensionContext): boolean {
    if (generating) {
        vscode.window.showInformationMessage('GAP: data generation is running, please wait');
        return false;
    }
    const dataDir = getGlobalDataDir(context);
    const jsonPath = path.join(dataDir, 'functions-all.json');

    try {
        copyBuiltinData(context, dataDir, jsonPath);
        loadJsonIntoMemory(jsonPath);
        vscode.window.showInformationMessage('GAP: reset completed');
        return true;
    } catch {
        vscode.window.showErrorMessage('GAP: reset failed');
        return false;
    }
}
