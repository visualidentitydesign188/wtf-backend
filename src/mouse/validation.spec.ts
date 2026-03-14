import {
  validateDrawOp,
  validateMovePointer,
  validateResetOps,
  sanitizePointerData,
} from './validation';

describe('validateDrawOp', () => {
  const validOp = {
    id: 'op-1',
    playerId: 'socket-1',
    type: 'pencil',
    timestamp: Date.now(),
    data: { path: [{ x: 0, y: 0 }], color: '#000', size: 2 },
  };

  it('should accept a valid pencil operation', () => {
    expect(validateDrawOp(validOp, 'socket-1')).toEqual({ valid: true });
  });

  it('should accept all valid operation types', () => {
    for (const type of ['pencil', 'sprayPaint', 'fillColor', 'eraser']) {
      const op = { ...validOp, type };
      expect(validateDrawOp(op, 'socket-1').valid).toBe(true);
    }
  });

  it('should reject null/undefined/non-object', () => {
    expect(validateDrawOp(null, 's').valid).toBe(false);
    expect(validateDrawOp(undefined, 's').valid).toBe(false);
    expect(validateDrawOp('string', 's').valid).toBe(false);
  });

  it('should reject missing or empty id', () => {
    expect(validateDrawOp({ ...validOp, id: '' }, 'socket-1').valid).toBe(false);
    expect(validateDrawOp({ ...validOp, id: undefined }, 'socket-1').valid).toBe(false);
  });

  it('should reject id exceeding max length', () => {
    const longId = 'a'.repeat(257);
    expect(validateDrawOp({ ...validOp, id: longId }, 'socket-1').valid).toBe(false);
  });

  it('should reject missing playerId', () => {
    expect(
      validateDrawOp({ ...validOp, playerId: undefined }, 'socket-1').valid,
    ).toBe(false);
  });

  it('should reject invalid type', () => {
    expect(
      validateDrawOp({ ...validOp, type: 'laser' }, 'socket-1').valid,
    ).toBe(false);
  });

  it('should reject non-number timestamp', () => {
    expect(
      validateDrawOp({ ...validOp, timestamp: 'abc' }, 'socket-1').valid,
    ).toBe(false);
  });

  it('should accept missing timestamp', () => {
    const { timestamp, ...noTs } = validOp;
    expect(validateDrawOp(noTs, 'socket-1').valid).toBe(true);
  });

  it('should reject missing data', () => {
    expect(
      validateDrawOp({ ...validOp, data: undefined }, 'socket-1').valid,
    ).toBe(false);
    expect(
      validateDrawOp({ ...validOp, data: 'text' }, 'socket-1').valid,
    ).toBe(false);
  });

  it('should reject path exceeding max points', () => {
    const bigPath = Array.from({ length: 5001 }, (_, i) => ({ x: i, y: i }));
    const op = { ...validOp, data: { path: bigPath } };
    expect(validateDrawOp(op, 'socket-1').valid).toBe(false);
  });

  it('should accept path at max points', () => {
    const maxPath = Array.from({ length: 5000 }, (_, i) => ({ x: i, y: i }));
    const op = { ...validOp, data: { path: maxPath, color: '#000', size: 2 } };
    expect(validateDrawOp(op, 'socket-1').valid).toBe(true);
  });

  it('should reject path with invalid points', () => {
    const op = { ...validOp, data: { path: [{ x: 'a', y: 0 }] } };
    expect(validateDrawOp(op, 'socket-1').valid).toBe(false);
  });

  it('should reject sprayPoints exceeding max', () => {
    const big = Array.from({ length: 10001 }, (_, i) => ({ x: i, y: i }));
    const op = { ...validOp, data: { sprayPoints: big } };
    expect(validateDrawOp(op, 'socket-1').valid).toBe(false);
  });

  it('should reject invalid fillPoint', () => {
    const op = { ...validOp, data: { fillPoint: { x: 'a', y: 0 } } };
    expect(validateDrawOp(op, 'socket-1').valid).toBe(false);
  });

  it('should accept valid fillPoint', () => {
    const op = {
      ...validOp,
      type: 'fillColor',
      data: { fillPoint: { x: 10, y: 20 }, fillColor: '#f00' },
    };
    expect(validateDrawOp(op, 'socket-1').valid).toBe(true);
  });

  it('should reject color exceeding max length', () => {
    const op = { ...validOp, data: { color: 'a'.repeat(51) } };
    expect(validateDrawOp(op, 'socket-1').valid).toBe(false);
  });

  it('should reject size below min', () => {
    const op = { ...validOp, data: { size: 0 } };
    expect(validateDrawOp(op, 'socket-1').valid).toBe(false);
  });

  it('should reject size above max', () => {
    const op = { ...validOp, data: { size: 501 } };
    expect(validateDrawOp(op, 'socket-1').valid).toBe(false);
  });

  it('should reject NaN/Infinity in coordinates', () => {
    const op = { ...validOp, data: { path: [{ x: NaN, y: 0 }] } };
    expect(validateDrawOp(op, 'socket-1').valid).toBe(false);
    const op2 = { ...validOp, data: { path: [{ x: Infinity, y: 0 }] } };
    expect(validateDrawOp(op2, 'socket-1').valid).toBe(false);
  });

  it('should reject NaN/Infinity in size', () => {
    const op = { ...validOp, data: { size: NaN } };
    expect(validateDrawOp(op, 'socket-1').valid).toBe(false);
  });

  it('should accept operation with fillResult', () => {
    const op = {
      ...validOp,
      type: 'fillColor',
      data: { fillPoint: { x: 0, y: 0 }, fillResult: { cells: [1, 2, 3] } },
    };
    expect(validateDrawOp(op, 'socket-1').valid).toBe(true);
  });
});

describe('validateMovePointer', () => {
  it('should accept valid pointer data', () => {
    expect(
      validateMovePointer({ x: 10, y: 20, current_page: 'home' }),
    ).toEqual({ valid: true });
  });

  it('should accept with optional scroll fields', () => {
    expect(
      validateMovePointer({
        x: 10,
        y: 20,
        scrollX: 0,
        scrollY: 100,
        pageX: 10,
        pageY: 120,
        current_page: 'home',
      }),
    ).toEqual({ valid: true });
  });

  it('should reject null', () => {
    expect(validateMovePointer(null).valid).toBe(false);
  });

  it('should reject missing x or y', () => {
    expect(validateMovePointer({ y: 10, current_page: 'p' }).valid).toBe(false);
    expect(validateMovePointer({ x: 10, current_page: 'p' }).valid).toBe(false);
  });

  it('should reject non-number x/y', () => {
    expect(
      validateMovePointer({ x: 'a', y: 10, current_page: 'p' }).valid,
    ).toBe(false);
  });

  it('should reject non-number scrollX', () => {
    expect(
      validateMovePointer({ x: 0, y: 0, scrollX: 'a', current_page: 'p' })
        .valid,
    ).toBe(false);
  });

  it('should reject missing current_page', () => {
    expect(validateMovePointer({ x: 0, y: 0 }).valid).toBe(false);
  });

  it('should reject current_page exceeding max length', () => {
    expect(
      validateMovePointer({ x: 0, y: 0, current_page: 'a'.repeat(201) }).valid,
    ).toBe(false);
  });
});

describe('validateResetOps', () => {
  it('should accept empty object', () => {
    expect(validateResetOps({}).valid).toBe(true);
  });

  it('should accept null/undefined', () => {
    expect(validateResetOps(null).valid).toBe(true);
    expect(validateResetOps(undefined).valid).toBe(true);
  });

  it('should accept valid userId', () => {
    expect(validateResetOps({ userId: 'abc' }).valid).toBe(true);
  });

  it('should reject non-object', () => {
    expect(validateResetOps('string').valid).toBe(false);
  });

  it('should reject userId exceeding max length', () => {
    expect(validateResetOps({ userId: 'a'.repeat(257) }).valid).toBe(false);
  });
});

describe('sanitizePointerData', () => {
  it('should only include known fields', () => {
    const data = {
      x: 10,
      y: 20,
      scrollX: 5,
      current_page: 'home',
      malicious: '<script>alert(1)</script>',
      __proto__: { admin: true },
    };
    const result = sanitizePointerData(data);
    expect(result).toEqual({ x: 10, y: 20, scrollX: 5, current_page: 'home' });
    expect((result as any).malicious).toBeUndefined();
  });

  it('should omit optional fields when not provided', () => {
    const result = sanitizePointerData({ x: 1, y: 2, current_page: 'p' });
    expect(result).toEqual({ x: 1, y: 2, current_page: 'p' });
    expect('scrollX' in result).toBe(false);
  });
});
