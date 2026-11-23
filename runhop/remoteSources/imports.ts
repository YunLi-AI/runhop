import type { SyntaxNode } from '@lezer/common';
import { parser } from '@lezer/python';

export interface SourceQuery {
  module: string;
  members: string[];
}

export interface ImportReference extends SourceQuery {
  from: number;
  to: number;
}

interface Binding {
  alias: string;
  query: SourceQuery;
}

function children(node: SyntaxNode): SyntaxNode[] {
  const result: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) result.push(child);
  return result;
}

function same(left: SyntaxNode, right: SyntaxNode): boolean {
  return left.from === right.from && left.to === right.to && left.type === right.type;
}

const scopes = new Set(['FunctionDefinition', 'ClassDefinition', 'LambdaExpression', 'Script']);
const bindingBoundaries = new Map([
  ['AssignStatement', 'AssignOp'],
  ['UpdateStatement', 'UpdateOp'],
  ['NamedExpression', 'AssignOp'],
  ['ForStatement', 'in'],
]);
const scopeOf = (node: SyntaxNode) => {
  let current = node.parent;
  while (current && !scopes.has(current.name)) current = current.parent;
  return current;
};

function selection(query: SourceQuery, node: SyntaxNode): ImportReference {
  return { ...query, from: node.from, to: node.to };
}

function imports(text: string, node: SyntaxNode, clicked?: SyntaxNode) {
  const all = children(node);
  const textFor = (token: SyntaxNode) => text.slice(token.from, token.to);
  const keyword = all.findIndex(token => token.name === 'import');
  if (keyword < 0) return { bindings: [], reference: undefined };
  const from = all[0]?.name === 'from';
  const moduleParts = from ? all.slice(1, keyword) : [];
  const module = moduleParts.map(textFor).join('');
  let reference: ImportReference | undefined;
  const bindings: Binding[] = [];
  if (clicked && moduleParts.some(part => same(part, clicked))) {
    const prefix = moduleParts
      .filter(part => part.to <= clicked.to)
      .map(textFor)
      .join('');
    reference = selection({ module: prefix, members: [] }, clicked);
  }
  const remaining = all.slice(keyword + 1);
  let start = 0;
  for (let i = 0; i <= remaining.length; i++) {
    if (i < remaining.length && remaining[i].name !== ',') continue;
    const group = remaining.slice(start, i);
    start = i + 1;
    const as = group.findIndex(part => part.name === 'as');
    const names = (as < 0 ? group : group.slice(0, as)).filter(
      part => part.name === 'VariableName'
    );
    if (!names.length) continue;
    const alias = as < 0 ? undefined : group[as + 1];
    const dotted = names.map(textFor).join('.');
    const full = from ? { module, members: [dotted] } : { module: dotted, members: [] };
    bindings.push({
      alias: textFor(alias ?? names[0]),
      query: from || alias ? full : { module: textFor(names[0]), members: [] },
    });
    if (!clicked) continue;
    const index = names.findIndex(part => same(part, clicked));
    if (index >= 0 || (alias && same(alias, clicked))) {
      const query =
        from || index < 0
          ? full
          : {
              module: names
                .slice(0, index + 1)
                .map(textFor)
                .join('.'),
              members: [],
            };
      reference = selection(query, clicked);
    }
  }
  return { bindings, reference };
}

function dottedName(node: SyntaxNode): SyntaxNode[] {
  if (node.name === 'VariableName') return [node];
  if (node.name !== 'MemberExpression') return [];
  const [object, dot, property] = children(node);
  if (!object || dot?.name !== '.' || property?.name !== 'PropertyName') return [];
  const base = dottedName(object);
  return base.length ? [...base, property] : [];
}

function targets(node: SyntaxNode): SyntaxNode[] {
  if (node.name === 'VariableName') return [node];
  if (['TupleExpression', 'ArrayExpression', 'ParenthesizedExpression'].includes(node.name)) {
    return children(node).flatMap(targets);
  }
  return [];
}

function bindingNames(node: SyntaxNode): SyntaxNode[] {
  if (scopes.has(node.name) && node.name !== 'Script') {
    const name = node.getChild('VariableName');
    return name ? [name] : [];
  }
  const boundary = bindingBoundaries.get(node.name);
  if (boundary) {
    const end = node.getChild(boundary)?.from ?? node.to;
    return children(node)
      .filter(token => token.to <= end)
      .flatMap(targets);
  }
  if (node.name === 'WithStatement' || node.name === 'TryStatement') {
    const items = children(node);
    return items.flatMap((item, index) =>
      item.name === 'as' && items[index + 1] ? targets(items[index + 1]) : []
    );
  }
  return [];
}

function parameterShadows(text: string, scope: SyntaxNode, name: string): boolean {
  const params = scope.getChild('ParamList');
  if (!params) return false;
  let binding = true;
  for (const item of children(params)) {
    if (item.name === ',') binding = true;
    if (item.name === 'VariableName' && binding) {
      if (text.slice(item.from, item.to) === name) return true;
      binding = false;
    } else if (item.name === 'AssignOp') {
      binding = false;
    }
  }
  return false;
}

type BindingEvent = { offset: number; query?: SourceQuery };

function scopeKey(node: SyntaxNode): string {
  return node.name + ':' + node.from + ':' + node.to;
}

export function importedReferences(text: string): ImportReference[] {
  const names: SyntaxNode[] = [];
  const scopesByName = new Map<string, Map<string, BindingEvent[]>>();
  parser.parse(text).iterate({
    enter({ node }) {
      if (node.name === 'VariableName' || node.name === 'PropertyName') {
        names.push(node);
        return;
      }
      const bindings: { alias: string; query?: SourceQuery }[] =
        node.name === 'ImportStatement'
          ? imports(text, node).bindings
          : bindingNames(node).map(name => ({ alias: text.slice(name.from, name.to) }));
      if (!bindings.length) return;
      const scope = scopeOf(node);
      if (!scope) return;
      const key = scopeKey(scope);
      const lookup = scopesByName.get(key) ?? new Map<string, BindingEvent[]>();
      for (const { alias, query } of bindings) {
        const events = lookup.get(alias) ?? [];
        events.push({ offset: node.from, query });
        lookup.set(alias, events);
      }
      scopesByName.set(key, lookup);
    },
  });

  function resolve(clicked: SyntaxNode): ImportReference | undefined {
    if (clicked.parent?.name === 'ImportStatement') {
      return imports(text, clicked.parent, clicked).reference;
    }
    if (clicked.parent && bindingNames(clicked.parent).some(name => same(name, clicked))) return;

    let expression = clicked;
    while (expression.parent?.name === 'MemberExpression') expression = expression.parent;
    const segments = dottedName(expression);
    const end = segments.findIndex(part => same(part, clicked));
    if (end < 0) return;
    const [root, ...properties] = segments
      .slice(0, end + 1)
      .map(part => text.slice(part.from, part.to));
    let scope = scopeOf(clicked);
    const inner = scope;
    for (; scope; scope = scopeOf(scope)) {
      // Methods do not use the enclosing class namespace for lexical lookup.
      if (scope.name === 'ClassDefinition' && scope !== inner) continue;
      if (parameterShadows(text, scope, root)) return;
      const events = scopesByName.get(scopeKey(scope))?.get(root);
      if (!events?.length) continue;
      const match = events.filter(entry => entry.offset < clicked.from).at(-1);
      const query = match
        ? match.query
        : scope.name === 'Script' && scope !== inner && events.length === 1
          ? events[0].query
          : undefined;
      if (!query) return;
      return selection(
        { module: query.module, members: [...query.members, ...properties] },
        clicked
      );
    }
  }

  return names.map(resolve).filter(reference => reference !== undefined);
}

export function referenceAt(
  references: ImportReference[],
  offset: number
): ImportReference | undefined {
  let low = 0;
  let high = references.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (references[middle].from <= offset) low = middle + 1;
    else high = middle;
  }
  const reference = references[low - 1];
  return reference && offset <= reference.to ? reference : undefined;
}

export function importedReference(text: string, offset: number): ImportReference | undefined {
  return referenceAt(importedReferences(text), offset);
}
