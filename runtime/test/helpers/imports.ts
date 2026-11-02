// Import-graph helpers (AIR-141), reused by the quarantine and bench import checks. They read sources with the TypeScript
// compiler API: a node walk, no regular expressions over text.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';

/** Every module specifier of a file. A non-literal `import()` or `require()` is listed as `'<dynamic>'`. */
export function specifiersOf(fileName: string, text: string): string[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: string[] = [];
  const literal = (arg: ts.Expression | undefined): string => (arg !== undefined && ts.isStringLiteralLike(arg) ? arg.text : '<dynamic>');
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined) {
      out.push(ts.isStringLiteralLike(node.moduleSpecifier) ? node.moduleSpecifier.text : '<dynamic>');
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      out.push(literal(node.moduleReference.expression));
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require')) {
        out.push(literal(node.arguments[0]));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

export interface Source {
  /** absolute path */
  file: string;
  text: string;
}

export type ReadSource = (file: string) => string | undefined;

export const readFromDisk: ReadSource = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : undefined);

/** `exports` map of runtime/package.json: `./planner` to an absolute file */
export function exportTargets(runtimeDir: string): Record<string, string> {
  const pkg = JSON.parse(readFileSync(join(runtimeDir, 'package.json'), 'utf8')) as { exports?: Record<string, string> };
  const out: Record<string, string> = {};
  for (const [key, target] of Object.entries(pkg.exports ?? {})) out[key.replace(/^\.\//, '')] = resolve(runtimeDir, target);
  return out;
}

export interface Closure {
  files: string[];
  /** specifiers that are not literal, with the file that has them */
  dynamic: string[];
  /** specifiers that did not resolve to a file */
  unresolved: string[];
}

/**
 * The files reachable from `entry`. Relative specifiers resolve to files, `@airlock/runtime/<sub>` through the exports map;
 * bare package names and `node:` specifiers are ignored.
 */
export function closureOf(entry: string, read: ReadSource, exportsMap: Record<string, string>): Closure {
  const seen = new Set<string>();
  const dynamic: string[] = [];
  const unresolved: string[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);
    const text = read(file);
    if (text === undefined) {
      unresolved.push(file);
      continue;
    }
    for (const spec of specifiersOf(file, text)) {
      if (spec === '<dynamic>') {
        dynamic.push(file);
        continue;
      }
      let target: string | undefined;
      if (spec.startsWith('.')) target = resolve(dirname(file), spec);
      else if (spec.startsWith('@airlock/runtime/')) target = exportsMap[spec.slice('@airlock/runtime/'.length)];
      else continue;
      if (target === undefined) unresolved.push(spec);
      else queue.push(target);
    }
  }
  return { files: [...seen].sort(), dynamic, unresolved };
}

/** The files of a closure that lie outside every allowed directory (each given with a trailing slash). */
export function outsideOf(files: readonly string[], allowedDirs: readonly string[]): string[] {
  return files.filter((f) => !allowedDirs.some((d) => f.startsWith(d)));
}
