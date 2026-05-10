# Jump to Source

Jump to Source is a minimal VS Code extension that opens the TypeScript or TSX source file behind a `.d.ts` declaration file.

## Why

This extension is a quick workaround for large codebases where TypeScript configuration does not enable jumping between packages. In those projects, VS Code may land on generated `.d.ts` files instead of the original source.

## Usage

1. Open a `.d.ts` file.
2. Place the cursor on a symbol.
3. Run `Jump to Source (*.d.ts -> *.ts/tsx)` from the Command Palette.

The extension searches for a matching `.ts` or `.tsx` file, opens it, and moves the cursor to the best matching symbol definition.

## How it works

The extension first searches the workspace for exact filename candidates, such as `index.ts` and `index.tsx` for `index.d.ts`.

When multiple files have the same name, it tries package-aware resolution. It reads the nearest `package.json`, checks for an ancestor `rush.json`, and uses Rush `packageName` / `projectFolder` metadata when available to prefer the source package folder.

For common build output folders such as `lib`, `dist`, `build`, `out`, `types`, and `declarations`, it preserves the relative path and checks exact source paths like `src/index.ts` or `source/foo/bar.tsx`.

If package metadata cannot identify one source file, the extension falls back to incremental path segment matching.

## Development

Install dependencies:

```sh
npm install
```

Available scripts:

- `npm run compile` - compile the extension into `out/`.
- `npm run watch` - compile continuously while developing.
- `npm run package` - build a `.vsix` package with `vsce`.
- `npm run code-install` - compile, package, and install the generated `.vsix` into VS Code.

Open this folder in VS Code and press F5 to launch an Extension Development Host.
