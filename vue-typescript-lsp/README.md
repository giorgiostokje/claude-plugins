# vue-typescript-lsp

A small Node wrapper (`bin/vue-ts-lsp.mjs`) around `typescript-language-server`. It adds two things:

- Loads `@vue/typescript-plugin` for `.vue` files. It looks in the project's `node_modules` first, then in `npm root -g`, so no path is hardcoded.
- Answers `textDocument/documentSymbol` for `.vue` files itself: the template, script and style blocks, plus the top-level declarations in each script block. It parses with the project's own `@vue/compiler-sfc` and `typescript`.

Use it instead of `typescript-lsp` in Vue projects; both claim the same extensions.

## Install the servers

```bash
npm install -g typescript-language-server typescript @vue/typescript-plugin
```

## Limits

No template completions, and no references or diagnostics inside `<template>`. Those need `@vue/language-server`, whose version 3 Claude Code's LSP client cannot drive. Run `vue-tsc` for template type errors.
