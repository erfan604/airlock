// AIR-228 / AIR-246: the strict shim. A process started with `node --require scripts/no-network.cjs` may listen but may not open any outbound
// connection, loopback included.
const net = require('node:net');
net.Socket.prototype.connect = function connect() {
  throw new Error('network blocked');
};
