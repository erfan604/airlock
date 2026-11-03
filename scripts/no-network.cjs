// AIR-228 / AIR-246: the strict shim. A process started with `node --require scripts/no-network.cjs` may listen but may not open any outbound
// TCP connection, loopback included. A connection to a local unix socket path is allowed: tsx talks to its own helper process over one, and a
// unix socket cannot leave the machine.
const net = require('node:net');
const original = net.Socket.prototype.connect;
net.Socket.prototype.connect = function connect(...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const isPath = typeof first === 'string' && Number.isNaN(Number(first)) ? true : first !== null && typeof first === 'object' && typeof first.path === 'string';
  if (isPath) return original.apply(this, args);
  throw new Error('network blocked');
};
