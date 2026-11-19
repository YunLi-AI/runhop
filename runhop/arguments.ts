import { quoteShell } from './paths';

export function formatArguments(args: string[]): string {
  return args.map(arg => (/^[^\s"'\\]+$/.test(arg) ? arg : quoteShell(arg))).join(' ');
}

export function parseArguments(input: string): string[] {
  const args: string[] = [];
  let quote: '"' | "'" | undefined;
  let argument = '';
  let started = false;
  for (let index = 0; index < input.length; index++) {
    const character = input[index];
    if (character === '\0') {
      throw new Error('Arguments cannot contain NUL characters.');
    }
    if (!quote && /\s/.test(character)) {
      if (started) {
        args.push(argument);
        argument = '';
        started = false;
      }
      continue;
    }
    started = true;
    if (character === quote) {
      quote = undefined;
    } else if (!quote && (character === '"' || character === "'")) {
      quote = character;
    } else if (character === '\\' && quote !== "'") {
      const next = input[index + 1];
      if (!next || next === '\0') {
        throw new Error('Finish the escape or quote the trailing backslash.');
      }
      if (!quote || next === '"' || next === '\\') {
        argument += next;
        index++;
      } else {
        argument += character;
      }
    } else {
      argument += character;
    }
  }
  if (quote) {
    throw new Error('Close the quoted argument.');
  }
  if (started) {
    args.push(argument);
  }
  return args;
}
