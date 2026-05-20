/**
 * Rail-following route geometry from OpenStreetMap.
 *
 * The frontend heatmap draws `segment_paths.geometry`. In production that's a
 * GPS-traced polyline from the aggregator; the seed has no GPS, so without help
 * it falls back to straight station-to-station lines.
 *
 * This module downloads Portugal's railway network from OSM (Overpass), builds a
 * routable graph, and finds the real track path between two points — so seeded
 * segments curve along the actual rails, like production does.
 *
 * The Overpass response is cached on disk; routing failures fall back to a
 * straight line so the seed never breaks.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = path.join(__dirname, ".osm-rail-cache.json");

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const OVERPASS_QUERY = `[out:json][timeout:600];
area["ISO3166-1"="PT"][admin_level=2]->.pt;
way["railway"~"^(rail|narrow_gauge)$"](area.pt);
(._;>;);
out skel qt;`;

export type LonLat = [number, number];

interface OsmElement {
    type: string;
    id: number;
    lat?: number;
    lon?: number;
    nodes?: number[];
}

/** Metres between two lon/lat points. */
function haversineM(a: LonLat, b: LonLat): number {
    const toRad = (x: number) => (x * Math.PI) / 180;
    const R = 6371000;
    const dLat = toRad(b[1] - a[1]);
    const dLon = toRad(b[0] - a[0]);
    const h =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(a[1])) *
            Math.cos(toRad(b[1])) *
            Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
}

async function fetchOsmElements(): Promise<OsmElement[]> {
    try {
        const cached = await readFile(CACHE_FILE, "utf8");
        return JSON.parse(cached) as OsmElement[];
    } catch {
        // not cached — download below
    }
    const res = await fetch(OVERPASS_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            // Overpass rejects requests without a User-Agent with HTTP 406.
            "User-Agent":
                "comboios-history-scraper/0.1 (research, non-commercial)",
        },
        body: "data=" + encodeURIComponent(OVERPASS_QUERY),
        signal: AbortSignal.timeout(600_000),
    });
    if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
    const json = (await res.json()) as { elements: OsmElement[] };
    await writeFile(CACHE_FILE, JSON.stringify(json.elements));
    return json.elements;
}

/** Binary min-heap of [priority, nodeId] pairs. */
class MinHeap {
    private a: [number, number][] = [];
    get size(): number {
        return this.a.length;
    }
    push(item: [number, number]): void {
        const a = this.a;
        a.push(item);
        let i = a.length - 1;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (a[p][0] <= a[i][0]) break;
            [a[p], a[i]] = [a[i], a[p]];
            i = p;
        }
    }
    pop(): [number, number] | undefined {
        const a = this.a;
        if (a.length === 0) return undefined;
        const top = a[0];
        const last = a.pop()!;
        if (a.length > 0) {
            a[0] = last;
            let i = 0;
            for (;;) {
                const l = 2 * i + 1;
                const r = 2 * i + 2;
                let s = i;
                if (l < a.length && a[l][0] < a[s][0]) s = l;
                if (r < a.length && a[r][0] < a[s][0]) s = r;
                if (s === i) break;
                [a[s], a[i]] = [a[i], a[s]];
                i = s;
            }
        }
        return top;
    }
}

export interface RailRouter {
    /** Rail-following path between two points, or null if not routable. */
    route(from: LonLat, to: LonLat): LonLat[] | null;
}

/**
 * Build a router over Portugal's rail network. Returns null (caller falls back
 * to straight lines) if OSM is unavailable or the network can't be loaded.
 */
export async function buildRailRouter(): Promise<RailRouter | null> {
    let elements: OsmElement[];
    try {
        elements = await fetchOsmElements();
    } catch (err) {
        console.warn(
            JSON.stringify({
                msg: "rail OSM unavailable — straight lines",
                err: (err as Error).message,
            }),
        );
        return null;
    }

    const coord = new Map<number, LonLat>();
    for (const e of elements) {
        if (e.type === "node" && e.lat != null && e.lon != null) {
            coord.set(e.id, [e.lon, e.lat]);
        }
    }

    // Undirected weighted graph: rail nodes joined by consecutive way segments.
    const adj = new Map<number, { to: number; d: number }[]>();
    const edge = (a: number, b: number) => {
        const ca = coord.get(a);
        const cb = coord.get(b);
        if (!ca || !cb) return;
        const d = haversineM(ca, cb);
        let la = adj.get(a);
        if (!la) adj.set(a, (la = []));
        la.push({ to: b, d });
        let lb = adj.get(b);
        if (!lb) adj.set(b, (lb = []));
        lb.push({ to: a, d });
    };
    for (const e of elements) {
        if (e.type === "way" && e.nodes) {
            for (let i = 1; i < e.nodes.length; i++) {
                edge(e.nodes[i - 1], e.nodes[i]);
            }
        }
    }

    const graphNodes = [...adj.keys()];
    if (graphNodes.length === 0) return null;

    // Snap a point to the nearest rail node. Cheap planar approximation for the
    // comparison — exact metres only matter for the 4 km reject gate.
    const snapCache = new Map<string, number | null>();
    const nearest = (p: LonLat): number | null => {
        const key = p[0].toFixed(5) + "," + p[1].toFixed(5);
        const cached = snapCache.get(key);
        if (cached !== undefined) return cached;
        const cosLat = Math.cos((p[1] * Math.PI) / 180);
        let best = -1;
        let bestSq = Infinity;
        for (const id of graphNodes) {
            const c = coord.get(id)!;
            const dx = (c[0] - p[0]) * cosLat;
            const dy = c[1] - p[1];
            const sq = dx * dx + dy * dy;
            if (sq < bestSq) {
                bestSq = sq;
                best = id;
            }
        }
        const metres = Math.sqrt(bestSq) * 111_320;
        const result = best >= 0 && metres < 4000 ? best : null;
        snapCache.set(key, result);
        return result;
    };

    return {
        route(from, to) {
            const s = nearest(from);
            const t = nearest(to);
            if (s == null || t == null) return null;
            if (s === t) return [from, to];

            // Bound the search so a rail-disconnected pair doesn't sweep the
            // whole network before giving up.
            const cap = Math.max(20000, haversineM(from, to) * 4);

            const dist = new Map<number, number>([[s, 0]]);
            const prev = new Map<number, number>();
            const heap = new MinHeap();
            heap.push([0, s]);
            let found = false;

            while (heap.size > 0) {
                const [d, u] = heap.pop()!;
                if (d > (dist.get(u) ?? Infinity)) continue;
                if (u === t) {
                    found = true;
                    break;
                }
                if (d > cap) break;
                for (const e of adj.get(u) ?? []) {
                    const nd = d + e.d;
                    if (nd < (dist.get(e.to) ?? Infinity)) {
                        dist.set(e.to, nd);
                        prev.set(e.to, u);
                        heap.push([nd, e.to]);
                    }
                }
            }
            if (!found) return null;

            const path: LonLat[] = [];
            let cur: number | undefined = t;
            while (cur !== undefined) {
                path.push(coord.get(cur)!);
                cur = prev.get(cur);
            }
            path.reverse();
            // Anchor the ends to the real station coordinates.
            return [from, ...path, to];
        },
    };
}
