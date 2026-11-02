// AIR-246: the loopback variant of scripts/no-network.cjs, for the Vite preview process, whose proxy talks to the replay server. Any host other
// than 127.0.0.1, ::1 and localhost throws `network blocked: <host>`; a Unix socket path passes.
const net = require('node:net');
const ALLOWED = new Set(['127.0.0.1', '::1', 'localhost']);
const original = net.Socket.prototype.connect;
net.Socket.prototype.connect = function connect(...args) {
  const first = args[0];
  let options = first;
  if (Array.isArray(first)) options = first[0];
  if (typeof options === 'number') {
    const host = typeof args[1] === 'string' ? args[1] : 'localhost';
    if (!ALLOWED.has(host)) throw new Error(`network blocked: ${host}`);
  } else if (options !== null && typeof options === 'object') {
    if (typeof options.path === 'string' && options.port === undefined) return original.apply(this, args);
    const host = options.host === undefined ? 'localhost' : String(options.host);
    if (!ALLOWED.has(host)) throw new Error(`network blocked: ${host}`);
  } else if (typeof options === 'string') {
    return original.apply(this, args);
  }
  return original.apply(this, args);
};
