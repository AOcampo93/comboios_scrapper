// CP operates roughly 05:00 → 01:00 Lisbon time. We poll only inside that window;
// the 4-hour quiet period saves ~17% of requests and produces no useful data anyway.

const TZ = "Europe/Lisbon";

export function isOperatingHours(now: Date = new Date()): boolean {
    const fmt = new Intl.DateTimeFormat("en-GB", {
        timeZone: TZ,
        hour: "2-digit",
        hour12: false,
    });
    const part = fmt.formatToParts(now).find((p) => p.type === "hour");
    if (!part) return true;
    const hour = Number.parseInt(part.value, 10);
    // 05:00 inclusive → 01:00 exclusive (next day) === hour ∈ [5,23] ∪ [0,0]
    return hour >= 5 || hour < 1;
}
