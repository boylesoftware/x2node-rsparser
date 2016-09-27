/**
 * RSMarkup module.
 *
 * @module rsmarkup
 */
'use strict';

/**
 * Invalid markup syntax.
 *
 * @extends Error
 */
class RSMarkupSyntaxError extends Error {

	constructor(message) {
		super();

		Error.captureStackTrace(this, this.constructor);

		this.name = 'RSMarkupSyntaxError';
		this.message = message;
	}
}

/**
 * Unexpected data in the result set row.
 *
 * @extends Error
 */
class RSMarkupDataError extends Error {

	constructor(message) {
		super();

		Error.captureStackTrace(this, this.constructor);

		this.name = 'RSMarkupDataError';
		this.message = message;
	}
}

/**
 * General module usage error, such as invalid arguments, inappropriate function
 * call, etc.
 *
 * @extends Error
 */
class RSMarkupUsageError extends Error {

	constructor(message) {
		super();

		Error.captureStackTrace(this, this.constructor);

		this.name = 'RSMarkupUsageError';
		this.message = message;
	}
}

/**
 * Invalid record type definition.
 *
 * @extends Error
 */
class RSMarkupRecordTypeError extends Error {

	constructor(message) {
		super();

		Error.captureStackTrace(this, this.constructor);

		this.name = 'RSMarkupRecordTypeError';
		this.message = message;
	}
}

/**
 * Result set parser.
 */
class RSParser {

	constructor(recordTypes, topRecordTypeName, options) {

		this._recordTypes = recordTypes;
		this._topRecordTypeName = topRecordTypeName;
		this._topRecordTypeDef = recordTypes[topRecordTypeName];
		if (!this._topRecordTypeDef)
			throw new RSMarkupUsageError(
				'Unknown record type "' + topRecordTypeName + '".');

		this._valueExtractors = {
			'string': function(val) { return val; },
			'number': function(val) { return val; },
			'boolean': function(val) {
				return (val === null ? null : (val ? true : false));
			},
			'datetime': function(val) { return val; },
			'isNull': function(val) { return (val === null); }
		};

		this._options = (options ? options : {});
		for (let n in this._options.valueExtractors)
			this._valueExtractors[n] = this._options.valueExtractors[n];

		this._columnHandlers = null;
	}

	/**
	 * Initialize parser with columns markup. A parser instance can be
	 * initialized only once. A parser must be initialized before result set rows
	 * can be fed to it.
	 *
	 * @param {string[]} markup Markup for each column in the result set.
	 *
	 * @throws {RSMarkupUsageError} If the parser has already been initialized or
	 * the specified <code>markup</code> argument is of invalid type.
	 * @throws {RSMarkupSyntaxError} If provided markup syntax is invalid.
	 * @throws {RSMarkupRecordTypeError} If invalid record type definitions were
	 * provided.
	 */
	init(markup) {

		// check if already initialized
		if (this._columnHandlers)
			throw new RSMarkupUsageError(
				'The parser has been already initialized.');

		// check the basic validity of the markup argument
		if (!Array.isArray(markup) || (markup.length < 1))
			throw new RSMarkupUsageError(
				'The markup definition must be an array of strings with at' +
					' least one element.');

		// save markup
		this._markup = markup;
		this._numColumns = markup.length;

		// create arrays for column handlers and states
		this._columnHandlers = [];
		this._columnHandlerStates = [];

		// parse the markup
		const lastColInd = this._parseObjectMarkup(
			0, null, {}, this._topRecordTypeDef.properties);
		if (lastColInd !== this._numColumns)
			throw new RSMarkupSyntaxError(
				'Markup column ' + lastColInd + ': unseen column prefix.');

		// create empty result objects
		this._records = [];
		this._referredRecords = {};

		// initialize row skipper
		this._skipNextNRows = 0;

		// initialize row counter
		this._rowsProcessed = 0;
	}

	_parseObjectMarkup(startColInd, parentPrefix, ctxObjectState, propDefs) {

		// determine object prefix
		const startColDef = this._markup[startColInd];
		let sepInd = startColDef.lastIndexOf('$');
		const objectPrefix = (
			sepInd >= 0 ? startColDef.substring(0, sepInd) : '');

		// make sure the prefix is different from the parent
		if (objectPrefix === parentPrefix)
			throw new RSMarkupSyntaxError(
				'Markup column ' + startColInd +
					': nested object prefix must be different from the parent' +
					' object prefix.');

		// single handlers by type
		const SINGLE_HANDLERS = {
			'string': this._handleSingleString,
			'number': this._handleSingleNumber,
			'boolean': this._handleSingleBoolean,
			'datetime': this._handleSingleDatetime
		};

		// parse and process column definitions
		let colInd = startColInd;
		do {

			// parse column definition
			const colDef = this._markup[colInd];
			let prefix, propName, fetchRef;
			sepInd = colDef.lastIndexOf('$');
			if (sepInd >= 0) {
				prefix = colDef.substring(0, sepInd);
				propName = colDef.substring(sepInd + 1);
			} else {
				prefix = '';
				propName = colDef;
			}
			if (fetchRef = propName.endsWith(':'))
				propName = propName.substring(0, propName.length - 1);

			// check if end of the object properties
			if (prefix !== objectPrefix)
				return colInd;

			// lookup property definition
			const propDef = propDefs[propName];
			if (!propDef)
				throw new RSMarkupSyntaxError(
					'Markup column ' + colInd + ': unknown property ' +
						propName + '.');

			// make sure the column is a reference if fetching
			const propType = propDef.valueType;
			if (fetchRef && !propType.startsWith('ref('))
				throw new RSMarkupRecordTypeError(
					'Markup column ' + colInd + ': property ' + propName +
						' is not a reference, cannot fetch it.');

			// create handler depending on the property type
			if (colInd === 0) {
				if (propDef.role !== 'id')
					throw new RSMarkupSyntaxError(
						'First column in the markup must refer to the record' +
							' id property.');
				if ((propType !== 'number') && (propType !== 'string'))
					throw new RSMarkupRecordTypeError(
						'Record id property value type may only be string or' +
							' number.');
				this._columnHandlers[colInd] = this._handleTopRecordId;
				this._columnHandlerStates[colInd] = {
					propName: propName,
					ctxObjectState: ctxObjectState,
					valueExtractor: this._valueExtractors[propType],
					lastValue: undefined,
					nextAnchor: -1
				};
				colInd++;

			} else if (
				(propType === 'string') || (propType === 'number') ||
					(propType === 'boolean') || (propType === 'datetime')
			) {
				this._columnHandlers[colInd] = SINGLE_HANDLERS[propType];
				this._columnHandlerStates[colInd] = {
					propName: propName,
					ctxObjectState: ctxObjectState
				};
				colInd++;

			} else if (propType === 'object') {
				this._columnHandlers[colInd] = this._handleSingleObject;
				const state = {
					propName: propName,
					ctxObjectState: ctxObjectState
				};
				this._columnHandlerStates[colInd] = state;
				if (++colInd < this._numColumns)
					colInd = this._parseObjectMarkup(
						colInd, objectPrefix, state, propDef.properties);
				state.nextColInd = colInd;

			} else if (propType === 'object?') {
				//...

			} /* TODO: more types */ else {
				throw new RSMarkupRecordTypeError(
					'Markup column ' + colInd + ': invalid markup syntax.');
			}

		} while (colInd < this._numColumns);

		// end of the markup
		return colInd;
	}

	_handleTopRecordId(state, val, rowNum) {

		const valToSet = state.valueExtractor(val, rowNum, 0, this._options);

		if (valToSet === null)
			throw new RSMarkupDataError(
				'Result set row ' + rowNum + ': top record id may not be null.');

		if (valToSet === state.lastValue) {
			if (state.nextAnchor < 0)
				throw new RSMarkupDataError(
					'Result set row ' + rowNum +
						': at least one anchor must change in each row.');
			return state.nextAnchor;
		}

		const record = new Object;
		state.ctxObjectState.record = record;
		this._records.push(record);

		record[state.propName] = valToSet;

		return 1;
	}

	_handleSingleString(state, val, rowNum, colInd) {

		return this._handleSingleValue('string', state, val, rowNum, colInd);
	}

	_handleSingleNumber(state, val, rowNum, colInd) {

		return this._handleSingleValue('number', state, val, rowNum, colInd);
	}

	_handleSingleBoolean(state, val, rowNum, colInd) {

		return this._handleSingleValue('boolean', state, val, rowNum, colInd);
	}

	_handleSingleDatetime(state, val, rowNum, colInd) {

		return this._handleSingleValue('datetime', state, val, rowNum, colInd);
	}

	_handleSingleValue(type, state, val, rowNum, colInd) {

		state.ctxObjectState.record[state.propName] =
			this._valueExtractors[type](val, rowNum, colInd, this._options);

		return colInd + 1;
	}

	_handleSingleObject(state, val, rowNum, colInd) {

		if (this._valueExtractors['isNull'](
			val, rowNum, colInd, this._options))
			return state.nextColInd;

		state.record = new Object();
		state.ctxObjectState.record[state.propName] = state.record;

		return colInd + 1;
	}

	merge(parser) {

		//...
	}

	reset() {

		//...
	}

	feedRow(row) {

		if (!this._columnHandlers)
			throw new RSMarkupUsageError('The parser has not been initialized.');

		const rowNum = this._rowsProcessed++;

		if (this._skipNextNRows > 0) {
			this._skipNextNRows--;
			return;
		}

		let colInd = 0;
		do {
			colInd = this._columnHandlers[colInd].call(
				this, this._columnHandlerStates[colInd],
				(
					this._options.rowAsArray ?
						row[colInd] : row[this._markup[colInd]]
				),
				rowNum, colInd);
		} while (colInd < this._numColumns);
	}

	get records() {

		return this._records;
	}

	get referredRecords() {

		return this._referredRecords;
	}
}

exports.createParser = function(
	recordTypes, topRecordTypeName, options, markup) {

	const parser = new RSParser(recordTypes, topRecordTypeName, options)

	if (markup)
		parser.init(markup);

	return parser;
};
