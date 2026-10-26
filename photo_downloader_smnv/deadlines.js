// A single wall-clock ticker for offscreen deadlines. Runtime replies wake the
// document even when its own timers are throttled; no popup polling is needed.
export function createDeadlineClock({ sleep, now = Date.now }) {
  const pending = new Set();
  let ticking = false;
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      while (pending.size) {
        try { await sleep(500); }
        catch { await new Promise(resolve => setTimeout(resolve, 1000)); }
        const at = now();
        for (const item of [...pending]) {
          if (!pending.has(item) || item.at > at) continue;
          pending.delete(item); item.fire();
        }
      }
    } finally { ticking = false; }
  }
  return (fire, ms) => {
    const item = { fire, at: now() + ms };
    pending.add(item); void tick();
    return () => pending.delete(item);
  };
}
let schedule = (fire, ms) => {
  const timer = setTimeout(fire, ms);
  return () => clearTimeout(timer);
};
export function useBackgroundDeadlines(sleep) { schedule = createDeadlineClock({ sleep }); }
export function deadline(fire, ms) { return schedule(fire, ms); }
