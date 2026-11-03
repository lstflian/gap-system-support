import * as vscode from 'vscode';
import {
    ensureHelpIndex
} from '../help/helpData';
import { refreshCurrentPage } from '../help/helpPanel';
import { initStyleState } from '../help/styleState';
import { BindingAnalysis } from '../language/analysis/bindings';
import { initGapParser, onDocumentChanged, onDocumentClosed } from '../language/parser/gapParser';
import { SEMANTIC_CONTENT_LIMIT, SEMANTIC_GLOBAL_CACHE_MAX_BYTES } from '../limits';
import { reportError } from '../shared/errors';
import { tryLog, tryValueAsync } from '../shared/guarded';
import { Failures, Messages } from '../shared/messages';
import { notifyError } from '../shared/notify';
import { GAPDefinitionResolver } from './analysis/definitionResolver';
import { GAPCompletionProvider } from './completion/completionProvider';
import { ensureData } from './completion/dataManager';
import { GAPDefinitionProvider } from './definition/definitionProvider';
import { GAPDiagnosticsProvider } from './diagnostics/diagnosticsProvider';
import { GAPFoldsProvider } from './folds/foldsProvider';
import { GAPSemanticTokensProvider, legend } from './highlight/semanticTokensProvider';
import { GAPHoverProvider } from './hover/hoverProvider';
import { GAPReferenceProvider } from './references/referenceProvider';

export async function initializeGapFeatures(context: vscode.ExtensionContext, isShuttingDown: () => boolean): Promise<boolean> {
    console.log('[GAP] extension activate start');
    const parserReady = await tryValueAsync(
        () => initGapParser(context).then(() => true),
        (err) => {
            reportError(err, Failures.parserInitializationFailed);
            notifyError(Messages.extension.parserLoadFailed);
            return false;
        },
    );
    if (!parserReady || isShuttingDown()) return false;

    tryLog(() => ensureData(context), Failures.completionDataLoadFailed);

    tryLog(() => ensureHelpIndex(context), Failures.helpIndexEnsureFailed);

    initStyleState(context);

    // Refresh the open help page when the MathJax setting changes.
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('gap.mathJax')) {
                refreshCurrentPage();
            }
        })
    );

    // Publish diagnostics for the current syntax tree.
    const diagnosticsProvider = new GAPDiagnosticsProvider();
    context.subscriptions.push(diagnosticsProvider);

    // Record content changes.
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(e => {
            if (e.document.languageId === 'gap') {
                onDocumentChanged(e.document.uri, e.contentChanges);
                diagnosticsProvider.schedule(e.document);
            }
        }),
    );

    // Register the document range semantic tokens provider.
    const highlightsPath = vscode.Uri.joinPath(context.extensionUri, 'queries', 'highlights.scm').fsPath;
    const highlightsGlobalPath = vscode.Uri.joinPath(context.extensionUri, 'queries', 'highlights.global.scm').fsPath;
    const localsPath = vscode.Uri.joinPath(context.extensionUri, 'queries', 'locals.scm').fsPath;

    const semanticProvider = new GAPSemanticTokensProvider(
        highlightsPath,
        localsPath,
        highlightsGlobalPath,
        {
            globalIndexMode: 'enabled',
            contentLengthLimit: SEMANTIC_CONTENT_LIMIT,
            maxGlobalCacheBytes: SEMANTIC_GLOBAL_CACHE_MAX_BYTES,
        },
    );
    context.subscriptions.push({ dispose: () => semanticProvider.dispose() });
    context.subscriptions.push(
        vscode.languages.registerDocumentRangeSemanticTokensProvider(
            { language: 'gap' },
            semanticProvider,
            legend,
        ),
    );

    const completionPath = vscode.Uri.joinPath(context.extensionUri, 'queries', 'completion.scm').fsPath;
    const bindings = new BindingAnalysis(completionPath);
    context.subscriptions.push(bindings);
    const completionProvider = new GAPCompletionProvider(completionPath, bindings);
    context.subscriptions.push(
        completionProvider,
        vscode.languages.registerCompletionItemProvider(
            { language: 'gap' },
            completionProvider,
        ),
    );

    const resolver = new GAPDefinitionResolver(completionPath, bindings);
    context.subscriptions.push(resolver);
    const hoverProvider = new GAPHoverProvider(completionPath, resolver);
    context.subscriptions.push(
        vscode.languages.registerHoverProvider(
            { language: 'gap' },
            hoverProvider,
        ),
    );

    // inline Peek References editor.
    const referenceProvider = new GAPReferenceProvider(completionPath, resolver);
    context.subscriptions.push(
        referenceProvider,
        vscode.languages.registerReferenceProvider(
            { language: 'gap' },
            referenceProvider,
        ),
    );

    // A definition click delegates to the reference provider. Combined with
    // editor.definitionLinkOpensInPeek, command-click opens Peek References.
    const definitionProvider = new GAPDefinitionProvider(
        completionPath,
        referenceProvider,
        resolver,
    );
    context.subscriptions.push(
        vscode.languages.registerDefinitionProvider(
            { language: 'gap' },
            definitionProvider,
        ),
    );

    const foldsPath = vscode.Uri.joinPath(context.extensionUri, 'queries', 'folds.scm').fsPath;
    const foldsProvider = new GAPFoldsProvider(foldsPath);
    context.subscriptions.push(
        foldsProvider,
        vscode.languages.registerFoldingRangeProvider(
            { language: 'gap' },
            foldsProvider,
        ),
    );

    // Validate immediately when a document is opened or saved.
    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(doc => diagnosticsProvider.checkNow(doc)),
    );
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(doc => diagnosticsProvider.checkNow(doc)),
    );
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(() => {
            resolver.onWorkspaceFilesChanged();
            referenceProvider.onWorkspaceFilesChanged();
        }),
        vscode.workspace.onDidCreateFiles(() => {
            resolver.onWorkspaceFilesChanged();
            referenceProvider.onWorkspaceFilesChanged();
        }),
        vscode.workspace.onDidDeleteFiles(() => {
            resolver.onWorkspaceFilesChanged();
            referenceProvider.onWorkspaceFilesChanged();
        }),
        vscode.workspace.onDidRenameFiles(() => {
            resolver.onWorkspaceFilesChanged();
            referenceProvider.onWorkspaceFilesChanged();
        }),
    );
    // Enable/disable diagnostics when the gap.diagnostics setting changes.
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('gap.diagnostics')) {
                diagnosticsProvider.onConfigurationChanged();
            }
        }),
    );

    context.subscriptions.push(
        vscode.workspace.onDidCloseTextDocument(doc => {
            onDocumentClosed(doc.uri);
            semanticProvider.onDocumentClosed(doc.uri);
            completionProvider.onDocumentClosed(doc.uri);
            referenceProvider.onDocumentClosed(doc.uri);
            diagnosticsProvider.onDocumentClosed(doc.uri);
        }),
    );

    for (const doc of vscode.workspace.textDocuments) {
        diagnosticsProvider.checkNow(doc);
    }
    console.log('[GAP] extension activated, semantic highlighting and folding ready');
    if (!context.globalState.get<boolean>('gap.welcomeShown')) {
        context.globalState.update('gap.welcomeShown', true);
        vscode.commands.executeCommand(
            'workbench.action.openWalkthrough',
            'flianlee.gap-system-support#gap-support.gettingStarted',
        );
    }
    return true;
}
