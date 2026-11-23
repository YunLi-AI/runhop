import { importedReference, importedReferences, referenceAt } from '../remoteSources/imports';

function at(source: string, label: string) {
  return importedReference(source, source.lastIndexOf(label) + 1);
}

test('resolves dotted imports and aliased members', () => {
  const source = 'import numpy.random as rng\nrng.randint(1, 4)\n';
  expect(at(source, 'random')).toMatchObject({ module: 'numpy.random', members: [] });
  expect(at(source, 'randint')).toMatchObject({ module: 'numpy.random', members: ['randint'] });
});

test('resolves multiline from imports, relative imports and class methods', () => {
  const source = 'from ..pkg import (\n    Widget as Alias,\n)\nAlias.make(1)';
  expect(at(source, 'Widget')).toMatchObject({ module: '..pkg', members: ['Widget'] });
  expect(at(source, 'make')).toMatchObject({ module: '..pkg', members: ['Widget', 'make'] });
});

test('uses local imports in their scope and skips parameters, strings and comments', () => {
  const source = [
    'import top as dep',
    'def method(dep):',
    '    return dep.shadowed()',
    'def other():',
    '    import scoped as dep',
    '    return dep.inside()',
    'dep.outside()',
    'text = "dep.string"',
    '# dep.comment',
  ].join('\n');
  expect(at(source, 'shadowed')).toBeUndefined();
  expect(at(source, 'inside')).toMatchObject({ module: 'scoped', members: ['inside'] });
  expect(at(source, 'outside')).toMatchObject({ module: 'top', members: ['outside'] });
  expect(at(source, 'string')).toBeUndefined();
  expect(at(source, 'comment')).toBeUndefined();
});

test('keeps local reassignment and its later references out of remote navigation', () => {
  const source = 'import library as name\nname = object()\nname.method()';
  expect(at(source, 'method')).toBeUndefined();
  expect(importedReference(source, source.indexOf('name =') + 1)).toBeUndefined();
});

test('links the imported member while leaving a subsequent local loop binding alone', () => {
  const source = [
    'import library as dep',
    'dep.member()',
    'for dep, index in entries:',
    '    dep.local()',
  ].join('\n');
  const references = importedReferences(source);
  const memberStart = source.indexOf('member');
  expect(referenceAt(references, memberStart)).toEqual({
    module: 'library',
    members: ['member'],
    from: memberStart,
    to: memberStart + 'member'.length,
  });
  expect(referenceAt(references, source.indexOf('local'))).toBeUndefined();
});
