const dns = require('dns');
const dgram = require('dgram');
const net = require('net');
const debug = require('debug')('nameserver:client');
const Packet = require('nameserver-packet');


/**
 * Creates DNS/TCP connection to given server
 * @param host hostname of the server
 * @param port destination port of the server
 * @returns {Promise}
 */
function getTcpSocket(host, port) {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection(port, host, e => {
			if(e) {
				reject(e);
				debug('Failed to connect to %s:%d: ', host, port, e.message);
			} else {
				resolve(socket);
				debug('Connected to %s:%d', host, port);
			}
		});

		socket.on('error', e => {
			reject(e); // just in case the promise is still not resolved
			socket.end();
			debug('Error on TCP connection %s:%d: %s', host, port, e.message);
		});

		socket.on('closed', () => {
			reject(new Error('Connection has been closed')); // just in case the promise is still not resolved
			debug('TCP connection %s:%d has been closed', host, port);
		});

		socket.on('end', () => {
			reject(new Error('Connection has been ended')); // just in case the promise is still not resolved
			debug('TCP connection %s:%d has been ended', host, port);
		});

		let buffer, packetLength;

		socket.on('data', b => {

			buffer = buffer ? Buffer.concat([buffer, b]) : b;

			if(!packetLength) {
				if(buffer.length < 2) {
					return;
				}
				packetLength = buffer.readUInt16BE();
			}

			if(buffer.length >= packetLength + 2) {
				try {
					const packet = Packet.parse(buffer.slice(2, packetLength + 2));
					buffer = buffer.slice(packetLength);
					packetLength = undefined;
					debug('Received packet on TCP connection %s:%d', host, port);
					socket.emit('packet', packet);
				} catch(e) {
					reject(e); // just in case the promise is still not resolved
					socket.end();
					debug('Invalid packet on TCP connection %s:%d: %s', host, port, e.message);
				}
			}
		});
	});
}


/**
 * DNS client implementation
 * @param host {string} hostname of the DNS server to be queried
 * @param port {port} port number
 * @param packet {Packet} request packet
 * @param options {object}
 *  - timeout {number} timeout of the single UDP or TCP request in milliseconds
 * @returns {Packet} response packet
 */
module.exports = async function(host, port, packet, options) {

	if(options === null || options === undefined) {
		options = {};
	}

	const timeout = Number.isInteger(options.timeout) ? options.timeout : 3000;

	const { address, family } = await new Promise((resolve, reject) => {
		dns.lookup(host, (e, address, family) => {
			if(e){
				reject(e);
			} else {
				resolve({address, family});
			}
		})
	});

	const requestId = packet.id;
	const serializedPacket = Packet.serialize(packet);

	// Try UDP first

	const response = await new Promise((resolve, reject) => {

		const t = setTimeout(() => {
			socket.close();
			reject(new Error('Timeout'));
		}, timeout);

		const socket = dgram.createSocket('udp' + family, data => {
			const response = Packet.parse(data);
			if(response.id === requestId) {
				clearTimeout(t);
				socket.close();
				resolve(response);
			}
		});

		socket.send(serializedPacket, port, address, e => {
			if(e) {
				clearTimeout(t);
				socket.close();
				reject(e);
			}
		});
	});

	if(!response.truncated) {
		debug('DNS/UDP query to %s:%d resolved', host, port);
		return response;
	}

	// Try TCP if UDP message was truncated

	const socket = await getTcpSocket(address, port);

	return await new Promise((resolve, reject) => {
		const t = setTimeout(() => {
			debug('DNS/TCP timeout quering %s:%d', host, port);
			socket.end();
			reject(new Error('Timeout'));
		}, timeout);

		socket.on('packet', response => {
			if(response.id === packet.id) {
				debug('DNS/TCP query to %s:%d resolved', host, port);
				clearTimeout(t);
				socket.removeListener('packet', arguments.callee);
				resolve(response);
			}
		});

		const buffer = Packet.serialize(packet);
		const length = buffer.length;

		socket.write(Buffer.from([(length & 0xff00) >> 8, length & 0x00ff]));
		socket.write(buffer);
	});
};
