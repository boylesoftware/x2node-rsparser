/**
 * Result set parser module.
 */
'use strict';


/////////////////////////////////////////////////////////////////////////////////
// Errors.
/////////////////////////////////////////////////////////////////////////////////

/**
 * Node.js <code>Error</code> object.
 *
 * @external Error
 * @see {@link https://nodejs.org/dist/latest-v4.x/docs/api/errors.html#errors_class_error}
 */

/**
 * Invalid markup syntax.
 *
 * @extends external:Error
 */
class RSParserMarkupError extends Error {

	/**
	 * Create new error.
	 *
	 * @param {string} message The error description.
	 */
	constructor(message) {
		super();

		Error.captureStackTrace(this, this.constructor);

		this.name = 'RSParserMarkupError';
		this.message = message;
	}
}

/**
 * Unexpected data in the result set row.
 *
 * @extends external:Error
 */
class RSParserDataError extends Error {

	/**
	 * Create new error.
	 *
	 * @param {string} message The error description.
	 */
	constructor(message) {
		super();

		Error.captureStackTrace(this, this.constructor);

		this.name = 'RSParserDataError';
		this.message = message;
	}
}

/**
 * General module usage error, such as invalid arguments, inappropriate function
 * call, etc.
 *
 * @extends external:Error
 */
class RSParserUsageError extends Error {

	/**
	 * Create new error.
	 *
	 * @param {string} message The error description.
	 */
	constructor(message) {
		super();

		Error.captureStackTrace(this, this.constructor);

		this.name = 'RSParserUsageError';
		this.message = message;
	}
}


/////////////////////////////////////////////////////////////////////////////////
// Handlers.
/////////////////////////////////////////////////////////////////////////////////

/**
 * Result set column handler.
 *
 * @protected
 * @abstract
 */
class ColumnHandler {

	constructor(colInd, parser) {

		this._colInd = colInd;
		this._parser = parser;
		this._options = parser.options;
		this._columnHandlers = parser.columnHandlers;
	}

	reset() { /* nothing */ }
}

/**
 * Result set anchor column handler.
 *
 * @protected
 * @abstract
 */
class AnchorColumnHandler extends ColumnHandler {

	constructor(colInd, parser) {
		super(colInd, parser);

		this._nextAnchor = -1;
	}

	setNextAnchor(nextAnchor) {

		if (this._nextAnchor >= 0)
			throw new RSParserMarkupError(
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
 * Root column handler. Technically it is not a column handler because it is not
 * associated with any column, but plays the role of the parent handler for the
 * top record id column handler.
 *
 * @protected
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
}

/**
 * Top record id column handler. Always associated with the first column in the
 * result set.
 *
 * @protected
 */
class TopRecordIdHandler extends AnchorColumnHandler {

	constructor(rootHandler, propDesc, parser) {
		super(0, parser);

		if (!propDesc.isId())
			throw new RSParserMarkupError(
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
		const val = this._valueExtractor(rawVal, rowNum, 0, this._options);
		if (val === null)
			throw new RSParserDataError(
				'Result set row ' + rowNum + ': top record id may not be null.');

		// check if same record
		if (val === this._lastValue) {

			// can't be same record if this is the only anchor
			if (this._nextAnchor < 0)
				throw new RSParserDataError(
					'Result set row ' + rowNum +
						': at least one anchor must change in each row.');

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
 * @protected
 */
class SingleValueHandler extends ColumnHandler {

	constructor(colInd, parentHandler, propDesc, parser) {
		super(colInd, parser);

		this._parentHandler = parentHandler;
		this._propName = propDesc.name;
		this._valueExtractor = parser.valueExtractors[propDesc.scalarValueType];
	}

	execute(rowNum, rawVal) {

		// get the value to set
		const val = this._valueExtractor(
			rawVal, rowNum, this._colInd, this._options);

		// set the property in the context object
		if (val !== null)
			this._parentHandler.setObjectProperty(this._propName, val);

		// go to the next column
		return this._colInd + 1;
	}
}

/**
 * Single nested object property column handler.
 *
 * @protected
 */
class SingleObjectHandler extends ColumnHandler {

	constructor(colInd, anchorHandler, parentHandler, propDesc, parser) {
		super(colInd, parser);

		this._anchorHandler = anchorHandler;
		this._parentHandler = parentHandler;
		this._propDesc = propDesc;
		this._propName = propDesc.name;
		this._nullChecker = parser.valueExtractors['isNull'];

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
		if (this._nullChecker(rawVal, rowNum, this._colInd, this._options)) {
			this._anchorHandler.emptyChildAnchors(this._nextColInd);
			return this._nextColInd;
		}

		// create new object
		this._curObject = this._propDesc.newObject();

		// set the property in the parent object
		this._parentHandler.setObjectProperty(this._propName, this._curObject);

		// go to the next column
		return this._colInd + 1;
	}

	setObjectProperty(propName, val) {

		this._curObject[propName] = val;
	}
}

/**
 * Single polymorphic nested object property column handler.
 *
 * @protected
 */
class SinglePolymorphicPropHandler extends ColumnHandler {

	constructor(colInd, parentHandler, propDesc, parser) {
		super(colInd, parser);

		this._parentHandler = parentHandler;
		this._propName = propDesc.name;

		this.reset();
	}

	reset() {

		this._hasValue = undefined;
	}

	execute(rowNum) {

		// reset has value flag
		this._hasValue = false;

		// go to the next column
		return this._colInd + 1;
	}

	hasValue() {

		return this._hasValue;
	}

	gotValue(rowNum, colInd, val) {

		// check if already has value
		if (this._hasValue)
			throw new RSParserDataError(
				'Result set row ' + rowNum + ', column ' + colInd +
					': more than one value for a polymorphic property ' +
					this._propName + '.');

		// raise the flag for the rest of the row
		this._hasValue = true;

		// set the value in the context object property
		if (val !== null)
			this._parentHandler.setObjectProperty(this._propName, val);
	}
}

/**
 * Handle of the polymorphic nested object subtype column.
 *
 * @protected
 */
class PolymorphicObjectTypeHandler extends ColumnHandler {

	constructor(colInd, anchorHandler, propDesc, superHandler, type, parser) {
		super(colInd, parser);

		this._anchorHandler = anchorHandler;
		this._propDesc = propDesc;
		this._superHandler = superHandler;
		this._type = type;
		this._nullChecker = parser.valueExtractors['isNull'];

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

		// skip object subtype columns if no object
		if (this._nullChecker(rawVal, rowNum, this._colInd, this._options)) {
			this._anchorHandler.emptyChildAnchors(this._nextColInd);
			return this._nextColInd;
		}

		// create new object and set its type property
		this._curObject = this._propDesc.newObject(this._type);

		// pass the object to the super handler
		this._superHandler.gotValue(rowNum, this._colInd, this._curObject);

		// go to the next column
		return this._colInd + 1;
	}

	setObjectProperty(propName, val) {

		this._curObject[propName] = val;
	}
}

/**
 * Single reference property column handler.
 *
 * @protected
 */
class SingleRefHandler extends ColumnHandler {

	constructor(colInd, parentHandler, propDesc, parser) {
		super(colInd, parser);

		this._parentHandler = parentHandler;
		this._propName = propDesc.name;
		this._referredRecordTypeName = propDesc.refTarget;
		const refRecordTypeDesc = parser.recordTypes.getRecordTypeDesc(
			this._referredRecordTypeName);
		this._valueExtractor = parser.valueExtractors[
			refRecordTypeDesc.getPropertyDesc(refRecordTypeDesc.idPropertyName)
				.scalarValueType];
	}

	execute(rowNum, rawVal) {

		// get referred record id
		const referredRecId = this._valueExtractor(
			rawVal, rowNum, this._colInd, this._options);

		// set the property in the context object
		if (referredRecId !== null)
			this._parentHandler.setObjectProperty(
				this._propName, this._referredRecordTypeName + '#' + referredRecId);

		// go to the next column
		return this._colInd + 1;
	}
}

/**
 * Single polymorphic reference property column handler.
 *
 * @protected
 */
class SinglePolymorphicRefHandler extends ColumnHandler {

	constructor(colInd, superHandler, type, parser) {
		super(colInd, parser);

		this._superHandler = superHandler;
		this._referredRecordTypeName = type;
		const refRecordTypeDesc = parser.recordTypes.getRecordTypeDesc(type);
		this._valueExtractor = parser.valueExtractors[
			refRecordTypeDesc.getPropertyDesc(refRecordTypeDesc.idPropertyName)
				.scalarValueType];

		this._isLast = false;
	}

	setLast() {

		this._isLast = true;
	}

	execute(rowNum, rawVal) {

		// get referred record id
		const referredRecId = this._valueExtractor(
			rawVal, rowNum, this._colInd, this._options);

		// create reference value
		const refVal = (
			referredRecId === null ? null :
				this._referredRecordTypeName + '#' + referredRecId);

		// pass the reference to the super handler
		if ((referredRecId !== null) ||
			(this._isLast && !this._superHandler.hasValue()))
			this._superHandler.gotValue(rowNum, this._colInd, refVal);

		// go to the next column
		return this._colInd + 1;
	}
}

/**
 * Single fetched reference property column handler.
 *
 * @protected
 */
class SingleFetchedRefHandler extends ColumnHandler {

	constructor(colInd, anchorHandler, parentHandler, propDesc, parser) {
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

		this._nextColInd = undefined;

		this.reset();
	}

	setNextColumnIndex(nextColInd) {

		this._nextColInd = nextColInd;
	}

	reset() {

		if (this._curObject)
			this._parser.endReferredRecord(this._colInd);

		this._curObject = null;
	}

	execute(rowNum, rawVal) {

		// get referred record id
		const referredRecId = this._valueExtractor(
			rawVal, rowNum, this._colInd, this._options);

		// skip the referred record property columns if no record
		if (referredRecId === null) {
			this._anchorHandler.emptyChildAnchors(this._nextColInd);
			return this._nextColInd;
		}

		// set the property in the context object
		const refVal = this._referredRecordTypeName + '#' + referredRecId;
		this._parentHandler.setObjectProperty(this._propName, refVal);

		// create new referred record object
		this._curObject = this._parser.beginReferredRecord(
			this._referredRecordTypeDesc, refVal, this._colInd);
		if (this._curObject === null)
			return this._nextColInd;

		// go to the next column
		return this._colInd + 1;
	}

	setObjectProperty(propName, val) {

		this._curObject[propName] = val;
	}
}

/**
 * Single fetched polymorphic reference property column handler.
 *
 * @protected
 */
class SingleFetchedPolymorphicRefHandler extends ColumnHandler {

	constructor(colInd, anchorHandler, superHandler, type, parser) {
		super(colInd, parser);

		this._anchorHandler = anchorHandler;
		this._superHandler = superHandler;
		this._referredRecordTypeName = type;
		this._referredRecordTypeDesc =
			parser.recordTypes.getRecordTypeDesc(type);
		this._valueExtractor = parser.valueExtractors[
			this._referredRecordTypeDesc.getPropertyDesc(
				this._referredRecordTypeDesc.idPropertyName).scalarValueType];

		this._nextColInd = undefined;
		this._isLast = false;

		this.reset();
	}

	setNextColumnIndex(nextColInd) {

		this._nextColInd = nextColInd;
	}

	setLast() {

		this._isLast = true;
	}

	reset() {

		if (this._curObject)
			this._parser.endReferredRecord(this._colInd);

		this._curObject = null;
	}

	execute(rowNum, rawVal) {

		// get referred record id
		const referredRecId = this._valueExtractor(
			rawVal, rowNum, this._colInd, this._options);

		// skip the referred record property columns if no record
		if (referredRecId === null) {
			this._anchorHandler.emptyChildAnchors(this._nextColInd);
			if (this._isLast && !this._superHandler.hasValue())
				this._superHandler.gotValue(rowNum, this._colInd, null);
			return this._nextColInd;
		}

		// pass the reference to the super handler
		const refVal = this._referredRecordTypeName + '#' + referredRecId;
		this._superHandler.gotValue(rowNum, this._colInd, refVal);

		// create new referred record object
		this._curObject = this._parser.beginReferredRecord(
			this._referredRecordTypeDesc, refVal, this._colInd);
		if (this._curObject === null)
			return this._nextColInd;

		// go to the next column
		return this._colInd + 1;
	}

	setObjectProperty(propName, val) {

		this._curObject[propName] = val;
	}
}

/**
 * Single row element array anchor column handler.
 *
 * @protected
 */
class ArraySingleRowAnchorHandler extends AnchorColumnHandler {

	constructor(colInd, parentHandler, propDesc, parser) {
		super(colInd, parser);

		this._parentHandler = parentHandler;
		this._propName = propDesc.name;
		this._nullChecker = parser.valueExtractors['isNull'];

		this.reset();
	}

	reset() {

		this._anchored = false;
		this._curArray = null;
	}

	execute(rowNum, rawVal) {

		// check if anchor is null
		const nullAnchor = this._nullChecker(
			rawVal, rowNum, this._colInd, this._options);

		// check if already has context array
		if (this._anchored) {
			if (nullAnchor)
				throw new RSParserDataError(
					'Result set row ' + rowNum + ', column ' + this._colInd +
						': unexpected NULL in the anchor column.');
			return this._colInd + 1;
		}

		// make anchored
		this._anchored = true;

		// skip the elements if no array
		if (nullAnchor)
			return this._colInd + 2; // note: should always be last

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
 * @protected
 */
class MapSingleRowAnchorHandler extends AnchorColumnHandler {

	constructor(colInd, parentHandler, propDesc, parser) {
		super(colInd, parser);

		this._parentHandler = parentHandler;
		this._propName = propDesc.name;
		this._keyValueExtractor = parser.valueExtractors['string'];

		this.reset();
	}

	reset() {

		this._lastKeyVal = undefined;
		this._curMap = null;
	}

	execute(rowNum, rawVal) {

		// get the key value
		const keyVal = this._keyValueExtractor(
			rawVal, rowNum, this._colInd, this._options);

		// check if the key is null
		if (keyVal === null) {

			// anchors must change
			if (this._lastKeyVal === null)
				throw new RSParserDataError(
					'Result set row ' + rowNum + ', column ' + this._colInd +
						': repeated NULL in the map key column.');

			// can't be in the middle of a map
			if (this._lastKeyVal !== undefined)
				throw new RSParserDataError(
					'Result set row ' + rowNum + ', column ' + this._colInd +
						': unexpected NULL in the map key column.');

			// update the last key value
			this._lastKeyVal = null;

			// skip the value
			return this._colInd + 2; // note: should always be last
		}

		// make sure we've got a new key
		if ((this._lastKeyVal === null) || (keyVal === this._lastKeyVal))
			throw new RSParserDataError(
				'Result set row ' + rowNum +
					': at least one anchor must change in each row.');

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
 * @protected
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
			this._valueExtractor(rawVal, rowNum, this._colInd, this._options));

		// go to the next column (always last)
		return this._colInd + 1;
	}
}

/**
 * Single row element array or map reference value column handler.
 *
 * @protected
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
		const referredRecId = this._valueExtractor(
			rawVal, rowNum, this._colInd, this._options);

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
 * Handler for a nested object array anchor column. Supports both polymorphic and
 * non-polymorphic objects.
 *
 * @protected
 */
class ObjectArrayAnchorHandler extends AnchorColumnHandler {

	constructor(colInd, parentHandler, propDesc, parser) {
		super(colInd, parser);

		this._parentHandler = parentHandler;
		this._propDesc = propDesc;
		this._propName = propDesc.name;
		this._isSimpleNestedObject =
			(!propDesc.isRef() && !propDesc.isPolymorph());
		this._nullChecker = parser.valueExtractors['isNull'];

		this.reset();
	}

	reset() {

		this._lastValue = undefined;
		this._curArray = null;
		this._curObject = null;

		this._hasValue = undefined;
	}

	execute(rowNum, rawVal) {

		// reset has value flag
		this._hasValue = false;

		// check if anchor is null
		if (this._nullChecker(rawVal, rowNum, this._colInd, this._options)) {

			// check if the anchor changed
			if (this._lastValue === null)
				throw new RSParserDataError(
					'Result set row ' + rowNum + ', column ' + this._colInd +
						': repeated NULL in the anchor column.');

			// check if null anchor in the middle of a collection
			if (this._lastValue !== undefined)
				throw new RSParserDataError(
					'Result set row ' + rowNum + ', column ' + this._colInd +
						': unexpected NULL in the anchor column.');

			// expect reset from a parent anchor
			this._lastValue = null;

			// skip the rest of the row
			return this._columnHandlers.length;
		}

		// check if was null
		if (this._lastValue === null)
			throw new RSParserDataError(
				'Result set row ' + rowNum + ', column ' + this._colInd +
					': NULL expected in the anchor column.');

		// check if anchor did not change
		if (rawVal === this._lastValue) {

			// at least one anchor must change
			if (this._nextAnchor < 0)
				throw new RSParserDataError(
					'Result set row ' + rowNum +
						': at least one anchor must change in each row.');

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
			this._curObject = this._propDesc.newObject();
			this._curArray.push(this._curObject);
		}

		// go to the next column
		return this._colInd + 1;
	}

	empty(upperColInd) {

		this._lastValue = null;

		this.emptyChildAnchors(upperColInd);
	}

	hasValue() {

		return this._hasValue;
	}

	gotValue(rowNum, colInd, val) {

		// check if already has value
		if (this._hasValue)
			throw new RSParserDataError(
				'Result set row ' + rowNum + ', column ' + colInd +
					': more than one value for a polymorphic property ' +
					this._propName + '.');

		// raise the flag for the rest of the row
		this._hasValue = true;

		// add the object to the context array
		this._curArray.push(val);
	}

	setObjectProperty(propName, val) {

		this._curObject[propName] = val;
	}
}

/**
 * Handler for a nested object map anchor column. Supports both polymorphic and
 * non-polymorphic objects.
 *
 * @protected
 */
class ObjectMapAnchorHandler extends AnchorColumnHandler {

	constructor(colInd, parentHandler, propDesc, parser) {
		super(colInd, parser);

		this._parentHandler = parentHandler;
		this._propDesc = propDesc;
		this._propName = propDesc.name;
		this._isSimpleNestedObject =
			(!propDesc.isRef() && !propDesc.isPolymorph());
		this._keyValueExtractor = parser.valueExtractors['string'];

		this.reset();
	}

	reset() {

		this._lastKeyVal = undefined;
		this._curMap = null;
		this._curObject = null;

		this._hasValue = undefined;
	}

	execute(rowNum, rawVal) {

		// reset has value flag
		this._hasValue = false;

		// get the key value
		const keyVal = this._keyValueExtractor(
			rawVal, rowNum, this._colInd, this._options);

		// check if the key is null
		if (keyVal === null) {

			// check if the key changed
			if (this._lastKeyVal === null)
				throw new RSParserDataError(
					'Result set row ' + rowNum + ', column ' + this._colInd +
						': repeated NULL in the map key column.');

			// check if null key in the middle of the map
			if (this._lastKeyVal !== undefined)
				throw new RSParserDataError(
					'Result set row ' + rowNum + ', column ' + this._colInd +
						': unexpected NULL in the map key column.');

			// expect reset from an ancestor anchor
			this._lastKeyVal = null;

			// skip the rest of the row
			return this._columnHandlers.length;
		}

		// check if the key was null
		if (this._lastKeyVal === null)
			throw new RSParserDataError(
				'Result set row ' + rowNum + ', column ' + this._colInd +
					': NULL expected in the map key column.');

		// check if key did not change
		if (keyVal === this._lastKeyVal) {

			// at least one anchor must change
			if (this._nextAnchor < 0)
				throw new RSParserDataError(
					'Result set row ' + rowNum +
						': at least one anchor must change in each row.');

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
			this._curObject = this._propDesc.newObject();
			this._curMap[keyVal] = this._curObject;
		}

		// go to the next column
		return this._colInd + 1;
	}

	empty(upperColInd) {

		this._lastKeyVal = null;

		this.emptyChildAnchors(upperColInd);
	}

	hasValue() {

		return this._hasValue;
	}

	gotValue(rowNum, colInd, val) {

		// check if already has value
		if (this._hasValue)
			throw new RSParserDataError(
				'Result set row ' + rowNum + ', column ' + colInd +
					': more than one value for a polymorphic property ' +
					this._propName + '.');

		// raise the flag for the rest of the row
		this._hasValue = true;

		// add the object to the context map
		this._curMap[this._lastKeyVal] = val;
	}

	setObjectProperty(propName, val) {

		this._curObject[propName] = val;
	}
}

/**
 * Fetched reference value column handler in an array or a map.
 *
 * @protected
 */
class CollectionFetchedRefHandler extends ColumnHandler {

	constructor(colInd, anchorHandler, propDesc, parser) {
		super(colInd, parser);

		this._anchorHandler = anchorHandler;
		this._referredRecordTypeName = propDesc.refTarget;
		this._referredRecordTypeDesc = parser.recordTypes.getRecordTypeDesc(
			this._referredRecordTypeName);
		this._valueExtractor = parser.valueExtractors[
			this._referredRecordTypeDesc.getPropertyDesc(
				this._referredRecordTypeDesc.idPropertyName).scalarValueType];

		this.reset();
	}

	reset() {

		if (this._curObject)
			this._parser.endReferredRecord(this._colInd);

		this._curObject = null;
	}

	execute(rowNum, rawVal) {

		// get referred record id
		const referredRecId = this._valueExtractor(
			rawVal, rowNum, this._colInd, this._options);

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
			this._referredRecordTypeDesc, refVal, this._colInd);
		if (this._curObject === null)
			return this._columnHandlers.length;

		// go to the next column
		return this._colInd + 1;
	}

	setObjectProperty(propName, val) {

		this._curObject[propName] = val;
	}
}


/////////////////////////////////////////////////////////////////////////////////
// Parser.
/////////////////////////////////////////////////////////////////////////////////

/**
 * Result set parser.
 */
class RSParser {

	/**
	 * Create new parser. The parser instance must be initialized with markup
	 * before it can be used.
	 *
	 * @param {module:x2node-records.RecordTypesLibrary} recordType Record types
	 * library.
	 * @param {string} topRecordTypeName Name of the record type being parsed.
	 * @param {Object} [options] Parser options.
	 */
	constructor(recordTypes, topRecordTypeName, options) {

		// store the basics
		this._recordTypes = recordTypes;
		this._topRecordTypeDesc =
			recordTypes.getRecordTypeDesc(topRecordTypeName);
		this._options = (options ? options : {});

		// create default value extractors
		this._valueExtractors = {
			'string': function(val) { return val; },
			'number': function(val) { return val; },
			'boolean': function(val) {
				return (val === null ? null : (val ? true : false));
			},
			'datetime': function(val) { return val; },
			'isNull': function(val) { return (val === null); }
		};

		// replace default value extractors with custom ones from the options
		for (let n in this._options.valueExtractors)
			this._valueExtractors[n] = this._options.valueExtractors[n];

		// uninitialized column handlers placeholder
		this._columnHandlers = null;

		// fetching references array
		this._fetchingRefs = new Array();
	}

	/**
	 * Record types library.
	 *
	 * @protected
	 * @type {module:x2node-records.RecordTypesLibrary}
	 * @readonly
	 */
	get recordTypes() { return this._recordTypes; }

	/**
	 * Value extractor functions by type.
	 *
	 * @protected
	 * @type {Object.<string,Function>}
	 * @readonly
	 */
	get valueExtractors() { return this._valueExtractors; }

	/**
	 * Parser options.
	 *
	 * @protected
	 * @type {Object}
	 * @readonly
	 */
	get options() { return this._options; }

	/**
	 * Handlers created from the markup for each result set column.
	 *
	 * @protected
	 * @type {ColumnHandler[]}
	 * @readonly
	 */
	get columnHandlers() { return this._columnHandlers; }

	/**
	 * Add new top record to the result.
	 *
	 * @protected
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
	 * @protected
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
	 * @protected
	 * @param {module:x2node-records.RecordTypeDescriptor} recordTypeDesc
	 * Referred record type descriptor.
	 * @param {string} refVal Reference value.
	 * @param {number} colInd Reference property column index.
	 * @returns {Object} The referred record instance, or <code>null</code> if
	 * already fetched and the following result set rows that belong to the
	 * record are about to be skipped.
	 */
	beginReferredRecord(recordTypeDesc, refVal, colInd) {

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
		this._referredRecordsNRows.set(key, this._rowsProcessed);

		return rec;
	}

	/**
	 * Indicate the last row of a fetched referred record.
	 *
	 * @protected
	 * @param {number} colInd Reference property column index.
	 */
	endReferredRecord(colInd) {

		const key = this._fetchingRefs[colInd] + ':' + colInd;
		this._referredRecordsNRows.set(
			key, this._rowsProcessed - this._referredRecordsNRows.get(key));
	}

	/**
	 * Initialize parser with columns markup. A parser instance can be
	 * initialized only once. A parser must be initialized before result set rows
	 * can be fed to it.
	 *
	 * @param {string[]} markup Markup for each column in the result set.
	 * @throws {RSParserUsageError} If the parser has already been initialized or
	 * the specified <code>markup</code> argument is of invalid type.
	 * @throws {RSParserMarkupError} If provided markup syntax is invalid.
	 */
	init(markup) {

		// check if already initialized
		if (this._columnHandlers)
			throw new RSParserUsageError(
				'The parser has been already initialized.');

		// check the basic validity of the markup argument
		if (!Array.isArray(markup) || (markup.length < 1))
			throw new RSParserUsageError(
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
			throw new RSParserMarkupError(
				'Markup column ' + lastColInd + ': unexpected column prefix.');

		// initialize empty result accumulators
		this._records = new Array();
		this._referredRecords = new Object();

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
	 * @param {ColumnHandler} parentHandler Context object handler.
	 * @param {module:x2node-records.PropertiesContainer} container Context
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
		do {

			// can't stay on this level once exhausted
			if (levelExhausted)
				throw new RSParserMarkupError(
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
			if (fetchRef = propName.endsWith(':'))
				propName = propName.substring(0, propName.length - 1);

			// check if end of the object properties
			if (prefix !== levelPrefix)
				return colInd;

			// check that the property exists
			if (!container.hasProperty(propName))
				throw new RSParserMarkupError(
					'Markup column ' + colInd + ': record type ' +
						container.recordTypeName + ' does not have property ' +
						container.nestedPath + propName + '.');

			// get property descriptor
			const propDesc = container.getPropertyDesc(propName);

			// only scalar non-polymorphic reference property can be fetched
			if (fetchRef && !propDesc.isRef())
				throw new RSParserMarkupError(
					'Markup column ' + colInd + ': record type ' +
						container.recordTypeName + ' property ' +
						container.nestedPath + propName +
						' is not a reference and cannot be fetched.');

			// exhaust level once non-scalar is seen
			if (!propDesc.isScalar())
				levelExhausted = true;

			// create handler depending on the property type
			let handler, superHandler, anchorHandler;
			if (colInd === 0) {
				this._columnHandlers[colInd] = new TopRecordIdHandler(
					parentHandler, propDesc, this);
				colInd++;

			} else switch (
				(propDesc.isScalar() ? 'scalar' : (
					propDesc.isArray() ? 'array' : 'map')) +
					':' + propDesc.scalarValueType + ':' +
					(propDesc.isPolymorph() ? 'poly' : 'mono')
			) {
				case 'scalar:string:mono':
				case 'scalar:number:mono':
				case 'scalar:boolean:mono':
				case 'scalar:datetime:mono':
				this._columnHandlers[colInd] = new SingleValueHandler(
					colInd, parentHandler, propDesc, this);
				colInd++;
				break;

				case 'scalar:object:mono':
				handler = new SingleObjectHandler(
					colInd, this._columnHandlers[lastAnchorColInd],
					parentHandler, propDesc, this);
				this._columnHandlers[colInd] = handler;
				if (++colInd < this._numColumns)
					colInd = this._parseObjectMarkup(
						colInd, levelPrefix, lastAnchorColInd, handler,
						propDesc.nestedProperties);
				handler.setNextColumnIndex(colInd);
				break;

				case 'scalar:object:poly':
				superHandler = new SinglePolymorphicPropHandler(
					colInd, parentHandler, propDesc, this);
				this._columnHandlers[colInd] = superHandler;
				if (++colInd < this._numColumns)
					colInd = this._parsePolymorphicObjectMarkup(
						colInd, levelPrefix, lastAnchorColInd, container,
						propDesc, superHandler);
				break;

				case 'scalar:ref:mono':
				if (fetchRef) {
					handler = new SingleFetchedRefHandler(
						colInd, this._columnHandlers[lastAnchorColInd],
						parentHandler, propDesc, this);
					this._columnHandlers[colInd] = handler;
					if (++colInd < this._numColumns)
						colInd = this._parseObjectMarkup(
							colInd, levelPrefix, lastAnchorColInd, handler,
							this._recordTypes.getRecordTypeDesc(
								propDesc.refTarget));
					handler.setNextColumnIndex(colInd);
				} else {
					this._columnHandlers[colInd] = new SingleRefHandler(
						colInd, parentHandler, propDesc, this);
					colInd++;
				}
				break;

				case 'scalar:ref:poly':
				superHandler = new SinglePolymorphicPropHandler(
					colInd, parentHandler, propDesc, this);
				this._columnHandlers[colInd] = superHandler;
				if (++colInd < this._numColumns)
					colInd = this._parsePolymorphicRefMarkup(
						colInd, levelPrefix, lastAnchorColInd, container,
						superHandler, fetchRef);
				break;

				case 'array:string:mono':
				case 'array:number:mono':
				case 'array:boolean:mono':
				case 'array:datetime:mono':
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

				case 'array:object:mono':
				this._columnHandlers[lastAnchorColInd].setNextAnchor(colInd);
				anchorHandler = new ObjectArrayAnchorHandler(
					colInd, parentHandler, propDesc, this);
				this._columnHandlers[colInd] = anchorHandler;
				if (++colInd < this._numColumns)
					colInd = this._parseObjectMarkup(
						colInd, levelPrefix, colInd - 1, anchorHandler,
						propDesc.nestedProperties);
				break;

				case 'array:object:poly':
				this._columnHandlers[lastAnchorColInd].setNextAnchor(colInd);
				anchorHandler = new ObjectArrayAnchorHandler(
					colInd, parentHandler, propDesc, this);
				this._columnHandlers[colInd] = anchorHandler;
				if (++colInd < this._numColumns)
					colInd = this._parsePolymorphicObjectMarkup(
						colInd, levelPrefix, colInd - 1, container, propDesc,
						anchorHandler);
				break;

				case 'array:ref:mono':
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

				case 'array:ref:poly':
				this._columnHandlers[lastAnchorColInd].setNextAnchor(colInd);
				anchorHandler = new ObjectArrayAnchorHandler(
					colInd, parentHandler, propDesc, this);
				this._columnHandlers[colInd] = anchorHandler;
				if (++colInd < this._numColumns)
					colInd = this._parsePolymorphicRefMarkup(
						colInd, levelPrefix, colInd - 1, container,
						anchorHandler, fetchRef);
				break;

				case 'map:string:mono':
				case 'map:number:mono':
				case 'map:boolean:mono':
				case 'map:datetime:mono':
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

				case 'map:object:mono':
				this._columnHandlers[lastAnchorColInd].setNextAnchor(colInd);
				anchorHandler = new ObjectMapAnchorHandler(
					colInd, parentHandler, propDesc, this);
				this._columnHandlers[colInd] = anchorHandler;
				if (++colInd < this._numColumns)
					colInd = this._parseObjectMarkup(
						colInd, levelPrefix, colInd - 1, anchorHandler,
						propDesc.nestedProperties);
				break;

				case 'map:object:poly':
				this._columnHandlers[lastAnchorColInd].setNextAnchor(colInd);
				anchorHandler = new ObjectMapAnchorHandler(
					colInd, parentHandler, propDesc, this);
				this._columnHandlers[colInd] = anchorHandler;
				if (++colInd < this._numColumns)
					colInd = this._parsePolymorphicObjectMarkup(
						colInd, levelPrefix, colInd - 1, container, propDesc,
						anchorHandler);
				break;

				case 'map:ref:mono':
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

				case 'map:ref:poly':
				this._columnHandlers[lastAnchorColInd].setNextAnchor(colInd);
				anchorHandler = new ObjectMapAnchorHandler(
					colInd, parentHandler, propDesc, this);
				this._columnHandlers[colInd] = anchorHandler;
				if (++colInd < this._numColumns)
					colInd = this._parsePolymorphicRefMarkup(
						colInd, levelPrefix, colInd - 1, container,
						anchorHandler, fetchRef);
				break;

				default:
				throw new RSParserUsageError(
					'Record type ' + container.recordTypeName + ' property ' +
						container.nestedPath + propName +
						' has unsupported value type specification.');
			}

		} while (colInd < this._numColumns);

		// end of the markup
		return colInd;
	}

	/**
	 * Recursively parse polymorphic object markup.
	 *
	 * @private
	 * @param {number} startColInd First object subtype column index.
	 * @param {string} parentPrefix Parent markup prefix.
	 * @param {number} lastAnchorColInd Index of the last anchor column.
	 * @param {module:x2node-records.PropertiesContainer} container Context
	 * object properties container.
	 * @param {module:x2node-records.PropertyDescriptor} propDesc Polymorphic
	 * object property descriptor.
	 * @param {ColumnHandler} superHandler Polymorphic object property column
	 * handler.
	 * @returns {number} Index of the column next after the object markup.
	 */
	_parsePolymorphicObjectMarkup(
		startColInd, parentPrefix, lastAnchorColInd, container, propDesc,
		superHandler) {

		// determine object prefix
		const levelPrefix = this._getLevelPrefix(startColInd, parentPrefix);
		if (levelPrefix === null)
			return startColInd;

		// parse and process column definitions
		let colInd = startColInd;
		do {

			// parse column definition
			const colDef = this._markup[colInd];
			let prefix, type;
			const sepInd = colDef.lastIndexOf('$');
			if (sepInd >= 0) {
				prefix = colDef.substring(0, sepInd);
				type = colDef.substring(sepInd + 1);
			} else {
				prefix = '';
				type = colDef;
			}

			// check if end of the object types
			if (prefix !== levelPrefix)
				return colInd;

			// lookup subtype properties
			const subtypeProps = propDesc.nestedProperties[type];
			if (!subtypeProps)
				throw new RSParserMarkupError(
					'Markup column ' + colInd +
						': unknown polymorphic object subtype ' + type + '.');

			// create handler and parse subtype markup
			const handler = new PolymorphicObjectTypeHandler(
				colInd, this._columnHandlers[lastAnchorColInd], propDesc,
				superHandler, type, this);
			this._columnHandlers[colInd] = handler;
			if (++colInd < this._numColumns)
				colInd = this._parseObjectMarkup(
					colInd, levelPrefix, lastAnchorColInd, handler,
					subtypeProps);
			handler.setNextColumnIndex(colInd);

		} while (colInd < this._numColumns);

		// end of the markup
		return colInd;
	}

	/**
	 * Recursively parse polymorphic reference markup.
	 *
	 * @private
	 * @param {number} startColInd First reference type column index.
	 * @param {string} parentPrefix Parent markup prefix.
	 * @param {number} lastAnchorColInd Index of the last anchor column.
	 * @param {module:x2node-records.PropertiesContainer} container Context
	 * object properties container.
	 * @param {ColumnHandler} superHandler Polymorphic reference property column
	 * handler.
	 * @param {boolean} fetchRef Tells if the reference needs to be fetched.
	 * @returns {number} Index of the column next after the property markup.
	 */
	_parsePolymorphicRefMarkup(
		startColInd, parentPrefix, lastAnchorColInd, container, superHandler,
		fetchRef) {

		// determine refs prefix
		const levelPrefix = this._getLevelPrefix(startColInd, parentPrefix);
		if (levelPrefix === null)
			return startColInd;

		// parse and process column definitions
		let colInd = startColInd;
		let lastHandler = null;
		do {

			// parse column definition
			const colDef = this._markup[colInd];
			let prefix, type;
			const sepInd = colDef.lastIndexOf('$');
			if (sepInd >= 0) {
				prefix = colDef.substring(0, sepInd);
				type = colDef.substring(sepInd + 1);
			} else {
				prefix = '';
				type = colDef;
			}

			// check if end of the reference types
			if (prefix !== levelPrefix)
				break;

			// lookup referred record type
			if (!this._recordTypes.hasRecordType(type))
				throw new RSParserMarkupError(
					'Markup column ' + colInd +
						': unknown reference target record type ' + type + '.');
			const refRecordTypeDesc = this._recordTypes.getRecordTypeDesc(type);

			// create handler and parse reference markup
			if (fetchRef) {
				const handler = new SingleFetchedPolymorphicRefHandler(
					colInd, this._columnHandlers[lastAnchorColInd],
					superHandler, type, this);
				this._columnHandlers[colInd] = handler;
				lastHandler = handler;
				if (++colInd < this._numColumns)
					colInd = this._parseObjectMarkup(
						colInd, levelPrefix, lastAnchorColInd, handler,
						this._recordTypes.getRecordTypeDesc(type));
				handler.setNextColumnIndex(colInd);

			} else { // no fetch
				const handler = new SinglePolymorphicRefHandler(
					colInd, superHandler, type, this);
				this._columnHandlers[colInd] = handler;
				lastHandler = handler;
				colInd++;
			}

		} while (colInd < this._numColumns);

		// mark last handler
		if (lastHandler)
			lastHandler.setLast();

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
	 * @param {RSParser} parser The other parser.
	 * @throws {RSParserUsageError} If the specified parser is incompatible with
	 * this one.
	 */
	merge(parser) {

		// make sure the parsers share the same top record type
		if (parser._topRecordTypeDesc !== this._topRecordTypeDesc)
			throw new RSParserUsageError(
				'Parsers must share the same top record type.');

		// merge the main record arrays
		const otherRecords = parser._records;
		if (otherRecords.length !== this._records.length)
			throw new RSParserUsageError(
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
	}

	/**
	 * Merge two objects.
	 *
	 * @private
	 * @param {Object} obj1 Object, into which to merge.
	 * @param {Object} obj2 Object to merge into <code>obj1</code> (stays
	 * unmodified).
	 * @param {module:x2node-records.PropertiesContainer} container Container
	 * that describes the object properties.
	 */
	_mergeObjects(obj1, obj2, container) {

		const idPropName = container.idPropertyName;

		Object.keys(obj2).forEach(propName => {
			if (obj1.hasOwnProperty(propName)) {
				const propDesc = container.getPropertyDesc(propName);
				if (propDesc.scalarValueType === 'object') {
					if (propDesc.isArray()) {
						this._mergeArrays(
							obj1[propName], obj2[propName], propDesc);
					} else if (propDesc.isMap()) {
						this._mergeMaps(
							obj1[propName], obj2[propName], propDesc);
					} else if (propDesc.isPolymorph()) {
						const typePropName =
							  propDesc.definition.typePropertyName;
						const nestedObj1 = obj1[propName];
						const nestedObj2 = obj2[propName];
						const type = nestedObj1[typePropName];
						if (type !== nestedObj2[typePropName])
							throw new RSParserUsageError(
								'Attempt to merge polymorphic objects of' +
									' different types.');
						this._mergeObjects(
							nestedObj1, nestedObj2,
							propDesc.nestedProperties[type]);
					} else {
						this._mergeObjects(
							obj1[propName], obj2[propName],
							propDesc.nestedProperties);
					}
				} else if (propName === idPropName) {
					if (obj1[propName] !== obj2[propName])
						throw new RSParserUsageError(
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
	 * @param {Object[]} array1 Array, into which to merge.
	 * @param {Object[]} array2 Array to merge into <code>array1</code> (stays
	 * unmodified).
	 * @param {module:x2node-records.PropertyDescriptor} propDesc Array property
	 * descriptor in the parent container.
	 */
	_mergeArrays(array1, array2, propDesc) {

		if (array1.length !== array2.length)
			throw new RSParserUsageError(
				'Attempt to merge object arrays of different lengths.');

		if (propDesc.isPolymorph()) {
			const typePropName = propDesc.typePropertyName;
			const subtypes = propDesc.nestedProperties;
			array1.forEach((obj1, i) => {
				const obj2 = array2[i];
				if (obj1 === null) {
					if (obj2 !== null)
						throw new RSParserUsageError(
							'Attempt to merge non-null array element with' +
								' null.');
				} else {
					if (obj2 === null)
						throw new RSParserUsageError(
							'Attempt to merge non-null array element with' +
								' null.');
					const type = obj1[typePropName];
					if (type !== obj2[typePropName])
						throw new RSParserUsageError(
							'Attempt to merge polymorphic objects of' +
								' different types.');
					this._mergeObjects(obj1, obj2, subtypes[type]);
				}
			});
		} else {
			const container = propDesc.nestedProperties;
			array1.forEach((obj1, i) => {
				const obj2 = array2[i];
				if (obj1 === null) {
					if (obj2 !== null)
						throw new RSParserUsageError(
							'Attempt to merge non-null array element with' +
								' null.');
				} else {
					if (obj2 === null)
						throw new RSParserUsageError(
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
	 * @param {module:x2node-records.PropertyDescriptor} propDesc Map property
	 * descriptor in the parent container.
	 */
	_mergeMaps(map1, map2, propDesc) {

		const keys = Object.keys(map1);
		if (keys.length !== Object.keys(map2))
			throw new RSParserUsageError(
				'Attempt to merge object maps of different sizes.');

		if (propDesc.isPolymorph()) {
			const typePropName = propDesc.typePropertyName;
			const subtypes = propDesc.nestedProperties;
			keys.forEach(key => {
				const obj1 = map1[key];
				const obj2 = map2[key];
				if (obj2 === undefined)
					throw new RSParserUsageError(
						'Attempt to merge maps with different keys.');
				if (obj1 === null) {
					if (obj2 !== null)
						throw new RSParserUsageError(
							'Attempt to merge non-null array element with' +
								' null.');
				} else {
					if (obj2 === null)
						throw new RSParserUsageError(
							'Attempt to merge non-null array element with' +
								' null.');
					const type = obj1[typePropName];
					if (type !== obj2[typePropName])
						throw new RSParserUsageError(
							'Attempt to merge polymorphic objects of' +
								' different types.');
					this._mergeObjects(obj1, obj2, subtypes[type]);
				}
			});
		} else {
			const container = propDesc.nestedProperties;
			keys.forEach(key => {
				const obj1 = map1[key];
				const obj2 = map2[key];
				if (obj2 === undefined)
					throw new RSParserUsageError(
						'Attempt to merge maps with different keys.');
				if (obj1 === null) {
					if (obj2 !== null)
						throw new RSParserUsageError(
							'Attempt to merge non-null map element with' +
								' null.');
				} else {
					if (obj2 === null)
						throw new RSParserUsageError(
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

		// new result accumulators
		this._records = new Array();
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
	 * @param {(Array|Object.<string,*>)} row The result set row, which can be an
	 * array of raw values for each result set column, or an object with column
	 * markup as the keys and corresponding raw values as the values.
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
	 * @type {Object[]}
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
	 * @type {Object.<string,Object>}
	 * @readonly
	 */
	get referredRecords() {

		return this._referredRecords;
	}
}


/////////////////////////////////////////////////////////////////////////////////
// Module.
/////////////////////////////////////////////////////////////////////////////////

module.exports = RSParser;
