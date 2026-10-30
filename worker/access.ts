// Cloudflare Access in front of a deployment. Access lets a request through only
// after the email PIN (or a service token) and adds a signed JWT. Checking that JWT
// here means the Worker never serves anything that didn't pass Access, even if a
// route or URL is ever exposed some other way. Enabled when ACCESS_AUD is set.

interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
}

let certs: { team: string; keys: Map<string, CryptoKey>; at: number } | null = null;

async function keysFor(team: string, kid: string): Promise<CryptoKey | null> {
  const fresh = certs && certs.team === team && Date.now() - certs.at < 3_600_000;
  if (!fresh || !certs!.keys.has(kid)) {
    const res = await fetch(`https://${team}/cdn-cgi/access/certs`);
    if (!res.ok) return null;
    const { keys } = (await res.json()) as { keys: Jwk[] };
    const map = new Map<string, CryptoKey>();
    for (const k of keys)
      map.set(k.kid, await crypto.subtle.importKey("jwk", { kty: k.kty, n: k.n, e: k.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
    certs = { team, keys: map, at: Date.now() };
  }
  return certs!.keys.get(kid) ?? null;
}

const b64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (ch) => ch.charCodeAt(0));

/** True when the request carries a valid Access JWT for this application. */
export async function passedAccess(request: Request, aud: string, team: string): Promise<boolean> {
  const jwt = request.headers.get("cf-access-jwt-assertion");
  if (!jwt) return false;
  const [h, p, sig] = jwt.split(".");
  if (!h || !p || !sig) return false;
  try {
    const header = JSON.parse(new TextDecoder().decode(b64url(h))) as { kid: string; alg: string };
    if (header.alg !== "RS256") return false;
    const key = await keysFor(team, header.kid);
    if (!key) return false;
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(sig), new TextEncoder().encode(`${h}.${p}`));
    if (!ok) return false;
    const claims = JSON.parse(new TextDecoder().decode(b64url(p))) as { aud: string | string[]; exp: number; iss: string };
    const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    return auds.includes(aud) && claims.exp * 1000 > Date.now() && claims.iss === `https://${team}`;
  } catch {
    return false;
  }
}
