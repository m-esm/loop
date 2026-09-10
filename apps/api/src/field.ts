import { BadRequestException } from '@nestjs/common';

export function field(body: unknown, key: string, limit: number): string {
  const value = body && typeof body === 'object' ? (body as Record<string, unknown>)[key] : undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > limit) {
    throw new BadRequestException(`${key} must be nonempty text of at most ${limit} characters`);
  }
  return value.trim();
}

export function roomId(value: unknown): string {
  if (value !== 'default') throw new BadRequestException('Unknown room');
  return value;
}
