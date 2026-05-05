import * as path from 'path';
import * as vscode from 'vscode';

const COMMAND_ID = 'jump-to-source.jumpToSource';
const DTS_SUFFIX = '.d.ts';
const DEFINITION_KEYWORDS = /\b(export|function|class|const|let|type|interface)\b/;

export function activate(context: vscode.ExtensionContext): void {
  const disposable = vscode.commands.registerCommand(COMMAND_ID, jumpToSource);
  context.subscriptions.push(disposable);
}

export function deactivate(): void {
  // No cleanup is required.
}

async function jumpToSource(): Promise<void> {
  const editor = vscode.window.activeTextEditor;

  if (!editor || !editor.document.uri.fsPath.endsWith(DTS_SUFFIX)) {
    vscode.window.showInformationMessage('This command only works in .d.ts files');
    return;
  }

  const declarationPath = editor.document.uri.fsPath;
  const cursorPosition = editor.selection.active;
  const symbol = getSymbolUnderCursor(editor.document, cursorPosition);
  const sourceFileName = getSourceFileName(declarationPath);
  const sourceUri = await resolveSourceUri(declarationPath, sourceFileName);

  if (!sourceUri) {
    vscode.window.showErrorMessage(`Could not find source file for ${sourceFileName}`);
    return;
  }

  const sourceDocument = await vscode.workspace.openTextDocument(sourceUri);
  const sourceEditor = await vscode.window.showTextDocument(sourceDocument);
  const targetPosition = symbol
    ? findBestSymbolPosition(sourceDocument, symbol) ?? clampPosition(sourceDocument, cursorPosition)
    : clampPosition(sourceDocument, cursorPosition);

  sourceEditor.selection = new vscode.Selection(targetPosition, targetPosition);
  sourceEditor.revealRange(
    new vscode.Range(targetPosition, targetPosition),
    vscode.TextEditorRevealType.InCenter
  );
}

function getSymbolUnderCursor(document: vscode.TextDocument, position: vscode.Position): string | undefined {
  const wordRange = document.getWordRangeAtPosition(position, /[$A-Z_a-z][$\w]*/);
  if (!wordRange) {
    return undefined;
  }

  const symbol = document.getText(wordRange).trim();
  return symbol.length > 0 ? symbol : undefined;
}

function getSourceFileName(declarationPath: string): string {
  const fileName = path.basename(declarationPath);
  return `${fileName.slice(0, -DTS_SUFFIX.length)}.ts`;
}

async function resolveSourceUri(
  declarationPath: string,
  sourceFileName: string
): Promise<vscode.Uri | undefined> {
  const matches = await vscode.workspace.findFiles(
    `**/${sourceFileName}`,
    '{**/node_modules/**,**/*.d.ts}'
  );

  if (matches.length === 0) {
    return undefined;
  }

  if (matches.length === 1) {
    return matches[0];
  }

  const pathFilteredMatch = filterByDeclarationPath(declarationPath, sourceFileName, matches);
  if (pathFilteredMatch) {
    return pathFilteredMatch;
  }

  return pickSourceFile(matches);
}

function filterByDeclarationPath(
  declarationPath: string,
  sourceFileName: string,
  matches: readonly vscode.Uri[]
): vscode.Uri | undefined {
  const declarationDirectorySegments = path.dirname(declarationPath).split(path.sep).filter(Boolean);
  let candidates = [...matches];

  for (let segmentCount = 1; segmentCount <= declarationDirectorySegments.length; segmentCount += 1) {
    const suffixSegments = declarationDirectorySegments.slice(-segmentCount);
    const expectedSuffix = path.join(...suffixSegments, sourceFileName);
    const filtered = candidates.filter((uri) => normalizePath(uri.fsPath).endsWith(normalizePath(expectedSuffix)));

    if (filtered.length === 1) {
      return filtered[0];
    }

    if (filtered.length > 1) {
      candidates = filtered;
    }
  }

  return undefined;
}

async function pickSourceFile(matches: readonly vscode.Uri[]): Promise<vscode.Uri | undefined> {
  const items = matches
    .map((uri) => ({
      label: vscode.workspace.asRelativePath(uri, false),
      description: uri.fsPath,
      uri
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: 'Choose source file'
  });

  return selected?.uri;
}

function findBestSymbolPosition(document: vscode.TextDocument, symbol: string): vscode.Position | undefined {
  const symbolPattern = new RegExp(`\\b${escapeRegExp(symbol)}\\b`, 'g');
  let firstMatch: vscode.Position | undefined;

  for (let lineIndex = 0; lineIndex < document.lineCount; lineIndex += 1) {
    const line = document.lineAt(lineIndex).text;
    symbolPattern.lastIndex = 0;

    for (const match of line.matchAll(symbolPattern)) {
      if (match.index === undefined) {
        continue;
      }

      const position = new vscode.Position(lineIndex, match.index);
      firstMatch ??= position;

      if (DEFINITION_KEYWORDS.test(line.slice(0, match.index))) {
        return position;
      }
    }
  }

  return firstMatch;
}

function clampPosition(document: vscode.TextDocument, position: vscode.Position): vscode.Position {
  const line = Math.min(position.line, Math.max(document.lineCount - 1, 0));
  const character = Math.min(position.character, document.lineAt(line).text.length);
  return new vscode.Position(line, character);
}

function normalizePath(value: string): string {
  return value.split(path.sep).join('/');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
