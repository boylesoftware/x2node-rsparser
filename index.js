/**
 * Database query result set parser module.
 *
 * @module x2node-rsparser
 * @requires module:x2node-common
 * @requires module:x2node-records
 * @implements {module:x2node-records.Extension}
 */
'use strict';

const common = require('x2node-common');

const ResultSetParser = require('./lib/result-set-parser.js');


/**
 * Value extractors registry.
 *
 * @private
 * @type {Object.<string,valueExtractor>}
 */
const VALUE_EXTRACTORS = {
	'string': function(val) {
		return (val === null ? null : String(val));
	},
	'number': function(val) {
		return (val === null ? null : Number(val));
	},
	'boolean': function(val) {
		return (val === null ? null : (val ? true : false));
	},
	'datetime': function(val) {
		return (val === null ? null : val.toISOString());
	},
	'isNull': function(val) {
		return (val === null);
	}
};


/////////////////////////////////////////////////////////////////////////////////
// Module
/////////////////////////////////////////////////////////////////////////////////

/**
 * Compatibility tag.
 *
 * @private
 * @constant {Symbol}
 */
const TAG = Symbol('X2NODE_RSPARSER');

/**
 * Tell if the provided object is supported by the module. Currently, only a
 * record types library instance can be tested using this function and it tells
 * if the library was constructed with the <code>x2node-rsparser</code>
 * extension.
 *
 * @param {*} obj Object to test.
 * @returns {boolean} <code>true</code> if supported by the rsparser module.
 */
exports.isSupported = function(obj) {

	return (obj[TAG] ? true : false);
};

/**
 * Get new result set parser. Before it can be used, the parser instance must be
 * initialized with the markup using
 * [init()]{@link module:x2node-rsparser~ResultSetParser#init} method.
 *
 * @param {module:x2node-records~RecordTypesLibrary} recordTypes Record types
 * library.
 * @param {string} topRecordTypeName Name of the record type, records of which
 * are being extracted from the result set.
 * @returns {module:x2node-rsparser~ResultSetParser} New uninitialized result set
 * parser.
 */
exports.getResultSetParser = function(recordTypes, topRecordTypeName) {

	if (!recordTypes[TAG])
		throw new common.X2UsageError(
			'Record types library does not have the rsparser extension.');

	return new ResultSetParser(recordTypes, VALUE_EXTRACTORS, topRecordTypeName);
};

/**
 * Result set column value extractor function.
 *
 * @callback valueExtractor
 * @param {*} rawVal Raw value returned by the underlying database driver.
 * @param {number} rowNum Current result set row number, starting from zero.
 * @param {number} colInd Column inder, starting from zero.
 * @returns {*} Value to be set in the resulting record object.
 */
/**
 * Register a custom result set column value extractor.
 *
 * @param {string} type Value type.
 * @param {module:x2node-rsparser~valueExtractor} extractorFunc Extractor
 * function.
 */
exports.registerValueExtractor = function(type, extractorFunc) {

	VALUE_EXTRACTORS[type] = extractorFunc;
};

/**
 * Call registered value extractor to convert raw database value into the record
 * property value.
 *
 * @param {string} type Value type.
 * @param {*} rawVal Raw value from the database.
 * @param {number} [rowNum=0] Optional result set row number.
 * @param {number} [colInd=0] Optional result set column index.
 * @returns {*} Corresponding value for the record property.
 */
exports.extractValue = function(type, rawVal, rowNum, colInd) {

	return VALUE_EXTRACTORS[type](rawVal, (rowNum || 0), (colInd || 0));
};


/////////////////////////////////////////////////////////////////////////////////
// Record Types Library Extension
/////////////////////////////////////////////////////////////////////////////////

// extend record types library
exports.extendRecordTypesLibrary = function(ctx, recordTypes) {

	// tag the library
	if (recordTypes[TAG])
		throw new common.X2UsageError(
			'The library is already extended by the rsparser module.');
	recordTypes[TAG] = true;

	// return it
	return recordTypes;
};

/**
 * Regular expression for parsing map key value type specifications.
 *
 * @private
 * @constant {RegExp}
 */
const KEY_VALUE_TYPE_RE = new RegExp(
	'^(string|number|boolean|datetime)|(ref)\\(([^|\\s]+)\\)$'
);

/**
 * <code>x2node-rsparser</code> module specific
 * [PropertyDescriptor]{@link module:x2node-records~PropertyDescriptor}
 * extension.
 *
 * @mixin PropertyDescriptorWithRSParser
 * @static
 */

/**
 * Get invalid property definition error.
 *
 * @private
 * @param {module:x2node-records~PropertyDescriptor} propDesc Property
 * descriptor.
 * @param {string} msg Error message.
 * @returns {module:x2node-common.X2UsageError} Error to throw.
 */
function invalidPropDef(propDesc, msg) {
	return new common.X2UsageError(
		'Property ' + propDesc.container.nestedPath + propDesc.name +
			' of record type ' + String(propDesc.container.recordTypeName) +
			' has invalid definition: ' + msg);
}

/**
 * Process key property name definition attribute and set the property
 * descriptor's key property value type and reference target accordingly.
 *
 * @private
 * @param {module:x2node-records~PropertyDescriptor} propDesc Map property
 * descriptor.
 * @param {module:x2node-records~PropertiesContainer} keyPropContainer Key
 * property container.
 */
function processKeyProperty(propDesc, keyPropContainer) {

	// get the key property descriptor
	const keyPropName = propDesc._keyPropertyName;
	if (!keyPropContainer.hasProperty(keyPropName))
		throw invalidPropDef(
			propDesc, 'key property ' + keyPropName +
				' not found among the target object properties.');
	const keyPropDesc = keyPropContainer.getPropertyDesc(keyPropName);

	// validate the key property type
	if (!keyPropDesc.isScalar() || (keyPropDesc.scalarValueType === 'object'))
		throw invalidPropDef(
			propDesc, 'key property ' + keyPropName +
				' is not suitable to be map key.');

	// set key value type in the map property descriptor
	propDesc._keyValueType = keyPropDesc.scalarValueType;
	if (keyPropDesc.isRef())
		propDesc._keyRefTarget = keyPropDesc.refTarget;
}

// extend property descriptors
exports.extendPropertyDescriptor = function(ctx, propDesc) {

	// get the definition
	const propDef = propDesc.definition;

	// validate nested object id property
	if (propDesc.scalarValueType === 'object') {
		if (propDesc.isArray() && !propDesc.isPolymorphRef())
			ctx.onLibraryValidation(() => {
				if (!propDesc.nestedProperties.idPropertyName)
					throw invalidPropDef(propDesc, 'missing id property.');
			});
		else if (!propDesc.isMap())
			ctx.onLibraryValidation(() => {
				if (propDesc.nestedProperties.idPropertyName)
					throw invalidPropDef(
						propDesc, 'may not have an id property.');
			});
	}

	// process map key attributes
	if (propDesc.isMap()) {
		if (propDef.keyPropertyName) {
			if (propDef.keyValueType)
				throw invalidPropDef(
					propDesc, 'cannot have both keyPropertyName and' +
						' keyValueType attributes.');
			propDesc._keyPropertyName = propDef.keyPropertyName;
			switch (propDesc.scalarValueType) {
			case 'object':
				if (propDesc.isPolymorphRef()) {
					ctx.onLibraryComplete(recordTypes => {
						let firstRefTargetDesc, firstKeyValueType;
						for (let refTarget of propDesc.refTargets) {
							if (!recordTypes.hasRecordType(refTarget))
								continue; // will be caught by the core
							const refTargetDesc = recordTypes.getRecordTypeDesc(
								refTarget);
							if (!refTargetDesc.hasProperty(
								propDesc.keyPropertyName))
								throw invalidPropDef(
									propDesc, 'key property ' +
										propDesc.keyPropertyName +
										' not found among record type ' +
										refTarget + ' properties.');
							const keyValueType = refTargetDesc.getPropertyDesc(
								propDesc.keyPropertyName).definition.valueType;
							if (!firstRefTargetDesc) {
								firstRefTargetDesc = refTargetDesc;
								firstKeyValueType = keyValueType;
							} else if (keyValueType !== firstKeyValueType) {
								throw invalidPropDef(
									propDesc, 'key property value type is' +
										' different in different target record' +
										' types.');
							}
						}
						if (firstRefTargetDesc)
							processKeyProperty(propDesc, firstRefTargetDesc);
					});
				} else { // nested object
					ctx.onContainerComplete(() => {
						processKeyProperty(propDesc, propDesc.nestedProperties);
					});
				}
				break;
			case 'ref':
				ctx.onLibraryComplete(() => {
					processKeyProperty(propDesc, propDesc.nestedProperties);
				});
			}
		} else if (propDef.keyValueType) { // do we have key value type?
			const m = KEY_VALUE_TYPE_RE.exec(propDef.keyValueType);
			if (m === null)
				throw invalidPropDef(propDesc, 'invalid keyValueType property.');
			if (m[1]) { // non-reference key
				propDesc._keyValueType = m[1];
			} else { // reference key
				propDesc._keyValueType = m[2];
				propDesc._keyRefTarget = m[3];
			}
		}
		ctx.onLibraryValidation(recordTypes => {
			if (!propDesc.keyValueType)
				throw invalidPropDef(
					propDesc, 'map key value type is not specified.');
			if (propDesc.keyValueType === 'object')
				throw invalidPropDef(
					propDesc, 'map key value type may not be object.');
			if (propDesc.keyValueType === 'ref') {
				if (!propDesc.keyRefTarget)
					throw invalidPropDef(
						propDesc, 'target record type of the reference' +
							' map key is not specified.');
				if (!recordTypes.hasRecordType(propDesc.keyRefTarget))
					throw invalidPropDef(
						propDesc, 'unknown reference map key target' +
							' record type.');
			}
		});
	}

	// add properties and methods to the descriptor:

	/**
	 * For a map property, scalar value type of the map key.
	 *
	 * @member {string=} module:x2node-rsparser~PropertyDescriptorWithRSParser#keyValueType
	 * @readonly
	 */
	Object.defineProperty(propDesc, 'keyValueType', {
		get() { return this._keyValueType; }
	});

	/**
	 * If <code>keyValueType</code> is a reference, the reference target record
	 * type name.
	 *
	 * @member {string=} module:x2node-rsparser~PropertyDescriptorWithRSParser#keyRefTarget
	 * @readonly
	 */
	Object.defineProperty(propDesc, 'keyRefTarget', {
		get() { return this._keyRefTarget; }
	});

	/**
	 * For a nested object or reference map property, name of the property in the
	 * nested object or the referred record that acts as the map key.
	 *
	 * @member {string=} module:x2node-rsparser~PropertyDescriptorWithRSParser#keyPropertyName
	 * @readonly
	 */
	Object.defineProperty(propDesc, 'keyPropertyName', {
		get() { return this._keyPropertyName; }
	});

	// return the descriptor
	return propDesc;
};
