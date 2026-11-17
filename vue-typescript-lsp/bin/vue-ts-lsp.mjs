#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const VUE_PLUGIN_NAME = '@vue/typescript-plugin';
const SYMBOL_KIND = { module: 2, class: 5, function: 12, variable: 13, constant: 14, interface: 11, enum: 10, typeParameter: 26 };

const child = spawn('typescript-language-server', ['--stdio'], { stdio: ['pipe', 'pipe', 'inherit'] });
child.on('error', (error) => {
  process.stderr.write('vue-ts-lsp: cannot start typescript-language-server: ' + error.message + '\n');
  process.exit(1);
});
child.on('exit', (code) => process.exit(code ?? 0));

let workspaceRoot = process.cwd();
const documents = new Map();

function frame(message) {
  const body = Buffer.from(JSON.stringify(message));
  return Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\r\n\r\n'), body]);
}

function messageReader(onMessage) {
  let buffered = Buffer.alloc(0);
  return (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    for (;;) {
      const headerEnd = buffered.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const match = /Content-Length: (\d+)/i.exec(buffered.subarray(0, headerEnd).toString());
      if (!match) {
        buffered = buffered.subarray(headerEnd + 4);
        continue;
      }
      const end = headerEnd + 4 + Number(match[1]);
      if (buffered.length < end) return;
      const body = buffered.subarray(headerEnd + 4, end);
      buffered = buffered.subarray(end);
      onMessage(JSON.parse(body.toString()));
    }
  };
}

function findVuePluginLocation(root) {
  const projectLocal = join(root, 'node_modules', VUE_PLUGIN_NAME);
  if (existsSync(projectLocal)) return projectLocal;
  try {
    const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
    const globalLocation = join(globalRoot, VUE_PLUGIN_NAME);
    if (existsSync(globalLocation)) return globalLocation;
  } catch {
    return null;
  }
  return null;
}

function withVuePlugin(initializeParams) {
  if (initializeParams.rootUri) workspaceRoot = fileURLToPath(initializeParams.rootUri);
  const location = findVuePluginLocation(workspaceRoot);
  if (!location) {
    process.stderr.write('vue-ts-lsp: ' + VUE_PLUGIN_NAME + ' not found; run npm install -g ' + VUE_PLUGIN_NAME + '\n');
    return initializeParams;
  }
  const options = initializeParams.initializationOptions ?? {};
  const plugins = [...(options.plugins ?? []), { name: VUE_PLUGIN_NAME, location, languages: ['vue'] }];
  return { ...initializeParams, initializationOptions: { ...options, plugins } };
}

function offsetAt(text, position) {
  let offset = 0;
  for (let line = 0; line < position.line; line++) {
    const next = text.indexOf('\n', offset);
    if (next < 0) return text.length;
    offset = next + 1;
  }
  return Math.min(offset + position.character, text.length);
}

function positionAt(text, offset) {
  let line = 0;
  let lineStart = 0;
  for (let index = text.indexOf('\n'); index >= 0 && index < offset; index = text.indexOf('\n', index + 1)) {
    line++;
    lineStart = index + 1;
  }
  return { line, character: offset - lineStart };
}

function trackDocument(message) {
  const { method, params } = message;
  if (method === 'textDocument/didOpen') documents.set(params.textDocument.uri, params.textDocument.text);
  if (method === 'textDocument/didClose') documents.delete(params.textDocument.uri);
  if (method !== 'textDocument/didChange') return;
  let text = documents.get(params.textDocument.uri);
  if (text === undefined) return;
  for (const change of params.contentChanges) {
    text = change.range
      ? text.slice(0, offsetAt(text, change.range.start)) + change.text + text.slice(offsetAt(text, change.range.end))
      : change.text;
  }
  documents.set(params.textDocument.uri, text);
}

function scriptDeclarations(typescript, text, block) {
  const sourceFile = typescript.createSourceFile('block.ts', block.content, typescript.ScriptTarget.Latest, true, typescript.ScriptKind.TS);
  const symbols = [];
  const base = block.loc.start.offset;
  const add = (node, nameNode, kind) => {
    const range = { start: positionAt(text, base + node.getStart(sourceFile)), end: positionAt(text, base + node.getEnd()) };
    const selectionRange = { start: positionAt(text, base + nameNode.getStart(sourceFile)), end: positionAt(text, base + nameNode.getEnd()) };
    symbols.push({ name: nameNode.getText(sourceFile), kind, range, selectionRange });
  };
  for (const statement of sourceFile.statements) {
    if (typescript.isFunctionDeclaration(statement) && statement.name) add(statement, statement.name, SYMBOL_KIND.function);
    if (typescript.isClassDeclaration(statement) && statement.name) add(statement, statement.name, SYMBOL_KIND.class);
    if (typescript.isInterfaceDeclaration(statement)) add(statement, statement.name, SYMBOL_KIND.interface);
    if (typescript.isTypeAliasDeclaration(statement)) add(statement, statement.name, SYMBOL_KIND.typeParameter);
    if (typescript.isEnumDeclaration(statement)) add(statement, statement.name, SYMBOL_KIND.enum);
    if (!typescript.isVariableStatement(statement)) continue;
    const isConstant = (statement.declarationList.flags & typescript.NodeFlags.Const) !== 0;
    for (const declaration of statement.declarationList.declarations) {
      if (!typescript.isIdentifier(declaration.name)) continue;
      const initializer = declaration.initializer;
      const isFunction = initializer && (typescript.isArrowFunction(initializer) || typescript.isFunctionExpression(initializer));
      add(declaration, declaration.name, isFunction ? SYMBOL_KIND.function : isConstant ? SYMBOL_KIND.constant : SYMBOL_KIND.variable);
    }
  }
  return symbols;
}

function blockSymbol(typescript, text, block, name, withDeclarations) {
  const start = text.lastIndexOf('<', block.loc.start.offset);
  const end = text.indexOf('>', block.loc.end.offset) + 1;
  const range = { start: positionAt(text, start), end: positionAt(text, end) };
  const selectionRange = { start: range.start, end: positionAt(text, text.indexOf('>', start) + 1) };
  const children = withDeclarations ? scriptDeclarations(typescript, text, block) : [];
  return { name, kind: SYMBOL_KIND.module, range, selectionRange, children };
}

function vueDocumentSymbols(uri) {
  try {
    const text = documents.get(uri) ?? readFileSync(fileURLToPath(uri), 'utf8');
    const projectRequire = createRequire(join(workspaceRoot, 'package.json'));
    const { parse } = projectRequire('@vue/compiler-sfc');
    const typescript = projectRequire('typescript');
    const { descriptor } = parse(text, { filename: fileURLToPath(uri) });
    const symbols = [];
    if (descriptor.template) symbols.push(blockSymbol(typescript, text, descriptor.template, 'template', false));
    if (descriptor.script) symbols.push(blockSymbol(typescript, text, descriptor.script, 'script', true));
    if (descriptor.scriptSetup) symbols.push(blockSymbol(typescript, text, descriptor.scriptSetup, 'script setup', true));
    for (const style of descriptor.styles) symbols.push(blockSymbol(typescript, text, style, 'style', false));
    return symbols.sort((first, second) => first.range.start.line - second.range.start.line);
  } catch (error) {
    process.stderr.write('vue-ts-lsp: document symbols failed: ' + error.message + '\n');
    return null;
  }
}

const fromClient = messageReader((message) => {
  if (message.method === 'initialize') message.params = withVuePlugin(message.params);
  trackDocument(message);
  const isVueSymbolRequest = message.method === 'textDocument/documentSymbol' && message.params.textDocument.uri.endsWith('.vue');
  const symbols = isVueSymbolRequest ? vueDocumentSymbols(message.params.textDocument.uri) : null;
  if (symbols) {
    process.stdout.write(frame({ jsonrpc: '2.0', id: message.id, result: symbols }));
    return;
  }
  child.stdin.write(frame(message));
});
process.stdin.on('data', fromClient);
process.stdin.on('end', () => child.stdin.end());
child.stdout.on('data', messageReader((message) => process.stdout.write(frame(message))));
