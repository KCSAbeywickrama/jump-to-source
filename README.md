# Jump to Source

Jump to Source is a minimal VS Code extension that opens the TypeScript source file behind a `.d.ts` declaration file.

## Usage

1. Open a `.d.ts` file.
2. Place the cursor on a symbol.
3. Run `Jump to Source` from the Command Palette.

The extension searches for a matching `.ts` file, opens it, and moves the cursor to the best matching symbol definition.

## Development

Install dependencies and compile:

```sh
npm install
npm run compile
```

Open this folder in VS Code and press F5 to launch an Extension Development Host.
