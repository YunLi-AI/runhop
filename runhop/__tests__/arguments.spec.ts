import { formatArguments, parseArguments } from '../arguments';

describe('RunHop script arguments', () => {
  it('preserves argument boundaries and leaves shell expressions as text', () => {
    expect(
      parseArguments(String.raw`--flag "/mnt/train data" '' a\ b "it's" $HOME $(uname)`)
    ).toEqual(['--flag', '/mnt/train data', '', 'a b', "it's", '$HOME', '$(uname)']);
  });

  it('reopens an argument list without changing literal values', () => {
    const args = ['', '한글', 'white space', String.raw`a\b`, `a"'b`, '\n', '--flag'];
    expect(parseArguments(formatArguments(args))).toEqual(args);
    expect(parseArguments('  ')).toEqual([]);
  });

  it('rejects incomplete quotes and escapes', () => {
    expect(() => parseArguments('"missing')).toThrow('Close the quoted argument.');
    expect(() => parseArguments('unfinished\\')).toThrow('Finish the escape');
    expect(() => parseArguments('leading\0trailing')).toThrow('NUL');
  });
});
