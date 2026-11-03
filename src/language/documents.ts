export interface SourceUri {
    readonly fsPath: string;
    toString(): string;
}

export interface SourcePosition {
    readonly line: number;
    readonly character: number;
}

export interface SourceRange {
    readonly start: SourcePosition;
    readonly end: SourcePosition;
}

export interface TextSnapshot {
    readonly uri: SourceUri;
    readonly version: number;
    getText(): string;
}

export interface SourceDocument extends TextSnapshot {
    readonly isUntitled: boolean;
    offsetAt(position: SourcePosition): number;
}

export interface SourceChange {
    readonly range: SourceRange;
    readonly rangeOffset: number;
    readonly rangeLength: number;
    readonly text: string;
}

export interface LanguageHost {
    openDocuments(): readonly SourceDocument[];
    workspaceRoot(uri: SourceUri): string | null;
}
