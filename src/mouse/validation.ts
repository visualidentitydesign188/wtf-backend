import type { OperationType } from './mouse.service';

const VALID_OP_TYPES = new Set<OperationType>([
  'pencil',
  'sprayPaint',
  'fillColor',
  'eraser',
]);

const MAX_ID_LENGTH = 256;
const MAX_PATH_POINTS = 5000;
const MAX_SPRAY_POINTS = 10000;
const MAX_COLOR_LENGTH = 50;
const MIN_BRUSH_SIZE = 0.1;
const MAX_BRUSH_SIZE = 500;
const MAX_PAGE_LENGTH = 200;

export interface ValidationResult {
  valid: boolean;
  reason?: string;
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && !Number.isNaN(v) && Number.isFinite(v);
}

function isStr(v: unknown, maxLen: number): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= maxLen;
}

function isPoint(p: unknown): p is { x: number; y: number } {
  return (
    p !== null &&
    typeof p === 'object' &&
    isNum((p as any).x) &&
    isNum((p as any).y)
  );
}

function isPointArray(
  arr: unknown,
  maxLen: number,
): arr is Array<{ x: number; y: number }> {
  if (!Array.isArray(arr)) return false;
  if (arr.length > maxLen) return false;
  for (let i = 0; i < arr.length; i++) {
    if (!isPoint(arr[i])) return false;
  }
  return true;
}

function isColor(v: unknown): boolean {
  return typeof v === 'string' && v.length <= MAX_COLOR_LENGTH;
}

export function validateDrawOp(
  op: unknown,
  socketId: string,
): ValidationResult {
  if (!op || typeof op !== 'object') {
    return { valid: false, reason: 'Operation must be an object' };
  }
  const o = op as Record<string, unknown>;

  if (!isStr(o.id, MAX_ID_LENGTH)) {
    return { valid: false, reason: 'Invalid or missing id' };
  }

  if (typeof o.playerId !== 'string') {
    return { valid: false, reason: 'Missing playerId' };
  }

  if (!VALID_OP_TYPES.has(o.type as OperationType)) {
    return {
      valid: false,
      reason: `Invalid type: must be one of ${[...VALID_OP_TYPES].join(', ')}`,
    };
  }

  if (o.timestamp !== undefined && !isNum(o.timestamp)) {
    return { valid: false, reason: 'timestamp must be a number' };
  }

  if (!o.data || typeof o.data !== 'object') {
    return { valid: false, reason: 'Missing or invalid data object' };
  }

  const d = o.data as Record<string, unknown>;

  if (d.path !== undefined && !isPointArray(d.path, MAX_PATH_POINTS)) {
    return {
      valid: false,
      reason: `path must be an array of {x,y} with at most ${MAX_PATH_POINTS} points`,
    };
  }

  if (
    d.sprayPoints !== undefined &&
    !isPointArray(d.sprayPoints, MAX_SPRAY_POINTS)
  ) {
    return {
      valid: false,
      reason: `sprayPoints must be an array of {x,y} with at most ${MAX_SPRAY_POINTS} points`,
    };
  }

  if (d.fillPoint !== undefined && !isPoint(d.fillPoint)) {
    return { valid: false, reason: 'fillPoint must be {x: number, y: number}' };
  }

  if (d.color !== undefined && !isColor(d.color)) {
    return { valid: false, reason: 'Invalid color value' };
  }
  if (d.fillColor !== undefined && !isColor(d.fillColor)) {
    return { valid: false, reason: 'Invalid fillColor value' };
  }
  if (d.targetColor !== undefined && !isColor(d.targetColor)) {
    return { valid: false, reason: 'Invalid targetColor value' };
  }
  if (d.backgroundColor !== undefined && !isColor(d.backgroundColor)) {
    return { valid: false, reason: 'Invalid backgroundColor value' };
  }

  if (d.size !== undefined) {
    if (!isNum(d.size) || d.size < MIN_BRUSH_SIZE || d.size > MAX_BRUSH_SIZE) {
      return {
        valid: false,
        reason: `size must be between ${MIN_BRUSH_SIZE} and ${MAX_BRUSH_SIZE}`,
      };
    }
  }

  return { valid: true };
}

export function validateMovePointer(data: unknown): ValidationResult {
  if (!data || typeof data !== 'object') {
    return { valid: false, reason: 'Pointer data must be an object' };
  }
  const d = data as Record<string, unknown>;

  if (!isNum(d.x) || !isNum(d.y)) {
    return { valid: false, reason: 'x and y are required numbers' };
  }

  if (d.scrollX !== undefined && !isNum(d.scrollX)) {
    return { valid: false, reason: 'scrollX must be a number' };
  }
  if (d.scrollY !== undefined && !isNum(d.scrollY)) {
    return { valid: false, reason: 'scrollY must be a number' };
  }
  if (d.pageX !== undefined && !isNum(d.pageX)) {
    return { valid: false, reason: 'pageX must be a number' };
  }
  if (d.pageY !== undefined && !isNum(d.pageY)) {
    return { valid: false, reason: 'pageY must be a number' };
  }

  if (!isStr(d.current_page, MAX_PAGE_LENGTH)) {
    return { valid: false, reason: 'current_page is required (string)' };
  }

  return { valid: true };
}

export function validateResetOps(data: unknown): ValidationResult {
  if (data === undefined || data === null) return { valid: true };
  if (typeof data !== 'object') {
    return { valid: false, reason: 'Data must be an object' };
  }
  const d = data as Record<string, unknown>;
  if (d.userId !== undefined && !isStr(d.userId, MAX_ID_LENGTH)) {
    return { valid: false, reason: 'userId must be a string' };
  }
  return { valid: true };
}

/**
 * Pick only known pointer fields from client data to prevent
 * injection of extra fields into the broadcast payload.
 */
export function sanitizePointerData(data: Record<string, unknown>): {
  x: number;
  y: number;
  scrollX?: number;
  scrollY?: number;
  pageX?: number;
  pageY?: number;
  current_page: string;
} {
  const result: Record<string, unknown> = {
    x: data.x,
    y: data.y,
    current_page: data.current_page,
  };
  if (data.scrollX !== undefined) result.scrollX = data.scrollX;
  if (data.scrollY !== undefined) result.scrollY = data.scrollY;
  if (data.pageX !== undefined) result.pageX = data.pageX;
  if (data.pageY !== undefined) result.pageY = data.pageY;
  return result as any;
}
