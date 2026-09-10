import { BadRequestException } from '@nestjs/common';

export function field(body: unknown, key: string, limit: number): string {
  const value = body && typeof body === 'object' ? (body as Record<string, unknown>)[key] : undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > limit) {
    throw new BadRequestException(`${key} must be nonempty text of at most ${limit} characters`);
  }
  return value.trim();
}

export function optionalField(body: unknown, key: string, limit: number): string | undefined {
  const value = body && typeof body === 'object' ? (body as Record<string, unknown>)[key] : undefined;
  if (value === undefined) return undefined;
  return field(body, key, limit);
}

export function roomId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > 100) {
    throw new BadRequestException('Unknown room');
  }
  return value;
}

export function mentionName(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new BadRequestException('name must be letters, digits, hyphen, or underscore');
  }
  return value;
}
