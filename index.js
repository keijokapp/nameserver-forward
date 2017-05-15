const debug = require('debug')('nameserver:forward');
const client = require('./client');

/**
 * DNS forwarding middleware
 * @param forwarders {string|string[]} array of DNS server to forward requests to
 * @returns {Function}
 */
module.exports = function(forwarders) {
	forwarders = Array.isArray(forwarders) ? forwarders.slice(0) : [ forwarders ];

	return function(req, res, next) {
		function success(result) {
			res.packet.rcode = result.rcode;
			for(const answer of result.answer) {
				res.packet.answer.push(answer);
			}
			for(const authority of result.authority) {
				res.packet.authority.push(authority);
			}
			for(const additional of result.additional) {
				res.packet.additional.push(additional);
			}
			next();
		}

		const forwarderIterator = forwarders[Symbol.iterator]();

		function tryForward(i) {

			const next = forwarderIterator.next();

			if(next.done) {
				return Promise.reject(new Error('No more servers to try'));
			}

			debug('Trying server ' + next.value);
			return client(next.value, 53, req.packet)
				.catch(e => {
					debug('Quering server %s failed: %s', next.value, e.message);
					return tryForward(i + 1);
				});
		}

		tryForward(0)
			.then(success)
			.catch(e => {
				debug('No more servers to try');
				next(e);
			});
	}
};
