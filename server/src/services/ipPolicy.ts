import { isIPv4, isIPv6 } from 'node:net';

/**
 * Decides whether an IP address is an acceptable destination for server-side
 * fetches. Everything that is not globally routable is rejected: loopback,
 * private, link-local, CGNAT, multicast, documentation, reserved and the
 * unspecified address. IPv4-mapped / NAT64 IPv6 addresses are unwrapped and
 * checked as IPv4 so they cannot be used to smuggle a private target.
 */
export function isPublicIp(ip: string): boolean {
  if (isIPv4(ip)) return isPublicIPv4(ip);
  if (isIPv6(ip)) return isPublicIPv6(ip);
  return false;
}

function isPublicIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return false;
  const [a, b, c] = parts as [number, number, number, number];
  if (a === 0) return false; // 0.0.0.0/8 "this network"
  if (a === 10) return false; // private
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT 100.64/10
  if (a === 127) return false; // loopback
  if (a === 169 && b === 254) return false; // link-local (incl. cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return false; // private
  if (a === 192 && b === 0 && c === 0) return false; // IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return false; // TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return false; // 6to4 relay
  if (a === 192 && b === 168) return false; // private
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  if (a >= 224) return false; // multicast, reserved, broadcast
  return true;
}

function isPublicIPv6(ip: string): boolean {
  const groups = expandIPv6(ip);
  if (!groups) return false;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [number, number, number, number, number, number, number, number];
  const isZeroPrefix = (n: number) => groups.slice(0, n).every((g) => g === 0);

  // :: (unspecified) and ::1 (loopback)
  if (isZeroPrefix(7) && (g7 === 0 || g7 === 1)) return false;
  // ::ffff:a.b.c.d (IPv4-mapped) and ::a.b.c.d (IPv4-compatible, deprecated)
  if (isZeroPrefix(5) && (g5 === 0xffff || g5 === 0)) return isPublicIPv4(v4FromGroups(g6, g7));
  // 64:ff9b::/96 (NAT64)
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return isPublicIPv4(v4FromGroups(g6, g7));
  // 2002::/16 (6to4) – embedded IPv4 in g1,g2
  if (g0 === 0x2002) return isPublicIPv4(v4FromGroups(g1, g2));
  if ((g0 & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
  if ((g0 & 0xffc0) === 0xfec0) return false; // fec0::/10 site-local (deprecated)
  if ((g0 & 0xff00) === 0xff00) return false; // ff00::/8 multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return false; // documentation
  if (g0 === 0x2001 && g1 === 0) return false; // Teredo – could tunnel anywhere
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return false; // 100::/64 discard
  return true;
}

function v4FromGroups(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

/** Expands an IPv6 string into 8 16-bit groups, handling `::` and an embedded dotted IPv4 tail. */
export function expandIPv6(ip: string): number[] | null {
  let s = ip;
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);
  // Convert trailing dotted IPv4 to two hex groups.
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    if (!isIPv4(tail)) return null;
    const [a, b, c, d] = tail.split('.').map(Number) as [number, number, number, number];
    s = `${s.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  if (all.length !== 8) return null;
  const groups = all.map((h) => parseInt(h || '0', 16));
  return groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff) ? null : groups;
}
