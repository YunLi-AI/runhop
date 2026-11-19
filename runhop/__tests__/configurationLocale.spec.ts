import {
  ConfigurationInputError,
  configurationLocale,
  configurationText,
} from '../configurationLocale';

describe('configuration language', () => {
  test.each([
    ['zh-cn', 'zh-CN'],
    ['zh-tw', 'zh-CN'],
    ['zh', 'zh-CN'],
    ['en', 'en'],
    ['ja', 'en'],
  ])('maps the VS Code language %s to %s', (vscodeLanguage, expected) => {
    expect(configurationLocale('auto', vscodeLanguage)).toBe(expected);
  });

  test('honors a manual selection regardless of the VS Code language', () => {
    expect(configurationLocale('en', 'zh-cn')).toBe('en');
    expect(configurationLocale('zh-CN', 'en')).toBe('zh-CN');
  });

  test('keeps configuration names and diagnostic text literal', () => {
    const error = new ConfigurationInputError('An entry already uses the name {0}.', 'Save {0}');
    expect(error.message).toBe('An entry already uses the name Save {0}.');
    expect(configurationText('zh-CN', error.template, ...error.values)).toBe(
      '名称「Save {0}」已被其他配置使用。'
    );
    expect(configurationText('zh-CN', 'ssh: connection refused')).toBe('ssh: connection refused');
    expect(configurationText('zh-CN', 'constructor')).toBe('constructor');
  });
});
