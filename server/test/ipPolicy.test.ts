import { describe, expect, it } from 'vitest';
import { expandIPv6, isPublicIp } from '../src/services/ipPolicy.js';

describe('isPublicIp', () => {
  it.each([
    '127.0.0.1', '127.255.255.254', '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', '0.0.0.0', '100.64.0.1', '192.0.0.1', '192.0.2.5', '198.18.0.1', '198.51.100.1', '203.0.113.7',
    '224.0.0.1', '240.0.0.1', '255.255.255.255',
  ])('rejects IPv4 %s', (ip) => expect(isPublicIp(ip)).toBe(false));

  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '172.15.255.255', '100.63.255.255', '100.128.0.1', '11.0.0.1'])(
    'accepts public IPv4 %s',
    (ip) => expect(isPublicIp(ip)).toBe(true),
  );

  it.each([
    '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fe80::1%en0', 'fec0::1', 'ff02::1', '2001:db8::1', '2001::1',
    '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:192.168.0.1', '::ffff:7f00:1', '::127.0.0.1', '64:ff9b::7f00:1', '64:ff9b::10.0.0.1', '2002:7f00:1::1', '100::1',
  ])('rejects IPv6 %s', (ip) => expect(isPublicIp(ip)).toBe(false));

  it.each(['2606:4700:4700::1111', '2a00:1450:4001:80e::200e', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:0808:0808::1'])(
    'accepts public IPv6 %s',
    (ip) => expect(isPublicIp(ip)).toBe(true),
  );

  it('rejects garbage', () => {
    expect(isPublicIp('not-an-ip')).toBe(false);
    expect(isPublicIp('')).toBe(false);
    expect(isPublicIp('999.1.1.1')).toBe(false);
  });
});

describe('expandIPv6', () => {
  it('expands compressed forms', () => {
    expect(expandIPv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(expandIPv6('2001:db8::8:800:200c:417a')).toEqual([0x2001, 0xdb8, 0, 0, 8, 0x800, 0x200c, 0x417a]);
    expect(expandIPv6('::ffff:192.168.0.1')).toEqual([0, 0, 0, 0, 0, 0xffff, 0xc0a8, 1]);
  });
  it('returns null for malformed input', () => {
    expect(expandIPv6('1::2::3')).toBeNull();
    expect(expandIPv6('1:2:3')).toBeNull();
    expect(expandIPv6('::ffff:999.1.1.1')).toBeNull();
  });
});
