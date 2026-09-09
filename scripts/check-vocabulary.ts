import ts from 'typescript';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { TASK_STATUSES } from '../packages/types/src';

const vocabulary = new Set<string>(TASK_STATUSES);
const violations: string[] = [];
function walk(path: string) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.next'].includes(entry.name)) continue;
    const file = join(path, entry.name);
    if (entry.isDirectory()) { walk(file); continue; }
    if (!/\.(ts|tsx)$/.test(file)) continue;
    if (file === 'packages/types/src/task-status.ts') continue;
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node) {
      if (ts.isArrayLiteralExpression(node) && node.elements.filter((item) => ts.isStringLiteral(item) && vocabulary.has(item.text)).length > 1) {
        violations.push(file);
      }
      if ((ts.isTypeAliasDeclaration(node) && ts.isUnionTypeNode(node.type)) && node.type.types.filter((item) => ts.isLiteralTypeNode(item) && ts.isStringLiteral(item.literal) && vocabulary.has(item.literal.text)).length > 1) {
        violations.push(file);
      }
      if (ts.isObjectLiteralExpression(node) && node.properties.filter((item) => item.name && (ts.isIdentifier(item.name) || ts.isStringLiteral(item.name)) && vocabulary.has(item.name.text)).length > 1) {
        violations.push(file);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
}
walk('apps');
walk('packages');
if (violations.length) throw new Error(`Mirrored status list: ${violations.join(', ')}`);
console.log('Status vocabulary gate: PASS (no mirrored status lists in apps or packages)');
