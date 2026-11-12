// Real road distance from an OSRM-compatible routing server (self-hosted, or a paid provider with the same API).
// Any failure returns null: the store's road factor (straight line x factor) is used instead, so ordering never stops.
export function osrmRoadKm(baseUrl: string, timeoutMs = 3000) {
  const base = baseUrl.replace(/\/$/, '');
  return async (from: { lat: number; lng: number }, to: { lat: number; lng: number }): Promise<number | null> => {
    const url = `${base}/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=false&alternatives=false`;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) return null;
      const j = await r.json() as { code?: string; routes?: Array<{ distance?: number }> };
      const m = j.code === 'Ok' ? j.routes?.[0]?.distance : undefined;
      return typeof m === 'number' && Number.isFinite(m) ? m / 1000 : null;
    } catch { return null; }
  };
}
