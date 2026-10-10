// Generator runtime (DECISIONS D-014). Services `yield` port results; the runner feeds values back.
//   runSync  — Apps Script: adapters are synchronous; a yielded Promise is a programming error.
//   runAsync — Node.js: adapters may return Promises (pg); each is awaited in order.
// Nested services are composed with `yield*`.

function isThenable(v) {
  return !!v && (typeof v === 'object' || typeof v === 'function') && typeof v.then === 'function';
}

function toIterator(genOrFn, args) {
  const it = typeof genOrFn === 'function' ? genOrFn(...args) : genOrFn;
  if (!it || typeof it.next !== 'function') throw new Error('runtime: expected a generator');
  return it;
}

export function runSync(genOrFn, ...args) {
  const it = toIterator(genOrFn, args);
  let step = it.next();
  while (!step.done) {
    const v = step.value;
    if (isThenable(v)) {
      step = it.throw(new Error('runtime: asynchronous value yielded in synchronous runtime'));
      continue;
    }
    step = it.next(v);
  }
  return step.value;
}

export async function runAsync(genOrFn, ...args) {
  const it = toIterator(genOrFn, args);
  let step = it.next();
  while (!step.done) {
    let value;
    let failed = false;
    let error;
    try {
      value = isThenable(step.value) ? await step.value : step.value;
    } catch (e) {
      failed = true;
      error = e;
    }
    step = failed ? it.throw(error) : it.next(value);
  }
  return step.value;
}

/** Helper for services: resolve several port calls (sequentially; GAS has no parallel I/O). */
export function* all(values) {
  const out = [];
  for (const v of values) out.push(yield v);
  return out;
}
