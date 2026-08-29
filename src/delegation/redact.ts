import type { ExecEvent } from '../executors/types.js';

const SECRET_KEY = /(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|cookie|password|passwd|secret)/i;

export function redactText(input: string): string {
  return input
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]{8,}/gi, '$1[已隐藏]')
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/g, '[已隐藏]')
    .replace(/\b((?:api[_-]?key|token|password|passwd|secret|cookie)\s*[:=]\s*)[^\s,;"']+/gi, '$1[已隐藏]')
    .replace(/("(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|cookie|password|passwd|secret)"\s*:\s*")[^"]*(")/gi, '$1[已隐藏]$2');
}

export function redactValue(value: unknown, key = ''): unknown {
  if (SECRET_KEY.test(key)) return '[已隐藏]';
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      out[childKey] = redactValue(childValue, childKey);
    }
    return out;
  }
  return value;
}

export function redactEvent(event: ExecEvent): ExecEvent {
  return redactValue(event) as ExecEvent;
}
