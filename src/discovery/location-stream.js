// ONE BROWSER WATCH, HOWEVER MANY THINGS WANT A READING.
//
// Two separate choices in this application consume the same device stream: live location, which shows where a person is
// right now and keeps nothing, and trip recording, which deliberately keeps what it is given. They are independent
// decisions - either can be on without the other, and stopping one must never stop the other - but they must never open
// two competing browser watches. This is the single owner of the watch: the first consumer opens it, the last one to
// leave closes it, and every reading is delivered to whoever is listening at that moment.
//
// Nothing here decides anything about a reading: no filtering, no sampling, no storage. A consumer that wants to keep
// points applies its own rules; a consumer that only wants to display one does exactly that.
export function createLocationStream({ provider } = {}) {
  const consumers = new Map();
  let watch = null;
  let watches = 0;
  let nextToken = 0;
  const deliver = reading => {
    // A COPY OF THE LIST, so a consumer that leaves while a reading is being delivered cannot change who receives it.
    for (const handler of [...consumers.values()]) {
      try {
        handler(reading);
      } catch {
        // ONE CONSUMER'S FAILURE IS NOT ANOTHER'S: a view that throws must not stop a recording from receiving the next
        // reading. Nothing is logged - a reading carries a coordinate, and coordinates do not go to a console.
      }
    }
  };
  const open = () => {
    if (watch || !provider?.watch) return;
    watches += 1;
    watch = provider.watch(deliver);
  };
  const close = () => {
    watch?.stop?.();
    watch = null;
  };
  return Object.freeze({
    // A CONSUMER JOINS, AND THE WATCH STARTS IF IT WAS NOT ALREADY RUNNING. The handle leaves the stream and is
    // idempotent: leaving twice closes nothing twice, and the watch survives as long as somebody is still listening.
    subscribe(handler) {
      if (typeof handler !== 'function') return () => {};
      nextToken += 1;
      const token = nextToken;
      consumers.set(token, handler);
      open();
      let left = false;
      return () => {
        if (left) return;
        left = true;
        consumers.delete(token);
        if (!consumers.size) close();
      };
    },
    active: () => Boolean(watch),
    consumerCount: () => consumers.size,
    // How many browser watches this stream has opened in this session. It exists so a test can prove that two consumers
    // share one watch rather than opening two; the application never reads it.
    watchCount: () => watches,
    stopAll() { consumers.clear(); close(); },
  });
}
