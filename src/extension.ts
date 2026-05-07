import * as path from 'path';
import * as vscode from 'vscode';

const COMMAND_ID = 'jump-to-source.jump';
const DTS_SUFFIX = '.d.ts';
const SOURCE_EXTENSIONS = ['.ts', '.tsx'] as const;
const PACKAGE_SOURCE_DIRECTORIES = ['src', 'source'];
const GENERATED_PATH_SEGMENTS = new Set(['lib', 'dist', 'build', 'out', 'types', 'declarations']);
const DEFINITION_KEYWORDS = /\b(export|function|class|const|let|type|interface)\b/;

interface PackageJson {
  name?: string;
  types?: string;
  typings?: string;
  main?: string;
  module?: string;
}

interface RushJson {
  projects?: Array<{
    packageName?: string;
    projectFolder?: string;
  }>;
}

interface PackageContext {
  packageRoot: string;
  packageJson: PackageJson;
  rushRoot?: string;
  rushJson?: RushJson;
}

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
  const sourceBaseName = getSourceBaseName(declarationPath);
  const sourceUri = await resolveSourceUri(declarationPath, sourceBaseName);

  if (!sourceUri) {
    vscode.window.showErrorMessage(`Could not find source file for ${formatSourceFileOptions(sourceBaseName)}`);
    return;
  }

  const sourceDocument = await vscode.workspace.openTextDocument(sourceUri);
  const sourceEditor = await vscode.window.showTextDocument(sourceDocument);
  const fallbackPosition = clampPosition(sourceDocument, cursorPosition);
  const targetPosition = symbol
    ? findBestSymbolPosition(sourceDocument, symbol) ?? fallbackPosition
    : fallbackPosition;

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

function getSourceBaseName(declarationPath: string): string {
  const fileName = path.basename(declarationPath);
  return fileName.slice(0, -DTS_SUFFIX.length);
}

async function resolveSourceUri(
  declarationPath: string,
  sourceBaseName: string
): Promise<vscode.Uri | undefined> {
  const matches = await findSourceCandidates(sourceBaseName);

  if (matches.length === 0) {
    return undefined;
  }

  if (matches.length === 1) {
    return matches[0];
  }

  const packageMatches = await filterByPackageContext(declarationPath, matches);
  if (packageMatches.length === 1) {
    return packageMatches[0];
  }

  if (packageMatches.length > 1) {
    return pickSourceFile(packageMatches);
  }

  const filteredMatches = filterByDeclarationPath(declarationPath, sourceBaseName, matches);
  if (filteredMatches.length === 1) {
    return filteredMatches[0];
  }

  return pickSourceFile(filteredMatches);
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

async function filterByPackageContext(
  declarationPath: string,
  matches: readonly vscode.Uri[]
): Promise<vscode.Uri[]> {
  const context = await getPackageContext(declarationPath);
  if (!context) {
    return [];
  }

  const strictMatches = filterByStrictOutputRewrite(declarationPath, matches, context);
  if (strictMatches.length > 0) {
    return strictMatches;
  }

  const preferredRoots = getPreferredSourceRoots(declarationPath, context);
  for (const root of preferredRoots) {
    const matchesUnderRoot = filterUrisUnderRoot(matches, root);
    if (matchesUnderRoot.length > 0) {
      return matchesUnderRoot;
    }
  }

  return [];
}

async function getPackageContext(declarationPath: string): Promise<PackageContext | undefined> {
  const workspaceRoot = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(declarationPath))?.uri.fsPath;
  const packageJsonPath = await findAncestorFile(path.dirname(declarationPath), 'package.json', workspaceRoot);
  if (!packageJsonPath) {
    return undefined;
  }

  const packageJson = await readJsonFile<PackageJson>(packageJsonPath);
  if (!packageJson) {
    return undefined;
  }

  const rushJsonPath = await findAncestorFile(path.dirname(packageJsonPath), 'rush.json', workspaceRoot);
  const rushJson = rushJsonPath ? await readJsonFile<RushJson>(rushJsonPath) : undefined;

  return {
    packageRoot: path.dirname(packageJsonPath),
    packageJson,
    rushRoot: rushJsonPath ? path.dirname(rushJsonPath) : undefined,
    rushJson
  };
}

function getPreferredSourceRoots(declarationPath: string, context: PackageContext): string[] {
  const roots: string[] = [];
  const rushProjectRoot = getRushProjectRoot(context);

  if (rushProjectRoot) {
    roots.push(...getPackageSourceRoots(rushProjectRoot));
  }

  roots.push(...getPackageSourceRoots(context.packageRoot));

  return dedupePaths(roots);
}

function filterByStrictOutputRewrite(
  declarationPath: string,
  matches: readonly vscode.Uri[],
  context: PackageContext
): vscode.Uri[] {
  const relativeOutputPath = getRelativePathAfterGeneratedSegment(declarationPath);
  if (!relativeOutputPath) {
    return [];
  }

  const sourceRoots = getStrictSourceRoots(context);
  const candidatePaths = sourceRoots.flatMap((root) =>
    SOURCE_EXTENSIONS.map((extension) =>
      normalizePath(path.join(root, replaceDeclarationExtension(relativeOutputPath, extension)))
    )
  );
  const candidatePathSet = new Set(candidatePaths);

  return matches.filter((uri) => candidatePathSet.has(normalizePath(uri.fsPath)));
}

function getStrictSourceRoots(context: PackageContext): string[] {
  const packageRoots = [getRushProjectRoot(context), context.packageRoot].filter((root): root is string => Boolean(root));
  return dedupePaths(
    packageRoots.flatMap((root) =>
      PACKAGE_SOURCE_DIRECTORIES.map((directory) => path.join(root, directory))
    )
  );
}

function getRelativePathAfterGeneratedSegment(declarationPath: string): string | undefined {
  const directorySegments = path.dirname(declarationPath).split(path.sep);
  const generatedSegmentIndex = directorySegments.findIndex((segment) =>
    GENERATED_PATH_SEGMENTS.has(segment.toLowerCase())
  );

  if (generatedSegmentIndex === -1) {
    return undefined;
  }

  const relativeDirectorySegments = directorySegments.slice(generatedSegmentIndex + 1);
  return path.join(...relativeDirectorySegments, path.basename(declarationPath));
}

function replaceDeclarationExtension(relativePath: string, extension: string): string {
  return relativePath.endsWith(DTS_SUFFIX)
    ? `${relativePath.slice(0, -DTS_SUFFIX.length)}${extension}`
    : relativePath;
}

function getRushProjectRoot(context: PackageContext): string | undefined {
  if (!context.rushRoot || !context.rushJson?.projects || !context.packageJson.name) {
    return undefined;
  }

  const project = context.rushJson.projects.find(
    (candidate) => candidate.packageName === context.packageJson.name && candidate.projectFolder
  );

  return project?.projectFolder ? path.resolve(context.rushRoot, project.projectFolder) : undefined;
}

function getPackageSourceRoots(packageRoot: string): string[] {
  return [
    ...PACKAGE_SOURCE_DIRECTORIES.map((directory) => path.join(packageRoot, directory)),
    packageRoot
  ];
}

function filterUrisUnderRoot(uris: readonly vscode.Uri[], root: string): vscode.Uri[] {
  const normalizedRoot = normalizePath(root);
  return uris.filter((uri) => {
    const normalizedPath = normalizePath(uri.fsPath);
    return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
  });
}

async function findAncestorFile(
  startDirectory: string,
  fileName: string,
  stopDirectory?: string
): Promise<string | undefined> {
  let currentDirectory = startDirectory;
  const normalizedStopDirectory = stopDirectory ? normalizePath(stopDirectory) : undefined;

  while (true) {
    const candidate = path.join(currentDirectory, fileName);
    if (await fileExists(candidate)) {
      return candidate;
    }

    if (normalizedStopDirectory && normalizePath(currentDirectory) === normalizedStopDirectory) {
      return undefined;
    }

    const parentDirectory = path.dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      return undefined;
    }

    currentDirectory = parentDirectory;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
    const json = Buffer.from(bytes).toString('utf8');
    return JSON.parse(stripTrailingCommas(stripJsonComments(json))) as T;
  } catch {
    return undefined;
  }
}

function stripJsonComments(json: string): string {
  let result = '';
  let inString = false;
  let escaped = false;

  for (let index = 0; index < json.length; index += 1) {
    const current = json[index];
    const next = json[index + 1];

    if (inString) {
      result += current;

      if (escaped) {
        escaped = false;
        continue;
      }

      if (current === '\\') {
        escaped = true;
        continue;
      }

      if (current === '"') {
        inString = false;
      }

      continue;
    }

    if (current === '"') {
      inString = true;
      result += current;
      continue;
    }

    if (current === '/' && next === '/') {
      while (index < json.length && json[index] !== '\n') {
        index += 1;
      }
      result += '\n';
      continue;
    }

    if (current === '/' && next === '*') {
      index += 2;
      while (index < json.length && !(json[index] === '*' && json[index + 1] === '/')) {
        result += json[index] === '\n' ? '\n' : ' ';
        index += 1;
      }
      index += 1;
      continue;
    }

    result += current;
  }

  return result;
}

function stripTrailingCommas(json: string): string {
  let result = '';
  let inString = false;
  let escaped = false;

  for (let index = 0; index < json.length; index += 1) {
    const current = json[index];

    if (inString) {
      result += current;

      if (escaped) {
        escaped = false;
        continue;
      }

      if (current === '\\') {
        escaped = true;
        continue;
      }

      if (current === '"') {
        inString = false;
      }

      continue;
    }

    if (current === '"') {
      inString = true;
      result += current;
      continue;
    }

    if (current === ',') {
      let lookahead = index + 1;
      while (/\s/.test(json[lookahead] ?? '')) {
        lookahead += 1;
      }

      if (json[lookahead] === '}' || json[lookahead] === ']') {
        continue;
      }
    }

    result += current;
  }

  return result;
}

function dedupePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const currentPath of paths) {
    const normalizedPath = normalizePath(currentPath);
    if (seen.has(normalizedPath)) {
      continue;
    }

    seen.add(normalizedPath);
    deduped.push(currentPath);
  }

  return deduped;
}

function filterByDeclarationPath(
  declarationPath: string,
  sourceBaseName: string,
  matches: readonly vscode.Uri[]
): vscode.Uri[] {
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

    if (filtered.length === 0) {
      return candidates;
    }

    if (filtered.length === 1) {
      return filtered;
    }

    if (filtered.length > 1) {
      candidates = filtered;
    }
  }

  return candidates;
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
