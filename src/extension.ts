import * as path from 'path';
import * as vscode from 'vscode';

const COMMAND_ID = 'jump-to-source.jump';
const DTS_SUFFIX = '.d.ts';
const SOURCE_EXTENSIONS = ['.ts', '.tsx'] as const;
const DEFINITION_KEYWORDS = /\b(export|function|class|const|let|type|interface)\b/;

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_ID, jumpToSource),
    vscode.languages.registerDefinitionProvider(
      [
        { scheme: 'file', language: 'typescript', pattern: '**/*.d.ts' },
        { scheme: 'file', language: 'typescriptreact', pattern: '**/*.d.ts' }
      ],
      {
        provideDefinition(document, position) {
          return provideSourceDefinition(document, position);
        }
      }
    )
  );
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
  const sourceBaseName = getSourceBaseName(declarationPath);
  const resolution = await resolveSourceUris(declarationPath, sourceBaseName);

  if (resolution.matches.length === 0) {
    vscode.window.showErrorMessage(`Could not find source file for ${formatSourceFileOptions(sourceBaseName)}`);
    return;
  }

  const sourceUri = resolution.resolved ?? await pickSourceFile(resolution.matches);
  if (!sourceUri) {
    return;
  }

  const sourceDocument = await vscode.workspace.openTextDocument(sourceUri);
  const sourceEditor = await vscode.window.showTextDocument(sourceDocument);
  const targetPosition = await getTargetPosition(editor.document, cursorPosition, sourceDocument);

  sourceEditor.selection = new vscode.Selection(targetPosition, targetPosition);
  sourceEditor.revealRange(
    new vscode.Range(targetPosition, targetPosition),
    vscode.TextEditorRevealType.InCenter
  );
}

async function provideSourceDefinition(
  document: vscode.TextDocument,
  position: vscode.Position
): Promise<vscode.Definition | undefined> {
  if (!document.uri.fsPath.endsWith(DTS_SUFFIX)) {
    return undefined;
  }

  const sourceBaseName = getSourceBaseName(document.uri.fsPath);
  const resolution = await resolveSourceUris(document.uri.fsPath, sourceBaseName);

  if (resolution.matches.length === 0) {
    return undefined;
  }

  const sourceUris = resolution.resolved ? [resolution.resolved] : resolution.matches;
  const locations = await Promise.all(
    sourceUris.map(async (sourceUri) => {
      const sourceDocument = await vscode.workspace.openTextDocument(sourceUri);
      const targetPosition = await getTargetPosition(document, position, sourceDocument);
      return new vscode.Location(sourceUri, targetPosition);
    })
  );

  return locations.length === 1 ? locations[0] : locations;
}

async function getTargetPosition(
  declarationDocument: vscode.TextDocument,
  declarationPosition: vscode.Position,
  sourceDocument: vscode.TextDocument
): Promise<vscode.Position> {
  const symbol = getSymbolUnderCursor(declarationDocument, declarationPosition);
  return symbol
    ? findBestSymbolPosition(sourceDocument, symbol) ?? clampPosition(sourceDocument, declarationPosition)
    : clampPosition(sourceDocument, declarationPosition);
}

function getSymbolUnderCursor(document: vscode.TextDocument, position: vscode.Position): string | undefined {
  const wordRange = document.getWordRangeAtPosition(position, /[$A-Z_a-z][$\w]*/);
  if (!wordRange) {
    return undefined;
  }

  const symbol = document.getText(wordRange).trim();
  return symbol.length > 0 ? symbol : undefined;
}

function getSourceBaseName(declarationPath: string): string {
  const fileName = path.basename(declarationPath);
  return fileName.slice(0, -DTS_SUFFIX.length);
}

async function resolveSourceUris(
  declarationPath: string,
  sourceBaseName: string
): Promise<{ matches: vscode.Uri[]; resolved?: vscode.Uri }> {
  const matches = await findSourceCandidates(sourceBaseName);

  if (matches.length === 1) {
    return { matches, resolved: matches[0] };
  }

  const pathFilteredMatch = filterByDeclarationPath(declarationPath, sourceBaseName, matches);
  if (pathFilteredMatch) {
    return { matches, resolved: pathFilteredMatch };
  }

  return { matches };
}

async function findSourceCandidates(sourceBaseName: string): Promise<vscode.Uri[]> {
  const candidateGroups = await Promise.all(
    SOURCE_EXTENSIONS.map((extension) =>
      vscode.workspace.findFiles(
        `**/${sourceBaseName}${extension}`,
        '{**/node_modules/**,**/*.d.ts}'
      )
    )
  );

  return candidateGroups.flat();
}

function filterByDeclarationPath(
  declarationPath: string,
  sourceBaseName: string,
  matches: readonly vscode.Uri[]
): vscode.Uri | undefined {
  const declarationDirectorySegments = path.dirname(declarationPath).split(path.sep).filter(Boolean);
  let candidates = [...matches];

  for (let segmentCount = 1; segmentCount <= declarationDirectorySegments.length; segmentCount += 1) {
    const suffixSegments = declarationDirectorySegments.slice(-segmentCount);
    const expectedSuffixes = SOURCE_EXTENSIONS.map((extension) =>
      normalizePath(path.join(...suffixSegments, `${sourceBaseName}${extension}`))
    );
    const filtered = candidates.filter((uri) =>
      expectedSuffixes.some((expectedSuffix) => normalizePath(uri.fsPath).endsWith(expectedSuffix))
    );

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

function formatSourceFileOptions(sourceBaseName: string): string {
  return SOURCE_EXTENSIONS.map((extension) => `${sourceBaseName}${extension}`).join(' or ');
}
