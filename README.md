# Jump to Source

Jump to Source is a minimal VS Code extension that opens the TypeScript or TSX source file behind a `.d.ts` declaration file.

## Why

This extension is a quick workaround for large codebases where TypeScript configuration does not enable jumping between packages. In those projects, VS Code may land on generated `.d.ts` files instead of the original source. This extension uses filename and incremental path segments matching to find the corresponding `.ts` or `.tsx` file directly.

## Usage

1. Open a `.d.ts` file.
2. Place the cursor on a symbol.
3. Run `Jump to Source (*.d.ts -> *.ts/tsx)` from the Command Palette.

The extension searches for a matching `.ts` or `.tsx` file, opens it, and moves the cursor to the best matching symbol definition.

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
