/**
 * This file does the following:
 * 
 * 1. Provides a live search QuickPick for GAP help entries.
 * 2. Filters results by book through a button.
 */

import * as vscode from 'vscode';
import { HelpEntry } from './indexData';

interface PickerItem extends vscode.QuickPickItem { entry: HelpEntry }

/** Show a filter button in the QuickPick. */
const filterOffBtn: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('filter'),
    tooltip: 'Filter by book',
};
const filterOnBtn: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('filter-filled'),
    tooltip: 'Filter by book (active)',
};

/**
 * Open a search picker that refreshes on each keystroke.
 * Return the chosen entry, or nothing if dismissed.
 */
export function showLiveSearchPicker(
    initialValue: string,
    onSearch: (topic: string, fromBegin: boolean) => HelpEntry[],
    initialFromBegin: boolean = true,
    bookDescriptions: Map<string, string> = new Map(),
): Promise<HelpEntry | undefined> {
    return new Promise(resolve => {
        const picker = vscode.window.createQuickPick<PickerItem>();

        // Track which books are currently selected for filtering
        let selectedBooks = new Set(bookDescriptions.keys());
        let fromBegin = initialFromBegin;
        let currentResults: HelpEntry[] = [];
        let inputEmpty = true;
        let bookPickerActive = false;
        let resolved = false;

        // Search mode toggle button
        const modeIcon = new vscode.ThemeIcon('regex');
        const modeBtn: vscode.QuickInputButton = {
            iconPath: modeIcon,
            tooltip: 'Toggle match mode',
        };

        // Placeholder text
        const placeholderText = 'Search GAP help: type to filter';
        picker.value = initialValue;

        /** Filter results down to the currently selected books. */
        const applyBookFilter = (results: HelpEntry[]): HelpEntry[] =>
            results.filter(e => selectedBooks.has(e.book));

        /** Update the placeholder text to show which books are being searched. */
        const updateFilterUI = () => {
            picker.title = fromBegin ? 'Prefix match' : 'Substring match';
            const n = selectedBooks.size;
            const total = bookDescriptions.size;
            const label = n === 0 ? 'No books'
                : n === total ? 'All books'
                : `Books: ${[...selectedBooks].sort().join(', ')}`;
            picker.placeholder = `${placeholderText}  |  ${label}`;
            const filterBtn = n === total ? filterOffBtn : filterOnBtn;
            const modeState: vscode.QuickInputButton = {
                ...modeBtn,
                toggle: { checked: !fromBegin },
            };
            picker.buttons = [modeState, filterBtn];
        };

        /** Search for the given topic and refresh the list. */
        const refresh = (topic: string) => {
            const trimmed = topic.trim();
            inputEmpty = !trimmed;
            if (!trimmed) {
                currentResults = [];
                picker.items = [];
                return;
            }
            const results = onSearch(trimmed, fromBegin);
            currentResults = results;
            picker.items = applyBookFilter(results).map(e => ({
                label: e.display,
                description: e.filePath,
                detail: e.book,
                alwaysShow: true,
                entry: e,
            }));
        };

        // Open the book selection panel
        const showBookPicker = async () => {
            bookPickerActive = true;
            const prevValue = picker.value;
            picker.hide();

            const bp = vscode.window.createQuickPick<vscode.QuickPickItem>();
            bp.canSelectMany = true;
            bp.matchOnDescription = true;
            bp.title = 'Filter by Book';
            bp.placeholder = 'Space to toggle, Enter to confirm';

            const backBtn: vscode.QuickInputButton = {
                iconPath: new vscode.ThemeIcon('arrow-left'),
                tooltip: 'Discard changes and go back',
            };
            const clearBtn: vscode.QuickInputButton = {
                iconPath: new vscode.ThemeIcon('clear-all'),
                tooltip: 'Clear all book filters',
            };
            bp.buttons = [backBtn, clearBtn];

            // List all known books and check the ones last picked
            let bpItems: vscode.QuickPickItem[];
            if (!inputEmpty) {
                const matchCount = new Map<string, number>();
                for (const e of currentResults) {
                    matchCount.set(e.book, (matchCount.get(e.book) || 0) + 1);
                }
                const narrowed = selectedBooks.size < bookDescriptions.size;
                bpItems = [...bookDescriptions.entries()]
                    .sort((a, b) => {
                        if (narrowed) {
                            const aChecked = selectedBooks.has(a[0]);
                            const bChecked = selectedBooks.has(b[0]);
                            if (aChecked !== bChecked) return aChecked ? -1 : 1;
                        }
                        const aMatch = (matchCount.get(a[0]) || 0) > 0;
                        const bMatch = (matchCount.get(b[0]) || 0) > 0;
                        if (aMatch !== bMatch) return aMatch ? -1 : 1;
                        return a[0].localeCompare(b[0]);
                    })
                    .map(([short, long]) => {
                        const count = matchCount.get(short) || 0;
                        return {
                            label: short,
                            description: long,
                            detail: count > 0
                                ? `${count} matching ${count === 1 ? 'entry' : 'entries'}`
                                : '0 matching entries',
                            picked: narrowed ? selectedBooks.has(short) : count > 0,
                        };
                    });
            } else {
                bpItems = [...bookDescriptions.entries()]
                    .sort((a, b) => a[0].localeCompare(b[0]))
                    .map(([short, long]) => ({
                        label: short,
                        description: long,
                        picked: selectedBooks.has(short),
                    }));
            }

            bp.items = bpItems;

            // We also need to tell VS Code which items are selected.
            bp.selectedItems = bpItems.filter(i => i.picked);

            bp.onDidTriggerButton(btn => {
                if (btn === backBtn) {
                    bp.hide();
                } else if (btn === clearBtn) {
                    bp.items = bp.items.map(i => ({ ...i, picked: false }));
                    bp.selectedItems = [];
                }
            });

            bp.onDidAccept(() => {
                selectedBooks = new Set(bp.selectedItems.map(i => i.label));
                bp.hide();
            });

            bp.onDidHide(() => {
                bp.dispose();
                bookPickerActive = false;
                updateFilterUI();
                picker.value = prevValue;
                picker.show();
                if (!inputEmpty && currentResults.length) {
                    picker.items = applyBookFilter(currentResults).map(e => ({
                        label: e.display,
                        description: e.filePath,
                        detail: e.book,
                        alwaysShow: true,
                        entry: e,
                    }));
                }
            });

            bp.show();
        };

        // Bind search and filter actions to the picker
        picker.onDidChangeValue(value => refresh(value));

        picker.onDidTriggerButton(async btn => {
            // The mode button is the only one with a toggle.
            if (btn.toggle !== undefined) {
                fromBegin = !fromBegin;
                updateFilterUI();
                if (!inputEmpty) refresh(picker.value);
            } else {
                await showBookPicker();
            }
        });

        picker.onDidAccept(() => {
            const selected = picker.selectedItems[0];
            if (selected) {
                resolved = true;
                picker.hide();
                resolve(selected.entry);
            }
        });

        picker.onDidHide(() => {
            if (!bookPickerActive && !resolved) {
                picker.dispose();
                resolve(undefined);
            }
        });

        if (initialValue) refresh(initialValue);
        updateFilterUI();
        picker.show();
    });
}

