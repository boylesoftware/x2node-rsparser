'use strict';

const expect = require('chai').expect;

const rsparser = require('../index.js');

describe('x2node-rsparser', function() {
	describe('.isSupported()', function() {
		it('should return false for untagged object', function() {
			expect(rsparser.isSupported({})).to.be.false;
		});
	});
});
