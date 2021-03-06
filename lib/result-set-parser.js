'use strict';

const common = require('x2node-common');


/////////////////////////////////////////////////////////////////////////////////
// Handlers
/////////////////////////////////////////////////////////////////////////////////

/**
 * Result set column handler.
 *
 * @private
 * @memberof module:x2node-rsparser
 * @inner
 * @abstract
 */
class ColumnHandler {

	constructor(colInd, parser) {

		this._colInd = colInd;
		this._parser = parser;
		this._columnHandlers = parser.columnHandlers;
	}

	reset() { /* nothing */ }

	toString() {
		return `${this.constructor.name} at col ${this._colInd}`;
	}
}

/**
 * Result set anchor column handler.
 *
 * @private
 * @memberof module:x2node-rsparser
 * @inner
 * @extends module:x2node-rsparser~ColumnHandler
 * @abstract
 */
class AnchorColumnHandler extends ColumnHandler {

	constructor(colInd, parser) {
		super(colInd, parser);

		this._nextAnchor = -1;
	}

	setNextAnchor(nextAnchor) {

		if (this._nextAnchor >= 0)
			throw new common.X2SyntaxError(
				'More than one collection axis at column ' + nextAnchor +
					': anchor at column ' + this._colInd + ' already has' +
					' a child anchor at column ' + this._nextAnchor + '.');

		this._nextAnchor = nextAnchor;
	}

	emptyChildAnchors(upperColInd) {

		if ((this._nextAnchor > 0) && (this._nextAnchor < upperColInd))
			this._columnHandlers[this._nextAnchor].empty(upperColInd);
	}
}

/**
 * Result set map key column handler.
 *
 * @private
 * @memberof module:x2node-rsparser
 * @inner
 * @extends module:x2node-rsparser~AnchorColumnHandler
 * @abstract
 */
class MapKeyColumnHandler extends AnchorColumnHandler {

	constructor(colInd, parser, propDesc) {
		super(colInd, parser);

		if (propDesc.keyValueType === 'ref') {
			const keyRefTarget = propDesc.keyRefTarget;
			const refRecordTypeDesc = parser.recordTypes.getRecordTypeDesc(
				keyRefTarget);
			const rawKeyValueExtractor = parser.valueExtractors[
				refRecordTypeDesc.getPropertyDesc(
					refRecordTypeDesc.idPropertyName).scalarValueType];
			this._keyValueExtractor = function(rawVal, rowNum, colInd) {
				const val = rawKeyValueExtractor(rawVal, rowNum, colInd);
				return (val === null ? null : keyRefTarget + '#' + String(val));
			};
		} else {
			const rawKeyValueExtractor = parser.valueExtractors[
				propDesc.keyValueType];
			this._keyValueExtractor = function(rawVal, rowNum, colInd) {
				const val = rawKeyValueExtractor(rawVal, rowNum, colInd);
				return (val === null ? null : String(val));
			};
		}
	}
}

/**
 * Root column handler. Technically it is not a column handler because it is not
 * associated with any column, but plays the role of the parent handler for the
 * top record id column handler.
 *
 * @private
 * @memberof module:x2node-rsparser
 * @inner
 * @extends module:x2node-rsparser~ColumnHandler
 */
class RootHandler extends ColumnHandler {

	constructor(parser) {
		super(-1, parser);

		this.reset();
	}

	reset() {

		this._curRecord = null;
	}

	addNewRecord() {

		this._curRecord = this._parser.addNewRecord();
	}

	setObjectProperty(propName, val) {

		this._curRecord[propName] = val;
	}

	getObjectProperty(propName) {

		return this._curRecord[propName];
	}

	isPropertySet(propName) {

		return (this._curRecord[propName] !== undefined);
	}
}

/**
 * Top record id column handler. Always associated with the first column in the
 * result set.
 *
 * @private
 * @memberof module:x2node-rsparser
 * @inner
 * @extends module:x2node-rsparser~AnchorColumnHandler
 */
class TopRecordIdHandler extends AnchorColumnHandler {

	constructor(rootHandler, propDesc, parser) {
		super(0, parser);

		if (!propDesc.isId())
			throw new common.X2SyntaxError(
				'First column in the markup must refer to the record id' +
					' property.');

		this._rootHandler = rootHandler;
		this._propName = propDesc.name;
		this._valueExtractor = parser.valueExtractors[propDesc.scalarValueType];

		this.reset();
	}

	reset() {

		this._lastValue = undefined;
	}

	execute(rowNum, rawVal) {

		// get the record id value
		const val = this._valueExtractor(rawVal, rowNum, 0);
		if (val === null)
			throw new common.X2DataError(
				'Result set row ' + rowNum + ': top record id may not be null.');

		// check if same record
		if (val === this._lastValue) {

			// can't be same record if this is the only anchor
			if (this._nextAnchor < 0)
				throw this._parser.invalidData(
					0, 'at least one anchor must change in each row.');

			// skip to the next anchor column
			return this._nextAnchor;
		}

		// update last value
		this._lastValue = val;

		// reset the down chain
		this._parser.resetChain(0);

		// add new top record
		this._rootHandler.addNewRecord();

		// set the id property
		this._rootHandler.setObjectProperty(this._propName, val);

		// go to the next column
		return 1;
	}
}

/**
 * Simple single value property column handler.
 *
 * @private
 * @memberof module:x2node-rsparser
 * @inner
 * @extends module:x2node-rsparser~ColumnHandler
 */
class SingleValueHandler extends ColumnHandler {

	constructor(colInd, parentHandler, propDesc, parser) {
		super(colInd, parser);

		this._parentHandler = parentHandler;
		this._propName = propDesc.name;
		this._valueExtractor = parser.valueExtractors[propDesc.scalarValueType];
		this._noNulls = !propDesc.optional;
	}

	execute(rowNum, rawVal) {

		// get the value to set
		const val = this._valueExtractor(rawVal, rowNum, this._colInd);

		// set the property in the context object
		if (val !== null)
			this._parentHandler.setObjectProperty(this._propName, val);
		else if (this._noNulls)
			throw this._parser.invalidData(
				this._colInd, 'unexpected NULL for property ' + this._propName +
					' that is not optional.');

		// go to the next column
		return this._colInd + 1;
	}
}

/**
 * Single nested object property column handler.
 *
 * @private
 * @memberof module:x2node-rsparser
 * @inner
 * @extends module:x2node-rsparser~ColumnHandler
 */
class SingleObjectHandler extends ColumnHandler {

	constructor(colInd, anchorHandler, parentHandler, propDesc, parser) {
		super(colInd, parser);

		this._anchorHandler = anchorHandler;
		this._parentHandler = parentHandler;
		this._propDesc = propDesc;
		this._propName = propDesc.name;
		this._nullChecker = parser.valueExtractors['isNull'];
		this._noNulls = !propDesc.optional;

		this._nextColInd = undefined;

		this.reset();
	}

	setNextColumnIndex(nextColInd) {

		this._nextColInd = nextColInd;
	}

	reset() {

		this._curObject = null;
	}

	execute(rowNum, rawVal) {

		// skip the object property columns if no object
		if (this._nullChecker(rawVal, rowNum, this._colInd)) {
			if (this._noNulls)
				throw this._parser.invalidData(
					this._colInd, 'unexpected NULL for property ' +
						this._propName + ' that is not optional.');
			this._anchorHandler.emptyChildAnchors(this._nextColInd);
			return this._nextColInd;
		}

		// create new object
		this._curObject = this._propDesc.nestedProperties.newRecord();

		// set the property in the parent object
		this._parentHandler.setObjectProperty(this._propName, this._curObject);

		// go to the next column
		return this._colInd + 1;
	}

	setObjectProperty(propName, val) {

		this._curObject[propName] = val;
	}

	getObjectProperty(propName) {

		return this._curObject[propName];
	}

	isPropertySet(propName) {

		return (this._curObject[propName] !== undefined);
	}
}

/**
 * Handler of the polymorphic nested object subtype column.
 *
 * @private
 * @memberof module:x2node-rsparser
 * @inner
 * @extends module:x2node-rsparser~ColumnHandler
 */
class PolymorphicObjectTypeHandler extends ColumnHandler {

	constructor(colInd, anchorHandler, parentHandler, propDesc, parser) {
		super(colInd, parser);

		this._anchorHandler = anchorHandler;
		this._parentHandler = parentHandler;
		this._propDesc = propDesc;
		this._type = propDesc.name;
		this._typePropName = propDesc.container.typePropertyName;
		this._nullChecker = parser.valueExtractors['isNull'];

		this._nextColInd = undefined;
		this._last = true;
	}

	setNextColumnIndex(nextColInd) {

		this._nextColInd = nextColInd;
	}

	makeNotLast() {

		this._last = false;
	}

	execute(rowNum, rawVal) {

		// skip the object property columns if no object
		if (this._nullChecker(rawVal, rowNum, this._colInd)) {
			if (this._last &&
				!this._parentHandler.isPropertySet(this._typePropName))
				throw this._parser.invalidData(
					this._colInd, 'no polymorphic object value.');
			this._anchorHandler.emptyChildAnchors(this._nextColInd);
			return this._nextColInd;
		}

		// set the type property
		const prevType = this._parentHandler.getObjectProperty(
			this._typePropName);
		if ((prevType !== undefined) && (prevType !== this._type))
			throw this._parser.invalidData(
				this._colInd, 'more than one value for a polymorphic object.');
		this._parentHandler.setObjectProperty(this._typePropName, this._type);

		// go to the next column
		return this._colInd + 1;
	}

	setObjectProperty(propName, val) {

		this._parentHandler.setObjectProperty(propName, val);
	}

	getObjectProperty(propName) {

		return this._parentHandler.getObjectProperty(propName);
	}

	isPropertySet(propName) {

		return this._parentHandler.isPropertySet(propName);
	}
}

/**
 * Single reference property column handler.
 *
 * @private
 * @memberof module:x2node-rsparser
 * @inner
 * @extends module:x2node-rsparser~ColumnHandler
 */
class SingleRefHandler extends ColumnHandler {

	constructor(colInd, parentHandler, propDesc, parser, last) {
		super(colInd, parser);

		this._parentHandler = parentHandler;
		this._propName = propDesc.name;
		this._referredRecordTypeName = propDesc.refTarget;
		const refRecordTypeDesc = parser.recordTypes.getRecordTypeDesc(
			this._referredRecordTypeName);
		this._valueExtractor = parser.valueExtractors[
			refRecordTypeDesc.getPropertyDesc(refRecordTypeDesc.idPropertyName)
				.scalarValueType];
		this._noNulls = !propDesc.optional;

		this._last = last;
	}

	makeNotLast() {

		this._last = false;
	}

	execute(rowNum, rawVal) {

		// get referred record id
		const referredRecId = this._valueExtractor(rawVal, rowNum, this._colInd);

		// set the property in the context object
		if (referredRecId !== null)
			this._parentHandler.setObjectProperty(
				this._propName,
				this._referredRecordTypeName + '#' + referredRecId);
		else if (this._noNulls)
			throw this._parser.invalidData(
				this._colInd, 'unexpected NULL for property ' + this._propName +
					' that is not optional.');
		else if (this._last && !this._parentHandler.isPropertySet(
			this._propName))
			throw this._parser.invalidData(
				this._colInd, 'no value for polymorphic reference.');

		// go to the next column
		return this._colInd + 1;
	}
}

/**
 * Single polymorphic reference property column handler.
 *
 * @private
 * @memberof module:x2node-rsparser
 * @inner
 * @extends module:x2node-rsparser~ColumnHandler
 */
class SinglePolymorphicRefHandler extends ColumnHandler {

	constructor(colInd, anchorHandler, parentHandler, propDesc, parser) {
		super(colInd, parser);

		this._anchorHandler = anchorHandler;
		this._parentHandler = parentHandler;
		this._propName = propDesc.name;
		this._nullChecker = parser.valueExtractors['isNull'];
		this._noNulls = !propDesc.optional;

		this._nextColInd = undefined;
	}

	setNextColumnIndex(nextColInd) {

		this._nextColInd = nextColInd;
	}

	execute(rowNum, rawVal) {

		// skip the pseudo-object property columns if no object
		if (this._nullChecker(rawVal, rowNum, this._colInd)) {
			if (this._noNulls)
				throw this._parser.invalidData(
					this._colInd, 'unexpected NULL for property ' +
						this._propName + ' that is not optional.');
			this._anchorHandler.emptyChildAnchors(this._nextColInd);
			return this._nextColInd;
		}

		// go to the next column
		return this._colInd + 1;
	}

	setObjectProperty(propName, val) {

		if (this._parentHandler.isPropertySet(this._propName))
			throw this._parser.invalidData(
				this._colInd, 'more than one value for a polymoprhic' +
					' reference.');

		this._parentHandler.setObjectProperty(this._propName, val);
	}

	getObjectProperty() {

		return this._parentHandler.getObjectProperty(this._propName);
	}

	isPropertySet() {

		return this._parentHandler.isPropertySet(this._propName);
	}
}

/**
 * Single fetched reference property column handler.
 *
 * @private
 * @memberof module:x2node-rsparser
 * @inner
 * @extends module:x2node-rsparser~ColumnHandler
 */
class SingleFetchedRefHandler extends ColumnHandler {

	constructor(colInd, anchorHandler, parentHandler, propDesc, parser, last) {
		super(colInd, parser);

		this._anchorHandler = anchorHandler;
		this._parentHandler = parentHandler;
		this._propName = propDesc.name;
		this._referredRecordTypeName = propDesc.refTarget;
		this._referredRecordTypeDesc = parser.recordTypes.getRecordTypeDesc(
			this._referredRecordTypeName);
		this._valueExtractor = parser.valueExtractors[
			this._referredRecordTypeDesc.getPropertyDesc(
				this._referredRecordTypeDesc.idPropertyName).scalarValueType];
		this._noNulls = !propDesc.optional;

		this._nextColInd = undefined;
		this._last = last;

		this.reset();
	}

	setNextColumnIndex(nextColInd) {

		this._nextColInd = nextColInd;
	}

	makeNotLast() {

		this._last = false;
	}

	reset() {

		if (this._curObject)
			this._parser.endReferredRecord(this._colInd, this._noSkip);

		this._curObject = null;
	}

	execute(rowNum, rawVal) {

		// get referred record id
		const referredRecId = this._valueExtractor(rawVal, rowNum, this._colInd);

		// skip the referred record property columns if no record
		if (referredRecId === null) {
			if (this._noNulls)
				throw this._parser.invalidData(
					this._colInd, 'unexpected NULL for property ' +
						this._propName + ' that is not optional.');
			if (this._last && !this._parentHandler.isPropertySet(this._propName))
				throw this._parser.invalidData(
					this._colInd, 'no value for polymorphic reference.');
			this._anchorHandler.emptyChildAnchors(this._nextColInd);
			return this._nextColInd;
		}

		// set the property in the context object
		const refVal = this._referredRecordTypeName + '#' + referredRecId;
		this._parentHandler.setObjectProperty(this._propName, refVal);

		// create new referred record object
		const noSkip = (
			this._noSkip || (this._noSkip = (
				this._nextColInd < this._columnHandlers.length))
		);
		this._curObject = this._parser.beginReferredRecord(
			this._referredRecordTypeDesc, refVal, this._colInd, noSkip);
		if (this._curObject === null)
			return this._nextColInd;

		// go to the next column
		return this._colInd + 1;
	}

	setObjectProperty(propName, val) {

		this._curObject[propName] = val;
	}

	getObjectProperty(propName) {

		return this._curObject[propName];
	}

	isPropertySet(propName) {

		return (this._curObject[propName] !== undefined);
	}
}

/**
 * Single row element array anchor column handler.
 *
 * @private
 * @memberof module:x2node-rsparser
 * @inner
 * @extends module:x2node-rsparser~AnchorColumnHandler
 */
class ArraySingleRowAnchorHandler extends AnchorColumnHandler {

	constructor(colInd, parentHandler, propDesc, parser) {
		super(colInd, parser);

		this._parentHandler = parentHandler;
		this._propName = propDesc.name;
		this._nullChecker = parser.valueExtractors['isNull'];
		this._noNulls = !propDesc.optional;

		this.reset();
	}

	reset() {

		this._anchored = false;
		this._curArray = null;
	}

	execute(rowNum, rawVal) {

		// check if anchor is null
		const nullAnchor = this._nullChecker(rawVal, rowNum, this._colInd);

		// check if already has context array
		if (this._anchored) {
			if (nullAnchor)
				throw this._parser.invalidData(
					this._colInd, 'unexpected NULL in the anchor column.');
			return this._colInd + 1;
		}

		// make anchored
		this._anchored = true;

		// skip the elements if no array
		if (nullAnchor) {
			if (this._noNulls)
				throw this._parser.invalidData(
					this._colInd, 'unexpected NULL for property ' +
						this._propName + ' that is not optional.');
			return this._colInd + 2; // note: should always be last
		}

		// create new array and set it in the context object
		this._curArray = new Array();
		this._parentHandler.setObjectProperty(this._propName, this._curArray);

		// proceed to the value column
		return this._colInd + 1;
	}

	empty() {

		this._anchored = true;
	}

	addElement(val) {

		this._curArray.push(val);
	}
}

/**
 * Single row element map anchor column handler.
 *
 * @private
 * @memberof module:x2node-rsparser
 * @inner
 * @extends module:x2node-rsparser~MapKeyColumnHandler
 */
class MapSingleRowAnchorHandler extends MapKeyColumnHandler {

	constructor(colInd, parentHandler, propDesc, parser) {
		super(colInd, parser, propDesc);

		this._parentHandler = parentHandler;
		this._propName = propDesc.name;
		this._noNulls = !propDesc.optional;

		this.reset();
	}

	reset() {

		this._lastKeyVal = undefined;
		this._curMap = null;
	}

	execute(rowNum, rawVal) {

		// get the key value
		const keyVal = this._keyValueExtractor(rawVal, rowNum, this._colInd);

		// check if the key is null
		if (keyVal === null) {

			// anchors must change
			if (this._lastKeyVal === null)
				throw this._parser.invalidData(
					this._colInd, 'repeated NULL in the map key column.');

			// can't be in the middle of a map
			if (this._lastKeyVal !== undefined)
				throw this._parser.invalidData(
					this._colInd, 'unexpected NULL in the map key column.');

			// check if the property is not optional
			if (this._noNulls)
				throw this._parser.invalidData(
					this._colInd, 'unexpected NULL for property ' +
						this._propName + ' that is not optional.');

			// update the last key value
			this._lastKeyVal = null;

			// skip the value
			return this._colInd + 2; // note: should always be last
		}

		// make sure we've got a new key
		if ((this._lastKeyVal === null) || (keyVal === this._lastKeyVal))
			throw this._parser.invalidData(
				this._colInd, 'at least one anchor must change in each row.');

		// create new map
		if (this._lastKeyVal === undefined) {
			this._curMap = new Object();
			this._parentHandler.setObjectProperty(this._propName, this._curMap);
		}

		// update the last key value
		this._lastKeyVal = keyVal;

		// proceed to the value column
		return this._colInd + 1;
	}

	empty() {

		this._lastKeyVal = null;
	}

	addElement(val) {

		if (val !== null)
			this._curMap[this._lastKeyVal] = val;
	}
}

/**
 * Single row element array or map value column handler.
 *
 * @private
 * @memberof module:x2node-rsparser
 * @inner
 * @extends module:x2node-rsparser~ColumnHandler
 */
class SingleRowValueHandler extends ColumnHandler {

	constructor(colInd, anchorHandler, propDesc, parser) {
		super(colInd, parser);

		this._anchorHandler = anchorHandler;
		this._valueExtractor = parser.valueExtractors[propDesc.scalarValueType];
	}

	execute(rowNum, rawVal) {

		// add value to the context array
		this._anchorHandler.addElement(
			this._valueExtractor(rawVal, rowNum, this._colInd));

		// go to the next column (always last)
		return this._colInd + 1;
	}
}

/**
 * Single row element array or map reference value column handler.
 *
 * @private
 * @memberof module:x2node-rsparser
 * @inner
 * @extends module:x2node-rsparser~ColumnHandler
 */
class SingleRowRefHandler extends ColumnHandler {

	constructor(colInd, anchorHandler, propDesc, parser) {
		super(colInd, parser);

		this._anchorHandler = anchorHandler;
		this._referredRecordTypeName = propDesc.refTarget;
		const refRecordTypeDesc = parser.recordTypes.getRecordTypeDesc(
			this._referredRecordTypeName);
		this._valueExtractor = parser.valueExtractors[
			refRecordTypeDesc.getPropertyDesc(refRecordTypeDesc.idPropertyName)
				.scalarValueType];
	}

	execute(rowNum, rawVal) {

		// get referred record id
		const referredRecId = this._valueExtractor(rawVal, rowNum, this._colInd);

		// create reference value
		const refVal = (
			referredRecId === null ? null :
				this._referredRecordTypeName + '#' + referredRecId);

		// add value to the context array
		this._anchorHandler.addElement(refVal);

		// go to the next column (always last)
		return this._colInd + 1;
	}
}

/**
 * Handler for a nested object array anchor column.
 *
 * @private
 * @memberof module:x2node-rsparser
 * @inner
 * @extends module:x2node-rsparser~AnchorColumnHandler
 */
class ObjectArrayAnchorHandler extends AnchorColumnHandler {

	constructor(colInd, parentHandler, propDesc, parser) {
		super(colInd, parser);

		this._parentHandler = parentHandler;
		this._propDesc = propDesc;
		this._propName = propDesc.name;
		this._isSimpleNestedObject = !propDesc.isRef();
		this._nullChecker = parser.valueExtractors['isNull'];
		this._noNulls = !propDesc.optional;

		this.reset();
	}

	reset() {

		this._lastValue = undefined;
		this._curArray = null;
		this._curObject = null;
	}

	execute(rowNum, rawVal) {

		// check if anchor is null
		if (this._nullChecker(rawVal, rowNum, this._colInd)) {

			// check if the anchor changed
			if (this._lastValue === null)
				throw this._parser.invalidData(
					this._colInd, 'repeated NULL in the anchor column.');

			// check if null anchor in the middle of a collection
			if (this._lastValue !== undefined)
				throw this._parser.invalidData(
					this._colInd, 'unexpected NULL in the anchor column.');

			// check if the property is not optional
			if (this._noNulls)
				throw this._parser.invalidData(
					this._colInd, 'unexpected NULL for property ' +
						this._propName + ' that is not optional.');

			// expect reset from a parent anchor
			this._lastValue = null;

			// skip the rest of the row
			return this._columnHandlers.length;
		}

		// check if was null
		if (this._lastValue === null)
			throw this._parser.invalidData(
				this._colInd, 'NULL expected in the anchor column.');

		// check if anchor did not change
		if (rawVal === this._lastValue) {

			// at least one anchor must change
			if (this._nextAnchor < 0)
				throw this._parser.invalidData(
					this._colInd, 'at least one anchor must change in each' +
						' row.');

			// skip to the next anchor column
			return this._nextAnchor;
		}

		// create new array and set it in the context object if first element
		if (this._lastValue === undefined) {
			this._curArray = new Array();
			this._parentHandler.setObjectProperty(
				this._propName, this._curArray);
		}

		// update last value
		this._lastValue = rawVal;

		// reset the down chain
		this._parser.resetChain(this._colInd);

		// create new object and add it to the array
		if (this._isSimpleNestedObject) {
			this._curObject = this._propDesc.nestedProperties.newRecord();
			this._curArray.push(this._curObject);
		}

		// go to the next column
		return this._colInd + 1;
	}

	empty(upperColInd) {

		this._lastValue = null;

		this.emptyChildAnchors(upperColInd);
	}

	gotValue(rowNum, colInd, val) {

		this._curArray.push(val);
	}

	setObjectProperty(propName, val) {

		this._curObject[propName] = val;
	}

	getObjectProperty(propName) {

		return this._curObject[propName];
	}

	isPropertySet(propName) {

		return (this._curObject[propName] !== undefined);
	}
}

/**
 * Handler for a polymorphic reference array anchor column.
 *
 * @private
 * @memberof module:x2node-rsparser
 * @inner
 * @extends module:x2node-rsparser~AnchorColumnHandler
 */
class PolymorphicRefArrayAnchorHandler extends AnchorColumnHandler {

	constructor(colInd, parentHandler, propDesc, parser) {
		super(colInd, parser);

		this._parentHandler = parentHandler;
		this._propName = propDesc.name;
		this._nullChecker = parser.valueExtractors['isNull'];
		this._noNulls = !propDesc.optional;

		this.reset();
	}

	reset() {

		this._lastValue = undefined;
		this._curArray = null;

		this._hasValue = false;
	}

	execute(rowNum, rawVal) {

		// reset has value flag
		this._hasValue = false;

		// check if anchor is null
		if (this._nullChecker(rawVal, rowNum, this._colInd)) {

			// check if the anchor changed
			if (this._lastValue === null)
				throw this._parser.invalidData(
					this._colInd, 'repeated NULL in the anchor column.');

			// check if null anchor in the middle of a collection
			if (this._lastValue !== undefined)
				throw this._parser.invalidData(
					this._colInd, 'unexpected NULL in the anchor column.');

			// check if the property is not optional
			if (this._noNulls)
				throw this._parser.invalidData(
					this._colInd, 'unexpected NULL for property ' +
						this._propName + ' that is not optional.');

			// expect reset from a parent anchor
			this._lastValue = null;

			// skip the rest of the row
			return this._columnHandlers.length;
		}

		// check if was null
		if (this._lastValue === null)
			throw this._parser.invalidData(
				this._colInd, 'NULL expected in the anchor column.');

		// check if anchor did not change
		if (rawVal === this._lastValue) {

			// at least one anchor must change
			if (this._nextAnchor < 0)
				throw this._parser.invalidData(
					this._colInd, 'at least one anchor must change in each' +
						' row.');

			// skip to the next anchor column
			return this._nextAnchor;
		}

		// create new array and set it in the context object if first element
		if (this._lastValue === undefined) {
			this._curArray = new Array();
			this._parentHandler.setObjectProperty(
				this._propName, this._curArray);
		}

		// update last value
		this._lastValue = rawVal;

		// reset the down chain
		this._parser.resetChain(this._colInd);

		// go to the next column
		return this._colInd + 1;
	}

	empty(upperColInd) {

		this._lastValue = null;

		this.emptyChildAnchors(upperColInd);
	}

	setObjectProperty(propName, val) {

		// check if already has value
		if (this._hasValue)
			throw this._parser.invalidData(
				this._colInd, 'more than one value for a polymoprhic' +
					' reference.');

		// raise the flag for the rest of the row
		this._hasValue = true;

		// add the value to the context array
		this._curArray.push(val);
	}

	getObjectProperty() {

		return this._curArray[this._curArray.length - 1];
	}

	isPropertySet() {

		return this._hasValue;
	}
}

/**
 * Handler for a nested object map anchor column.
 *
 * @private
 * @memberof module:x2node-rsparser
 * @inner
 * @extends module:x2node-rsparser~MapKeyColumnHandler
 */
class ObjectMapAnchorHandler extends MapKeyColumnHandler {

	constructor(colInd, parentHandler, propDesc, parser) {
		super(colInd, parser, propDesc);

		this._parentHandler = parentHandler;
		this._propDesc = propDesc;
		this._propName = propDesc.name;
		this._isSimpleNestedObject = !propDesc.isRef();
		this._noNulls = !propDesc.optional;

		this.reset();
	}

	reset() {

		this._lastKeyVal = undefined;
		this._curMap = null;
		this._curObject = null;
	}

	execute(rowNum, rawVal) {

		// get the key value
		const keyVal = this._keyValueExtractor(rawVal, rowNum, this._colInd);

		// check if the key is null
		if (keyVal === null) {

			// check if the key changed
			if (this._lastKeyVal === null)
				throw this._parser.invalidData(
					this._colInd, 'repeated NULL in the map key column.');

			// check if null key in the middle of the map
			if (this._lastKeyVal !== undefined)
				throw this._parser.invalidData(
					this._colInd, 'unexpected NULL in the map key column.');

			// check if the property is not optional
			if (this._noNulls)
				throw this._parser.invalidData(
					this._colInd, 'unexpected NULL for property ' +
						this._propName + ' that is not optional.');

			// expect reset from an ancestor anchor
			this._lastKeyVal = null;

			// skip the rest of the row
			return this._columnHandlers.length;
		}

		// check if the key was null
		if (this._lastKeyVal === null)
			throw this._parser.invalidData(
				this._colInd, 'NULL expected in the map key column.');

		// check if key did not change
		if (keyVal === this._lastKeyVal) {

			// at least one anchor must change
			if (this._nextAnchor < 0)
				throw this._parser.invalidData(
					this._colInd, 'at least one anchor must change in each' +
						' row.');

			// skip to the next anchor column
			return this._nextAnchor;
		}

		// create new map and set it in the context object if first element
		if (this._lastKeyVal === undefined) {
			this._curMap = new Object();
			this._parentHandler.setObjectProperty(
				this._propName, this._curMap);
		}

		// update last key value
		this._lastKeyVal = keyVal;

		// reset the down chain
		this._parser.resetChain(this._colInd);

		// create new object and add it to the map
		if (this._isSimpleNestedObject) {
			this._curObject = this._propDesc.nestedProperties.newRecord();
			this._curMap[keyVal] = this._curObject;
		}

		// go to the next column
		return this._colInd + 1;
	}

	empty(upperColInd) {

		this._lastKeyVal = null;

		this.emptyChildAnchors(upperColInd);
	}

	gotValue(rowNum, colInd, val) {

		this._curMap[this._lastKeyVal] = val;
	}

	setObjectProperty(propName, val) {

		this._curObject[propName] = val;
	}

	getObjectProperty(propName) {

		return this._curObject[propName];
	}

	isPropertySet(propName) {

		return (this._curObject[propName] !== undefined);
	}
}

/**
 * Handler for a polymorphic reference map anchor column.
 *
 * @private
 * @memberof module:x2node-rsparser
 * @inner
 * @extends module:x2node-rsparser~MapKeyColumnHandler
 */
class PolymorphicRefMapAnchorHandler extends MapKeyColumnHandler {

	constructor(colInd, parentHandler, propDesc, parser) {
		super(colInd, parser, propDesc);

		this._parentHandler = parentHandler;
		this._propName = propDesc.name;
		this._noNulls = !propDesc.optional;

		this.reset();
	}

	reset() {

		this._lastKeyVal = undefined;
		this._curMap = null;

		this._hasValue = false;
	}

	execute(rowNum, rawVal) {

		// reset has value flag
		this._hasValue = false;

		// get the key value
		const keyVal = this._keyValueExtractor(rawVal, rowNum, this._colInd);

		// check if the key is null
		if (keyVal === null) {

			// check if the key changed
			if (this._lastKeyVal === null)
				throw this._parser.invalidData(
					this._colInd, 'repeated NULL in the map key column.');

			// check if null key in the middle of the map
			if (this._lastKeyVal !== undefined)
				throw this._parser.invalidData(
					this._colInd, 'unexpected NULL in the map key column.');

			// check if the property is not optional
			if (this._noNulls)
				throw this._parser.invalidData(
					this._colInd, 'unexpected NULL for property ' +
						this._propName + ' that is not optional.');

			// expect reset from an ancestor anchor
			this._lastKeyVal = null;

			// skip the rest of the row
			return this._columnHandlers.length;
		}

		// check if the key was null
		if (this._lastKeyVal === null)
			throw this._parser.invalidData(
				this._colInd, 'NULL expected in the map key column.');

		// check if key did not change
		if (keyVal === this._lastKeyVal) {

			// at least one anchor must change
			if (this._nextAnchor < 0)
				throw this._parser.invalidData(
					this._colInd, 'at least one anchor must change in each' +
						' row.');

			// skip to the next anchor column
			return this._nextAnchor;
		}

		// create new map and set it in the context object if first element
		if (this._lastKeyVal === undefined) {
			this._curMap = new Object();
			this._parentHandler.setObjectProperty(
				this._propName, this._curMap);
		}

		// update last key value
		this._lastKeyVal = keyVal;

		// reset the down chain
		this._parser.resetChain(this._colInd);

		// go to the next column
		return this._colInd + 1;
	}

	empty(upperColInd) {

		this._lastKeyVal = null;

		this.emptyChildAnchors(upperColInd);
	}

	setObjectProperty(propName, val) {

		// check if already has value
		if (this._hasValue)
			throw this._parser.invalidData(
				this._colInd, 'more than one value for a polymoprhic' +
					' reference.');

		// raise the flag for the rest of the row
		this._hasValue = true;

		// add the value to the context map
		this._curMap[this._lastKeyVal] = val;
	}

	getObjectProperty() {

		return this._curMap[this._lastKeyVal];
	}

	isPropertySet() {

		return this._hasValue;
	}
}

/**
 * Fetched reference value column handler in an array or a map.
 *
 * @private
 * @memberof module:x2node-rsparser
 * @inner
 * @extends module:x2node-rsparser~ColumnHandler
 */
class CollectionFetchedRefHandler extends ColumnHandler {

	constructor(colInd, anchorHandler, propDesc, parser) {
		super(colInd, parser);

		this._anchorHandler = anchorHandler;
		this._referredRecordTypeName = propDesc.refTarget;
		this._referredRecordTypeDesc = parser.recordTypes.getRecordTypeDesc(
			this._referredRecordTypeName);
		this._referredRecordIdPropName =
			this._referredRecordTypeDesc.idPropertyName;
		this._valueExtractor = parser.valueExtractors[
			this._referredRecordTypeDesc.getPropertyDesc(
				this._referredRecordIdPropName).scalarValueType];

		this.reset();
	}

	reset() {

		if (this._curObject)
			this._parser.endReferredRecord(this._colInd, false);

		this._curObject = null;
	}

	execute(rowNum, rawVal) {

		// get referred record id
		const referredRecId = this._valueExtractor(rawVal, rowNum, this._colInd);

		// create reference value
		const refVal = (
			referredRecId === null ? null :
				this._referredRecordTypeName + '#' + referredRecId);

		// add value to the context array
		this._anchorHandler.gotValue(rowNum, this._colInd, refVal);

		// skip the referred record property columns if no record
		if (referredRecId === null) {
			const beyondColInd = this._columnHandlers.length;
			this._anchorHandler.emptyChildAnchors(beyondColInd);
			return beyondColInd;
		}

		// create new referred record object
		this._curObject = this._parser.beginReferredRecord(
			this._referredRecordTypeDesc, refVal, this._colInd, false);
		if (this._curObject === null)
			return this._columnHandlers.length;

		// set id in the referred record object
		this._curObject[this._referredRecordIdPropName] = referredRecId;

		// go to the next column
		return this._colInd + 1;
	}

	setObjectProperty(propName, val) {

		this._curObject[propName] = val;
	}

	getObjectProperty(propName) {

		return this._curObject[propName];
	}

	isPropertySet(propName) {

		return (this._curObject[propName] !== undefined);
	}
}


/////////////////////////////////////////////////////////////////////////////////
// Parser
/////////////////////////////////////////////////////////////////////////////////

/**
 * Result set parser.
 *
 * @memberof module:x2node-rsparser
 * @inner
 */
class ResultSetParser {

	/**
	 * <strong>Note:</strong> The constructor is not accessible from the client
	 * code. Instances are created using module's
	 * [getResultSetParser()]{@link module:x2node-rsparser.getResultSetParser}
	 * function.
	 *
	 * @param {module:x2node-records~RecordTypesLibrary} recordTypes Record types
	 * library.
	 * @param {Object.<string,function>} valueExtractors Value extractors.
	 * @param {string} topRecordTypeName Name of the record type being parsed.
	 */
	constructor(recordTypes, valueExtractors, topRecordTypeName) {

		// store the basics
		this._recordTypes = recordTypes;
		this._valueExtractors = valueExtractors;
		this._topRecordTypeDesc =
			recordTypes.getRecordTypeDesc(topRecordTypeName);

		// result accumulators
		this._records = new Array();
		this._referredRecords = new Object();

		// uninitialized column handlers placeholder
		this._columnHandlers = null;

		// fetching references array
		this._fetchingRefs = new Array();
	}

	/**
	 * Record types library.
	 *
	 * @member {module:x2node-records~RecordTypesLibrary}
	 * @readonly
	 */
	get recordTypes() { return this._recordTypes; }

	/**
	 * Value extractors.
	 *
	 * @private
	 * @member {Object.<string,function>}
	 * @readonly
	 */
	get valueExtractors() { return this._valueExtractors; }

	/**
	 * Handlers created from the markup for each result set column.
	 *
	 * @private
	 * @member {Array.<module:x2node-rsparser~ColumnHandler>}
	 * @readonly
	 */
	get columnHandlers() { return this._columnHandlers; }

	/**
	 * Get invalid data error for the current row.
	 *
	 * @private
	 * @param {number} colInd Column index.
	 * @param {string} msg Error description.
	 * @returns {module:x2node-common.X2DataError} The error to throw.
	 */
	invalidData(colInd, msg) {

		return new common.X2DataError(
			'Bad result set row' + (
				this._records.length > 0 ?
					' for ' + this._topRecordTypeDesc.name +
					' #' + String(
						this._records[this._records.length - 1][
							this._topRecordTypeDesc.idPropertyName]) :
					''
			) + ' (row ' + this._rowsProcessed + ', col ' + (colInd + 1) +
				'): ' + msg);
	}

	/**
	 * Add new top record to the result.
	 *
	 * @private
	 * @returns {Object} The new record instance.
	 */
	addNewRecord() {

		const rec = this._topRecordTypeDesc.newRecord();

		this._records.push(rec);

		return rec;
	}

	/**
	 * Reset every handler in the columns following (and excluding) the specified
	 * one. Called from an anchor handler when the anchor value changes.
	 *
	 * @private
	 * @param {number} anchorColInd The anchor column index.
	 */
	resetChain(anchorColInd) {

		for (let i = anchorColInd + 1, len = this._numColumns; i < len; i++)
			this._columnHandlers[i].reset();
	}

	/**
	 * Indicate that a fetched referred record started in the current row. If
	 * necessary, the method creates a new record instance and adds it to the
	 * referred records.
	 *
	 * @private
	 * @param {module:x2node-records~RecordTypeDescriptor} recordTypeDesc
	 * Referred record type descriptor.
	 * @param {string} refVal Reference value.
	 * @param {number} colInd Reference property column index.
	 * @param {boolean} noSkip <code>true</code> to turn off row skipping.
	 * @returns {Object} The referred record instance, or <code>null</code> if
	 * already fetched and the following result set rows that belong to the
	 * record are about to be skipped.
	 */
	beginReferredRecord(recordTypeDesc, refVal, colInd, noSkip) {

		const key = refVal + ':' + colInd;
		const r = this._referredRecordsNRows.get(key);

		if (r !== undefined) {
			this._skipNextNRows = r - 1;
			return null;
		}

		let rec = this._referredRecords[refVal];
		if (!rec) {
			rec = recordTypeDesc.newRecord();
			this._referredRecords[refVal] = rec;
		}

		this._fetchingRefs[colInd] = refVal;
		if (!noSkip)
			this._referredRecordsNRows.set(key, this._rowsProcessed);

		return rec;
	}

	/**
	 * Indicate the last row of a fetched referred record.
	 *
	 * @private
	 * @param {number} colInd Reference property column index.
	 * @param {boolean} noSkip <code>true</code> to turn off row skipping.
	 */
	endReferredRecord(colInd, noSkip) {

		if (noSkip)
			return;

		const key = this._fetchingRefs[colInd] + ':' + colInd;
		this._referredRecordsNRows.set(
			key, this._rowsProcessed - this._referredRecordsNRows.get(key));
	}

	/**
	 * Initialize parser with columns markup. A parser instance can be
	 * initialized only once. A parser must be initialized before result set rows
	 * can be fed to it.
	 *
	 * @param {Array.<string>} markup Markup for each column in the result set.
	 * @throws {module:x2node-common.X2UsageError} If the parser has already been
	 * initialized or the specified <code>markup</code> argument is of invalid
	 * type.
	 * @throws {module:x2node-common.X2SyntaxError} If provided markup syntax is
	 * invalid.
	 */
	init(markup) {

		// check if already initialized
		if (this._columnHandlers)
			throw new common.X2UsageError(
				'The parser has been already initialized.');

		// check the basic validity of the markup argument
		if (!Array.isArray(markup) || (markup.length < 1))
			throw new common.X2UsageError(
				'The markup definition must be an array of strings with at' +
					' least one element.');

		// save markup
		this._markup = markup;
		this._numColumns = markup.length;

		// create array for column handlers
		this._columnHandlers = new Array();

		// parse the markup
		const lastColInd = this._parseObjectMarkup(
			0, null, 0, new RootHandler(this), this._topRecordTypeDesc);
		if (lastColInd !== this._numColumns)
			throw new common.X2SyntaxError(
				'Markup column ' + lastColInd + ': unexpected column prefix.');

		// initialize row skipper
		this._referredRecordsNRows = new Map();
		this._skipNextNRows = 0;

		// initialize row counter
		this._rowsProcessed = 0;
	}

	/**
	 * Recursively parse object markup.
	 *
	 * @private
	 * @param {number} startColInd First object property column index.
	 * @param {string} parentPrefix Parent markup prefix.
	 * @param {number} lastAnchorColInd Index of the last anchor column.
	 * @param {module:x2node-rsparser~ColumnHandler} parentHandler Context object
	 * handler.
	 * @param {module:x2node-records~PropertiesContainer} container Context
	 * object properties container.
	 * @returns {number} Index of the column next after the object markup.
	 */
	_parseObjectMarkup(
		startColInd, parentPrefix, lastAnchorColInd, parentHandler, container) {

		// determine object prefix
		const levelPrefix = this._getLevelPrefix(startColInd, parentPrefix);
		if (levelPrefix === null)
			return startColInd;

		// parse and process column definitions
		let colInd = startColInd;
		let levelExhausted = false;
		let prevSubtypeHandler;
		do {

			// can't stay on this level once exhausted
			if (levelExhausted)
				throw new common.X2SyntaxError(
					'Markup column ' + colInd +
						': cannot have any more properties at this nesting' +
						' level.');

			// parse column definition
			const colDef = this._markup[colInd];
			let prefix, propName, fetchRef;
			const sepInd = colDef.lastIndexOf('$');
			if (sepInd >= 0) {
				prefix = colDef.substring(0, sepInd);
				propName = colDef.substring(sepInd + 1);
			} else {
				prefix = '';
				propName = colDef;
			}
			fetchRef = propName.endsWith(':');
			if (fetchRef)
				propName = propName.substring(0, propName.length - 1);

			// check if end of the object properties
			if (prefix !== levelPrefix)
				return colInd;

			// check that the property exists
			if (!container.hasProperty(propName))
				throw new common.X2SyntaxError(
					'Markup column ' + colInd + ': record type ' +
						container.recordTypeName + ' does not have property ' +
						container.nestedPath + propName + '.');

			// get property descriptor
			const propDesc = container.getPropertyDesc(propName);

			// only scalar non-polymorphic reference property can be fetched
			if (fetchRef && !propDesc.isRef())
				throw new common.X2SyntaxError(
					'Markup column ' + colInd + ': record type ' +
						container.recordTypeName + ' property ' +
						container.nestedPath + propName +
						' is not a reference and cannot be fetched.');

			// exhaust level once non-scalar is seen
			if (!propDesc.isScalar())
				levelExhausted = true;

			// create top record id handler for the first column
			if (colInd === 0) {
				this._columnHandlers[colInd] = new TopRecordIdHandler(
					parentHandler, propDesc, this);
				colInd++;
				continue;
			}

			// create handler depending on the property type
			let handler, anchorHandler;
			switch (
				(propDesc.isScalar() ? 'scalar' : (
					propDesc.isArray() ? 'array' : 'map')) +
					':' + propDesc.scalarValueType
			) {
			case 'scalar:string':
			case 'scalar:number':
			case 'scalar:boolean':
			case 'scalar:datetime':

				this._columnHandlers[colInd] = new SingleValueHandler(
					colInd, parentHandler, propDesc, this);
				colInd++;

				break;

			case 'scalar:object':

				if (propDesc.isPolymorphRef()) {
					handler = new SinglePolymorphicRefHandler(
						colInd, this._columnHandlers[lastAnchorColInd],
						parentHandler, propDesc, this);
				} else if (propDesc.isSubtype()) {
					handler = new PolymorphicObjectTypeHandler(
						colInd, this._columnHandlers[lastAnchorColInd],
						parentHandler, propDesc, this);
					if (prevSubtypeHandler)
						prevSubtypeHandler.makeNotLast();
					prevSubtypeHandler = handler;
				} else {
					handler = new SingleObjectHandler(
						colInd, this._columnHandlers[lastAnchorColInd],
						parentHandler, propDesc, this);
				}
				this._columnHandlers[colInd] = handler;

				if (++colInd < this._numColumns)
					colInd = this._parseObjectMarkup(
						colInd, levelPrefix, lastAnchorColInd, handler,
						propDesc.nestedProperties);

				handler.setNextColumnIndex(colInd);

				break;

			case 'scalar:ref':

				if (fetchRef) {
					handler = new SingleFetchedRefHandler(
						colInd, this._columnHandlers[lastAnchorColInd],
						parentHandler, propDesc, this, propDesc.isSubtype());
					this._columnHandlers[colInd] = handler;
					if (++colInd < this._numColumns)
						colInd = this._parseObjectMarkup(
							colInd, levelPrefix, lastAnchorColInd, handler,
							this._recordTypes.getRecordTypeDesc(
								propDesc.refTarget));
					handler.setNextColumnIndex(colInd);
				} else {
					handler = new SingleRefHandler(
						colInd, parentHandler, propDesc, this,
						propDesc.isSubtype());
					this._columnHandlers[colInd] = handler;
					colInd++;
				}

				if (propDesc.isSubtype()) {
					if (prevSubtypeHandler)
						prevSubtypeHandler.makeNotLast();
					prevSubtypeHandler = handler;
				}

				break;

			case 'array:string':
			case 'array:number':
			case 'array:boolean':
			case 'array:datetime':

				this._columnHandlers[lastAnchorColInd].setNextAnchor(colInd);

				anchorHandler = new ArraySingleRowAnchorHandler(
					colInd, parentHandler, propDesc, this);
				this._columnHandlers[colInd] = anchorHandler;

				if ((++colInd < this._numColumns)
					&& (this._getLevelPrefix(colInd, prefix) !== null)) {
					this._columnHandlers[colInd] = new SingleRowValueHandler(
						colInd, anchorHandler, propDesc, this);
					colInd++;
				}

				break;

			case 'array:object':

				this._columnHandlers[lastAnchorColInd].setNextAnchor(colInd);

				if (propDesc.isPolymorphRef()) {
					anchorHandler = new PolymorphicRefArrayAnchorHandler(
						colInd, parentHandler, propDesc, this);
				} else {
					anchorHandler = new ObjectArrayAnchorHandler(
						colInd, parentHandler, propDesc, this);
				}
				this._columnHandlers[colInd] = anchorHandler;

				if (++colInd < this._numColumns)
					colInd = this._parseObjectMarkup(
						colInd, levelPrefix, colInd - 1, anchorHandler,
						propDesc.nestedProperties);

				break;

			case 'array:ref':

				this._columnHandlers[lastAnchorColInd].setNextAnchor(colInd);

				if (fetchRef) {

					anchorHandler = new ObjectArrayAnchorHandler(
						colInd, parentHandler, propDesc, this);
					this._columnHandlers[colInd] = anchorHandler;

					if (++colInd < this._numColumns) {
						handler = new CollectionFetchedRefHandler(
							colInd, anchorHandler, propDesc, this);
						this._columnHandlers[colInd] = handler;
						if (++colInd < this._numColumns)
							colInd = this._parseObjectMarkup(
								colInd, levelPrefix, colInd - 2, handler,
								this._recordTypes.getRecordTypeDesc(
									propDesc.refTarget));
					}

				} else {

					anchorHandler = new ArraySingleRowAnchorHandler(
						colInd, parentHandler, propDesc, this);
					this._columnHandlers[colInd] = anchorHandler;

					if ((++colInd < this._numColumns)
						&& (this._getLevelPrefix(colInd, prefix) !== null)) {
						this._columnHandlers[colInd] = new SingleRowRefHandler(
							colInd, anchorHandler, propDesc, this);
						colInd++;
					}
				}

				break;

			case 'map:string':
			case 'map:number':
			case 'map:boolean':
			case 'map:datetime':

				this._columnHandlers[lastAnchorColInd].setNextAnchor(colInd);

				anchorHandler = new MapSingleRowAnchorHandler(
					colInd, parentHandler, propDesc, this);
				this._columnHandlers[colInd] = anchorHandler;

				if ((++colInd < this._numColumns)
					&& (this._getLevelPrefix(colInd, prefix) !== null)) {
					this._columnHandlers[colInd] = new SingleRowValueHandler(
						colInd, anchorHandler, propDesc, this);
					colInd++;
				}

				break;

			case 'map:object':

				this._columnHandlers[lastAnchorColInd].setNextAnchor(colInd);

				if (propDesc.isPolymorphRef()) {
					anchorHandler = new PolymorphicRefMapAnchorHandler(
						colInd, parentHandler, propDesc, this);
				} else {
					anchorHandler = new ObjectMapAnchorHandler(
						colInd, parentHandler, propDesc, this);
				}
				this._columnHandlers[colInd] = anchorHandler;

				if (++colInd < this._numColumns)
					colInd = this._parseObjectMarkup(
						colInd, levelPrefix, colInd - 1, anchorHandler,
						propDesc.nestedProperties);

				break;

			case 'map:ref':

				this._columnHandlers[lastAnchorColInd].setNextAnchor(colInd);

				if (fetchRef) {

					anchorHandler = new ObjectMapAnchorHandler(
						colInd, parentHandler, propDesc, this);
					this._columnHandlers[colInd] = anchorHandler;

					if (++colInd < this._numColumns) {
						handler = new CollectionFetchedRefHandler(
							colInd, anchorHandler, propDesc, this);
						this._columnHandlers[colInd] = handler;
						if (++colInd < this._numColumns)
							colInd = this._parseObjectMarkup(
								colInd, levelPrefix, colInd - 2, handler,
								this._recordTypes.getRecordTypeDesc(
									propDesc.refTarget));
					}

				} else {

					anchorHandler = new MapSingleRowAnchorHandler(
						colInd, parentHandler, propDesc, this);
					this._columnHandlers[colInd] = anchorHandler;

					if ((++colInd < this._numColumns)
						&& (this._getLevelPrefix(colInd, prefix) !== null)) {
						this._columnHandlers[colInd] = new SingleRowRefHandler(
							colInd, anchorHandler, propDesc, this);
						colInd++;
					}
				}

				break;

			default: // should never happen
				throw new Error(
					'Internal X2 error: record type ' +
						String(container.recordTypeName) + ' property ' +
						container.nestedPath + propName +
						' has unrecognized specification.');
			}

		} while (colInd < this._numColumns);

		// end of the markup
		return colInd;
	}

	/**
	 * Extract markup nesting level prefix from the (first) column markup.
	 *
	 * @private
	 * @param {number} startColInd Index of the first column in the level.
	 * @param {string} parentPrefix Parent level prefix.
	 * @returns {string} Level prefix, or <code>null</code> if the column does
	 * not belong to a nested level (nested level prefix must be longer than the
	 * parent level).
	 */
	_getLevelPrefix(startColInd, parentPrefix) {

		// determine the prefix
		const startColDef = this._markup[startColInd];
		const sepInd = startColDef.lastIndexOf('$');
		const prefix = (sepInd >= 0 ? startColDef.substring(0, sepInd) : '');

		// nested level prefix must be longer than the parent
		if ((parentPrefix !== null) && (prefix.length <= parentPrefix.length))
			return null;

		// return the prefix
		return prefix;
	}

	/**
	 * Merge records collected by another parser into this one. The specified
	 * other parser must contain the same number of records in the same order.
	 * Each record is then merged one by one into the records in this parser.
	 *
	 * @param {module:x2node-rsparser~ResultSetParser} parser The other parser.
	 * @returns {module:x2node-rsparser~ResultSetParser} This parser.
	 * @throws {module:x2node-common.X2UsageError} If the specified parser is
	 * incompatible with this one.
	 */
	merge(parser) {

		// make sure the parsers share the same top record type
		if (parser._topRecordTypeDesc !== this._topRecordTypeDesc)
			throw new common.X2UsageError(
				'Parsers must share the same top record type.');

		// merge the main record arrays
		const otherRecords = parser._records;
		if (otherRecords.length !== this._records.length)
			throw new common.X2UsageError(
				'Parsers must contain same number of records.');
		this._records.forEach((rec, i) => {
			this._mergeObjects(rec, otherRecords[i], this._topRecordTypeDesc);
		});

		// merge referred records maps
		Object.keys(parser._referredRecords).forEach(ref => {
			const rec = this._referredRecords[ref];
			if (rec !== undefined) {
				this._mergeObjects(
					rec, parser._referredRecords[ref],
					this._recordTypes.getRecordTypeDesc(
						ref.substring(0, ref.indexOf('#'))));
			} else {
				this._referredRecords[ref] = parser._referredRecords[ref];
			}
		});

		// return this merged parser
		return this;
	}

	/**
	 * Merge two objects.
	 *
	 * @private
	 * @param {Object} obj1 Object, into which to merge.
	 * @param {Object} obj2 Object to merge into <code>obj1</code> (stays
	 * unmodified).
	 * @param {module:x2node-records~PropertiesContainer} container Container
	 * that describes the object properties.
	 */
	_mergeObjects(obj1, obj2, container) {

		const idPropName = container.idPropertyName;

		Object.keys(obj2).forEach(propName => {
			if (!container.hasProperty(propName))
				return;
			if (obj1.hasOwnProperty(propName)) {
				const propDesc = container.getPropertyDesc(propName);
				if ((propDesc.scalarValueType === 'object') &&
					!propDesc.isPolymorphRef()) {
					if (propDesc.isArray()) {
						this._mergeArrays(
							obj1[propName], obj2[propName], propDesc);
					} else if (propDesc.isMap()) {
						this._mergeMaps(
							obj1[propName], obj2[propName], propDesc);
					} else if (propDesc.isPolymorphObject()) {
						const typePropName =
							propDesc.nestedProperties.typePropertyName;
						const nestedObj1 = obj1[propName];
						const nestedObj2 = obj2[propName];
						const type = nestedObj1[typePropName];
						if (type !== nestedObj2[typePropName])
							throw new common.X2UsageError(
								'Attempt to merge polymorphic objects of' +
									' different types.');
						this._mergeObjects(
							nestedObj1, nestedObj2, propDesc.nestedProperties);
						this._mergeObjects(
							nestedObj1, nestedObj2,
							propDesc.nestedProperties.getPropertyDesc(type)
								.nestedProperties);
					} else {
						this._mergeObjects(
							obj1[propName], obj2[propName],
							propDesc.nestedProperties);
					}
				} else if (propName === idPropName) {
					if (obj1[propName] !== obj2[propName])
						throw new common.X2UsageError(
							'Attempt to merge objects with different ids.');
				} else { // overwrite
					obj1[propName] = obj2[propName];
				}
			} else {
				obj1[propName] = obj2[propName];
			}
		});
	}

	/**
	 * Merge two object arrays.
	 *
	 * @private
	 * @param {Array.<Object>} array1 Array, into which to merge.
	 * @param {Array.<Object>} array2 Array to merge into <code>array1</code>
	 * (stays unmodified).
	 * @param {module:x2node-records~PropertyDescriptor} propDesc Array property
	 * descriptor in the parent container.
	 */
	_mergeArrays(array1, array2, propDesc) {

		if (array1.length !== array2.length)
			throw new common.X2UsageError(
				'Attempt to merge object arrays of different lengths.');

		if (propDesc.isPolymorphObject()) {
			const typePropName = propDesc.nestedProperties.typePropertyName;
			array1.forEach((obj1, i) => {
				const obj2 = array2[i];
				if (obj1 === null) {
					if (obj2 !== null)
						throw new common.X2UsageError(
							'Attempt to merge non-null array element with' +
								' null.');
				} else {
					if (obj2 === null)
						throw new common.X2UsageError(
							'Attempt to merge non-null array element with' +
								' null.');
					const type = obj1[typePropName];
					if (type !== obj2[typePropName])
						throw new common.X2UsageError(
							'Attempt to merge polymorphic objects of' +
								' different types.');
					this._mergeObjects(
						obj1, obj2, propDesc.nestedProperties);
					this._mergeObjects(
						obj1, obj2,
						propDesc.nestedProperties.getPropertyDesc(type)
							.nestedProperties);
				}
			});
		} else {
			const container = propDesc.nestedProperties;
			array1.forEach((obj1, i) => {
				const obj2 = array2[i];
				if (obj1 === null) {
					if (obj2 !== null)
						throw new common.X2UsageError(
							'Attempt to merge non-null array element with' +
								' null.');
				} else {
					if (obj2 === null)
						throw new common.X2UsageError(
							'Attempt to merge non-null array element with' +
								' null.');
					this._mergeObjects(obj1, obj2, container);
				}
			});
		}
	}

	/**
	 * Merge two object maps.
	 *
	 * @private
	 * @param {Object.<string,Object>} map1 Map, into which to merge.
	 * @param {Object.<string,Object>} map2 Map to merge into <code>map1</code>
	 * (stays unmodified).
	 * @param {module:x2node-records~PropertyDescriptor} propDesc Map property
	 * descriptor in the parent container.
	 */
	_mergeMaps(map1, map2, propDesc) {

		const keys = Object.keys(map1);
		if (keys.length !== Object.keys(map2).length)
			throw new common.X2UsageError(
				'Attempt to merge object maps of different sizes.');

		if (propDesc.isPolymorphObject()) {
			const typePropName = propDesc.nestedProperties.typePropertyName;
			keys.forEach(key => {
				const obj1 = map1[key];
				const obj2 = map2[key];
				if (obj2 === undefined)
					throw new common.X2UsageError(
						'Attempt to merge maps with different keys.');
				if (obj1 === null) {
					if (obj2 !== null)
						throw new common.X2UsageError(
							'Attempt to merge non-null array element with' +
								' null.');
				} else {
					if (obj2 === null)
						throw new common.X2UsageError(
							'Attempt to merge non-null array element with' +
								' null.');
					const type = obj1[typePropName];
					if (type !== obj2[typePropName])
						throw new common.X2UsageError(
							'Attempt to merge polymorphic objects of' +
								' different types.');
					this._mergeObjects(
						obj1, obj2, propDesc.nestedProperties);
					this._mergeObjects(
						obj1, obj2,
						propDesc.nestedProperties.getPropertyDesc(type)
							.nestedProperties);
				}
			});
		} else {
			const container = propDesc.nestedProperties;
			keys.forEach(key => {
				const obj1 = map1[key];
				const obj2 = map2[key];
				if (obj2 === undefined)
					throw new common.X2UsageError(
						'Attempt to merge maps with different keys.');
				if (obj1 === null) {
					if (obj2 !== null)
						throw new common.X2UsageError(
							'Attempt to merge non-null map element with' +
								' null.');
				} else {
					if (obj2 === null)
						throw new common.X2UsageError(
							'Attempt to merge non-null map element with' +
								' null.');
					this._mergeObjects(obj1, obj2, container);
				}
			});
		}
	}

	/**
	 * Reset the parser so that it can be re-used to parse another result set.
	 * The method creates new empty <code>records</code> and
	 * <code>referredRecords</code> properties and leaves the markup in place, so
	 * there is no need to initialize the parser again and the new result set
	 * rows can start to be fed to the parser right away.
	 */
	reset() {

		// reset result accumulators
		this._records.length = 0;
		this._referredRecords = new Object();

		// reset row skipper
		this._referredRecordsNRows.clear();
		this._skipNextNRows = 0;

		// reset row counter
		this._rowsProcessed = 0;

		// reset column handlers
		this._columnHandlers.forEach(handler => { handler.reset(); });
	}

	/**
	 * Feed a result set row to the parser. Note, the parser must be initialized
	 * with markup before rows can be fed to it.
	 *
	 * @param {(Array.<*>|Object.<string,*>)} row The result set row, which can
	 * be an array of raw values for each result set column, or an object with
	 * column markup as the keys and corresponding raw values as the values.
	 * @throws {module:x2node-common.X2DataError} If the row data does not match
	 * the markup.
	 */
	feedRow(row) {

		const rowNum = this._rowsProcessed++;

		if (this._skipNextNRows > 0) {
			this._skipNextNRows--;
			return;
		}

		let colInd = 0;
		if (Array.isArray(row)) {
			do {
				colInd = this._columnHandlers[colInd].execute(
					rowNum, row[colInd]);
			} while (colInd < this._numColumns);
		} else {
			do {
				colInd = this._columnHandlers[colInd].execute(
					rowNum, row[this._markup[colInd]]);
			} while (colInd < this._numColumns);
		}
	}

	/**
	 * Array of records extracted from the result set rows. The property is
	 * usually read by the client after all result set rows have been fed to the
	 * parser.
	 *
	 * @member {Array.<Object>}
	 * @readonly
	 */
	get records() {

		return this._records;
	}

	/**
	 * Records corresponding to references in fetched reference properties. The
	 * property is usually read by the client after all result set rows have been
	 * fed to the parser.
	 *
	 * @member {Object.<string,Object>}
	 * @readonly
	 */
	get referredRecords() {

		return this._referredRecords;
	}
}

// export the class
module.exports = ResultSetParser;
