/**
 * RSMarkup module.
 *
 * @module rsmarkup
 */
'use strict';


/////////////////////////////////////////////////////////////////////////////////
// Errors.
/////////////////////////////////////////////////////////////////////////////////

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


/////////////////////////////////////////////////////////////////////////////////
// Handlers.
/////////////////////////////////////////////////////////////////////////////////

class RootHandler {

	constructor(parser) {

		this._records = parser.records;

		this._curRecord = null;
	}

	addNewRecord() {

		this._records.push(this._curRecord = new Object());
	}

	setObjectProperty(propName, val) {

		this._curRecord[propName] = val;
	}
}

class TopRecordIdHandler {

	constructor(rootHandler, propDesc, parser) {

		if (!propDesc.isId())
			throw new RSMarkupSyntaxError(
				'First column in the markup must refer to the record id' +
					' property.');

		this._rootHandler = rootHandler;
		this._propName = propDesc.name;
		this._valueExtractor = parser.valueExtractors[propDesc.scalarValueType];
		this._options = parser.options;
		this._columnHandlers = parser.columnHandlers;

		this._nextAnchor = -1;

		this._lastValue = undefined;
	}

	setNextAnchor(nextAnchor) {

		if (this._nextAnchor >= 0)
			throw new RSMarkupSyntaxError(
				'More than one collection axis at column ' + nextAnchor +
					': anchor at column 0 already has' +
					' a child anchor at column ' + this._nextAnchor + '.');

		this._nextAnchor = nextAnchor;
	}

	execute(rowNum, rawVal) {

		// get the record id value
		const val = this._valueExtractor(rawVal, rowNum, 0, this._options);
		if (val === null)
			throw new RSMarkupDataError(
				'Result set row ' + rowNum + ': top record id may not be null.');

		// check if same record
		if (val === this._lastValue) {

			// can't be same record if this is the only anchor
			if (this._nextAnchor < 0)
				throw new RSMarkupDataError(
					'Result set row ' + rowNum +
						': at least one anchor must change in each row.');

			// skip to the next anchor column
			return this._nextAnchor;
		}

		// update last value
		this._lastValue = val;

		// reset the anchor chain
		if (this._nextAnchor > 0)
			this._columnHandlers[this._nextAnchor].reset();

		// add new top record
		this._rootHandler.addNewRecord();

		// set the id property
		this._rootHandler.setObjectProperty(this._propName, val);

		// go to the next column
		return 1;
	}

	emptyChildAnchors(upperColInd) {

		if ((this._nextAnchor > 0) && (this._nextAnchor < upperColInd))
			this._columnHandlers[this._nextAnchor].empty(upperColInd);
	}
}

class SingleValueHandler {

	constructor(colInd, parentHandler, propDesc, parser) {

		this._colInd = colInd;
		this._parentHandler = parentHandler;
		this._propName = propDesc.name;
		this._valueExtractor = parser.valueExtractors[propDesc.scalarValueType];
		this._options = parser.options;
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

class SingleObjectHandler {

	constructor(colInd, anchorHandler, parentHandler, propDesc, parser) {

		this._colInd = colInd;
		this._anchorHandler = anchorHandler;
		this._parentHandler = parentHandler;
		this._propName = propDesc.name;
		this._nullChecker = parser.valueExtractors['isNull'];
		this._options = parser.options;

		this._nextColInd = undefined;

		this._curObject = null;
	}

	setNextColumnIndex(nextColInd) {

		this._nextColInd = nextColInd;
	}

	execute(rowNum, rawVal) {

		// skip the object property columns if no object
		if (this._nullChecker(rawVal, rowNum, this._colInd, this._options)) {
			this._anchorHandler.emptyChildAnchors(this._nextColInd);
			return this._nextColInd;
		}

		// create new object
		this._curObject = new Object();

		// set the property in the parent object
		this._parentHandler.setObjectProperty(this._propName, this._curObject);

		// go to the next column
		return this._colInd + 1;
	}

	setObjectProperty(propName, val) {

		this._curObject[propName] = val;
	}
}

class SinglePolymorphicPropHandler {

	constructor(colInd, parentHandler, propDesc) {

		this._colInd = colInd;
		this._parentHandler = parentHandler;
		this._propName = propDesc.name;

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
			throw new RSMarkupDataError(
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

class PolymorphicObjectTypeHandler {

	constructor(colInd, anchorHandler, propDesc, superHandler, type, parser) {

		this._colInd = colInd;
		this._anchorHandler = anchorHandler;
		this._superHandler = superHandler;
		this._typePropName = propDesc.definition.typePropertyName;
		this._type = type;
		this._nullChecker = parser.valueExtractors['isNull'];
		this._options = parser.options;

		this._nextColInd = undefined;

		this._curObject = null;
	}

	setNextColumnIndex(nextColInd) {

		this._nextColInd = nextColInd;
	}

	execute(rowNum, rawVal) {

		// skip object subtype columns if no object
		if (this._nullChecker(rawVal, rowNum, this._colInd, this._options)) {
			this._anchorHandler.emptyChildAnchors(this._nextColInd);
			return this._nextColInd;
		}

		// create new object and set its type property
		this._curObject = new Object();
		this._curObject[this._typePropName] = this._type;

		// pass the object to the super handler
		this._superHandler.gotValue(rowNum, this._colInd, this._curObject);

		// go to the next column
		return this._colInd + 1;
	}

	setObjectProperty(propName, val) {

		this._curObject[propName] = val;
	}
}

class SingleRefHandler {

	constructor(colInd, parentHandler, propDesc, parser) {

		this._colInd = colInd;
		this._parentHandler = parentHandler;
		this._propName = propDesc.name;
		this._referredRecordType = propDesc.refTarget;
		const refRecordTypeDesc = parser.recordTypes.getRecordTypeDesc(
			this._referredRecordType);
		this._valueExtractor = parser.valueExtractors[
			refRecordTypeDesc.getPropertyDesc(refRecordTypeDesc.idPropertyName)
				.scalarValueType];
		this._options = parser.options;
	}

	execute(rowNum, rawVal) {

		// get referred record id
		const referredRecId = this._valueExtractor(
			rawVal, rowNum, this._colInd, this._options);

		// set the property in the context object
		if (referredRecId !== null)
			this._parentHandler.setObjectProperty(
				this._propName, this._referredRecordType + '#' + referredRecId);

		// go to the next column
		return this._colInd + 1;
	}
}

class SinglePolymorphicRefHandler {

	constructor(colInd, superHandler, type, parser) {

		this._colInd = colInd;
		this._superHandler = superHandler;
		this._referredRecordType = type;
		const refRecordTypeDesc = parser.recordTypes.getRecordTypeDesc(type);
		this._valueExtractor = parser.valueExtractors[
			refRecordTypeDesc.getPropertyDesc(refRecordTypeDesc.idPropertyName)
				.scalarValueType];
		this._options = parser.options;

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
				this._referredRecordType + '#' + referredRecId);

		// pass the reference to the super handler
		if ((referredRecId !== null) ||
			(this._isLast && !this._superHandler.hasValue()))
			this._superHandler.gotValue(rowNum, this._colInd, refVal);

		// go to the next column
		return this._colInd + 1;
	}
}

class SingleFetchedRefHandler {

	constructor(colInd, anchorHandler, parentHandler, propDesc, parser) {

		this._colInd = colInd;
		this._anchorHandler = anchorHandler;
		this._parentHandler = parentHandler;
		this._propName = propDesc.name;
		this._referredRecordType = propDesc.refTarget;
		const refRecordTypeDesc = parser.recordTypes.getRecordTypeDesc(
			this._referredRecordType);
		this._valueExtractor = parser.valueExtractors[
			refRecordTypeDesc.getPropertyDesc(refRecordTypeDesc.idPropertyName)
				.scalarValueType];
		this._options = parser.options;
		this._referredRecords = parser.referredRecords;

		this._nextColInd = undefined;

		this._curObject = null;
	}

	setNextColumnIndex(nextColInd) {

		this._nextColInd = nextColInd;
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
		const refVal = this._referredRecordType + '#' + referredRecId;
		this._parentHandler.setObjectProperty(this._propName, refVal);

		// create new referred record object and save it
		this._curObject = new Object();
		this._referredRecords[refVal] = this._curObject;

		// go to the next column
		return this._colInd + 1;
	}

	setObjectProperty(propName, val) {

		this._curObject[propName] = val;
	}
}

class SingleFetchedPolymorphicRefHandler {

	constructor(colInd, anchorHandler, superHandler, type, parser) {

		this._colInd = colInd;
		this._anchorHandler = anchorHandler;
		this._superHandler = superHandler;
		this._referredRecordType = type;
		const refRecordTypeDesc = parser.recordTypes.getRecordTypeDesc(type);
		this._valueExtractor = parser.valueExtractors[
			refRecordTypeDesc.getPropertyDesc(refRecordTypeDesc.idPropertyName)
				.scalarValueType];
		this._options = parser.options;
		this._referredRecords = parser.referredRecords;

		this._nextColInd = undefined;
		this._isLast = false;

		this._curObject = null;
	}

	setNextColumnIndex(nextColInd) {

		this._nextColInd = nextColInd;
	}

	setLast() {

		this._isLast = true;
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
		const refVal = this._referredRecordType + '#' + referredRecId;
		this._superHandler.gotValue(rowNum, this._colInd, refVal);

		// create new referred record object and save it
		this._curObject = new Object();
		this._referredRecords[refVal] = this._curObject;

		// go to the next column
		return this._colInd + 1;
	}

	setObjectProperty(propName, val) {

		this._curObject[propName] = val;
	}
}

class ArraySingleRowAnchorHandler {

	constructor(colInd, parentHandler, propDesc, parser) {

		this._colInd = colInd;
		this._parentHandler = parentHandler;
		this._propName = propDesc.name;
		this._nullChecker = parser.valueExtractors['isNull'];
		this._options = parser.options;

		this.reset();
	}

	execute(rowNum, rawVal) {

		// check if anchor is null
		const nullAnchor = this._nullChecker(
			rawVal, rowNum, this._colInd, this._options);

		// check if already has context array
		if (this._anchored) {
			if (nullAnchor)
				throw new RSMarkupDataError(
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

	reset() {

		this._anchored = false;
		this._curArray = null;
	}

	empty() {

		this._anchored = true;
	}

	addElement(val) {

		this._curArray.push(val);
	}
}

class MapSingleRowAnchorHandler {

	constructor(colInd, parentHandler, propDesc, parser) {

		this._colInd = colInd;
		this._parentHandler = parentHandler;
		this._propName = propDesc.name;
		this._keyValueExtractor = parser.valueExtractors['string'];
		this._options = parser.options;

		this.reset();
	}

	execute(rowNum, rawVal) {

		// get the key value
		const keyVal = this._keyValueExtractor(
			rawVal, rowNum, this._colInd, this._options);

		// check if the key is null
		if (keyVal === null) {

			// anchors must change
			if (this._lastKeyVal === null)
				throw new RSMarkupDataError(
					'Result set row ' + rowNum + ', column ' + this._colInd +
						': repeated NULL in the map key column.');

			// can't be in the middle of a map
			if (this._lastKeyVal !== undefined)
				throw new RSMarkupDataError(
					'Result set row ' + rowNum + ', column ' + this._colInd +
						': unexpected NULL in the map key column.');

			// update the last key value
			this._lastKeyVal = null;

			// skip the value
			return this._colInd + 2; // note: should always be last
		}

		// make sure we've got a new key
		if ((this._lastKeyVal === null) || (keyVal === this._lastKeyVal))
			throw new RSMarkupDataError(
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

	reset() {

		this._lastKeyVal = undefined;
		this._curMap = null;
	}

	empty() {

		this._lastKeyVal = null;
	}

	addElement(val) {

		if (val !== null)
			this._curMap[this._lastKeyVal] = val;
	}
}

class SingleRowValueHandler {

	constructor(colInd, anchorHandler, propDesc, parser) {

		this._colInd = colInd;
		this._anchorHandler = anchorHandler;
		this._valueExtractor = parser.valueExtractors[propDesc.scalarValueType];
		this._options = parser.options;
	}

	execute(rowNum, rawVal) {

		// add value to the context array
		this._anchorHandler.addElement(
			this._valueExtractor(rawVal, rowNum, this._colInd, this._options));

		// go to the next column (always last)
		return this._colInd + 1;
	}
}

class SingleRowRefHandler {

	constructor(colInd, anchorHandler, propDesc, parser) {

		this._colInd = colInd;
		this._anchorHandler = anchorHandler;
		this._referredRecordType = propDesc.refTarget;
		const refRecordTypeDesc = parser.recordTypes.getRecordTypeDesc(
			this._referredRecordType);
		this._valueExtractor = parser.valueExtractors[
			refRecordTypeDesc.getPropertyDesc(refRecordTypeDesc.idPropertyName)
				.scalarValueType];
		this._options = parser.options;
	}

	execute(rowNum, rawVal) {

		// get referred record id
		const referredRecId = this._valueExtractor(
			rawVal, rowNum, this._colInd, this._options);

		// create reference value
		const refVal = (
			referredRecId === null ? null :
				this._referredRecordType + '#' + referredRecId);

		// add value to the context array
		this._anchorHandler.addElement(refVal);

		// go to the next column (always last)
		return this._colInd + 1;
	}
}

/**
 * Handler for a nested object array anchor column. Supports both polymorphic and
 * non-polymorphic objects.
 */
class ObjectArrayAnchorHandler {

	constructor(colInd, parentHandler, propDesc, parser) {

		this._colInd = colInd;
		this._parentHandler = parentHandler;
		this._propName = propDesc.name;
		this._isSimpleNestedObject =
			(!propDesc.isRef() && !propDesc.isPolymorph());
		this._nullChecker = parser.valueExtractors['isNull'];
		this._options = parser.options;
		this._columnHandlers = parser.columnHandlers;

		this._nextAnchor = -1;

		this._hasValue = undefined;

		this.reset();
	}

	setNextAnchor(nextAnchor) {

		if (this._nextAnchor >= 0)
			throw new RSMarkupSyntaxError(
				'More than one collection axis at column ' + nextAnchor +
					': anchor at column ' + this._colInd + ' already has' +
					' a child anchor at column ' + this._nextAnchor + '.');

		this._nextAnchor = nextAnchor;
	}

	execute(rowNum, rawVal) {

		// reset has value flag
		this._hasValue = false;

		// check if anchor is null
		if (this._nullChecker(rawVal, rowNum, this._colInd, this._options)) {

			// check if the anchor changed
			if (this._lastValue === null)
				throw new RSMarkupDataError(
					'Result set row ' + rowNum + ', column ' + this._colInd +
						': repeated NULL in the anchor column.');

			// check if null anchor in the middle of a collection
			if (this._lastValue !== undefined)
				throw new RSMarkupDataError(
					'Result set row ' + rowNum + ', column ' + this._colInd +
						': unexpected NULL in the anchor column.');

			// expect reset from a parent anchor
			this._lastValue = null;

			// skip the rest of the row
			return this._columnHandlers.length;
		}

		// check if was null
		if (this._lastValue === null)
			throw new RSMarkupDataError(
				'Result set row ' + rowNum + ', column ' + this._colInd +
					': NULL expected in the anchor column.');

		// check if anchor did not change
		if (rawVal === this._lastValue) {

			// at least one anchor must change
			if (this._nextAnchor < 0)
				throw new RSMarkupDataError(
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

		// reset the rest of the anchor chain
		if (this._nextAnchor > 0)
			this._columnHandlers[this._nextAnchor].reset();

		// create new object and add it to the array
		if (this._isSimpleNestedObject) {
			this._curObject = new Object();
			this._curArray.push(this._curObject);
		}

		// go to the next column
		return this._colInd + 1;
	}

	reset() {

		this._lastValue = undefined;
		this._curArray = null;
		this._curObject = null;

		// proceed down the anchor chain
		if (this._nextAnchor > 0)
			this._columnHandlers[this._nextAnchor].reset();
	}

	empty(upperColInd) {

		this._lastValue = null;

		this.emptyChildAnchors(upperColInd);
	}

	emptyChildAnchors(upperColInd) {

		if ((this._nextAnchor > 0) && (this._nextAnchor < upperColInd))
			this._columnHandlers[this._nextAnchor].empty(upperColInd);
	}

	hasValue() {

		return this._hasValue;
	}

	gotValue(rowNum, colInd, val) {

		// check if already has value
		if (this._hasValue)
			throw new RSMarkupDataError(
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

class ObjectMapAnchorHandler {

	constructor(colInd, parentHandler, propDesc, parser) {

		this._colInd = colInd;
		this._parentHandler = parentHandler;
		this._propName = propDesc.name;
		this._isSimpleNestedObject =
			(!propDesc.isRef() && !propDesc.isPolymorph());
		this._keyValueExtractor = parser.valueExtractors['string'];
		this._options = parser.options;
		this._columnHandlers = parser.columnHandlers;

		this._nextAnchor = -1;

		this._hasValue = undefined;

		this.reset();
	}

	setNextAnchor(nextAnchor) {

		if (this._nextAnchor >= 0)
			throw new RSMarkupSyntaxError(
				'More than one collection axis at column ' + nextAnchor +
					': anchor at column ' + this._colInd + ' already has' +
					' a child anchor at column ' + this._nextAnchor + '.');

		this._nextAnchor = nextAnchor;
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
				throw new RSMarkupDataError(
					'Result set row ' + rowNum + ', column ' + this._colInd +
						': repeated NULL in the map key column.');

			// check if null key in the middle of the map
			if (this._lastKeyVal !== undefined)
				throw new RSMarkupDataError(
					'Result set row ' + rowNum + ', column ' + this._colInd +
						': unexpected NULL in the map key column.');

			// expect reset from an ancestor anchor
			this._lastKeyVal = null;

			// skip the rest of the row
			return this._columnHandlers.length;
		}

		// check if the key was null
		if (this._lastKeyVal === null)
			throw new RSMarkupDataError(
				'Result set row ' + rowNum + ', column ' + this._colInd +
					': NULL expected in the map key column.');

		// check if key did not change
		if (keyVal === this._lastKeyVal) {

			// at least one anchor must change
			if (this._nextAnchor < 0)
				throw new RSMarkupDataError(
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

		// reset the rest of the anchor chain
		if (this._nextAnchor > 0)
			this._columnHandlers[this._nextAnchor].reset();

		// create new object and add it to the map
		if (this._isSimpleNestedObject) {
			this._curObject = new Object();
			this._curMap[keyVal] = this._curObject;
		}

		// go to the next column
		return this._colInd + 1;
	}

	reset() {

		this._lastKeyVal = undefined;
		this._curMap = null;
		this._curObject = null;

		// proceed down the anchor chain
		if (this._nextAnchor > 0)
			this._columnHandlers[this._nextAnchor].reset();
	}

	empty(upperColInd) {

		this._lastKeyVal = null;

		this.emptyChildAnchors(upperColInd);
	}

	emptyChildAnchors(upperColInd) {

		if ((this._nextAnchor > 0) && (this._nextAnchor < upperColInd))
			this._columnHandlers[this._nextAnchor].empty(upperColInd);
	}

	hasValue() {

		return this._hasValue;
	}

	gotValue(rowNum, colInd, val) {

		// check if already has value
		if (this._hasValue)
			throw new RSMarkupDataError(
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

class CollectionFetchedRefHandler {

	constructor(colInd, anchorHandler, propDesc, parser) {

		this._colInd = colInd;
		this._anchorHandler = anchorHandler;
		this._referredRecordType = propDesc.refTarget;
		const refRecordTypeDesc = parser.recordTypes.getRecordTypeDesc(
			this._referredRecordType);
		this._valueExtractor = parser.valueExtractors[
			refRecordTypeDesc.getPropertyDesc(refRecordTypeDesc.idPropertyName)
				.scalarValueType];
		this._options = parser.options;
		this._columnHandlers = parser.columnHandlers;
		this._referredRecords = parser.referredRecords;

		this._curObject = null;
	}

	execute(rowNum, rawVal) {

		// get referred record id
		const referredRecId = this._valueExtractor(
			rawVal, rowNum, this._colInd, this._options);

		// create reference value
		const refVal = (
			referredRecId === null ? null :
				this._referredRecordType + '#' + referredRecId);

		// add value to the context array
		this._anchorHandler.gotValue(rowNum, this._colInd, refVal);

		// skip the referred record property columns if no record
		if (referredRecId === null) {
			const beyondColInd = this._columnHandlers.length;
			this._anchorHandler.emptyChildAnchors(beyondColInd);
			return beyondColInd;
		}

		// create new referred record object and save it
		this._curObject = new Object();
		this._referredRecords[refVal] = this._curObject;

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
	}

	get recordTypes() { return this._recordTypes; }

	get valueExtractors() { return this._valueExtractors; }

	get options() { return this._options; }

	get columnHandlers() { return this._columnHandlers; }

	// TODO: utilize this in fetched ref handlers
	skipNextNRows(nRows) { this._skipNextNRows = nRows; }

	/**
	 * Initialize parser with columns markup. A parser instance can be
	 * initialized only once. A parser must be initialized before result set rows
	 * can be fed to it.
	 *
	 * @param {string[]} markup Markup for each column in the result set.
	 *
	 * @throws {RSMarkupUsageError} If the parser has already been initialized,
	 * the specified <code>markup</code> argument is of invalid type or
	 * incompatible record types library was provided.
	 * @throws {RSMarkupSyntaxError} If provided markup syntax is invalid.
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

		// initialize empty result accumulators
		this._records = [];
		this._referredRecords = {};

		// create array for column handlers
		this._columnHandlers = new Array();

		// parse the markup
		const lastColInd = this._parseObjectMarkup(
			0, null, 0, new RootHandler(this), this._topRecordTypeDesc);
		if (lastColInd !== this._numColumns)
			throw new RSMarkupSyntaxError(
				'Markup column ' + lastColInd + ': unexpected column prefix.');

		// initialize row skipper
		this._skipNextNRows = 0;

		// initialize row counter
		this._rowsProcessed = 0;
	}

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
				throw new RSMarkupSyntaxError(
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
				throw new RSMarkupSyntaxError(
					'Markup column ' + colInd + ': record type ' +
						container.recordTypeName + ' does not have property ' +
						container.nestedPath + propName + '.');

			// get property descriptor
			const propDesc = container.getPropertyDesc(propName);

			// only scalar non-polymorphic reference property can be fetched
			if (fetchRef && !propDesc.isRef())
				throw new RSMarkupSyntaxError(
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
					colInd, parentHandler, propDesc);
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
					colInd, parentHandler, propDesc);
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
				if (++colInd < this._numColumns) {
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
					if (++colInd < this._numColumns) {
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
				if (++colInd < this._numColumns) {
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
					if (++colInd < this._numColumns) {
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
				throw new RSMarkupUsageError(
					'Record type ' + container.recordTypeName + ' property ' +
						container.nestedPath + propName +
						' has unsupported value type specification.');
			}

		} while (colInd < this._numColumns);

		// end of the markup
		return colInd;
	}

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
				throw new RSMarkupSyntaxError(
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
				throw new RSMarkupSyntaxError(
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

	merge(parser) {

		//...
	}

	reset() {

		//...
	}

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

	get records() {

		return this._records;
	}

	get referredRecords() {

		return this._referredRecords;
	}
}


/////////////////////////////////////////////////////////////////////////////////
// Module.
/////////////////////////////////////////////////////////////////////////////////

const RecordTypesLibrary = require('./record-types-library');

exports.createParser = function(
	recordTypeDefs, topRecordTypeName, options, markup) {

	const parser = new RSParser(
		new RecordTypesLibrary(recordTypeDefs), topRecordTypeName, options);

	if (markup)
		parser.init(markup);

	return parser;
};
