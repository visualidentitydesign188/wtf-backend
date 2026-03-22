import {
  expandAllowedSocketOrigins,
  normalizeSocketOrigin,
} from './socketio-cors.util';

describe('normalizeSocketOrigin', () => {
  it('trims, lowercases, strips trailing slashes', () => {
    expect(normalizeSocketOrigin('  HTTPS://AllThingsWTF.COM/  ')).toBe(
      'https://allthingswtf.com',
    );
  });
});

describe('expandAllowedSocketOrigins', () => {
  it('adds www when only apex is listed', () => {
    const set = expandAllowedSocketOrigins(['https://allthingswtf.com']);
    expect(set.has('https://allthingswtf.com')).toBe(true);
    expect(set.has('https://www.allthingswtf.com')).toBe(true);
  });

  it('adds apex when only www is listed', () => {
    const set = expandAllowedSocketOrigins(['https://www.allthingswtf.com']);
    expect(set.has('https://www.allthingswtf.com')).toBe(true);
    expect(set.has('https://allthingswtf.com')).toBe(true);
  });

  it('supports multiple domains', () => {
    const set = expandAllowedSocketOrigins([
      'https://a.example.com',
      'https://b.example.org',
    ]);
    expect(set.has('https://a.example.com')).toBe(true);
    expect(set.has('https://www.a.example.com')).toBe(true);
    expect(set.has('https://b.example.org')).toBe(true);
    expect(set.has('https://www.b.example.org')).toBe(true);
  });
});
