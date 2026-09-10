export type ComposerResult =
  | { kind: 'text'; text: string }
  | { kind: 'task'; title: string; definitionOfDone: string }
  | { kind: 'error'; code: 'empty' | 'unknown_command' | 'invalid_task'; message: string };

export function parseComposer(input: string): ComposerResult {
  const text = input.trim();
  if (!text) return { kind: 'error', code: 'empty', message: 'Write a message first.' };
  if (text.startsWith('//')) return { kind: 'text', text: text.slice(1) };
  if (!text.startsWith('/')) return { kind: 'text', text };
  if (!/^\/task(?:\s|$)/.test(text)) {
    return { kind: 'error', code: 'unknown_command', message: 'Unknown command. Use /task or escape a slash with //.' };
  }
  const content = text.slice(5).trim();
  const separator = content.indexOf('::');
  const title = (separator < 0 ? content : content.slice(0, separator)).trim();
  const definitionOfDone = separator < 0 ? title : content.slice(separator + 2).trim();
  if (!title || title.length > 200 || !definitionOfDone || definitionOfDone.length > 8000) {
    return { kind: 'error', code: 'invalid_task', message: 'Use /task <title> :: <done when>, with a title of at most 200 characters.' };
  }
  return { kind: 'task', title, definitionOfDone };
}
